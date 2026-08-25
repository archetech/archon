import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import { socksDispatcher } from 'fetch-socks';
// Aliased rather than shadowing the global fetch, which the rest of this file
// uses with DOM-typed bodies. socksDispatcher is built on fetch-socks's undici
// (>=7), and Node's built-in fetch hands it a v6-era request handler that it
// rejects with "invalid onRequestStart method" -- a bare `TypeError: fetch
// failed` in milliseconds, long before any Tor round trip. See #916.
import { fetch as socksFetch } from 'undici';
import multer from 'multer';

import type Keymaster from '@didcid/keymaster';
import type KeymasterClient from '@didcid/clients/keymaster';
import type { DatabaseInterface, User } from './db/interfaces.js';
import type { EmailBridge } from './email-bridge.js';
import { createOAuthRoutes } from './oauth/index.js';
import {
    EXPLORER_URL,
    IPFS_API_URL,
    IPNS_KEY_NAME,
    MEMBERSHIP_SCHEMA_DID,
    OWNER_DID,
    PUBLIC_URL,
    SENDGRID_API_KEY,
    SENDGRID_FROM_EMAIL,
    SERVICE_DOMAIN,
    SERVICE_NAME,
    TOR_PROXY,
    WALLET_URL,
    WEBHOOK_SECRET,
} from './config.js';

// An object, so tests can substitute it. SOCKS-dispatched requests deliberately
// bypass globalThis.fetch, so a test cannot observe them by stubbing that --
// and mocking the 'undici' module does not work either, because this file
// resolves it from the service's own node_modules while a test resolves it from
// the repo root. Two different modules, one mock.
export const socksEgress = { fetch: socksFetch };

// Mutable state owned by the bootstrap in index.ts. Routes read it through this
// object because it is populated after the routes are registered.
export interface HeraldContext {
    keymaster: Keymaster | KeymasterClient;
    db: DatabaseInterface;
    emailBridge: EmailBridge | null;
    serviceDID: string;
}

// A manifest entry is whatever its subject put there. `publishCredential`
// checks the shape and that the caller is the subject, never the proof, and a
// controller can write `didDocumentData` directly regardless -- so an entry
// naming any issuer can be self-asserted. The public profile renders these
// under a "Credentials" heading, where a stranger has no other way to tell a
// signed credential from a claim (#945).
//
// Verified here rather than in the browser: the check has to resolve the
// issuer's DID document, which needs the gatekeeper this service already
// holds, and the client carries no keymaster.
// `invalid` and `unverifiable` are kept apart deliberately. A credential whose
// signature or issuer does not check out has been examined and failed, and a
// reader should treat it as a claim someone made about themselves. One whose
// issuer cannot be resolved has not been examined at all, and saying so is
// honest where calling it invalid would not be.
type CredentialCheck = {
    status: 'valid' | 'invalid' | 'revoked' | 'unverifiable';
    reason?: string;
};

async function checkManifestCredential(
    keymaster: Keymaster | KeymasterClient,
    credentialDid: string,
    vc: any,
): Promise<CredentialCheck> {
    try {
        const verificationMethod = vc?.proof?.verificationMethod;

        if (typeof verificationMethod !== 'string') {
            return { status: 'invalid', reason: 'no proof' };
        }

        // verifyProof checks the signature against whoever the proof names,
        // which is not necessarily whoever the credential claims issued it.
        // Without this comparison a credential saying `issuer: did:cid:bank`
        // and signed with the subject's own key verifies happily, and marking
        // that "valid" would launder the forgery rather than catch it.
        const [signer] = verificationMethod.split('#');

        if (!vc.issuer || vc.issuer !== signer) {
            return { status: 'invalid', reason: 'issuer does not match the signing key' };
        }

        if (!await keymaster.verifyProof(vc)) {
            return { status: 'invalid', reason: 'signature does not verify' };
        }

        // The manifest holds a copy of the credential, so revoking the
        // credential asset leaves that copy in place and looking healthy.
        const doc = await keymaster.resolveDID(credentialDid);

        if (doc?.didDocumentMetadata?.deactivated) {
            return { status: 'revoked' };
        }

        return { status: 'valid' };
    }
    catch (error: any) {
        // An unresolvable issuer or a gatekeeper failure lands here. Nothing
        // was disproved, so this is a gap in what we can tell the reader
        // rather than a verdict on the credential.
        return { status: 'unverifiable', reason: 'issuer could not be resolved' };
    }
}

