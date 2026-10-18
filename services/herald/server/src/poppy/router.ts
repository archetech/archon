import crypto from 'crypto';
import express, { Request, Response, Router } from 'express';
import { AgentDirectory, AgentError, type Agent } from './agents.js';
import { AssertionError, verifyAssertion } from './assertions.js';
import {
    SCOPES,
    authorizationServerMetadata,
    endpoints,
    poppyDocument,
    type PoppyConfig,
} from './config.js';
import { DpopError, verifyDpopProof } from './dpop.js';
import { consentPage, deviceEntryPage, errorPage, pageHeaders } from './pages.js';
import { RateLimiter } from './rate-limit.js';
import {
    PoppyStore,
    hashSecret,
    randomSecret,
    type Grant,
    type Session,
    type SignIn,
} from './store.js';
import { createApiRouter, type PoppyAccounts } from './api.js';

// Personal Agent Protocol (Draft 0.1) Company endpoints for Herald: the token
// endpoint (4.2, 4.4-4.8), revocation (4.9), Direct and Device Sign-In with an
// Archon wallet (4.5, 4.6), and the OpenAPI interface (section 6). Mediated
// Sign-In (4.7) does not apply: Archon accounts have no passwords to submit.

export interface PoppyOptions {
    config: PoppyConfig;
    store: PoppyStore;
    agents: AgentDirectory;
    accounts: PoppyAccounts;
    now?: () => number;
}

export interface PoppyConnection {
    id: string;
    clientId: string;
    name: string;
    domain: string;
    scope: string[];
    createdAt: string;
    lastUsedAt: string;
    expiresAt: string;
}

export interface Poppy {
    router: Router;
    wellKnown: Router;
    listConnections(did: string): Promise<PoppyConnection[]>;
    disconnect(did: string, agentId: string): Promise<boolean>;
}

const JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const DEVICE_CODE = 'urn:ietf:params:oauth:grant-type:device_code';
const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
const PKCE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
const PKCE_S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const MAX_USER_ID_LENGTH = 255;

class OAuthError extends Error {
    constructor(readonly status: number, readonly code: string, description: string, readonly retryAfter?: number) {
        super(description);
    }
}

function sendOAuthError(res: Response, error: OAuthError): void {
    res.set('Cache-Control', 'no-store');
    if (error.retryAfter) {
        res.set('Retry-After', String(error.retryAfter));
    }
    res.status(error.status).json({ error: error.code, error_description: error.message });
}

// Form parameters must appear once; a repeated one parses as an array.
function param(body: Record<string, unknown>, name: string): string | undefined {
    const value = body?.[name];
    if (value === undefined || value === '') {
        return undefined;
    }
    if (typeof value !== 'string') {
        throw new OAuthError(400, 'invalid_request', `${name} must appear once`);
    }
    return value;
}

function required(body: Record<string, unknown>, name: string): string {
    const value = param(body, name);
    if (value === undefined) {
        throw new OAuthError(400, 'invalid_request', `${name} is required`);
    }
    return value;
}

function parseScope(value: string | undefined, allowEmpty = false): string[] {
    if (value === undefined) {
        if (allowEmpty) {
            return [];
        }
        throw new OAuthError(400, 'invalid_scope', 'scope is required');
    }
    const scopes = [...new Set(value.split(' ').filter(Boolean))];
    if (!allowEmpty && scopes.length === 0) {
        throw new OAuthError(400, 'invalid_scope', 'scope is required');
    }
    const unknown = scopes.filter(scope => !Object.hasOwn(SCOPES, scope));
    if (unknown.length) {
        throw new OAuthError(400, 'invalid_scope', `unknown scope ${unknown[0]}`);
    }
    return scopes;
}

function pkceMatches(verifier: string, challenge: string): boolean {
    if (!PKCE_VERIFIER.test(verifier)) {
        return false;
    }
    const computed = Buffer.from(crypto.createHash('sha256').update(verifier).digest('base64url'));
    const expected = Buffer.from(challenge);
    return computed.length === expected.length && crypto.timingSafeEqual(computed, expected);
}

