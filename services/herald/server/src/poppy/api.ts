import { Request, Response, Router, NextFunction } from 'express';
import { endpoints, type PoppyConfig } from './config.js';
import { DPOP_ALGORITHMS, verifyDpopProof } from './dpop.js';
import { RateLimiter } from './rate-limit.js';
import type { PoppyStore } from './store.js';

// The OpenAPI interface listed in poppy.json (spec section 6). Every request
// carries a DPoP-bound Session Token; Bearer tokens are refused because this
// is not an MCP API (4.3). Signed out, an agent can do what any visitor to
// Herald can; signed in, it acts on the User's own Herald account within the
// scopes the User granted.

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
    sessionId: string;
    did?: string;
    scope: string[];
}

interface ApiOptions {
    config: PoppyConfig;
    store: PoppyStore;
    accounts: PoppyAccounts;
    now: () => number;
}

function challenge(res: Response, status: number, error?: string, extra: Record<string, string> = {}): void {
    const params = [`algs="${DPOP_ALGORITHMS.join(' ')}"`];
    if (error) {
        params.unshift(`error="${error}"`);
    }
    for (const [key, value] of Object.entries(extra)) {
        params.push(`${key}="${value}"`);
    }
    res.set('WWW-Authenticate', `DPoP ${params.join(', ')}`);
    res.set('Cache-Control', 'no-store');
    res.status(status).json({ error: error ?? 'invalid_token' });
}

function context(res: Response): PoppyRequestContext {
    return res.locals.poppy as PoppyRequestContext;
}

export function createApiRouter({ config, store, accounts, now }: ApiOptions): Router {
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
            const authorization = req.headers.authorization || '';
            // Authentication schemes are case-insensitive (RFC 9110 §11.1).
            const match = /^DPoP\s+([A-Za-z0-9\-._~+/]+=*)$/i.exec(authorization);
            if (!match) {
                challenge(res, 401, authorization ? 'invalid_token' : undefined);
                return;
            }
            const token = match[1];
            const record = await store.getSessionToken(token);
            if (!record) {
                challenge(res, 401, 'invalid_token');
                return;
            }
            const url = `${config.origin}/names${new URL(req.originalUrl, 'http://herald').pathname}`;
            let jkt: string;
            try {
                jkt = await verifyDpopProof({ header: req.headers.dpop, method: req.method, url, accessToken: token }, store.kv, now);
            }
            catch {
                challenge(res, 401, 'invalid_dpop_proof');
                return;
            }
            if (jkt !== record.jkt) {
                challenge(res, 401, 'invalid_dpop_proof');
                return;
            }

            const wait = clientLimiter.take(record.clientId) || sessionLimiter.take(record.sessionId);
            if (wait) {
                res.set('Retry-After', String(wait));
                res.status(429).json({ error: 'rate_limited' });
                return;
            }

            // Sign-out takes effect at once: a signed-in token counts only
            // while its Session is still signed in with the same grant (4.9).
            let did: string | undefined;
            if (record.signedIn && record.grantId) {
                const session = await store.getSession(record.sessionId);
                const current = session ? await store.getSessionGrant(session.id) : null;
                const grant = current === record.grantId ? await store.getGrant(record.grantId) : null;
                if (grant && grant.did === record.did) {
                    did = grant.did;
                }
            }
            res.locals.poppy = {
                clientId: record.clientId,
                userId: record.userId,
                sessionId: record.sessionId,
                did,
                scope: did ? record.scope : [],
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
                challenge(res, 403, 'sign_in_required');
                return;
            }
            if (!ctx.scope.includes(scope)) {
                challenge(res, 403, 'insufficient_scope', { scope });
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

    router.get('/api/account', requireScope('poppy:read'), handle(async (_req, res) => {
        const profile = await accounts.profile(context(res).did!);
        send(res, profile ? { status: 200, body: profile } : { status: 404, body: { error: 'account_not_found' } });
    }));

    router.get('/api/account/credential', requireScope('poppy:read'), handle(async (_req, res) => {
        send(res, await accounts.credential(context(res).did!));
    }));

    router.put('/api/account/name', requireScope('poppy:write'), handle(async (req, res) => {
        send(res, await accounts.setName(context(res).did!, req.body?.name));
    }));

    router.delete('/api/account/name', requireScope('poppy:write'), handle(async (_req, res) => {
        send(res, await accounts.deleteName(context(res).did!));
    }));

    return router;
}

export function openApiDocument(config: PoppyConfig, apiUrl: string) {
    const error = { $ref: '#/components/schemas/Error' };
    const json = (schema: unknown) => ({ content: { 'application/json': { schema } } });
    const security = [{ dpop: [] }];
    const nameParam = { name: 'name', in: 'path', required: true, schema: { type: 'string' } };
    return {
        openapi: '3.1.0',
        info: {
            title: `${config.organizationName} names`,
            version: '1.0.0',
            description: `Archon names at ${config.domain}. Requests carry a DPoP-bound Personal Agent Protocol Session Token. Lookups work signed out; /account needs a signed-in Session with poppy:read or poppy:write.`,
        },
        servers: [{ url: apiUrl }],
        security,
        components: {
            securitySchemes: {
                dpop: { type: 'http', scheme: 'DPoP', description: 'Session Token with a DPoP Proof (RFC 9449).' },
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
                    summary: "The signed-in User's profile (poppy:read)",
                    responses: { 200: { description: 'Profile', ...json({ $ref: '#/components/schemas/Account' }) }, 403: { description: 'sign_in_required or insufficient_scope', ...json(error) } },
                },
            },
            '/account/credential': {
                get: {
                    operationId: 'getAccountCredential',
                    summary: "The signed-in User's membership credential (poppy:read)",
                    responses: { 200: { description: 'Verifiable credential', ...json({ type: 'object' }) }, 404: { description: 'No credential', ...json(error) } },
                },
            },
            '/account/name': {
                put: {
                    operationId: 'setAccountName',
                    summary: "Claim or change the signed-in User's name (poppy:write)",
                    requestBody: { required: true, ...json({ type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }) },
                    responses: { 200: { description: 'Name set', ...json({ type: 'object' }) }, 400: { description: 'Invalid name', ...json({ type: 'object' }) }, 409: { description: 'Name taken', ...json({ type: 'object' }) } },
                },
                delete: {
                    operationId: 'deleteAccountName',
                    summary: "Release the signed-in User's name and revoke its credential (poppy:write)",
                    responses: { 200: { description: 'Name released', ...json({ type: 'object' }) }, 404: { description: 'No name', ...json({ type: 'object' }) } },
                },
            },
        },
    };
}
