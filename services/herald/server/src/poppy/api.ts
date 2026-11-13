import { Request, Response, Router, NextFunction } from 'express';
import type { Agent } from './agents.js';
import { POPPY_PROTOCOL_VERSION, endpoints, type PoppyConfig } from './config.js';
import { DPOP_ALGORITHMS, verifyDpopProof } from './dpop.js';
import { RateLimitedError, RateLimiter } from './rate-limit.js';
import { SessionHeaderError, verifySessionHeader } from './session-header.js';
import type { PoppyStore } from './store.js';

// The OpenAPI interface listed in poppy.json (spec section 7). Every request
// carries the Session header, which says which agent, User and Session it is
// from. A signed-in request also carries a DPoP-bound access token, which says
// which account it may act on and with which scopes. Signed out, an agent can
// do what any visitor to Herald can.

export interface AccountResult {
    status: number;
    body: unknown;
}

// What Herald provides to Poppy. Implemented in routes.ts over the same
// helpers its own routes use, so both apply identical rules.
export interface PoppyAccounts {
    // `description` is shown by the wallet answering the challenge.
    createChallenge(callback: string, description: string): Promise<string>;
    verifyResponse(response: string): Promise<{ match: boolean; challenge?: string; responder?: string }>;
    ensureUser(did: string): Promise<void>;
    nameOf(did: string): Promise<string | undefined>;

    lookupName(name: string): Promise<{ name: string; did: string } | null>;
    member(name: string): Promise<unknown | null>;
    resolveDid(did: string): Promise<unknown | null>;
    directory(): Promise<unknown>;

    profile(did: string): Promise<unknown | null>;
    credential(did: string): Promise<AccountResult>;
    setName(did: string, name: unknown): Promise<AccountResult>;
    deleteName(did: string): Promise<AccountResult>;
}

export interface PoppyRequestContext {
    clientId: string;
    userId: string;
    sessionKey: string;
    agentId?: string;
    did?: string;
    scope: string[];
}

interface ApiOptions {
    config: PoppyConfig;
    store: PoppyStore;
    accounts: PoppyAccounts;
    now: () => number;
    // Loads the agent a Session header names, within the budget for clients
    // not seen before; `rememberClient` takes a verified one out of it.
    loadAgent(clientId: string, refreshKeys?: boolean): Promise<Agent>;
    rememberClient(clientId: string): void;
}

// An access token error, in WWW-Authenticate as RFC 9449 §7.1 and RFC 6750 §3
// describe. With no error code, the request needs the account and carried no
// token; `scope` then names what to ask for (spec section 7).
function challenge(res: Response, status: number, error?: string, scope?: string): void {
    const params = [`algs="${DPOP_ALGORITHMS.join(' ')}"`];
    if (scope) {
        params.unshift(`scope="${scope}"`);
    }
    if (error) {
        params.unshift(`error="${error}"`);
    }
    res.set('WWW-Authenticate', `DPoP ${params.join(', ')}`);
    res.set('Cache-Control', 'no-store');
    res.status(status).json(error ? { error } : {});
}

// A Session or version error: HTTP 400 with a JSON body, not 401, so that an
// OAuth library does not take it for a problem with the token (5.3).
function sessionError(res: Response, error: string, description?: string): void {
    res.set('Cache-Control', 'no-store');
    res.status(400).json(description ? { error, error_description: description } : { error });
}

function tooManyRequests(res: Response, retryAfter: number): void {
    res.set('Retry-After', String(retryAfter));
    res.set('Cache-Control', 'no-store');
    res.status(429).json({});
}

function context(res: Response): PoppyRequestContext {
    return res.locals.poppy as PoppyRequestContext;
}

