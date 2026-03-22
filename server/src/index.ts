import express, {
    Request,
    Response,
    NextFunction
} from 'express';
import session from 'express-session';
import morgan from 'morgan';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import cors from 'cors';
import { socksDispatcher } from 'fetch-socks';

import CipherNode from '@didcid/cipher/node';
import GatekeeperClient from '@didcid/gatekeeper/client';
import Keymaster from '@didcid/keymaster';
import KeymasterClient from '@didcid/keymaster/client';
import WalletJson from '@didcid/keymaster/wallet/json';
import { DatabaseInterface, User } from './db/interfaces.js';
import { DbJson } from './db/json.js';
import { DbSqlite } from './db/sqlite.js';
import { createOAuthRoutes } from './oauth/index.js';

let keymaster: Keymaster | KeymasterClient;
let db: DatabaseInterface;

dotenv.config();

const HOST_PORT = Number(process.env.NS_HOST_PORT) || 3300;
const GATEKEEPER_URL = process.env.NS_GATEKEEPER_URL || 'http://localhost:4224';
const WALLET_URL = process.env.NS_WALLET_URL || 'http://localhost:4224';
const NS_DATABASE_TYPE = process.env.NS_DATABASE || 'json';
const IPFS_API_URL = process.env.NS_IPFS_API_URL || 'http://localhost:5001/api/v0';
const SERVICE_NAME = process.env.NS_SERVICE_NAME || 'name-service';
const PUBLIC_URL = process.env.NS_PUBLIC_URL || `http://localhost:${HOST_PORT}`;
const SERVICE_DOMAIN = process.env.NS_SERVICE_DOMAIN || '';
const SESSION_SECRET = process.env.NS_SESSION_SECRET || SERVICE_NAME;
const IPNS_KEY_NAME = process.env.NS_IPNS_KEY_NAME || SERVICE_NAME;
const MEMBERSHIP_SCHEMA_DID = process.env.NS_MEMBERSHIP_SCHEMA_DID || '';
const TOR_PROXY = process.env.NS_TOR_PROXY || '';

const app = express();
const logins: Record<string, {
    response: string;
    challenge: string;
    did: string;
    verify: any;
}> = {};

app.use(morgan('dev'));
app.use(express.json());

// Session setup
app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false } // Set to true if using HTTPS
}));

let serviceDID = '';
const OWNER_DID = process.env.NS_OWNER_DID || '';

async function initServiceIdentity(): Promise<void> {
    const currentId = await keymaster.getCurrentId();

    try {
        const docs = await keymaster.resolveDID(SERVICE_NAME);
        if (!docs.didDocument?.id) {
            throw new Error('No DID found');
        }
        serviceDID = docs.didDocument.id;
        console.log(`${SERVICE_NAME}: ${serviceDID}`);
    }
    catch (error) {
        console.log(`Creating ID ${SERVICE_NAME}`);
        serviceDID = await keymaster.createId(SERVICE_NAME);
    }

    await keymaster.setCurrentId(SERVICE_NAME);

    if (!OWNER_DID) {
        console.warn('Warning: NS_OWNER_DID not set — no user will have owner access');
    } else {
        console.log(`Owner: ${OWNER_DID}`);
    }

    if (currentId) {
        await keymaster.setCurrentId(currentId);
    }
}

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

function checkNameAvailability(currentDb: any, trimmedName: string, excludeDid?: string): boolean {
    if (!currentDb.users) return true;
    for (const [existingDid, user] of Object.entries(currentDb.users) as [string, any][]) {
        if (existingDid !== excludeDid && user.name?.toLowerCase() === trimmedName) {
            return false;
        }
    }
    return true;
}