function userCode(): string {
    const bytes = crypto.randomBytes(8);
    const chars = [...bytes].map(byte => USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]);
    return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

function normalizeUserCode(value: unknown): string {
    const letters = String(value ?? '').toUpperCase().replace(/[^A-Z]/g, '');
    return letters.length === 8 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : '';
}

function readCookie(req: Request, name: string): string | undefined {
    for (const part of (req.headers.cookie || '').split(';')) {
        const index = part.indexOf('=');
        if (index > 0 && part.slice(0, index).trim() === name) {
            return decodeURIComponent(part.slice(index + 1).trim());
        }
    }
    return undefined;
}

function sameSecret(secret: string | undefined, hash: string): boolean {
    if (!secret) {
        return false;
    }
    const actual = Buffer.from(hashSecret(secret));
    const expected = Buffer.from(hash);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function createPoppy(options: PoppyOptions): Poppy {
    const { config, store, agents, accounts } = options;
    const now = options.now ?? Date.now;
    const urls = endpoints(config);
    const cookiePath = new URL(config.issuer).pathname;
    const secureCookie = config.issuer.startsWith('https:');

    // Drawbridge limits requests per source address in front of Herald.
    // Herald cannot tell sources apart (it sees Drawbridge, and forwarded
    // headers are caller-controlled), so its own limits are per client_id
    // after authentication, and otherwise global.
    const tokenLimiter = new RateLimiter(300, 60_000, now);
    const newClientLimiter = new RateLimiter(60, 60_000, now);
    const userCodeLimiter = new RateLimiter(60, 60_000, now);
    // Each sign-in page creates a wallet challenge.
    const signInLimiter = new RateLimiter(120, 60_000, now);
    const knownClients = new Set<string>();
    const MAX_KNOWN_CLIENTS = 10_000;

    // Loads an agent's metadata. A client_id not yet verified here spends the
    // new-client budget first, because loading it fetches from the agent.
    async function loadAgent(clientId: string): Promise<Agent> {
        if (!knownClients.has(clientId)) {
            const wait = newClientLimiter.take('new');
            if (wait) {
                throw new OAuthError(429, 'rate_limited', 'too many new client_id values', wait);
            }
        }
        try {
            return await agents.get(clientId);
        }
        catch (error) {
            throw new OAuthError(401, 'invalid_client', error instanceof AgentError ? error.message : 'client metadata could not be loaded');
        }
    }

    function rememberClient(clientId: string): void {
        if (knownClients.size >= MAX_KNOWN_CLIENTS) {
            knownClients.clear();
        }
        knownClients.add(clientId);
    }

    // ---------- client authentication (4.1) ----------

    async function authenticateClient(body: Record<string, unknown>): Promise<Agent> {
        const clientId = required(body, 'client_id');
        if (param(body, 'client_assertion_type') !== CLIENT_ASSERTION_TYPE) {
            throw new OAuthError(401, 'invalid_client', 'private_key_jwt client authentication is required');
        }
        const assertion = required(body, 'client_assertion');

        const agent = await loadAgent(clientId);
        try {
            const { payload } = await verifyAssertion(assertion, agent, agents, config.issuer, store.kv, now);
            if (payload.sub !== clientId) {
                throw new AssertionError('client assertion sub must be the client_id');
            }
        }
        catch (error) {
            throw new OAuthError(401, 'invalid_client', error instanceof Error ? error.message : 'client assertion rejected');
        }

        rememberClient(clientId);
        // Charged only after the signature and replay checks, so nobody else
        // can use up an agent's allowance.
        const wait = tokenLimiter.take(clientId);
        if (wait) {
            throw new OAuthError(429, 'rate_limited', 'too many requests for this client_id', wait);
        }
        return agent;
    }

    async function requireDpop(req: Request): Promise<string> {
        try {
            return await verifyDpopProof({ header: req.headers.dpop, method: 'POST', url: urls.token }, store.kv, now);
        }
        catch (error) {
            throw new OAuthError(400, 'invalid_dpop_proof', error instanceof DpopError ? error.message : 'DPoP proof rejected');
        }
    }

    // ---------- Sessions and tokens ----------

    async function newSession(clientId: string, userId: string): Promise<Session> {
        const session: Session = {
            id: randomSecret('ses_', 16),
            clientId,
            userId,
            createdAt: now(),
            expiresAt: now() + config.sessionSeconds * 1000,
        };
        await store.putSession(session);
        return session;
    }

    async function sessionFor(sessionId: string | undefined, clientId: string, userId?: string): Promise<Session | null> {
        if (sessionId === undefined) {
            return null;
        }
        const session = await store.getSession(sessionId);
        if (!session || session.clientId !== clientId || (userId !== undefined && session.userId !== userId)) {
            throw new OAuthError(400, 'invalid_session', 'the Session has ended or belongs to another Personal Agent or User');
        }
        return session;
    }

    function checkResource(body: Record<string, unknown>): void {
        const resource = param(body, 'resource');
        if (resource !== undefined && resource !== urls.api) {
            throw new OAuthError(400, 'invalid_target', 'unknown resource');
        }
    }

    async function issueSessionToken(session: Session, jkt: string, scope: string[], grant?: Grant) {
        const token = randomSecret('pst_');
        await store.putSessionToken(token, {
            sessionId: session.id,
            clientId: session.clientId,
            userId: session.userId,
            jkt,
            scope,
            signedIn: Boolean(grant),
            grantId: grant?.id,
            did: grant?.did,
            expiresAt: now() + config.sessionTokenSeconds * 1000,
        });
        return {
            access_token: token,
            token_type: 'DPoP',
            expires_in: config.sessionTokenSeconds,
            scope: scope.join(' '),
            session_id: session.id,
            signed_in: Boolean(grant),
        };
    }

    const ACCOUNT_MISMATCH = 'this Session is, or was, signed in to a different account';

    async function signInSession(session: Session, grant: Grant): Promise<Session> {
        if (!await store.bindSessionAccount(session, grant.did)) {
            throw new OAuthError(400, 'account_mismatch', ACCOUNT_MISMATCH);
        }
        await store.addGrantSession(grant, session.id);
        if (!await store.setSessionGrant(session, grant.id)) {
            throw new OAuthError(400, 'invalid_session', 'the Session has ended');
        }
        return session;
    }

    // Completes a sign-in: a new Account Token and a signed-in Session Token.
    // The Session is bound to the account before the grant exists, so a
    // request that loses the binding leaves no usable Account Token behind.
    async function completeSignIn(session: Session, agent: Agent, did: string, scope: string[], tokenScope: string[], jkt: string) {
        if (!await store.bindSessionAccount(session, did)) {
            throw new OAuthError(400, 'account_mismatch', ACCOUNT_MISMATCH);
        }
        const accountToken = randomSecret('pat_');
        const grant: Grant = {
            id: randomSecret('grt_', 16),
            tokenHash: hashSecret(accountToken),
            clientId: agent.clientId,
            clientName: agent.metadata.client_name || agent.domain,
            domain: agent.domain,
            userId: session.userId,
            did,
            scope,
            createdAt: now(),
            expiresAt: now() + config.accountTokenSeconds * 1000,
            lastUsedAt: now(),
        };
        await store.putGrant(grant);
        const signedIn = await signInSession(session, grant);
        return {
            ...await issueSessionToken(signedIn, jkt, tokenScope, grant),
            refresh_token: accountToken,
            refresh_token_expires_in: config.accountTokenSeconds,
        };
    }

    // ---------- grant handlers ----------

    // Any token request may ask for fewer scopes than were granted (4.3);
    // the Account Token keeps the granted ones.
    function narrowScope(body: Record<string, unknown>, granted: string[]): string[] {
        const requested = param(body, 'scope');
        if (requested === undefined) {
            return granted;
        }
        const scope = parseScope(requested);
        if (!scope.every(item => granted.includes(item))) {
            throw new OAuthError(400, 'invalid_scope', 'scope can only narrow what was granted');
        }
        return scope;
    }

    async function jwtBearerGrant(req: Request, agent: Agent, jkt: string) {
        const { payload } = await verifyAssertion(param(req.body, 'assertion'), agent, agents, config.issuer, store.kv, now)
            .catch(error => { throw new OAuthError(400, 'invalid_grant', error instanceof Error ? error.message : 'assertion rejected'); });
        const userId = payload.sub;
        if (typeof userId !== 'string' || !userId || userId.length > MAX_USER_ID_LENGTH) {
            throw new OAuthError(400, 'invalid_grant', 'sub must be the User ID');
        }
        const session = await sessionFor(param(req.body, 'session_id'), agent.clientId, userId)
            ?? await newSession(agent.clientId, userId);
        // A signed-in Session is renewed with its Account Token (4.8); the
        // assertion renews it signed out.
        return issueSessionToken(session, jkt, []);
    }

    async function authorizationCodeGrant(req: Request, agent: Agent, jkt: string) {
        const code = required(req.body, 'code');
        const redirectUri = required(req.body, 'redirect_uri');
        const verifier = required(req.body, 'code_verifier');
        const session = await sessionFor(required(req.body, 'session_id'), agent.clientId);
        const record = await store.takeAuthCode(code);
        if (!record || record.clientId !== agent.clientId || record.redirectUri !== redirectUri) {
            throw new OAuthError(400, 'invalid_grant', 'the code is invalid, expired or already used');
        }
        if (!pkceMatches(verifier, record.codeChallenge)) {
            throw new OAuthError(400, 'invalid_grant', 'code_verifier does not match');
        }
        const scope = narrowScope(req.body, record.scope);
        return completeSignIn(session!, agent, record.did, record.scope, scope, jkt);
    }

    async function refreshTokenGrant(req: Request, agent: Agent, jkt: string) {
        const revoked = () => new OAuthError(400, 'invalid_grant', 'the Account Token is invalid, expired or revoked');
        const grant = await store.getGrantByToken(param(req.body, 'refresh_token'));
        if (!grant || grant.clientId !== agent.clientId) {
            throw revoked();
        }
        const scope = narrowScope(req.body, grant.scope);
        const session = await sessionFor(param(req.body, 'session_id'), agent.clientId, grant.userId)
            ?? await newSession(agent.clientId, grant.userId);
        // A revocation may land at any point here. Touching never recreates a
        // deleted grant, and the check after signing in undoes the Session's
        // link to a grant revoked meanwhile, so revocation always wins.
        if (!await store.touchGrant(grant)) {
            throw revoked();
        }
        const signedIn = await signInSession(session, grant);
        if (!await store.getGrant(grant.id)) {
            await store.clearSessionGrant(signedIn.id, grant.id);
            throw revoked();
        }
        return issueSessionToken(signedIn, jkt, scope, grant);
    }

    async function deviceCodeGrant(req: Request, agent: Agent, jkt: string) {
        const deviceHash = hashSecret(required(req.body, 'device_code'));
        const session = await sessionFor(required(req.body, 'session_id'), agent.clientId);
        const device = await store.getDevice(deviceHash);
        if (!device || device.clientId !== agent.clientId) {
            throw new OAuthError(400, 'invalid_grant', 'unknown device_code');
        }
        if (device.expiresAt <= now()) {
            await store.deleteDevice(deviceHash, device);
            throw new OAuthError(400, 'expired_token', 'the device code has expired');
        }

        const decision = await store.getDeviceDecision(deviceHash);
        if (!decision) {
            const polling = await store.getDevicePolling(deviceHash);
            const interval = polling?.interval ?? device.interval;
            const tooSoon = polling !== null && now() - polling.lastPollAt < interval * 1000;
            await store.putDevicePolling(deviceHash, device, {
                lastPollAt: now(),
                interval: tooSoon ? interval + 5 : interval,
            });
            if (tooSoon) {
                throw new OAuthError(400, 'slow_down', 'poll no faster than the interval');
            }
            throw new OAuthError(400, 'authorization_pending', 'the User has not finished signing in');
        }

        // Checked before consuming, so a bad request does not use up an approval.
        const scope = decision.approved ? narrowScope(req.body, decision.scope) : [];
        // Only the poll that consumes the decision acts on it.
        if (!await store.consumeDeviceDecision(deviceHash, device)) {
            throw new OAuthError(400, 'invalid_grant', 'the device code has already been used');
        }
        await store.deleteDevice(deviceHash, device);
        if (!decision.approved) {
            throw new OAuthError(400, 'access_denied', 'the User declined');
        }
        return completeSignIn(session!, agent, decision.did, decision.scope, scope, jkt);
    }

    // ---------- router ----------

    const router = Router();
    router.use(express.urlencoded({ extended: false, limit: '64kb' }));
    router.use(express.json({ limit: '64kb' }));

    router.post('/token', async (req: Request, res: Response) => {
        try {
            const body = req.body ?? {};
            const grantType = required(body, 'grant_type');
            const agent = await authenticateClient(body);
            const jkt = await requireDpop(req);
            checkResource(body);

            let response;
            if (grantType === JWT_BEARER) {
                response = await jwtBearerGrant(req, agent, jkt);
            } else if (grantType === 'authorization_code') {
                response = await authorizationCodeGrant(req, agent, jkt);
            } else if (grantType === 'refresh_token') {
                response = await refreshTokenGrant(req, agent, jkt);
            } else if (grantType === DEVICE_CODE) {
                response = await deviceCodeGrant(req, agent, jkt);
            } else {
                throw new OAuthError(400, 'unsupported_grant_type', 'unsupported grant_type');
            }
            res.set('Cache-Control', 'no-store');
            res.json(response);
        }
        catch (error) {
            sendOAuthError(res, error instanceof OAuthError ? error : new OAuthError(500, 'server_error', 'token request failed'));
        }
    });

    router.post('/revoke', async (req: Request, res: Response) => {
        try {
            const body = req.body ?? {};
            const agent = await authenticateClient(body);
            const grant = await store.getGrantByToken(required(body, 'token'));
            // Only the client the Account Token was issued to can revoke it;
            // anything else is answered as RFC 7009 answers an unknown token.
            if (grant && grant.clientId === agent.clientId) {
                await store.revokeGrant(grant);
            }
            res.set('Cache-Control', 'no-store');
            res.status(200).json({});
        }
        catch (error) {
            sendOAuthError(res, error instanceof OAuthError ? error : new OAuthError(500, 'server_error', 'revocation failed'));
        }
    });

    router.post('/device_authorization', async (req: Request, res: Response) => {
        try {
            const body = req.body ?? {};
            const agent = await authenticateClient(body);
            const scope = parseScope(param(body, 'scope'));
            const deviceCode = randomSecret('pdc_');
            const code = userCode();
            const expiresAt = now() + config.deviceCodeSeconds * 1000;
            await store.putDevice(deviceCode, {
                clientId: agent.clientId,
                scope,
                userCode: code,
                interval: config.deviceIntervalSeconds,
                expiresAt,
            });
            res.set('Cache-Control', 'no-store');
            res.json({
                device_code: deviceCode,
                user_code: code,
                verification_uri: urls.deviceVerification,
                verification_uri_complete: `${urls.deviceVerification}?user_code=${encodeURIComponent(code)}`,
                expires_in: config.deviceCodeSeconds,
                interval: config.deviceIntervalSeconds,
            });
        }
        catch (error) {
            sendOAuthError(res, error instanceof OAuthError ? error : new OAuthError(500, 'server_error', 'device authorization failed'));
        }
    });

    // ---------- sign-in pages ----------

    function sendPage(res: Response, status: number, render: (nonce: string) => string): void {
        const nonce = crypto.randomBytes(16).toString('base64');
        res.status(status).set(pageHeaders(nonce)).send(render(nonce));
    }

    function redirectWith(base: string, params: Record<string, string | undefined>): string {
        const url = new URL(base);
        for (const [key, value] of Object.entries(params)) {
            if (value !== undefined) {
                url.searchParams.set(key, value);
            }
        }
        return url.href;
    }

    async function startSignIn(res: Response, signIn: Omit<SignIn, 'id' | 'browserSecretHash' | 'csrfHash' | 'expiresAt' | 'challenge'>) {
        const id = randomSecret('sgn_', 16);
        const browserSecret = randomSecret('', 32);
        const csrf = randomSecret('', 24);
        const challenge = await accounts.createChallenge(`${config.issuer}/signin/response`);
        const record: SignIn = {
            ...signIn,
            id,
            browserSecretHash: hashSecret(browserSecret),
            csrfHash: hashSecret(csrf),
            challenge,
            expiresAt: now() + config.codeSeconds * 1000,
        };
        await store.putSignIn(record);
        res.cookie(`poppy_${id}`, browserSecret, {
            httpOnly: true,
            secure: secureCookie,
            sameSite: 'lax',
            path: cookiePath,
            maxAge: config.codeSeconds * 1000,
        });
        const challengeUrl = `${config.walletUrl}?challenge=${encodeURIComponent(challenge)}`;
        sendPage(res, 200, nonce => consentPage({
            nonce,
            organization: config.organizationName,
            agentName: signIn.clientName,
            agentDomain: signIn.domain,
            logoUri: signIn.logoUri,
            scope: signIn.scope,
            accessDays: Math.round(config.accountTokenSeconds / 86400),
            challengeUrl,
            statusUrl: `${config.issuer}/signin/${id}/status`,
            decideUrl: `${config.issuer}/signin/${id}/decide`,
            csrf,
            userCode: signIn.userCode,
        }));
    }

    router.get('/authorize', async (req: Request, res: Response) => {
        const query = req.query as Record<string, unknown>;
        let agent: Agent;
        let redirectUri: string;
        try {
            const clientId = param(query, 'client_id');
            redirectUri = param(query, 'redirect_uri') ?? '';
            if (!clientId) {
                throw new Error('client_id is missing');
            }
            agent = await loadAgent(clientId);
            // Errors are shown here rather than redirected until the
            // redirect_uri is known to belong to the agent.
            if (!agent.metadata.redirect_uris.includes(redirectUri)) {
                throw new Error('redirect_uri is not one of the agent’s redirect_uris');
            }
        }
        catch (error) {
            sendPage(res, 400, nonce => errorPage(nonce, config.organizationName,
                error instanceof AgentError || error instanceof OAuthError || error instanceof Error ? error.message : 'invalid request'));
            return;
        }

        const wait = signInLimiter.take('all');
        if (wait) {
            res.set('Retry-After', String(wait));
            sendPage(res, 429, nonce => errorPage(nonce, config.organizationName, 'Too many sign-in attempts. Wait a minute and try again.'));
            return;
        }

        const state = typeof query.state === 'string' ? query.state : undefined;
        const fail = (code: string, description: string) => res.redirect(303, redirectWith(redirectUri, {
            error: code,
            error_description: description,
            state,
            iss: config.issuer,
        }));

        try {
            if (param(query, 'response_type') !== 'code') {
                return fail('unsupported_response_type', 'response_type must be code');
            }
            const challenge = param(query, 'code_challenge');
            if (param(query, 'code_challenge_method') !== 'S256' || !challenge || !PKCE_S256_CHALLENGE.test(challenge)) {
                return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required');
            }
            let scope: string[];
            try {
                scope = parseScope(param(query, 'scope'));
            }
            catch (error) {
                return fail('invalid_scope', error instanceof Error ? error.message : 'invalid scope');
            }
            await startSignIn(res, {
                kind: 'direct',
                clientId: agent.clientId,
                clientName: agent.metadata.client_name || agent.domain,
                logoUri: agent.metadata.logo_uri,
                domain: agent.domain,
                scope,
                redirectUri,
                state,
                codeChallenge: challenge,
            });
        }
        catch (error) {
            if (error instanceof OAuthError) {
                return fail(error.code, error.message);
            }
            return fail('server_error', 'sign-in could not start');
        }
    });

    router.get('/device', (req: Request, res: Response) => {
        const code = typeof req.query.user_code === 'string' ? req.query.user_code : '';
        sendPage(res, 200, nonce => deviceEntryPage(nonce, config.organizationName, urls.deviceVerification, code));
    });

    router.post('/device', async (req: Request, res: Response) => {
        const entered = normalizeUserCode(req.body?.user_code);
        const wait = userCodeLimiter.take('all');
        if (wait) {
            res.set('Retry-After', String(wait));
            sendPage(res, 429, nonce => deviceEntryPage(nonce, config.organizationName, urls.deviceVerification, entered,
                'Too many attempts. Wait a minute and try again.'));
            return;
        }
        const hash = entered ? await store.getDeviceHashByUserCode(entered) : null;
        if (hash && signInLimiter.take('all')) {
            sendPage(res, 429, nonce => errorPage(nonce, config.organizationName, 'Too many sign-in attempts. Wait a minute and try again.'));
            return;
        }
        const device = hash ? await store.getDevice(hash) : null;
        if (!hash || !device || device.expiresAt <= now() || await store.getDeviceDecision(hash)) {
            sendPage(res, 400, nonce => deviceEntryPage(nonce, config.organizationName, urls.deviceVerification, entered,
                'That code is not valid or has expired. Check it against the one your agent shows.'));
            return;
        }
        try {
            const agent = await loadAgent(device.clientId);
            await startSignIn(res, {
                kind: 'device',
                clientId: agent.clientId,
                clientName: agent.metadata.client_name || agent.domain,
                logoUri: agent.metadata.logo_uri,
                domain: agent.domain,
                scope: device.scope,
                deviceCodeHash: hash,
                userCode: device.userCode,
            });
        }
        catch {
            sendPage(res, 400, nonce => errorPage(nonce, config.organizationName, 'The agent’s details could not be loaded.'));
        }
    });

    async function browserSignIn(req: Request, csrf?: string): Promise<SignIn | null> {
        const signIn = await store.getSignIn(req.params.id);
        if (!signIn) {
            return null;
        }
        // The cookie ties the page to the browser that opened it; the CSRF
        // value, required to decide, is known only to that page.
        if (!sameSecret(readCookie(req, `poppy_${signIn.id}`), signIn.browserSecretHash)) {
            return null;
        }
        return csrf === undefined || sameSecret(csrf, signIn.csrfHash) ? signIn : null;
    }

    router.get('/signin/:id/status', async (req: Request, res: Response) => {
        const signIn = await browserSignIn(req);
        res.set('Cache-Control', 'no-store');
        if (!signIn) {
            res.status(404).json({ error: 'sign_in_not_found' });
            return;
        }
        const account = await store.getSignInAccount(signIn);
        const status = await store.isSignInDecided(signIn) ? 'done' : account ? 'authenticated' : 'pending';
        res.json(status === 'authenticated' ? { status, did: account!.did, name: account!.name } : { status });
    });

    router.post('/signin/:id/decide', async (req: Request, res: Response) => {
        res.set('Cache-Control', 'no-store');
        const csrf = req.headers['x-poppy-csrf'];
        const signIn = typeof csrf === 'string' ? await browserSignIn(req, csrf) : null;
        if (!signIn) {
            res.status(403).json({ error: 'access_denied', error_description: 'This sign-in page has expired. Start again from your agent.' });
            return;
        }
        const account = await store.getSignInAccount(signIn);
        if (!account) {
            res.status(409).json({ error: 'invalid_request', error_description: 'Sign in with your wallet first.' });
            return;
        }
        // The first submission decides; repeats (a double click) change nothing.
        if (!await store.claimSignInDecision(signIn)) {
            res.status(409).json({ error: 'invalid_request', error_description: 'This sign-in has already been answered.' });
            return;
        }
        const selected = Array.isArray(req.body?.scope) ? req.body.scope : [];
        const granted = signIn.scope.filter(scope => selected.includes(scope));
        const approved = req.body?.decision === 'approve' && granted.length > 0;

        if (signIn.kind === 'direct') {
            if (!approved) {
                res.json({ redirect: redirectWith(signIn.redirectUri!, { error: 'access_denied', state: signIn.state, iss: config.issuer }) });
                return;
            }
            const code = randomSecret('pac_');
            await store.putAuthCode(code, {
                clientId: signIn.clientId,
                redirectUri: signIn.redirectUri!,
                codeChallenge: signIn.codeChallenge!,
                did: account.did,
                scope: granted,
            }, now() + config.codeSeconds * 1000);
            res.json({ redirect: redirectWith(signIn.redirectUri!, { code, state: signIn.state, iss: config.issuer }) });
            return;
        }

        const device = await store.getDevice(signIn.deviceCodeHash!);
        const decided = device && device.expiresAt > now() && await store.decideDevice(signIn.deviceCodeHash!, device,
            approved ? { approved: true, did: account.did, scope: granted } : { approved: false });
        if (!decided) {
            res.status(410).json({ error: 'expired_token', error_description: 'This request has expired or was already answered. Start again from your agent.' });
            return;
        }
        res.json({ message: approved
            ? 'Connected. You can close this page and return to your agent.'
            : 'Declined. Nothing was connected.' });
    });

    // The wallet posts its challenge response here.
    router.post('/signin/response', async (req: Request, res: Response) => {
        try {
            const response = req.body?.response;
            if (typeof response !== 'string' || !response) {
                res.status(400).json({ error: 'missing_response' });
                return;
            }
            const verify = await accounts.verifyResponse(response);
            if (!verify.match || !verify.challenge || !verify.responder) {
                res.status(401).json({ error: 'invalid_response' });
                return;
            }
            const signIn = await store.getSignInByChallenge(verify.challenge);
            if (!signIn) {
                res.status(400).json({ error: 'unknown_challenge' });
                return;
            }
            await accounts.ensureUser(verify.responder);
            const account = { did: verify.responder, name: await accounts.nameOf(verify.responder) };
            // The first response decides the account; a later one cannot replace it.
            if (!await store.authenticateSignIn(signIn, account)) {
                res.status(409).json({ error: 'already_answered' });
                return;
            }
            res.json({ ok: true });
        }
        catch {
            res.status(500).json({ error: 'server_error' });
        }
    });

    router.use('/', createApiRouter({ config, store, accounts, now }));

    // ---------- discovery (section 3) ----------

    const wellKnown = Router();
    wellKnown.get('/.well-known/poppy.json', (_req: Request, res: Response) => {
        res.set('Cache-Control', 'public, max-age=300');
        res.json(poppyDocument(config));
    });
    wellKnown.get(`/.well-known/oauth-authorization-server${new URL(config.issuer).pathname}`, (_req: Request, res: Response) => {
        res.set('Cache-Control', 'public, max-age=300');
        res.json(authorizationServerMetadata(config));
    });

    // ---------- account settings ----------

    // One entry per agent: signing in again adds a grant rather than
    // replacing one, and disconnecting an agent revokes all of its grants
    // for the account (guides, "Account settings").
    function agentId(clientId: string): string {
        return `agt_${hashSecret(clientId).slice(0, 22)}`;
    }

    async function listConnections(did: string): Promise<PoppyConnection[]> {
        const byAgent = new Map<string, Grant[]>();
        for (const grant of await store.listGrantsForDid(did)) {
            byAgent.set(grant.clientId, [...(byAgent.get(grant.clientId) ?? []), grant]);
        }
        return [...byAgent.values()]
            .map(grants => {
                const latest = grants.reduce((a, b) => (b.lastUsedAt > a.lastUsedAt ? b : a));
                return {
                    id: agentId(latest.clientId),
                    clientId: latest.clientId,
                    name: latest.clientName,
                    domain: latest.domain,
                    scope: [...new Set(grants.flatMap(grant => grant.scope))].sort(),
                    createdAt: new Date(Math.min(...grants.map(grant => grant.createdAt))).toISOString(),
                    lastUsedAt: new Date(latest.lastUsedAt).toISOString(),
                    expiresAt: new Date(Math.max(...grants.map(grant => grant.expiresAt))).toISOString(),
                };
            })
            .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
    }

    async function disconnect(did: string, id: string): Promise<boolean> {
        const grants = (await store.listGrantsForDid(did)).filter(grant => agentId(grant.clientId) === id);
        for (const grant of grants) {
            await store.revokeGrant(grant);
        }
        return grants.length > 0;
    }

    return { router, wellKnown, listConnections, disconnect };
}