export function createApiRouter({ config, store, accounts, now, loadAgent, rememberClient }: ApiOptions): Router {
    const urls = endpoints(config);
    const clientLimiter = new RateLimiter(600, 60_000, now);
    const sessionLimiter = new RateLimiter(120, 60_000, now);

    async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if ('access_token' in (req.query ?? {})) {
                res.set('Cache-Control', 'no-store');
                res.status(400).json({ error: 'invalid_request', error_description: 'tokens are not accepted in a URL' });
                return;
            }
            const url = `${config.origin}/names${new URL(req.originalUrl, 'http://herald').pathname}`;

            // The access token, when there is one. It is checked before the
            // Session header so that an expired token is reported as one,
            // which the agent fixes by refreshing.
            let account: { token: string; clientId: string; did: string; scope: string[] } | undefined;
            const authorization = req.headers.authorization;
            if (authorization) {
                // Authentication schemes are case-insensitive (RFC 9110 §11.1).
                const match = /^DPoP\s+([A-Za-z0-9\-._~+/]+=*)$/i.exec(authorization);
                const token = match?.[1];
                const record = token ? await store.getAccessToken(token) : null;
                // Revocation takes effect at once: a token counts only while
                // the grant it was issued under still exists (5.5).
                const grant = record ? await store.getGrant(record.grantId) : null;
                if (!token || !record || !grant || grant.did !== record.did) {
                    challenge(res, 401, 'invalid_token');
                    return;
                }
                let jkt: string | undefined;
                try {
                    jkt = await verifyDpopProof({ header: req.headers.dpop, method: req.method, url, accessToken: token }, store.kv, now);
                }
                catch {
                    // Left undefined, it fails the comparison below.
                }
                if (jkt !== record.jkt) {
                    challenge(res, 401, 'invalid_dpop_proof');
                    return;
                }
                account = { token, clientId: record.clientId, did: record.did, scope: record.scope };
            }

            let session;
            try {
                session = await verifySessionHeader({
                    header: req.headers['poppy-session'],
                    version: req.headers['poppy-version'],
                    method: req.method,
                    url,
                    accessToken: account && { token: account.token, clientId: account.clientId },
                }, { issuer: config.issuer, versions: [POPPY_PROTOCOL_VERSION], loadAgent, kv: store.kv, now });
            }
            catch (error) {
                if (error instanceof SessionHeaderError) {
                    sessionError(res, error.code, error.message);
                    return;
                }
                if (error instanceof RateLimitedError) {
                    tooManyRequests(res, error.retryAfter);
                    return;
                }
                throw error;
            }
            rememberClient(session.clientId);

            const sessionKey = store.sessionKey(session.clientId, session.sessionId, session.userId);
            const wait = clientLimiter.take(session.clientId) || sessionLimiter.take(sessionKey);
            if (wait) {
                tooManyRequests(res, wait);
                return;
            }

            // A Session uses one account. A token for another one is refused,
            // and the agent starts a new Session for it (5.4).
            if (account && !await store.bindSessionAccount(sessionKey, account.did, config.sessionSeconds)) {
                sessionError(res, 'session_ended', 'this Session has used a different account');
                return;
            }

            res.locals.poppy = {
                clientId: session.clientId,
                userId: session.userId,
                sessionKey,
                agentId: session.agentId,
                did: account?.did,
                scope: account?.scope ?? [],
            } satisfies PoppyRequestContext;
            next();
        }
        catch (error) {
            next(error);
        }
    }

    function requireScope(scope: string) {
        return (_req: Request, res: Response, next: NextFunction) => {
            const ctx = context(res);
            if (!ctx.did) {
                challenge(res, 401, undefined, scope);
                return;
            }
            if (!ctx.scope.includes(scope)) {
                challenge(res, 403, 'insufficient_scope', scope);
                return;
            }
            next();
        };
    }

    const send = (res: Response, result: { status: number; body: unknown }) => {
        res.set('Cache-Control', 'no-store');
        res.status(result.status).json(result.body);
    };

    const handle = (fn: (req: Request, res: Response) => Promise<void>) =>
        async (req: Request, res: Response) => {
            try {
                await fn(req, res);
            }
            catch {
                res.set('Cache-Control', 'no-store');
                res.status(500).json({ error: 'server_error' });
            }
        };

    const router = Router();

    router.get('/openapi.json', (_req: Request, res: Response) => {
        res.set('Cache-Control', 'public, max-age=300');
        res.json(openApiDocument(config, urls.api));
    });

    router.use('/api', authenticate);

    router.get('/api/names/:name', handle(async (req, res) => {
        const result = await accounts.lookupName(String(req.params.name));
        send(res, result ? { status: 200, body: result } : { status: 404, body: { error: 'name_not_found' } });
    }));

    router.get('/api/members/:name', handle(async (req, res) => {
        const result = await accounts.member(String(req.params.name));
        send(res, result ? { status: 200, body: result } : { status: 404, body: { error: 'name_not_found' } });
    }));

    router.get('/api/dids/:did', handle(async (req, res) => {
        const result = await accounts.resolveDid(String(req.params.did));
        send(res, result ? { status: 200, body: result } : { status: 404, body: { error: 'did_not_found' } });
    }));

    router.get('/api/directory', handle(async (_req, res) => {
        send(res, { status: 200, body: await accounts.directory() });
    }));

    router.get('/api/account', requireScope('profile:read'), handle(async (_req, res) => {
        const profile = await accounts.profile(context(res).did!);
        send(res, profile ? { status: 200, body: profile } : { status: 404, body: { error: 'account_not_found' } });
    }));

    router.get('/api/account/credential', requireScope('profile:read'), handle(async (_req, res) => {
        send(res, await accounts.credential(context(res).did!));
    }));

    router.put('/api/account/name', requireScope('name:write'), handle(async (req, res) => {
        send(res, await accounts.setName(context(res).did!, req.body?.name));
    }));

    router.delete('/api/account/name', requireScope('name:write'), handle(async (_req, res) => {
        send(res, await accounts.deleteName(context(res).did!));
    }));

    return router;
}