async function issueOrUpdateCredential(did: string, user: any, trimmedName: string): Promise<void> {
    await keymaster.setCurrentId(SERVICE_NAME);

    if (user.credentialDid) {
        const vc: any = await keymaster.getCredential(user.credentialDid);
        if (!vc) throw new Error('Failed to fetch existing credential');
        vc.credentialSubject.name = `${trimmedName}@${SERVICE_DOMAIN}`;
        vc.validFrom = new Date().toISOString();
        const updated = await keymaster.updateCredential(user.credentialDid, vc);
        if (!updated) throw new Error('Failed to update credential');
        user.credentialIssuedAt = new Date().toISOString();
        console.log(`Updated credential ${user.credentialDid} for ${trimmedName}`);
    } else {
        const boundCredential = await keymaster.bindCredential(did, {
            schema: MEMBERSHIP_SCHEMA_DID,
            validFrom: new Date().toISOString(),
            claims: { name: `${trimmedName}@${SERVICE_DOMAIN}` }
        });
        const credentialDid = await keymaster.issueCredential(boundCredential);
        user.credentialDid = credentialDid;
        user.credentialIssuedAt = new Date().toISOString();
        console.log(`Issued new credential ${credentialDid} for ${trimmedName}`);
    }
}

async function revokeCredential(user: any, name: string): Promise<void> {
    if (user.credentialDid) {
        try {
            await keymaster.setCurrentId(SERVICE_NAME);
            await keymaster.revokeCredential(user.credentialDid);
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
    const verify = await keymaster.verifyResponse(response, { retries: 10 });
    if (!verify.match || !verify.responder) return null;
    return verify.responder;
}

function ensureUser(currentDb: any, did: string): any {
    if (!currentDb.users) currentDb.users = {};
    const now = new Date().toISOString();
    if (!currentDb.users[did]) {
        currentDb.users[did] = { firstLogin: now, lastLogin: now, logins: 1 };
    }
    return currentDb.users[did];
}

function findNameDid(name: string): string | null {
    const currentDb = db.loadDb();
    if (!currentDb.users) return null;
    for (const [did, user] of Object.entries(currentDb.users)) {
        if (user.name?.toLowerCase() === name.toLowerCase()) {
            return did;
        }
    }
    return null;
}

async function resolveLightningEndpoint(name: string): Promise<{ did: string; endpoint: string } | null> {
    const did = findNameDid(name);
    if (!did) return null;

    const didDoc: any = await keymaster.resolveDID(did);
    if (!didDoc?.didDocument?.service) return null;

    const lightning = didDoc.didDocument.service.find(
        (s: any) => s.type === 'Lightning' || s.id?.endsWith('#lightning')
    );
    if (!lightning?.serviceEndpoint) return null;

    return { did, endpoint: lightning.serviceEndpoint };
}

function isAuthenticated(req: Request, res: Response, next: NextFunction): void {
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
    const verify = await keymaster.verifyResponse(response, { retries: 10 });

    if (verify.match) {
        const challenge = verify.challenge;
        const did = verify.responder!;
        const currentDb = db.loadDb();

        if (!currentDb.users) {
            currentDb.users = {};
        }

        const now = new Date().toISOString();

        if (currentDb.users[did]) {
            currentDb.users[did].lastLogin = now;
            currentDb.users[did].logins = (currentDb.users[did].logins || 0) + 1;
        }
        else {
            currentDb.users[did] = {
                firstLogin: now,
                lastLogin: now,
                logins: 1,
            }
        }

        db.writeDb(currentDb);

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

app.use(cors(corsOptions));

app.options('/api/{*path}', cors(corsOptions));
app.options('/.well-known/{*path}', cors(corsOptions));

// Helper function for OAuth
async function getMemberByDID(did: string): Promise<any> {
    const currentDb = db.loadDb();
    if (currentDb.users && currentDb.users[did]) {
        return {
            ...currentDb.users[did],
            did,
            handle: currentDb.users[did].name
        };
    }
    return null;
}

// Mount OAuth routes (keymaster accessed lazily)
const oauthRouter = createOAuthRoutes(() => keymaster, getMemberByDID);
app.use('/oauth', oauthRouter);
console.log('OAuth routes mounted at /oauth');

app.get('/api/version', async (_: Request, res: Response) => {
    try {
        res.json(1);
    } catch (error) {
        console.log(error);
        res.status(500).send(String(error));
    }
});

app.get('/api/config', (_: Request, res: Response) => {
    res.json({
        serviceName: SERVICE_NAME,
        serviceDomain: SERVICE_DOMAIN,
        publicUrl: PUBLIC_URL,
    });
});

app.get('/api/challenge', async (req: Request, res: Response) => {
    try {
        const challenge = await keymaster.createChallenge({
            // @ts-ignore
            callback: `${PUBLIC_URL}/api/login`
        });
        req.session.challenge = challenge;
        const challengeURL = `${WALLET_URL}?challenge=${challenge}`;

        const doc = await keymaster.resolveDID(challenge);
        console.log(JSON.stringify(doc, null, 4));
        res.json({ challenge, challengeURL });
    } catch (error) {
        console.log(error);
        res.status(500).send(String(error));
    }
});

app.get('/api/login', cors(corsOptions), async (req: Request, res: Response) => {
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

app.post('/api/login', cors(corsOptions), async (req: Request, res: Response) => {
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

app.post('/api/logout', async (req: Request, res: Response) => {
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

app.get('/api/check-auth', async (req: Request, res: Response) => {
    try {
        if (!req.session.user && req.session.challenge) {
            const challengeData = logins[req.session.challenge];
            if (challengeData) {
                req.session.user = { did: challengeData.did };
            }
        }

        const isAuthenticated = !!req.session.user;
        const userDID = isAuthenticated ? req.session.user?.did : null;
        const currentDb = db.loadDb();

        let profile: any = null;

        if (isAuthenticated && userDID && currentDb.users) {
            profile = currentDb.users[userDID] || null;
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

app.get('/api/users', isAuthenticated, async (_: Request, res: Response) => {
    try {
        const currentDb = db.loadDb();
        const users = currentDb.users ? Object.keys(currentDb.users) : [];
        res.json(users);
    }
    catch (error) {
        console.log(error);
        res.status(500).send(String(error));
    }
});

app.get('/api/admin', isOwner, async (_: Request, res: Response) => {
    try {
        res.json(db.loadDb());
    }
    catch (error) {
        console.log(error);
        res.status(500).send(String(error));
    }
});

// Publish registry to IPFS and update IPNS
app.post('/api/admin/publish', isOwner, async (_: Request, res: Response) => {
    try {
        // Build registry from DB
        const currentDb = db.loadDb();
        const names: Record<string, string> = {};

        if (currentDb.users) {
            for (const [did, user] of Object.entries(currentDb.users)) {
                if (user.name) {
                    names[user.name] = did;
                }
            }
        }

        const registry = {
            version: 1,
            updated: new Date().toISOString(),
            names
        };

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

app.get('/api/profile/:did', isAuthenticated, async (req: Request, res: Response) => {
    try {
        const did = req.params.did as string;
        const currentDb = db.loadDb();

        if (!currentDb.users || !currentDb.users[did]) {
            res.status(404).send('Not found');
            return;
        }

        const profile: User = { ...currentDb.users[did] };

        profile.did = did;
        profile.isUser = (req.session?.user?.did === did);

        res.json(profile);
    }
    catch (error) {
        console.log(error);
        res.status(500).send(String(error));
    }
});

app.get('/api/profile/:did/name', isAuthenticated, async (req: Request, res: Response) => {
    try {
        const did = req.params.did as string;
        const currentDb = db.loadDb();

        if (!currentDb.users || !currentDb.users[did]) {
            res.status(404).send('Not found');
            return;
        }

        const profile = currentDb.users[did];
        res.json({ name: profile.name });
    }
    catch (error) {
        console.log(error);
        res.status(500).send(String(error));
    }
});

app.put('/api/profile/:did/name', isAuthenticated, async (req: Request, res: Response) => {
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

        const currentDb = db.loadDb();
        if (!currentDb.users || !currentDb.users[did]) {
            res.status(404).send('Not found');
            return;
        }

        if (!checkNameAvailability(currentDb, trimmedName, did)) {
            res.status(409).json({ ok: false, message: 'Name already taken' });
            return;
        }

        const user = currentDb.users[did];
        user.name = trimmedName;
        await issueOrUpdateCredential(did, user, trimmedName);
        db.writeDb(currentDb);

        res.json({ ok: true, message: `name set to ${trimmedName}` });
    }
    catch (error) {
        console.log(error);
        res.status(500).send(String(error));
    }
});

// Delete name and revoke credential (session-based)
app.delete('/api/profile/:did/name', isAuthenticated, async (req: Request, res: Response) => {
    try {
        const did = req.params.did as string;

        if (!req.session.user || req.session.user.did !== did) {
            res.status(403).json({ message: 'Forbidden' });
            return;
        }

        const currentDb = db.loadDb();
        if (!currentDb.users || !currentDb.users[did]) {
            res.status(404).send('Not found');
            return;
        }

        const user = currentDb.users[did];
        const deletedName = user.name;

        await revokeCredential(user, deletedName || '');
        delete user.name;
        db.writeDb(currentDb);

        res.json({ ok: true, message: `name '${deletedName}' deleted and credential revoked` });
    }
    catch (error) {
        console.log(error);
        res.status(500).send(String(error));
    }
});

// Stateless name claim (Bearer token auth)
app.put('/api/name', async (req: Request, res: Response) => {
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

        const currentDb = db.loadDb();
        const user = ensureUser(currentDb, did);

        if (!checkNameAvailability(currentDb, trimmedName, did)) {
            res.status(409).json({ ok: false, message: 'Name already taken' });
            return;
        }

        user.name = trimmedName;
        await issueOrUpdateCredential(did, user, trimmedName);
        db.writeDb(currentDb);

        let credential = null;
        if (user.credentialDid) {
            credential = await keymaster.getCredential(user.credentialDid);
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
app.delete('/api/name', async (req: Request, res: Response) => {
    try {
        const did = await verifyBearerToken(req);
        if (!did) {
            res.status(401).json({ ok: false, message: 'Valid Bearer token (response DID) required' });
            return;
        }

        const currentDb = db.loadDb();
        if (!currentDb.users?.[did]) {
            res.status(404).json({ ok: false, message: 'User not found' });
            return;
        }

        const user = currentDb.users[did];
        const deletedName = user.name;

        if (!deletedName) {
            res.status(404).json({ ok: false, message: 'No name to delete' });
            return;
        }

        await revokeCredential(user, deletedName);
        delete user.name;
        db.writeDb(currentDb);

        res.json({ ok: true, message: `name '${deletedName}' deleted and credential revoked` });
    }
    catch (error) {
        console.log(error);
        res.status(500).send(String(error));
    }
});

// Export name registry for IPNS publication
app.get('/api/registry', async (_: Request, res: Response) => {
    try {
        const currentDb = db.loadDb();
        const names: Record<string, string> = {};

        if (currentDb.users) {
            for (const [did, user] of Object.entries(currentDb.users)) {
                if (user.name) {
                    names[user.name] = did;
                }
            }
        }

        const registry = {
            version: 1,
            updated: new Date().toISOString(),
            names
        };

        res.json(registry);
    }
    catch (error) {
        console.log(error);
        res.status(500).send(String(error));
    }
});

// Resolve a name to a DID
app.get('/api/name/:name', async (req: Request, res: Response) => {
    try {
        const name = (req.params.name as string).trim().toLowerCase();
        const currentDb = db.loadDb();

        if (currentDb.users) {
            for (const [did, user] of Object.entries(currentDb.users)) {
                if (user.name?.toLowerCase() === name) {
                    res.json({ name, did });
                    return;
                }
            }
        }

        res.status(404).json({ error: 'Name not found' });
    }
    catch (error) {
        console.log(error);
        res.status(500).send(String(error));
    }
});

// Public directory.json - same as /api/registry for IPNS compatibility
app.get('/directory.json', async (_: Request, res: Response) => {
    try {
        const currentDb = db.loadDb();
        const names: Record<string, string> = {};

        if (currentDb.users) {
            for (const [did, user] of Object.entries(currentDb.users)) {
                if (user.name) {
                    names[user.name] = did;
                }
            }
        }

        const registry = {
            version: 1,
            updated: new Date().toISOString(),
            names
        };

        res.json(registry);
    }
    catch (error) {
        console.log(error);
        res.status(500).send(String(error));
    }
});

// Resolve a member name to their DID document
// Public API endpoint for member lookup
app.get('/api/member/:name', async (req: Request, res: Response) => {
    try {
        const name = (req.params.name as string).trim().toLowerCase();
        const currentDb = db.loadDb();

        let memberDid: string | null = null;

        if (currentDb.users) {
            for (const [did, user] of Object.entries(currentDb.users)) {
                if (user.name?.toLowerCase() === name) {
                    memberDid = did;
                    break;
                }
            }
        }

        if (!memberDid) {
            res.status(404).json({ error: 'Name not found', name });
            return;
        }

        // Fetch DID document from gatekeeper
        const didDoc = await keymaster.resolveDID(memberDid);

        res.json(didDoc);
    }
    catch (error: any) {
        console.log(error);
        res.status(500).json({ error: error.message || String(error) });
    }
});


// Admin: Delete a user
app.delete('/api/admin/user/:did', isOwner, async (req: Request, res: Response) => {
    try {
        const did = decodeURIComponent(req.params.did as string);
        const currentDb = db.loadDb();

        if (!currentDb.users || !currentDb.users[did]) {
            res.status(404).json({ error: 'User not found' });
            return;
        }

        // Don't allow deleting the owner
        if (did === OWNER_DID) {
            res.status(403).json({ error: 'Cannot delete the owner account' });
            return;
        }

        const userName = currentDb.users[did].name || did;
        delete currentDb.users[did];
        db.writeDb(currentDb);

        console.log(`Deleted user ${userName} (${did})`);
        res.json({ ok: true, message: `User ${userName} deleted` });
    }
    catch (error: any) {
        console.log(error);
        res.status(500).json({ error: error.message || String(error) });
    }
});

// Get member's credential
app.get('/api/credential', isAuthenticated, async (req: Request, res: Response) => {
    try {
        const userDid = req.session.user?.did;
        if (!userDid) {
            res.status(401).json({ error: 'Not authenticated' });
            return;
        }

        const currentDb = db.loadDb();
        const user = currentDb.users?.[userDid];

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
        const credential = await keymaster.getCredential(user.credentialDid);

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

app.get('/.well-known/lnurlp/:name', async (req: Request, res: Response) => {
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

app.get('/api/lnurlp/:name/callback', async (req: Request, res: Response) => {
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

        const response = await fetch(invoiceUrl, fetchOptions);
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
app.get('/.well-known/names', async (_: Request, res: Response) => {
    try {
        const currentDb = db.loadDb();
        const names: Record<string, string> = {};

        if (currentDb.users) {
            for (const [did, user] of Object.entries(currentDb.users)) {
                if (user.name) {
                    names[user.name] = did;
                }
            }
        }

        res.json({
            version: 1,
            updated: new Date().toISOString(),
            names
        });
    }
    catch (error) {
        console.log(error);
        res.status(500).send(String(error));
    }
});

// GET /.well-known/names/:name — resolve a name to a DID
app.get('/.well-known/names/:name', async (req: Request, res: Response) => {
    try {
        const name = (req.params.name as string).trim().toLowerCase();
        const did = findNameDid(name);

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

// PUT /.well-known/names/:name — register/claim a name (requires Bearer DID auth)
app.put('/.well-known/names/:name', async (req: Request, res: Response) => {
    try {
        const did = await verifyBearerToken(req);
        if (!did) {
            res.status(401).json({ ok: false, message: 'Valid Bearer token (response DID) required' });
            return;
        }

        const validation = validateName(req.params.name);
        if (!validation.ok) {
            res.status(400).json({ ok: false, message: validation.message });
            return;
        }
        const trimmedName = validation.trimmedName!;

        const currentDb = db.loadDb();
        const user = ensureUser(currentDb, did);

        if (!checkNameAvailability(currentDb, trimmedName, did)) {
            res.status(409).json({ ok: false, message: 'Name already taken' });
            return;
        }

        user.name = trimmedName;
        await issueOrUpdateCredential(did, user, trimmedName);
        db.writeDb(currentDb);

        let credential = null;
        if (user.credentialDid) {
            credential = await keymaster.getCredential(user.credentialDid);
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

// GET /.well-known/webfinger — RFC 7033 WebFinger discovery
app.get('/.well-known/webfinger', async (req: Request, res: Response) => {
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

        const did = findNameDid(name);
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
                    href: `${PUBLIC_URL}/api/member/${name}`,
                },
            ],
        };

        // Add profile page link if service domain is configured
        if (SERVICE_DOMAIN) {
            jrd.links.push({
                rel: 'http://webfinger.net/rel/profile-page',
                type: 'text/html',
                href: `${PUBLIC_URL}/${name}`,
            });
        }

        res.set('Content-Type', 'application/jrd+json');
        res.json(jrd);
    }
    catch (error) {
        console.log(error);
        res.status(500).send(String(error));
    }
});

if (process.env.NS_SERVE_CLIENT !== 'false') {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const clientBuildPath = path.join(__dirname, '../../client/build');
    app.use(express.static(clientBuildPath));

    app.use((req, res) => {
        if (!req.path.startsWith('/api')) {
            res.sendFile(path.join(clientBuildPath, 'index.html'));
        } else {
            console.warn(`Warning: Unhandled API endpoint - ${req.method} ${req.originalUrl}`);
            res.status(404).json({ message: 'Endpoint not found' });
        }
    });
}

process.on('uncaughtException', (error) => {
    console.error('Unhandled exception caught', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled rejection at:', promise, 'reason:', reason);
});

app.listen(HOST_PORT, '0.0.0.0', async () => {
    if (NS_DATABASE_TYPE === 'sqlite') {
        db = new DbSqlite();
    } else {
        db = new DbJson();
    }

    if (db.init) {
        try {
            db.init();
        } catch (e: any) {
            console.error(`Error initialising database: ${e.message}`);
            process.exit(1);
        }
    }

    if (process.env.NS_KEYMASTER_URL) {
        keymaster = new KeymasterClient();
        await keymaster.connect({
            url: process.env.NS_KEYMASTER_URL,
            waitUntilReady: true,
            intervalSeconds: 5,
            chatty: true,
        });
        console.log(`${SERVICE_NAME} using keymaster at ${process.env.NS_KEYMASTER_URL}`);
    }
    else {
        const passphrase = process.env.NS_WALLET_PASSPHRASE;

        if (!passphrase) {
            console.error('Error: NS_WALLET_PASSPHRASE environment variable not set');
            process.exit(1);
        }

        const gatekeeper = new GatekeeperClient();
        await gatekeeper.connect({
            url: GATEKEEPER_URL,
            waitUntilReady: true,
            intervalSeconds: 5,
            chatty: true,
        });
        const wallet = new WalletJson('wallet.json', 'data');
        const cipher = new CipherNode();
        keymaster = new Keymaster({
            gatekeeper,
            wallet,
            cipher,
            passphrase,
        });
        
        // Load existing wallet (decrypt and restore IDs/aliases)
        await keymaster.loadWallet();
        console.log(`${SERVICE_NAME} using gatekeeper at ${GATEKEEPER_URL}`);
    }

    await initServiceIdentity();
    console.log(`${SERVICE_NAME} using wallet at ${WALLET_URL}`);
    console.log(`${SERVICE_NAME} listening on port ${HOST_PORT}`);
});