export function createHeraldRoutes(ctx: HeraldContext): {
    router: express.Router;
    startDmailPollLoop: () => void;
} {
    const router = express.Router();
    const logins: Record<string, {
        response: string;
        challenge: string;
        did: string;
        verify: any;
    }> = {};

    function validateName(name: any): { ok: boolean; trimmedName?: string; message?: string } {
        if (!name || typeof name !== 'string') {
            return { ok: false, message: 'Name is required' };
        }
        const trimmedName = name.trim().toLowerCase();
        if (trimmedName.length < 3 || trimmedName.length > 32) {
            return { ok: false, message: 'Name must be 3-32 characters' };
        }
        if (!/^[a-z0-9_-]+$/.test(trimmedName)) {
            return { ok: false, message: 'Name can only contain letters, numbers, hyphens, and underscores' };
        }
        return { ok: true, trimmedName };
    }

    async function checkNameAvailability(trimmedName: string, excludeDid?: string): Promise<boolean> {
        const existingDid = await ctx.db.findDidByName(trimmedName);
        return !existingDid || existingDid === excludeDid;
    }

    async function issueOrUpdateCredential(did: string, user: any, trimmedName: string): Promise<void> {
        if (!MEMBERSHIP_SCHEMA_DID) {
            console.warn(`Skipping credential issuance for ${trimmedName}: ARCHON_HERALD_MEMBERSHIP_SCHEMA_DID is not set`);
            return;
        }

        await ctx.keymaster.setCurrentId(SERVICE_NAME);

        if (user.credentialDid) {
            const vc: any = await ctx.keymaster.getCredential(user.credentialDid);
            if (!vc) throw new Error('Failed to fetch existing credential');
            vc.credentialSubject.name = `${trimmedName}@${SERVICE_DOMAIN}`;
            vc.validFrom = new Date().toISOString();
            const updated = await ctx.keymaster.updateCredential(user.credentialDid, vc);
            if (!updated) throw new Error('Failed to update credential');
            user.credentialIssuedAt = new Date().toISOString();
            console.log(`Updated credential ${user.credentialDid} for ${trimmedName}`);
        } else {
            const boundCredential = await ctx.keymaster.bindCredential(did, {
                schema: MEMBERSHIP_SCHEMA_DID,
                validFrom: new Date().toISOString(),
                claims: { name: `${trimmedName}@${SERVICE_DOMAIN}` }
            });
            const credentialDid = await ctx.keymaster.issueCredential(boundCredential);
            user.credentialDid = credentialDid;
            user.credentialIssuedAt = new Date().toISOString();
            console.log(`Issued new credential ${credentialDid} for ${trimmedName}`);
        }
    }

    async function revokeCredential(user: any, name: string): Promise<void> {
        if (user.credentialDid) {
            try {
                await ctx.keymaster.setCurrentId(SERVICE_NAME);
                await ctx.keymaster.revokeCredential(user.credentialDid);
                console.log(`Revoked credential ${user.credentialDid} for ${name}`);
            } catch (err) {
                console.log(`Failed to revoke credential: ${err}`);
            }
            delete user.credentialDid;
            delete user.credentialIssuedAt;
        }
    }

    async function verifyBearerToken(req: Request): Promise<string | null> {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) return null;
        const response = authHeader.slice(7);
        if (!response) return null;
        const verify = await ctx.keymaster.verifyResponse(response, { retries: 10 });
        if (!verify.match || !verify.responder) return null;
        return verify.responder;
    }

    async function ensureUser(did: string): Promise<User> {
        const now = new Date().toISOString();
        const existingUser = await ctx.db.getUser(did);
        if (existingUser) {
            return existingUser;
        }
        const user = { firstLogin: now, lastLogin: now, logins: 1 };
        await ctx.db.setUser(did, user);
        return user;
    }

    async function findNameDid(name: string): Promise<string | null> {
        return ctx.db.findDidByName(name);
    }

    async function listUsers(): Promise<Record<string, User>> {
        return ctx.db.listUsers();
    }

    function buildRegistry(users: Record<string, User>): { version: number; updated: string; names: Record<string, string> } {
        const names: Record<string, string> = {};

        for (const [did, user] of Object.entries(users)) {
            if (user.name) {
                names[user.name] = did;
            }
        }

        return {
            version: 1,
            updated: new Date().toISOString(),
            names,
        };
    }

    async function resolveLightningEndpoint(name: string): Promise<{ did: string; endpoint: string } | null> {
        const did = await findNameDid(name);
        if (!did) return null;

        const didDoc: any = await ctx.keymaster.resolveDID(did);
        if (!didDoc?.didDocument?.service) return null;

        const lightning = didDoc.didDocument.service.find(
            (s: any) => s.type === 'Lightning' || s.id?.endsWith('#lightning')
        );
        if (!lightning?.serviceEndpoint) return null;

        return { did, endpoint: lightning.serviceEndpoint };
    }

    async function resolveAvatarImage(name: string): Promise<{
    did: string;
    avatarDid: string;
    file: {
        data: Buffer;
        type: string;
        filename?: string;
        bytes?: number;
    };
} | null> {
        const did = await findNameDid(name);
        if (!did) return null;

        const memberDoc: any = await ctx.keymaster.resolveDID(did);
        const avatarDid = typeof memberDoc?.didDocumentData?.avatar === 'string'
            ? memberDoc.didDocumentData.avatar.trim()
            : '';

        if (!avatarDid) return null;

        const image = await ctx.keymaster.getImage(avatarDid);
        const data = image?.file?.data ?? null;

        if (!data || !Buffer.isBuffer(data) || !image?.file?.type || !image.image) {
            return null;
        }

        return {
            did,
            avatarDid,
            file: {
                ...image.file,
                data,
            },
        };
    }

    function getSafeAvatarContentType(contentType: string): string {
        const normalizedType = contentType.trim().toLowerCase();
        const allowedAvatarContentTypes = new Set([
            'image/avif',
            'image/gif',
            'image/jpeg',
            'image/jpg',
            'image/png',
            'image/webp',
        ]);

        return allowedAvatarContentTypes.has(normalizedType)
            ? normalizedType
            : 'application/octet-stream';
    }

    function isAuthenticated(req: Request, res: Response, next: NextFunction): void {
        if (!req.session.user && req.session.challenge) {
            const challengeData = logins[req.session.challenge];
            if (challengeData) {
                req.session.user = { did: challengeData.did };
            }
        }

        if (req.session.user) {
            return next();
        }
        res.status(401).send('You need to log in first');
    }

    function isOwner(req: Request, res: Response, next: NextFunction): void {
        isAuthenticated(req, res, () => {
            const userDid = req.session.user?.did;
            if (userDid === OWNER_DID) {
                return next();
            }
            res.status(403).send('Owner access required');
        });
    }

    async function loginUser(response: string): Promise<any> {
        const verify = await ctx.keymaster.verifyResponse(response, { retries: 10 });

        if (verify.match) {
            const challenge = verify.challenge;
            const did = verify.responder!;
            const now = new Date().toISOString();
            const user = await ctx.db.getUser(did);

            if (user) {
                user.lastLogin = now;
                user.logins = (user.logins || 0) + 1;
                await ctx.db.setUser(did, user);
            } else {
                await ctx.db.setUser(did, {
                    firstLogin: now,
                    lastLogin: now,
                    logins: 1,
                });
            }

            logins[challenge] = {
                response,
                challenge,
                did,
                verify,
            };
        }

        return verify;
    }

    const corsOptions = {
        origin: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE'],
        credentials: true,
        optionsSuccessStatus: 200
    };

    router.use(cors(corsOptions));

    router.options('/api/{*path}', cors(corsOptions));
    router.options('/.well-known/{*path}', cors(corsOptions));

    // Helper function for OAuth
    async function getMemberByDID(did: string): Promise<any> {
        const user = await ctx.db.getUser(did);
        if (user) {
            return {
                ...user,
                did,
                handle: user.name
            };
        }
        return null;
    }

    // Mount OAuth routes (ctx.keymaster accessed lazily)
    const oauthRouter = createOAuthRoutes(() => ctx.keymaster, getMemberByDID);
    router.use('/oauth', oauthRouter);
    console.log('OAuth routes mounted at /oauth');

    // OIDC Discovery at root level (required by spec)
    router.get('/.well-known/openid-configuration', (_req: Request, res: Response) => {
        const issuer = PUBLIC_URL;
        res.json({
            issuer,
            authorization_endpoint: `${issuer}/oauth/authorize`,
            token_endpoint: `${issuer}/oauth/token`,
            userinfo_endpoint: `${issuer}/oauth/userinfo`,
            response_types_supported: ['code'],
            subject_types_supported: ['public'],
            id_token_signing_alg_values_supported: ['ES256'],
            scopes_supported: ['openid', 'profile'],
            claims_supported: ['sub', 'name', 'preferred_username', 'picture']
        });
    });

    router.get('/api/version', async (_: Request, res: Response) => {
        try {
            res.json(1);
        } catch (error) {
            console.log(error);
            res.status(500).send(String(error));
        }
    });

    router.get('/api/config', (_: Request, res: Response) => {
        res.json({
            serviceName: SERVICE_NAME,
            serviceDID: ctx.serviceDID,
            ...(SENDGRID_API_KEY ? { relayAgent: ctx.serviceDID } : {}),
            serviceDomain: SERVICE_DOMAIN,
            publicUrl: PUBLIC_URL,
            walletUrl: WALLET_URL,
            explorerUrl: EXPLORER_URL,
        });
    });

    router.get('/api/challenge', async (req: Request, res: Response) => {
        try {
            const challenge = await ctx.keymaster.createChallenge({
            // @ts-ignore
                callback: `${PUBLIC_URL}/api/login`
            });
            req.session.challenge = challenge;
            const challengeURL = `${WALLET_URL}?challenge=${challenge}`;

            const doc = await ctx.keymaster.resolveDID(challenge);
            console.log(JSON.stringify(doc, null, 4));
            res.json({ challenge, challengeURL });
        } catch (error) {
            console.log(error);
            res.status(500).send(String(error));
        }
    });

    // Email bridge: inbound email webhook (SendGrid Inbound Parse)
    const inboundEmailUpload = multer();
    router.post('/api/inbound-email', inboundEmailUpload.none(), async (req: Request, res: Response) => {
        try {
            if (!ctx.emailBridge?.isConfigured()) {
                res.status(404).json({ error: 'Email bridge not configured' });
                return;
            }

            // Verify webhook authenticity via query parameter token
            if (WEBHOOK_SECRET && req.query.secret !== WEBHOOK_SECRET) {
                console.warn('Inbound email webhook rejected: invalid or missing secret');
                res.status(401).json({ error: 'Unauthorized' });
                return;
            }

            const email = ctx.emailBridge.parseInboundEmail(req.body);
            if (!email) {
                console.warn('Inbound email missing required fields');
                res.status(400).json({ error: 'Missing from or to fields' });
                return;
            }

            const spamScore = parseFloat(email.spam_score || '0');
            if (spamScore > 5) {
                console.warn(`Inbound email rejected: spam score ${spamScore} from ${email.from}`);
                res.status(200).json({ ok: true, action: 'spam-rejected' });
                return;
            }

            const token = ctx.emailBridge.extractReplyToken(email.to);
            if (token) {
                const tokenData = await ctx.emailBridge.lookupToken(token);
                if (!tokenData) {
                    console.warn(`Inbound email with expired/unknown token from ${email.from}`);
                    res.status(200).json({ ok: true, action: 'token-expired' });
                    return;
                }

                // Reply to an outbound email: create dmail to original sender
                const replyFromEmail = ctx.emailBridge.extractEmailAddress(email.from) || email.from;
                await ctx.keymaster.setCurrentId(SERVICE_NAME);
                const dmailMessage = {
                    to: [tokenData.senderDid],
                    cc: [] as string[],
                    subject: `[email from ${replyFromEmail}] ${email.subject}`,
                    body: email.text || '(no text content)',
                    reference: tokenData.originalDmailDid,
                };
                const dmailDid = await ctx.keymaster.createDmail(dmailMessage, { registry: 'hyperswarm' });
                const noticeDid = await ctx.keymaster.sendDmail(dmailDid);

                await ctx.emailBridge.storeEmailMapping(dmailDid, replyFromEmail, tokenData.senderDid);
                console.log(`Inbound email from ${email.from} → dmail ${dmailDid} to ${tokenData.senderDid} (notice: ${noticeDid})`);
                res.status(200).json({ ok: true, action: 'delivered', dmailDid });
                return;
            }

            // No reply token — try to resolve recipient as a Herald name
            const recipientName = ctx.emailBridge.extractRecipientName(email.to);
            if (!recipientName) {
                console.warn(`Inbound email with no recognizable recipient from ${email.from} to ${email.to}`);
                res.status(200).json({ ok: true, action: 'no-recipient-ignored' });
                return;
            }

            const recipientDid = await ctx.db.findDidByName(recipientName);
            if (!recipientDid) {
                console.warn(`Inbound email to unknown Herald name "${recipientName}" from ${email.from}`);
                res.status(200).json({ ok: true, action: 'unknown-name-ignored' });
                return;
            }

            // Unsolicited inbound: create dmail from Herald to the named recipient
            const senderEmail = ctx.emailBridge.extractEmailAddress(email.from) || email.from;
            await ctx.keymaster.setCurrentId(SERVICE_NAME);
            const dmailMessage = {
                to: [recipientDid],
                cc: [] as string[],
                subject: `[email from ${senderEmail}] ${email.subject}`,
                body: email.text || '(no text content)',
            };
            const dmailDid = await ctx.keymaster.createDmail(dmailMessage, { registry: 'hyperswarm' });
            const noticeDid = await ctx.keymaster.sendDmail(dmailDid);

            await ctx.emailBridge.storeEmailMapping(dmailDid, senderEmail, recipientDid);
            console.log(`Inbound email from ${email.from} → dmail ${dmailDid} to ${recipientName} (${recipientDid}) (notice: ${noticeDid})`);
            res.status(200).json({ ok: true, action: 'delivered', dmailDid });
        } catch (error) {
            console.error('Error processing inbound email:', error);
            res.status(200).json({ ok: true, action: 'error' });
        }
    });

    // Email bridge: send email (authenticated)
    router.post('/api/send-email', async (req: Request, res: Response) => {
        try {
            if (!ctx.emailBridge?.isConfigured()) {
                res.status(404).json({ error: 'Email bridge not configured' });
                return;
            }

            const senderDid = await verifyBearerToken(req);
            if (!senderDid) {
                res.status(401).json({ error: 'Authentication required' });
                return;
            }

            const user = await ctx.db.getUser(senderDid);
            if (!user?.name) {
                res.status(403).json({ error: 'Herald name required to send email' });
                return;
            }

            const { to, subject, body, dmailDid } = req.body;
            if (!to || !subject || !body || !dmailDid) {
                res.status(400).json({ error: 'Missing required fields: to, subject, body, dmailDid' });
                return;
            }

            const result = await ctx.emailBridge.sendEmail({
                to,
                subject,
                body,
                senderName: user.name,
                senderDid,
                dmailDid,
            });

            console.log(`Email sent by ${user.name} (${senderDid}) to ${to}`);
            res.json({ ok: true, token: result.token });
        } catch (error) {
            console.error('Error sending email:', error);
            res.status(500).json({ error: 'Failed to send email' });
        }
    });

    router.get('/api/login', cors(corsOptions), async (req: Request, res: Response) => {
        try {
            const { response } = req.query;
            if (typeof response !== 'string') {
                res.status(400).json({ error: 'Missing or invalid response param' });
                return;
            }
            const verify = await loginUser(response);
            if (!verify.challenge) {
                res.json({ authenticated: false });
                return;
            }
            req.session.user = {
                did: verify.responder
            };
            res.json({ authenticated: verify.match });
        } catch (error) {
            console.log(error);
            res.status(500).send(String(error));
        }
    });

    router.post('/api/login', cors(corsOptions), async (req: Request, res: Response) => {
        try {
            const { response } = req.body;
            const verify = await loginUser(response);
            if (!verify.challenge) {
                res.json({ authenticated: false });
                return;
            }
            req.session.user = {
                did: verify.responder
            };
            res.json({ authenticated: verify.match });
        } catch (error) {
            console.log(error);
            res.status(500).send(String(error));
        }
    });

    router.post('/api/logout', async (req: Request, res: Response) => {
        try {
            req.session.destroy(err => {
                if (err) {
                    console.log(err);
                }
            });
            res.json({ ok: true });
        }
        catch (error) {
            console.log(error);
            res.status(500).send(String(error));
        }
    });

    router.get('/api/check-auth', async (req: Request, res: Response) => {
        try {
            if (!req.session.user && req.session.challenge) {
                const challengeData = logins[req.session.challenge];
                if (challengeData) {
                    req.session.user = { did: challengeData.did };
                }
            }

            const isAuthenticated = !!req.session.user;
            const userDID = isAuthenticated ? req.session.user?.did : null;
            let profile: any = null;

            if (isAuthenticated && userDID) {
                profile = await ctx.db.getUser(userDID);
            }

            const auth = {
                isAuthenticated,
                userDID,
                isOwner: isAuthenticated && userDID === OWNER_DID,
                profile,
            };

            res.json(auth);
        }
        catch (error) {
            console.log(error);
            res.status(500).send(String(error));
        }
    });

    router.get('/api/users', isAuthenticated, async (_: Request, res: Response) => {
        try {
            const users = Object.keys(await listUsers());
            res.json(users);
        }
        catch (error) {
            console.log(error);
            res.status(500).send(String(error));
        }
    });

    router.get('/api/admin', isOwner, async (_: Request, res: Response) => {
        try {
            res.json({ users: await listUsers() });
        }
        catch (error) {
            console.log(error);
            res.status(500).send(String(error));
        }
    });

    // Publish registry to IPFS and update IPNS
    router.post('/api/admin/publish', isOwner, async (_: Request, res: Response) => {
        try {
        // Build registry from DB
            const registry = buildRegistry(await listUsers());

            const registryJson = JSON.stringify(registry, null, 2);

            // Add to IPFS
            const formData = new FormData();
            formData.append('file', new Blob([registryJson], { type: 'application/json' }), 'registry.json');

            const addResponse = await fetch(`${IPFS_API_URL}/add?pin=true`, {
                method: 'POST',
                body: formData
            });

            if (!addResponse.ok) {
                throw new Error(`IPFS add failed: ${addResponse.statusText}`);
            }

            const addResult = await addResponse.json();
            const cid = addResult.Hash;

            console.log(`Registry added to IPFS: ${cid}`);

            // Publish to IPNS
            const publishResponse = await fetch(
                `${IPFS_API_URL}/name/publish?arg=/ipfs/${cid}&key=${IPNS_KEY_NAME}`,
                { method: 'POST' }
            );

            if (!publishResponse.ok) {
                throw new Error(`IPNS publish failed: ${publishResponse.statusText}`);
            }

            const publishResult = await publishResponse.json();

            console.log(`Registry published to IPNS: ${publishResult.Name}`);

            res.json({
                ok: true,
                cid,
                ipns: publishResult.Name,
                registry
            });
        }
        catch (error: any) {
            console.log(error);
            res.status(500).json({ ok: false, error: error.message || String(error) });
        }
    });

    router.get('/api/profile/:did', isAuthenticated, async (req: Request, res: Response) => {
        try {
            const did = req.params.did as string;
            const user = await ctx.db.getUser(did);
            if (!user) {
                res.status(404).send('Not found');
                return;
            }

            const profile: User = { ...user };

            profile.did = did;
            profile.isUser = (req.session?.user?.did === did);

            res.json(profile);
        }
        catch (error) {
            console.log(error);
            res.status(500).send(String(error));
        }
    });

    router.get('/api/profile/:did/name', isAuthenticated, async (req: Request, res: Response) => {
        try {
            const did = req.params.did as string;
            const user = await ctx.db.getUser(did);
            if (!user) {
                res.status(404).send('Not found');
                return;
            }

            res.json({ name: user.name });
        }
        catch (error) {
            console.log(error);
            res.status(500).send(String(error));
        }
    });

    router.put('/api/profile/:did/name', isAuthenticated, async (req: Request, res: Response) => {
        try {
            const did = req.params.did as string;

            if (!req.session.user || req.session.user.did !== did) {
                res.status(403).json({ message: 'Forbidden' });
                return;
            }

            const validation = validateName(req.body.name);
            if (!validation.ok) {
                res.status(400).json({ ok: false, message: validation.message });
                return;
            }
            const trimmedName = validation.trimmedName!;

            const user = await ctx.db.getUser(did);
            if (!user) {
                res.status(404).send('Not found');
                return;
            }

            if (!(await checkNameAvailability(trimmedName, did))) {
                res.status(409).json({ ok: false, message: 'Name already taken' });
                return;
            }

            user.name = trimmedName;
            await issueOrUpdateCredential(did, user, trimmedName);
            await ctx.db.setUser(did, user);

            res.json({ ok: true, message: `name set to ${trimmedName}` });
        }
        catch (error) {
            console.log(error);
            res.status(500).send(String(error));
        }
    });

    // Delete name and revoke credential (session-based)
    router.delete('/api/profile/:did/name', isAuthenticated, async (req: Request, res: Response) => {
        try {
            const did = req.params.did as string;

            if (!req.session.user || req.session.user.did !== did) {
                res.status(403).json({ message: 'Forbidden' });
                return;
            }

            const user = await ctx.db.getUser(did);
            if (!user) {
                res.status(404).send('Not found');
                return;
            }

            const deletedName = user.name;

            await revokeCredential(user, deletedName || '');
            delete user.name;
            await ctx.db.setUser(did, user);

            res.json({ ok: true, message: `name '${deletedName}' deleted and credential revoked` });
        }
        catch (error) {
            console.log(error);
            res.status(500).send(String(error));
        }
    });

    // Stateless name claim (Bearer token auth)
    router.put('/api/name', async (req: Request, res: Response) => {
        try {
            const did = await verifyBearerToken(req);
            if (!did) {
                res.status(401).json({ ok: false, message: 'Valid Bearer token (response DID) required' });
                return;
            }

            const validation = validateName(req.body.name);
            if (!validation.ok) {
                res.status(400).json({ ok: false, message: validation.message });
                return;
            }
            const trimmedName = validation.trimmedName!;

            const user = await ensureUser(did);

            if (!(await checkNameAvailability(trimmedName, did))) {
                res.status(409).json({ ok: false, message: 'Name already taken' });
                return;
            }

            user.name = trimmedName;
            await issueOrUpdateCredential(did, user, trimmedName);
            await ctx.db.setUser(did, user);

            let credential = null;
            if (user.credentialDid) {
                credential = await ctx.keymaster.getCredential(user.credentialDid);
            }

            res.json({
                ok: true,
                name: trimmedName,
                did,
                credentialDid: user.credentialDid,
                credentialIssuedAt: user.credentialIssuedAt,
                credential,
            });
        }
        catch (error) {
            console.log(error);
            res.status(500).send(String(error));
        }
    });

    // Stateless name delete (Bearer token auth)
    router.delete('/api/name', async (req: Request, res: Response) => {
        try {
            const did = await verifyBearerToken(req);
            if (!did) {
                res.status(401).json({ ok: false, message: 'Valid Bearer token (response DID) required' });
                return;
            }

            const user = await ctx.db.getUser(did);
            if (!user) {
                res.status(404).json({ ok: false, message: 'User not found' });
                return;
            }

            const deletedName = user.name;

            if (!deletedName) {
                res.status(404).json({ ok: false, message: 'No name to delete' });
                return;
            }

            await revokeCredential(user, deletedName);
            delete user.name;
            await ctx.db.setUser(did, user);

            res.json({ ok: true, message: `name '${deletedName}' deleted and credential revoked` });
        }
        catch (error) {
            console.log(error);
            res.status(500).send(String(error));
        }
    });

    // Export name registry for IPNS publication
    router.get('/api/registry', async (_: Request, res: Response) => {
        try {
            res.json(buildRegistry(await listUsers()));
        }
        catch (error) {
            console.log(error);
            res.status(500).send(String(error));
        }
    });

    // Resolve a name to a DID
    router.get('/api/name/:name', async (req: Request, res: Response) => {
        try {
            const name = (req.params.name as string).trim().toLowerCase();
            const did = await findNameDid(name);
            if (did) {
                res.json({ name, did });
                return;
            }

            res.status(404).json({ error: 'Name not found' });
        }
        catch (error) {
            console.log(error);
            res.status(500).send(String(error));
        }
    });

    // Public directory.json - same as /api/registry for IPNS compatibility
    router.get('/directory.json', async (_: Request, res: Response) => {
        try {
            res.json(buildRegistry(await listUsers()));
        }
        catch (error) {
            console.log(error);
            res.status(500).send(String(error));
        }
    });

    // Resolve a member name to their DID document
    // Public API endpoint for member lookup
    router.get('/api/member/:name', async (req: Request, res: Response) => {
        try {
            const name = (req.params.name as string).trim().toLowerCase();
            const memberDid = await findNameDid(name);
            if (!memberDid) {
                res.status(404).json({ error: 'Name not found', name });
                return;
            }

            // Fetch DID document from gatekeeper
            const didDoc = await ctx.keymaster.resolveDID(memberDid);

            // Reported alongside the document rather than inside it: the
            // manifest is part of didDocumentData, and annotating a resolved
            // DID document with fields of our own is the conformance mistake
            // #676 removed.
            const manifest = (didDoc.didDocumentData as { manifest?: Record<string, any> })?.manifest ?? {};
            const credentialStatus: Record<string, CredentialCheck> = {};

            for (const [credentialDid, vc] of Object.entries(manifest)) {
                credentialStatus[credentialDid] = await checkManifestCredential(ctx.keymaster, credentialDid, vc);
            }

            res.json({ ...didDoc, credentialStatus });
        }
        catch (error: any) {
            console.log(error);
            res.status(500).json({ error: error.message || String(error) });
        }
    });

    // Resolve a member name to their avatar image
    router.get('/api/name/:name/avatar', async (req: Request, res: Response) => {
        try {
            const name = (req.params.name as string).trim().toLowerCase();
            const avatar = await resolveAvatarImage(name);

            if (!avatar) {
                res.status(404).json({ error: 'Avatar not found', name });
                return;
            }

            res.set('X-Content-Type-Options', 'nosniff');
            res.set('Content-Type', getSafeAvatarContentType(avatar.file.type));
            res.set('Content-Length', String(avatar.file.data.length));
            if (avatar.file.filename) {
                res.set('Content-Disposition', `inline; filename="${encodeURIComponent(avatar.file.filename)}"`);
            }

            res.send(avatar.file.data);
        }
        catch (error: any) {
            console.log(error);
            res.status(500).json({ error: error.message || String(error) });
        }
    });


    // Admin: Delete a user
    router.delete('/api/admin/user/:did', isOwner, async (req: Request, res: Response) => {
        try {
            const did = decodeURIComponent(req.params.did as string);
            const user = await ctx.db.getUser(did);
            if (!user) {
                res.status(404).json({ error: 'User not found' });
                return;
            }

            // Don't allow deleting the owner
            if (did === OWNER_DID) {
                res.status(403).json({ error: 'Cannot delete the owner account' });
                return;
            }

            const userName = user.name || did;
            await ctx.db.deleteUser(did);

            console.log(`Deleted user ${userName} (${did})`);
            res.json({ ok: true, message: `User ${userName} deleted` });
        }
        catch (error: any) {
            console.log(error);
            res.status(500).json({ error: error.message || String(error) });
        }
    });

    // Get member's credential
    router.get('/api/credential', isAuthenticated, async (req: Request, res: Response) => {
        try {
            const userDid = req.session.user?.did;
            if (!userDid) {
                res.status(401).json({ error: 'Not authenticated' });
                return;
            }

            const user = await ctx.db.getUser(userDid);

            if (!user) {
                res.status(404).json({ error: 'User not found' });
                return;
            }

            if (!user.credentialDid) {
                res.json({
                    hasCredential: false,
                    name: user.name || null,
                    message: 'No credential issued yet'
                });
                return;
            }

            // Fetch the credential
            const credential = await ctx.keymaster.getCredential(user.credentialDid);

            res.json({
                hasCredential: true,
                credentialDid: user.credentialDid,
                credentialIssuedAt: user.credentialIssuedAt,
                credential
            });
        }
        catch (error: any) {
            console.log(error);
            const errorMsg = error?.message || error?.error || (typeof error === 'string' ? error : JSON.stringify(error));
            res.status(500).json({ error: errorMsg });
        }
    });


    // LUD16 Lightning Address support
    const LN_MIN_SENDABLE = 1000;        // 1 sat in msats
    const LN_MAX_SENDABLE = 100000000000; // 100k sats in msats

    router.get('/.well-known/lnurlp/:name', async (req: Request, res: Response) => {
        try {
            const name = (req.params.name as string).trim().toLowerCase();
            const result = await resolveLightningEndpoint(name);

            if (!result) {
                res.json({ status: 'ERROR', reason: 'No Lightning service found for this name' });
                return;
            }

            const metadata = JSON.stringify([
                ['text/plain', `Payment to ${name}@${SERVICE_DOMAIN}`],
                ['text/identifier', `${name}@${SERVICE_DOMAIN}`]
            ]);

            res.json({
                tag: 'payRequest',
                callback: `${PUBLIC_URL}/api/lnurlp/${name}/callback`,
                minSendable: LN_MIN_SENDABLE,
                maxSendable: LN_MAX_SENDABLE,
                metadata,
            });
        }
        catch (error: any) {
            console.log(error);
            res.json({ status: 'ERROR', reason: error.message || 'Internal error' });
        }
    });

    router.get('/api/lnurlp/:name/callback', async (req: Request, res: Response) => {
        try {
            const name = (req.params.name as string).trim().toLowerCase();
            const amount = parseInt(req.query.amount as string, 10);

            if (!amount || amount < LN_MIN_SENDABLE || amount > LN_MAX_SENDABLE) {
                res.json({ status: 'ERROR', reason: `Amount must be between ${LN_MIN_SENDABLE} and ${LN_MAX_SENDABLE} msats` });
                return;
            }

            const result = await resolveLightningEndpoint(name);
            if (!result) {
                res.json({ status: 'ERROR', reason: 'No Lightning service found for this name' });
                return;
            }

            // LUD16 amount is in millisatoshis, convert to satoshis for Lightning endpoint
            const amountSats = Math.floor(amount / 1000);
            const invoiceUrl = `${result.endpoint}?amount=${amountSats}`;
            const fetchOptions: any = {};

            if (result.endpoint.includes('.onion') && TOR_PROXY) {
                const [host, port] = TOR_PROXY.split(':');
                fetchOptions.dispatcher = socksDispatcher({
                    type: 5,
                    host: host || 'localhost',
                    port: parseInt(port || '9050'),
                });
            }

            // Only the SOCKS-dispatched path needs undici's fetch; clearnet stays
            // on the built-in one, which the rest of this service uses (#916).
            const doFetch = fetchOptions.dispatcher ? socksEgress.fetch : fetch;
            const response = await doFetch(invoiceUrl, fetchOptions);
            if (!response.ok) {
                res.json({ status: 'ERROR', reason: 'Lightning service returned an error' });
                return;
            }

            const data: any = await response.json();

            // Normalize to LUD06 format (pr + routes)
            res.json({
                pr: data.pr || data.paymentRequest,
                routes: data.routes || [],
            });
        }
        catch (error: any) {
            console.log(error);
            res.json({ status: 'ERROR', reason: error.message || 'Internal error' });
        }
    });

    // ── Well-Known Endpoints (Issue #4) ─────────────────────────────────

    // GET /.well-known/names — list/directory of registered names
    router.get('/.well-known/names', async (_: Request, res: Response) => {
        try {
            res.json(buildRegistry(await listUsers()));
        }
        catch (error) {
            console.log(error);
            res.status(500).send(String(error));
        }
    });

    // GET /.well-known/names/:name — resolve a name to a DID
    router.get('/.well-known/names/:name', async (req: Request, res: Response) => {
        try {
            const name = (req.params.name as string).trim().toLowerCase();
            const did = await findNameDid(name);

            if (!did) {
                res.status(404).json({ error: 'Name not found' });
                return;
            }

            res.json({ name, did });
        }
        catch (error) {
            console.log(error);
            res.status(500).send(String(error));
        }
    });

    // GET /.well-known/webfinger — RFC 7033 WebFinger discovery
    router.get('/.well-known/webfinger', async (req: Request, res: Response) => {
        try {
            const resource = req.query.resource as string;

            if (!resource) {
                res.status(400).json({ error: 'Missing required "resource" query parameter' });
                return;
            }

            // Parse acct: URI — expect "acct:name@domain"
            const acctMatch = resource.match(/^acct:([^@]+)@(.+)$/);
            if (!acctMatch) {
                res.status(400).json({ error: 'Resource must be in "acct:name@domain" format' });
                return;
            }

            const [, name, domain] = acctMatch;

            // Verify the domain matches this service
            if (SERVICE_DOMAIN && domain !== SERVICE_DOMAIN) {
                res.status(404).json({ error: 'Unknown domain' });
                return;
            }

            const did = await findNameDid(name);
            if (!did) {
                res.status(404).json({ error: 'Name not found' });
                return;
            }

            const jrd: any = {
                subject: resource,
                aliases: [did],
                links: [
                    {
                        rel: 'self',
                        type: 'application/activity+json',
                        href: `${PUBLIC_URL}/api/name/${name}`,
                    },
                    {
                        rel: 'http://webfinger.net/rel/profile-page',
                        type: 'text/html',
                        // Must match a route the client actually serves. `/name/:name`
                        // is not one — it fell through to the SPA's catch-all and
                        // redirected to the home page.
                        href: `${PUBLIC_URL}/id/${name}`,
                    },
                    {
                        rel: 'https://w3id.org/did',
                        type: 'application/json',
                        href: `https://${SERVICE_DOMAIN}/api/v1/did/${did}`,
                    },
                    {
                        rel: 'http://webfinger.net/rel/avatar',
                        href: `${PUBLIC_URL}/api/name/${name}/avatar`,
                    },
                ],
            };

            res.set('Content-Type', 'application/jrd+json');
            res.json(jrd);
        }
        catch (error) {
            console.log(error);
            res.status(500).send(String(error));
        }
    });

    process.on('uncaughtException', (error) => {
        console.error('Unhandled exception caught', error);
    });

    process.on('unhandledRejection', (reason, promise) => {
        console.error('Unhandled rejection at:', promise, 'reason:', reason);
    });

    const DMAIL_POLL_INTERVAL_MS = 60_000; // 1 minute

    async function pollDmailForEmail(): Promise<void> {
        if (!ctx.emailBridge?.isConfigured()) return;

        try {
            await ctx.keymaster.setCurrentId(SERVICE_NAME);
            await ctx.keymaster.refreshNotices();

            const dmails = await ctx.keymaster.listDmail();
            for (const [dmailDid, item] of Object.entries(dmails)) {
                if (!item.tags.includes('unread')) continue;

                // Resolve sender info (shared by both paths)
                const rawSender = typeof item.sender === 'string' ? item.sender : 'Unknown';
                const isDid = rawSender.startsWith('did:');
                let senderName: string;
                let fromEmail: string;

                if (isDid) {
                    const senderUser = await ctx.db.getUser(rawSender);
                    if (senderUser?.name) {
                        senderName = senderUser.name;
                        fromEmail = `${senderName}@${SERVICE_DOMAIN}`;
                    } else {
                        senderName = 'dmail-user';
                        fromEmail = SENDGRID_FROM_EMAIL;
                    }
                } else {
                    senderName = rawSender;
                    fromEmail = `${senderName}@${SERVICE_DOMAIN}`;
                }

                // Path 1: Reply to a bridged email (has reference matching a stored mapping)
                if (item.message.reference) {
                    const mapping = await ctx.emailBridge.lookupEmailMapping(item.message.reference);
                    if (mapping) {
                        await ctx.emailBridge.sendEmail({
                            to: mapping.emailAddress,
                            subject: item.message.subject,
                            body: item.message.body,
                            senderName,
                            senderDid: mapping.recipientDid,
                            dmailDid,
                            fromEmail,
                        });
                        await ctx.keymaster.fileDmail(dmailDid, ['inbox']);
                        console.log(`Forwarded reply dmail ${dmailDid} from ${senderName} to ${mapping.emailAddress}`);
                        continue;
                    }
                }

                // Path 2: Compose new email via "[email to addr] subject" convention
                if (ctx.serviceDID && (item.message.to.includes(ctx.serviceDID) || (item.message.cc ?? []).includes(ctx.serviceDID))) {
                    const emailToMatch = item.message.subject.match(/^\[email to ([^\]]+)\]\s*(.*)/i);
                    if (emailToMatch) {
                        const toEmail = emailToMatch[1].trim();
                        const realSubject = emailToMatch[2] || '(no subject)';

                        await ctx.emailBridge.sendEmail({
                            to: toEmail,
                            subject: realSubject,
                            body: item.message.body,
                            senderName,
                            senderDid: rawSender,
                            dmailDid,
                            fromEmail,
                        });
                        await ctx.keymaster.fileDmail(dmailDid, ['inbox']);
                        console.log(`Composed email from ${senderName} to ${toEmail}: ${realSubject}`);
                        continue;
                    }
                }
            }
        } catch (error) {
            console.error('Dmail poll error:', error);
        }
    }

    let dmailPollInFlight = false;

    function startDmailPollLoop(): void {
        console.log(`${SERVICE_NAME} dmail poll loop started (interval: ${DMAIL_POLL_INTERVAL_MS / 1000}s)`);

        const runPoll = async () => {
            if (dmailPollInFlight) return;
            dmailPollInFlight = true;
            try {
                await pollDmailForEmail();
            } finally {
                dmailPollInFlight = false;
            }
        };

        // Initial poll after a short delay to let startup finish
        setTimeout(() => {
            runPoll();
            setInterval(runPoll, DMAIL_POLL_INTERVAL_MS);
        }, 5000);
    }


    return { router, startDmailPollLoop };
}