export function openApiDocument(config: PoppyConfig, apiUrl: string) {
    const error = { $ref: '#/components/schemas/Error' };
    const json = (schema: unknown) => ({ content: { 'application/json': { schema } } });
    // Only the /account operations need an access token.
    const security = [{ dpop: [] }];
    const nameParam = { name: 'name', in: 'path', required: true, schema: { type: 'string' } };
    return {
        openapi: '3.1.0',
        info: {
            title: `${config.organizationName} names`,
            version: '1.0.0',
            description: `Archon names at ${config.domain}. Every request carries the Personal Agent Protocol Session header. Lookups work signed out; /account also needs a DPoP-bound access token with profile:read or name:write.`,
        },
        servers: [{ url: apiUrl }],
        components: {
            securitySchemes: {
                dpop: { type: 'http', scheme: 'DPoP', description: 'Access token with a DPoP proof (RFC 9449), for the /account operations.' },
            },
            schemas: {
                Error: { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] },
                NameRecord: {
                    type: 'object',
                    properties: { name: { type: 'string' }, did: { type: 'string' } },
                    required: ['name', 'did'],
                },
                Account: {
                    type: 'object',
                    properties: {
                        did: { type: 'string' },
                        name: { type: 'string' },
                        credentialDid: { type: 'string' },
                        credentialIssuedAt: { type: 'string', format: 'date-time' },
                    },
                    required: ['did'],
                },
            },
        },
        paths: {
            '/names/{name}': {
                get: {
                    operationId: 'lookupName',
                    summary: 'Find the DID registered under a name',
                    parameters: [nameParam],
                    responses: { 200: { description: 'The name and its DID', ...json({ $ref: '#/components/schemas/NameRecord' }) }, 404: { description: 'No such name', ...json(error) } },
                },
            },
            '/members/{name}': {
                get: {
                    operationId: 'getMember',
                    summary: 'Resolve a name to its DID document, with the checked status of its published credentials',
                    parameters: [nameParam],
                    responses: { 200: { description: 'DID resolution result and credentialStatus', ...json({ type: 'object' }) }, 404: { description: 'No such name', ...json(error) } },
                },
            },
            '/dids/{did}': {
                get: {
                    operationId: 'resolveDid',
                    summary: 'Resolve a DID',
                    parameters: [{ name: 'did', in: 'path', required: true, schema: { type: 'string' } }],
                    responses: { 200: { description: 'DID resolution result', ...json({ type: 'object' }) }, 404: { description: 'Not found', ...json(error) } },
                },
            },
            '/directory': {
                get: {
                    operationId: 'getDirectory',
                    summary: 'List every registered name and its DID',
                    responses: { 200: { description: 'The name registry', ...json({ type: 'object' }) } },
                },
            },
            '/account': {
                get: {
                    operationId: 'getAccount',
                    security,
                    summary: "The signed-in User's profile (profile:read)",
                    responses: { 200: { description: 'Profile', ...json({ $ref: '#/components/schemas/Account' }) }, 401: { description: 'No access token; the challenge names the scope needed' }, 403: { description: 'insufficient_scope', ...json(error) } },
                },
            },
            '/account/credential': {
                get: {
                    operationId: 'getAccountCredential',
                    security,
                    summary: "The signed-in User's membership credential (profile:read)",
                    responses: { 200: { description: 'Verifiable credential', ...json({ type: 'object' }) }, 404: { description: 'No credential', ...json(error) } },
                },
            },
            '/account/name': {
                put: {
                    operationId: 'setAccountName',
                    security,
                    summary: "Claim or change the signed-in User's name (name:write)",
                    requestBody: { required: true, ...json({ type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }) },
                    responses: { 200: { description: 'Name set', ...json({ type: 'object' }) }, 400: { description: 'Invalid name', ...json({ type: 'object' }) }, 409: { description: 'Name taken', ...json({ type: 'object' }) } },
                },
                delete: {
                    operationId: 'deleteAccountName',
                    security,
                    summary: "Release the signed-in User's name and revoke its credential (name:write)",
                    responses: { 200: { description: 'Name released', ...json({ type: 'object' }) }, 404: { description: 'No name', ...json({ type: 'object' }) } },
                },
            },
        },
    };
}
