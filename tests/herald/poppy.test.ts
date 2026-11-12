import crypto from 'crypto';
import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { exportJWK, generateKeyPair } from 'jose';

import { AgentDirectory } from '../../services/herald/server/src/poppy/agents.ts';
import { createPoppyConfig } from '../../services/herald/server/src/poppy/config.ts';
import { MemoryKV } from '../../services/herald/server/src/poppy/kv.ts';
import { createPoppy, type Poppy } from '../../services/herald/server/src/poppy/router.ts';
import { PoppyStore, hashSecret } from '../../services/herald/server/src/poppy/store.ts';
import type { PoppyAccounts } from '../../services/herald/server/src/poppy/api.ts';
import {
    AGENT_ID, ALICE, API, BOB, ISSUER, ORIGIN, REDIRECT, TOKEN,
    TestAgent, fakeAccounts, fetcherFor, fetches, type Docs,
} from './poppy-helpers.ts';

// Herald as a Personal Agent Protocol Company (0.4), exercised by a test
// Personal Agent (poppy-helpers.ts). Client metadata is served by an injected
// fetcher, since the production transport refuses anything but public HTTPS.

let agent: TestAgent;
let docs: Docs;
let poppy: Poppy;
let app: express.Express;
let kv: MemoryKV;
let descriptions: string[];
let accounts: PoppyAccounts;

beforeEach(async () => {
    fetches.length = 0;
    agent = await new TestAgent().init();
    await agent.newSessionKey();
    docs = agent.docs();
    kv = new MemoryKV();
    const fake = fakeAccounts();
    descriptions = fake.descriptions;
    accounts = fake.accounts;
    const config = createPoppyConfig(ORIGIN, 'archon.test', 'https://wallet.archon.test');
    poppy = createPoppy({
        config,
        store: new PoppyStore(kv),
        agents: new AgentDirectory(fetcherFor(() => docs)),
        accounts,
    });
    app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use('/poppy', poppy.router);
    app.use(poppy.wellKnown);
});

async function token(form: Record<string, string>, dpop?: string) {
    const req = request(app).post('/poppy/token').type('form').send(form);
    return dpop === undefined ? req : req.set('DPoP', dpop);
}

// A Session is whatever Session ID and User ID the agent signs into its
// Session header; nothing starts one.
type TestSession = { sid: string; sub: string };
const SESSION: TestSession = { sid: 'Yx2b7Qd_Kp8mR3vT1nWc4A', sub: 'usr_alice_1' };

// A request as a Personal Agent sends it: the Session header and version on
// every one, and the access token with its DPoP proof when signed in.
async function api(method: 'get' | 'put' | 'delete', path: string, accessToken?: string, body?: object, session = SESSION) {
    const url = `${API}${path}`;
    let req = request(app)[method](`/poppy/api${path}`)
        .set('Poppy-Session', await agent.session(method.toUpperCase(), url, session, {}, accessToken))
        .set('Poppy-Version', '0.4');
    if (accessToken) {
        req = req.set('Authorization', `DPoP ${accessToken}`)
            .set('DPoP', await agent.proof(method.toUpperCase(), url, accessToken));
    }
    return body === undefined ? req : req.send(body);
}

// Drives Direct Sign-In through the consent page, the wallet response and the
// User's decision, and returns the redirect the browser is sent to.
async function directSignIn(did: string, scope = 'profile:read name:write', approve: string[] | null = scope.split(' ')) {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const page = await request(app).get('/poppy/authorize').query({
        response_type: 'code',
        client_id: AGENT_ID,
        redirect_uri: REDIRECT,
        scope,
        state: 'st-1',
        code_challenge: challenge,
        code_challenge_method: 'S256',
    });
    expect(page.status).toBe(200);
    const cookie = page.headers['set-cookie'][0].split(';')[0];
    const csrf = /"csrf":"([^"]+)"/.exec(page.text)![1];
    const statusUrl = /"statusUrl":"([^"]+)"/.exec(page.text)![1].replace(ISSUER, '/poppy');
    const decideUrl = /"decideUrl":"([^"]+)"/.exec(page.text)![1].replace(ISSUER, '/poppy');
    const walletChallenge = decodeURIComponent(/challenge=([^"&]+)/.exec(page.text)![1]);

    await request(app).post('/poppy/signin/response')
        .send({ response: JSON.stringify({ challenge: walletChallenge, responder: did }) })
        .expect(200);
    const status = await request(app).get(statusUrl).set('Cookie', cookie);
    expect(status.body).toMatchObject({ status: 'authenticated', did });

    const decided = await request(app).post(decideUrl).set('Cookie', cookie).set('X-Poppy-CSRF', csrf)
        .send({ decision: approve ? 'approve' : 'decline', scope: approve ?? [] });
    expect(decided.status).toBe(200);
    return { redirect: new URL(decided.body.redirect), verifier, page };
}

async function exchange(redirect: URL, verifier: string, extra: Record<string, string> = {}) {
    return token({
        grant_type: 'authorization_code',
        code: redirect.searchParams.get('code')!,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
        ...extra,
        ...await agent.clientAuth(),
    }, await agent.proof('POST', TOKEN));
}

async function signedIn(did = ALICE, scope = 'profile:read name:write', approve?: string[]) {
    const { redirect, verifier } = await directSignIn(did, scope, approve);
    const response = await exchange(redirect, verifier);
    expect(response.status).toBe(200);
    return { signIn: response.body };
}

async function refresh(refreshToken: string, extra: Record<string, string> = {}) {
    return token({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        ...extra,
        ...await agent.clientAuth(),
    }, await agent.proof('POST', TOKEN));
}

async function pollDevice(deviceCode: string) {
    return token({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode,
        ...await agent.clientAuth(),
    }, await agent.proof('POST', TOKEN));
}

describe('discovery', () => {
    it('publishes poppy.json with the version, the described scopes and the OpenAPI interface', async () => {
        const response = await request(app).get('/.well-known/poppy.json').expect(200);
        expect(response.body).toEqual({
            protocol_version: '0.4',
            organization: { name: 'archon.test', domain: 'archon.test' },
            auth: {
                issuer: ISSUER,
                scopes: {
                    'profile:read': expect.any(String),
                    'name:write': expect.any(String),
                },
                scope_hints: {
                    'profile:read': { changes: 'none', personal_data: true },
                    'name:write': { changes: 'irreversible', personal_data: true },
                },
            },
            apis: [expect.objectContaining({ type: 'openapi', url: `${ISSUER}/openapi.json` })],
        });
    });

    it('names its issuer in the domain’s protected resource metadata, which is how an agent finds it', async () => {
        const response = await request(app).get('/.well-known/oauth-protected-resource').expect(200);
        expect(response.body).toEqual({
            resource: 'https://archon.test',
            authorization_servers: [ISSUER],
            scopes_supported: ['profile:read', 'name:write'],
        });
    });

    it('publishes RFC 8414 metadata at the issuer path, listing the domain it is the issuer of', async () => {
        const response = await request(app).get('/.well-known/oauth-authorization-server/names/poppy').expect(200);
        expect(response.body).toMatchObject({
            issuer: ISSUER,
            token_endpoint: TOKEN,
            revocation_endpoint: `${ISSUER}/revoke`,
            authorization_endpoint: `${ISSUER}/authorize`,
            device_authorization_endpoint: `${ISSUER}/device_authorization`,
            protected_resources: ['https://archon.test'],
            scopes_supported: ['profile:read', 'name:write'],
        });
        expect(response.body.poppy_domains).toBeUndefined();
        expect(response.body.dpop_signing_alg_values_supported).toContain('ES256');
        expect(response.body.token_endpoint_auth_signing_alg_values_supported).toEqual(expect.arrayContaining(['ES256', 'PS384']));
    });

    it('offers Direct and Device Sign-In and refresh through grant_types_supported, and no Session grant', async () => {
        const response = await request(app).get('/.well-known/oauth-authorization-server/names/poppy').expect(200);
        expect(response.body.grant_types_supported).toEqual([
            'authorization_code',
            'refresh_token',
            'urn:ietf:params:oauth:grant-type:device_code',
        ]);
    });

    // The steps of spec 3 and 3.2, as a Personal Agent takes them.
    it('can be discovered from the domain alone, each document confirming the last', async () => {
        const domain = 'archon.test';
        const poppyJson = (await request(app).get('/.well-known/poppy.json').expect(200)).body;
        expect(poppyJson.organization.domain).toBe(domain);

        const resource = (await request(app).get('/.well-known/oauth-protected-resource').expect(200)).body;
        expect(resource.resource).toBe(`https://${domain}`);
        expect(resource.authorization_servers).toHaveLength(1);
        const [issuer] = resource.authorization_servers;
        expect(poppyJson.auth.issuer).toBe(issuer);

        // RFC 8414 §3.1: the well-known segment goes before the issuer's path.
        const { origin, pathname } = new URL(issuer);
        expect(origin).toBe(ORIGIN);
        const metadata = (await request(app).get(`/.well-known/oauth-authorization-server${pathname}`).expect(200)).body;
        expect(metadata.issuer).toBe(issuer);
        expect(metadata.protected_resources).toContain(`https://${domain}`);
        expect(metadata.grant_types_supported).toContain('refresh_token');
        for (const scope of Object.keys(poppyJson.auth.scopes)) {
            expect(metadata.scopes_supported).toContain(scope);
            expect(Object.keys(poppyJson.auth.scope_hints[scope]).sort()).toEqual(['changes', 'personal_data']);
        }
    });

    it('serves an OpenAPI 3.1 description whose server is the API base', async () => {
        const response = await request(app).get('/poppy/openapi.json').expect(200);
        expect(response.body.openapi).toBe('3.1.0');
        expect(response.body.servers).toEqual([{ url: API }]);
    });
});

describe('client authentication at the token endpoint', () => {
    // Any grant reaches client authentication first; a refresh is the shortest.
    const form = async (overrides: Record<string, string> = {}) => ({
        grant_type: 'refresh_token',
        refresh_token: 'prt_unknown',
        ...await agent.clientAuth(),
        ...overrides,
    });

    it('rejects a client assertion addressed to the token endpoint', async () => {
        const response = await token(await form({ client_assertion: await agent.assertion({ aud: TOKEN }) }), await agent.proof('POST', TOKEN));
        expect(response.status).toBe(401);
        expect(response.body.error).toBe('invalid_client');
    });

    it('rejects a client assertion with an audience array', async () => {
        const array = await agent.jwt({
            iss: AGENT_ID,
            sub: AGENT_ID,
            aud: [ISSUER, 'https://other.example'],
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 60,
            jti: crypto.randomBytes(16).toString('base64url'),
        });
        const response = await token(await form({ client_assertion: array }), await agent.proof('POST', TOKEN));
        expect(response.body.error).toBe('invalid_client');
    });

    it('rejects a reused assertion jti', async () => {
        const reused = await form();
        expect((await token(reused, await agent.proof('POST', TOKEN))).body.error).toBe('invalid_grant');
        const replay = await token(reused, await agent.proof('POST', TOKEN));
        expect(replay.status).toBe(401);
        expect(replay.body.error).toBe('invalid_client');
    });

    it.each(['poppy-browser+jwt', 'poppy-session+jwt', 'poppy-delegation+jwt', 'dpop+jwt'])('rejects a %s as a client assertion', async (typ) => {
        const response = await token(await form({ client_assertion: await agent.assertion({}, { typ }) }), await agent.proof('POST', TOKEN));
        expect(response.body.error).toBe('invalid_client');
    });

    it('rejects an agent whose metadata does not name itself', async () => {
        docs[AGENT_ID] = { ...(docs[AGENT_ID] as object), client_id: 'https://agent.example/other.json' };
        const response = await token(await form(), await agent.proof('POST', TOKEN));
        expect(response.status).toBe(401);
        expect(response.body.error).toBe('invalid_client');
    });

    it('rejects an agent whose key set is on another domain', async () => {
        docs[AGENT_ID] = { ...(docs[AGENT_ID] as object), jwks_uri: 'https://keys.example/jwks.json' };
        expect((await token(await form(), await agent.proof('POST', TOKEN))).body.error).toBe('invalid_client');
    });

    it('rejects a key set holding a private key', async () => {
        docs['https://agent.example/jwks.json'] = { keys: [{ ...agent.publicJwk, d: 'secret' }] };
        expect((await token(await form(), await agent.proof('POST', TOKEN))).body.error).toBe('invalid_client');
    });

    it('requires a DPoP proof at the token endpoint', async () => {
        const response = await token(await form());
        expect(response.status).toBe(400);
        expect(response.body.error).toBe('invalid_dpop_proof');
    });

    it('rejects a replayed DPoP proof at the token endpoint', async () => {
        const proof = await agent.proof('POST', TOKEN);
        expect((await token(await form(), proof)).body.error).toBe('invalid_grant');
        expect((await token(await form(), proof)).body.error).toBe('invalid_dpop_proof');
    });

    it('rejects a DPoP proof for another URL', async () => {
        const response = await token(await form(), await agent.proof('POST', 'https://archon.test/names/oauth/token'));
        expect(response.body.error).toBe('invalid_dpop_proof');
    });

    it('rejects repeated form parameters', async () => {
        const response = await request(app).post('/poppy/token')
            .type('form')
            .send('grant_type=refresh_token&grant_type=authorization_code')
            .set('DPoP', await agent.proof('POST', TOKEN));
        expect(response.body.error).toBe('invalid_request');
    });

    it('no longer has a grant that starts a Session', async () => {
        const response = await token({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: await agent.assertion({ sub: 'usr_1' }),
            ...await agent.clientAuth(),
        }, await agent.proof('POST', TOKEN));
        expect(response.body.error).toBe('unsupported_grant_type');
    });
});

describe('the OpenAPI interface, signed out', () => {
    it('answers lookups with the Session header alone', async () => {
        const response = await api('get', '/names/alice');
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ name: 'alice', did: ALICE });
    });

    it('refuses a request without the Session header', async () => {
        const response = await request(app).get('/poppy/api/directory').set('Poppy-Version', '0.4');
        expect(response.status).toBe(400);
        expect(response.body.error).toBe('invalid_session');
        expect(response.headers['www-authenticate']).toBeUndefined();
    });

    it('refuses a request without Poppy-Version, or with one it does not serve', async () => {
        const header = async () => agent.session('GET', `${API}/directory`, SESSION);
        const missing = await request(app).get('/poppy/api/directory').set('Poppy-Session', await header());
        expect(missing.status).toBe(400);
        expect(missing.body).toMatchObject({ error: 'version_unsupported' });

        const old = await request(app).get('/poppy/api/directory').set('Poppy-Session', await header()).set('Poppy-Version', '0.2');
        expect(old.body).toMatchObject({ error: 'version_unsupported' });
    });

    it('refuses a Session header signed for another request', async () => {
        const response = await request(app).get('/poppy/api/directory')
            .set('Poppy-Session', await agent.session('GET', `${API}/names/alice`, SESSION))
            .set('Poppy-Version', '0.4');
        expect(response.status).toBe(400);
        expect(response.body.error).toBe('invalid_session');
    });

    it('refuses a Session header used twice', async () => {
        const header = await agent.session('GET', `${API}/directory`, SESSION);
        const send = () => request(app).get('/poppy/api/directory').set('Poppy-Session', header).set('Poppy-Version', '0.4');
        expect((await send()).status).toBe(200);
        expect((await send()).body.error).toBe('invalid_session');
    });

    it('refuses a client it cannot load, as a Session error and not a token error', async () => {
        delete docs[AGENT_ID];
        const response = await api('get', '/directory');
        expect(response.status).toBe(400);
        expect(response.body.error).toBe('invalid_session');
    });

    it('asks for an access token, naming the scope, when a request needs the account', async () => {
        const response = await api('get', '/account');
        expect(response.status).toBe(401);
        const challenge = response.headers['www-authenticate'];
        expect(challenge).toMatch(/^DPoP /);
        expect(challenge).toContain('scope="profile:read"');
        expect(challenge).not.toContain('error=');
    });

    it('does not resolve wallet aliases as DIDs', async () => {
        const response = await api('get', '/dids/herald');
        expect(response.status).toBe(404);
    });
});

describe('the OpenAPI interface, signed in', () => {
    it('acts on the account the access token is for, within its scopes', async () => {
        const { signIn } = await signedIn();
        const account = await api('get', '/account', signIn.access_token);
        expect(account.status).toBe(200);
        expect(account.body).toMatchObject({ did: ALICE, name: 'alice' });

        const renamed = await api('put', '/account/name', signIn.access_token, { name: 'alicia' });
        expect(renamed.status).toBe(200);
    });

    it('refuses a Bearer access token, since its tokens are DPoP-bound', async () => {
        const { signIn } = await signedIn();
        const response = await request(app).get('/poppy/api/account')
            .set('Authorization', `Bearer ${signIn.access_token}`)
            .set('Poppy-Session', await agent.session('GET', `${API}/account`, SESSION, {}, signIn.access_token))
            .set('Poppy-Version', '0.4');
        expect(response.status).toBe(401);
        expect(response.headers['www-authenticate']).toContain('error="invalid_token"');
    });

    it('refuses a token in the URL', async () => {
        const { signIn } = await signedIn();
        const response = await request(app).get('/poppy/api/directory').query({ access_token: signIn.access_token });
        expect(response.status).toBe(400);
    });

    it('refuses a proof from a key other than the one the token is bound to', async () => {
        const { signIn } = await signedIn();
        const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
        const proof = await agent.proof('GET', `${API}/account`, signIn.access_token, privateKey as CryptoKey, await exportJWK(publicKey));
        const response = await request(app).get('/poppy/api/account')
            .set('Authorization', `DPoP ${signIn.access_token}`).set('DPoP', proof)
            .set('Poppy-Session', await agent.session('GET', `${API}/account`, SESSION, {}, signIn.access_token))
            .set('Poppy-Version', '0.4');
        expect(response.status).toBe(401);
        expect(response.headers['www-authenticate']).toContain('error="invalid_dpop_proof"');
    });

    it('refuses a valid token with a Session header that does not cover it', async () => {
        const { signIn } = await signedIn();
        const url = `${API}/account`;
        const response = await request(app).get('/poppy/api/account')
            .set('Authorization', `DPoP ${signIn.access_token}`)
            .set('DPoP', await agent.proof('GET', url, signIn.access_token))
            .set('Poppy-Session', await agent.session('GET', url, SESSION))
            .set('Poppy-Version', '0.4');
        expect(response.status).toBe(400);
        expect(response.body.error).toBe('invalid_session');
    });

    it('refuses a token issued to one agent in a Session header signed by another', async () => {
        const { signIn } = await signedIn();
        const other = await new TestAgent('https://other.example/agent.json').init();
        await other.newSessionKey();
        const otherDocs = other.docs() as Record<string, any>;
        docs['https://other.example/agent.json'] = { ...otherDocs['https://other.example/agent.json'], jwks_uri: 'https://other.example/jwks.json', redirect_uris: [] };
        docs['https://other.example/jwks.json'] = { keys: [other.publicJwk] };
        const url = `${API}/account`;
        // The other agent has the token and the key it is bound to, but not
        // the first agent's keys.
        const response = await request(app).get('/poppy/api/account')
            .set('Authorization', `DPoP ${signIn.access_token}`)
            .set('DPoP', await agent.proof('GET', url, signIn.access_token))
            .set('Poppy-Session', await other.session('GET', url, SESSION, {}, signIn.access_token))
            .set('Poppy-Version', '0.4');
        expect(response.status).toBe(400);
        expect(response.body.error).toBe('invalid_session');
    });

    it('lets one sign-in serve several Sessions', async () => {
        const { signIn } = await signedIn();
        expect((await api('get', '/account', signIn.access_token)).status).toBe(200);
        expect((await api('get', '/account', signIn.access_token, undefined, { sid: 'another-session', sub: SESSION.sub })).status).toBe(200);
    });

    it('ends a Session that is given a second account', async () => {
        const alice = (await signedIn(ALICE)).signIn;
        const bob = (await signedIn(BOB)).signIn;
        expect((await api('get', '/account', alice.access_token)).status).toBe(200);

        const mixed = await api('get', '/account', bob.access_token);
        expect(mixed.status).toBe(400);
        expect(mixed.body.error).toBe('session_ended');
        // A new Session for the second account works.
        expect((await api('get', '/account', bob.access_token, undefined, { sid: 'bobs-session', sub: 'usr_bob_1' })).status).toBe(200);
    });

    it('keeps a Session usable signed out after it has used an account', async () => {
        const { signIn } = await signedIn();
        expect((await api('get', '/account', signIn.access_token)).status).toBe(200);
        expect((await api('get', '/names/alice')).status).toBe(200);
        expect((await api('get', '/account')).status).toBe(401);
    });
});

describe('Direct Sign-In', () => {
    it('shows the agent, its domain and the scopes, and blocks framing', async () => {
        const { page } = await directSignIn(ALICE);
        expect(page.text).toContain('Example Agent');
        expect(page.text).toContain('agent.example');
        expect(page.text).toContain('name:write');
        expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    });

    it('exchanges the code for an access token and a refresh token, as RFC 6749 describes', async () => {
        const { redirect, verifier } = await directSignIn(ALICE);
        const response = await exchange(redirect, verifier);
        expect(response.status).toBe(200);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.body).toEqual({
            access_token: expect.stringMatching(/^pat_/),
            token_type: 'DPoP',
            expires_in: 3600,
            refresh_token: expect.stringMatching(/^prt_/),
            scope: 'profile:read name:write',
        });
    });

    it('needs no Session to sign in', async () => {
        const { redirect, verifier } = await directSignIn(ALICE);
        const response = await exchange(redirect, verifier, { session_id: 'ses_anything' });
        expect(response.status).toBe(200);
        expect(response.body.session_id).toBeUndefined();
    });

    it('includes iss and state in the redirect', async () => {
        const { redirect } = await directSignIn(ALICE);
        expect(redirect.origin + redirect.pathname).toBe(REDIRECT);
        expect(redirect.searchParams.get('state')).toBe('st-1');
        expect(redirect.searchParams.get('iss')).toBe(ISSUER);
    });

    it('grants only the scopes the User approved, and says which', async () => {
        const { signIn } = await signedIn(ALICE, 'profile:read name:write', ['profile:read']);
        expect(signIn.scope).toBe('profile:read');
        const write = await api('put', '/account/name', signIn.access_token, { name: 'x' });
        expect(write.status).toBe(403);
        expect(write.headers['www-authenticate']).toContain('error="insufficient_scope"');
        expect(write.headers['www-authenticate']).toContain('scope="name:write"');
    });

    it('ends as a decline when the User approves no scope', async () => {
        const { redirect } = await directSignIn(ALICE, 'profile:read name:write', []);
        expect(redirect.searchParams.get('error')).toBe('access_denied');
        expect(redirect.searchParams.has('code')).toBe(false);
    });

    it('sends access_denied with iss when the User declines', async () => {
        const { redirect } = await directSignIn(ALICE, 'profile:read', null);
        expect(redirect.searchParams.get('error')).toBe('access_denied');
        expect(redirect.searchParams.get('iss')).toBe(ISSUER);
        expect(redirect.searchParams.has('code')).toBe(false);
    });

    it('does not redirect to a redirect_uri the agent did not register', async () => {
        const response = await request(app).get('/poppy/authorize').query({
            response_type: 'code', client_id: AGENT_ID, redirect_uri: 'https://evil.example/cb',
            scope: 'profile:read', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256',
        });
        expect(response.status).toBe(400);
        expect(response.headers.location).toBeUndefined();
    });

    it('redirects invalid_scope with iss for an unknown scope, including one from draft 0.2', async () => {
        for (const scope of ['poppy:admin', 'poppy:read']) {
            const response = await request(app).get('/poppy/authorize').query({
                response_type: 'code', client_id: AGENT_ID, redirect_uri: REDIRECT, state: 's',
                scope, code_challenge: 'x'.repeat(43), code_challenge_method: 'S256',
            });
            expect(response.status).toBe(303);
            const location = new URL(response.headers.location);
            expect(location.searchParams.get('error')).toBe('invalid_scope');
            expect(location.searchParams.get('iss')).toBe(ISSUER);
        }
    });

    it('requires PKCE with S256', async () => {
        const response = await request(app).get('/poppy/authorize').query({
            response_type: 'code', client_id: AGENT_ID, redirect_uri: REDIRECT, scope: 'profile:read',
            code_challenge: 'x'.repeat(43), code_challenge_method: 'plain',
        });
        expect(new URL(response.headers.location).searchParams.get('error')).toBe('invalid_request');
    });

    it('refuses a decision without the page’s CSRF value', async () => {
        const page = await request(app).get('/poppy/authorize').query({
            response_type: 'code', client_id: AGENT_ID, redirect_uri: REDIRECT, scope: 'profile:read',
            code_challenge: 'x'.repeat(43), code_challenge_method: 'S256',
        });
        const cookie = page.headers['set-cookie'][0].split(';')[0];
        const decideUrl = /"decideUrl":"([^"]+)"/.exec(page.text)![1].replace(ISSUER, '/poppy');
        const response = await request(app).post(decideUrl).set('Cookie', cookie)
            .send({ decision: 'approve', scope: ['profile:read'] });
        expect(response.status).toBe(403);
    });

    it('issues the renamed scopes for a sign-in approved under the draft 0.2 names', async () => {
        const verifier = crypto.randomBytes(32).toString('base64url');
        await new PoppyStore(kv).putAuthCode('pac_before-upgrade', {
            clientId: AGENT_ID,
            redirectUri: REDIRECT,
            codeChallenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
            did: ALICE,
            scope: ['poppy:read', 'poppy:write'],
        }, Date.now() + 60_000);

        const response = await exchange(new URL(`${REDIRECT}?code=pac_before-upgrade`), verifier);
        expect(response.body.scope).toBe('profile:read name:write');
        expect((await api('put', '/account/name', response.body.access_token, { name: 'alicia' })).status).toBe(200);
    });

    it('accepts a code only once', async () => {
        const { redirect, verifier } = await directSignIn(ALICE, 'profile:read');
        expect((await exchange(redirect, verifier)).status).toBe(200);
        expect((await exchange(redirect, verifier)).body.error).toBe('invalid_grant');
    });
});

describe('loopback redirects', () => {
    const LOOPBACK = 'http://127.0.0.1/callback';

    function authorize(redirectUri: string) {
        return request(app).get('/poppy/authorize').query({
            response_type: 'code', client_id: AGENT_ID, redirect_uri: redirectUri, state: 's',
            scope: 'profile:read', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256',
        });
    }

    beforeEach(() => {
        docs[AGENT_ID] = { ...(docs[AGENT_ID] as object), redirect_uris: [REDIRECT, LOOPBACK, 'http://[::1]/callback'] };
    });

    it('accepts an agent that lists one, for an app on the User’s computer', async () => {
        expect((await authorize(REDIRECT)).status).toBe(200);
    });

    it.each(['http://127.0.0.1:51004/callback', 'http://127.0.0.1/callback', 'http://[::1]:8123/callback'])('matches %s whatever its port', async (uri) => {
        expect((await authorize(uri)).status).toBe(200);
    });

    it.each([
        'http://127.0.0.1:51004/other',
        'http://127.0.0.1:51004/callback?x=1',
        'http://localhost:51004/callback',
        'http://192.168.1.10:51004/callback',
        'https://127.0.0.1:51004/callback',
    ])('does not match %s', async (uri) => {
        const response = await authorize(uri);
        expect(response.status).toBe(400);
        expect(response.headers.location).toBeUndefined();
    });

    it('refuses an agent that lists an http redirect which is not loopback', async () => {
        docs[AGENT_ID] = { ...(docs[AGENT_ID] as object), redirect_uris: ['http://agent.example/callback'] };
        expect((await authorize('http://agent.example/callback')).status).toBe(400);
    });

    it('exchanges the code with the redirect_uri the request used, port included', async () => {
        const used = 'http://127.0.0.1:51004/callback';
        const verifier = crypto.randomBytes(32).toString('base64url');
        const page = await request(app).get('/poppy/authorize').query({
            response_type: 'code', client_id: AGENT_ID, redirect_uri: used, scope: 'profile:read',
            code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
        });
        const cookie = page.headers['set-cookie'][0].split(';')[0];
        const csrf = /"csrf":"([^"]+)"/.exec(page.text)![1];
        const decideUrl = /"decideUrl":"([^"]+)"/.exec(page.text)![1].replace(ISSUER, '/poppy');
        const walletChallenge = decodeURIComponent(/challenge=([^"&]+)/.exec(page.text)![1]);
        await request(app).post('/poppy/signin/response')
            .send({ response: JSON.stringify({ challenge: walletChallenge, responder: ALICE }) }).expect(200);
        const decided = await request(app).post(decideUrl).set('Cookie', cookie).set('X-Poppy-CSRF', csrf)
            .send({ decision: 'approve', scope: ['profile:read'] });
        const redirect = new URL(decided.body.redirect);
        expect(redirect.origin + redirect.pathname).toBe(used);

        const form = async (redirectUri: string) => ({
            grant_type: 'authorization_code', code: redirect.searchParams.get('code')!,
            redirect_uri: redirectUri, code_verifier: verifier, ...await agent.clientAuth(),
        });
        expect((await token(await form(used), await agent.proof('POST', TOKEN))).status).toBe(200);
    });
});

describe('refresh tokens and signing out', () => {
    it('issues a new access token, narrowed on request, and keeps the refresh token', async () => {
        const { signIn } = await signedIn();
        const response = await refresh(signIn.refresh_token, { scope: 'profile:read' });
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ token_type: 'DPoP', scope: 'profile:read' });
        expect(response.body.access_token).not.toBe(signIn.access_token);
        expect(response.body.refresh_token).toBeUndefined();
        expect((await api('put', '/account/name', response.body.access_token, { name: 'x' })).status).toBe(403);
    });

    it('cannot widen the scopes of a refresh token', async () => {
        const { signIn } = await signedIn(ALICE, 'profile:read');
        const response = await refresh(signIn.refresh_token, { scope: 'profile:read name:write' });
        expect(response.body.error).toBe('invalid_scope');
    });

    it('accepts a refresh token only from the client it was issued to', async () => {
        const { signIn } = await signedIn();
        // A second agent on its own domain, with its own keys.
        const other = await new TestAgent('https://other.example/agent.json').init();
        const otherDocs = other.docs() as Record<string, any>;
        docs['https://other.example/agent.json'] = { ...otherDocs['https://other.example/agent.json'], jwks_uri: 'https://other.example/jwks.json', redirect_uris: [] };
        docs['https://other.example/jwks.json'] = { keys: [other.publicJwk] };
        const response = await token({
            grant_type: 'refresh_token',
            refresh_token: signIn.refresh_token,
            ...await other.clientAuth(),
        }, await other.proof('POST', TOKEN));
        expect(response.body.error).toBe('invalid_grant');
    });

    it('signs out at once when the refresh token is revoked', async () => {
        const { signIn } = await signedIn();
        const revoked = await request(app).post('/poppy/revoke').type('form').send({
            token: signIn.refresh_token,
            token_type_hint: 'refresh_token',
            ...await agent.clientAuth(),
        });
        expect(revoked.status).toBe(200);

        const account = await api('get', '/account', signIn.access_token);
        expect(account.status).toBe(401);
        expect(account.headers['www-authenticate']).toContain('error="invalid_token"');
        expect((await refresh(signIn.refresh_token)).body.error).toBe('invalid_grant');

        // The Session continues signed out.
        expect((await api('get', '/names/alice')).status).toBe(200);
    });

    it('lists connected agents for account settings and disconnects them', async () => {
        const { signIn } = await signedIn();
        const connections = await poppy.listConnections(ALICE);
        expect(connections).toEqual([expect.objectContaining({
            clientId: AGENT_ID,
            name: 'Example Agent',
            domain: 'agent.example',
            scope: ['name:write', 'profile:read'],
        })]);
        expect(await poppy.disconnect(BOB, connections[0].id)).toBe(false);
        expect(await poppy.disconnect(ALICE, connections[0].id)).toBe(true);
        expect(await poppy.listConnections(ALICE)).toEqual([]);
        expect((await refresh(signIn.refresh_token)).body.error).toBe('invalid_grant');
    });

    it('reads a grant issued under the draft 0.2 scope names as the scopes that replace them', async () => {
        const { signIn } = await signedIn();
        const [connection] = await poppy.listConnections(ALICE);
        expect(connection).toBeDefined();
        // Rewrite the stored grant as draft 0.2 left it.
        const key = (await kv.members(`grants-by-did:${ALICE}`))[0];
        const stored = JSON.parse((await kv.get(`grant:${key}`))!);
        await kv.set(`grant:${key}`, JSON.stringify({ ...stored, scope: ['poppy:read', 'poppy:write'], userId: 'usr_alice_1' }), 3600);

        const response = await refresh(signIn.refresh_token);
        expect(response.body.scope).toBe('profile:read name:write');
        expect((await api('get', '/account', response.body.access_token)).status).toBe(200);
    });
});

describe('Device Sign-In', () => {
    async function authorizeDevice(scope = 'profile:read') {
        const response = await request(app).post('/poppy/device_authorization').type('form')
            .send({ scope, ...await agent.clientAuth() });
        expect(response.status).toBe(200);
        return response.body;
    }

    async function approveOnPage(userCode: string, did: string, decision: 'approve' | 'decline') {
        const opened = await request(app).get('/poppy/device').query({ user_code: userCode });
        expect(opened.status).toBe(200);
        const page = await request(app).post('/poppy/device').type('form').send({ user_code: userCode.toLowerCase() });
        expect(page.status).toBe(200);
        expect(page.text).toContain(userCode);
        const cookie = page.headers['set-cookie'][0].split(';')[0];
        const csrf = /"csrf":"([^"]+)"/.exec(page.text)![1];
        const decideUrl = /"decideUrl":"([^"]+)"/.exec(page.text)![1].replace(ISSUER, '/poppy');
        const walletChallenge = decodeURIComponent(/challenge=([^"&]+)/.exec(page.text)![1]);
        await request(app).post('/poppy/signin/response')
            .send({ response: JSON.stringify({ challenge: walletChallenge, responder: did }) }).expect(200);
        return request(app).post(decideUrl).set('Cookie', cookie).set('X-Poppy-CSRF', csrf)
            .send({ decision, scope: ['profile:read'] });
    }

    it('issues a device code and user code', async () => {
        const device = await authorizeDevice();
        expect(device.user_code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
        expect(device.verification_uri).toBe(`${ISSUER}/device`);
        expect(device.verification_uri_complete).toContain(encodeURIComponent(device.user_code));
        expect(device.interval).toBe(5);
    });

    it('stays pending until the User approves, and does not approve on opening the link', async () => {
        const device = await authorizeDevice();
        await request(app).get('/poppy/device').query({ user_code: device.user_code });
        expect((await pollDevice(device.device_code)).body.error).toBe('authorization_pending');
        expect((await pollDevice(device.device_code)).body.error).toBe('slow_down');

        const decided = await approveOnPage(device.user_code, ALICE, 'approve');
        expect(decided.status).toBe(200);

        const signIn = await pollDevice(device.device_code);
        expect(signIn.status).toBe(200);
        expect(signIn.body).toMatchObject({ token_type: 'DPoP', scope: 'profile:read' });
        expect(signIn.body.refresh_token).toMatch(/^prt_/);
        expect((await api('get', '/account', signIn.body.access_token)).status).toBe(200);
    });

    it('returns access_denied when the User declines', async () => {
        const device = await authorizeDevice();
        await approveOnPage(device.user_code, ALICE, 'decline');
        expect((await pollDevice(device.device_code)).body.error).toBe('access_denied');
    });

    it('rejects an unknown user code without starting a sign-in', async () => {
        const response = await request(app).post('/poppy/device').type('form').send({ user_code: 'BBBB-BBBB' });
        expect(response.status).toBe(400);
        expect(response.headers['set-cookie']).toBeUndefined();
    });
});

describe('concurrent and repeated requests', () => {
    it('rejects scopes inherited from Object.prototype', async () => {
        const response = await request(app).post('/poppy/device_authorization').type('form')
            .send({ scope: 'constructor', ...await agent.clientAuth() });
        expect(response.body.error).toBe('invalid_scope');
        const page = await request(app).get('/poppy/authorize').query({
            response_type: 'code', client_id: AGENT_ID, redirect_uri: REDIRECT, scope: 'toString',
            code_challenge: 'x'.repeat(43), code_challenge_method: 'S256',
        });
        expect(new URL(page.headers.location).searchParams.get('error')).toBe('invalid_scope');
    });

    it('binds a Session to one account when requests for two accounts race', async () => {
        const alice = (await signedIn(ALICE, 'profile:read')).signIn;
        const bob = (await signedIn(BOB, 'profile:read')).signIn;
        const results = await Promise.all([
            api('get', '/account', alice.access_token),
            api('get', '/account', bob.access_token),
        ]);
        expect(results.map(result => result.status).sort()).toEqual([200, 400]);
        expect(results.find(result => result.status === 400)!.body.error).toBe('session_ended');
    });

    it('acts on a consent decision only once', async () => {
        const page = await request(app).get('/poppy/authorize').query({
            response_type: 'code', client_id: AGENT_ID, redirect_uri: REDIRECT, scope: 'profile:read',
            code_challenge: 'x'.repeat(43), code_challenge_method: 'S256',
        });
        const cookie = page.headers['set-cookie'][0].split(';')[0];
        const csrf = /"csrf":"([^"]+)"/.exec(page.text)![1];
        const decideUrl = /"decideUrl":"([^"]+)"/.exec(page.text)![1].replace(ISSUER, '/poppy');
        const walletChallenge = decodeURIComponent(/challenge=([^"&]+)/.exec(page.text)![1]);
        await request(app).post('/poppy/signin/response')
            .send({ response: JSON.stringify({ challenge: walletChallenge, responder: ALICE }) }).expect(200);
        // A second wallet response cannot change the account.
        await request(app).post('/poppy/signin/response')
            .send({ response: JSON.stringify({ challenge: walletChallenge, responder: BOB }) }).expect(409);

        const decide = () => request(app).post(decideUrl).set('Cookie', cookie).set('X-Poppy-CSRF', csrf)
            .send({ decision: 'approve', scope: ['profile:read'] });
        const results = await Promise.all([decide(), decide()]);
        expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    });

    it('issues one refresh token from one device approval, however many polls race', async () => {
        const device = (await request(app).post('/poppy/device_authorization').type('form')
            .send({ scope: 'profile:read', ...await agent.clientAuth() })).body;
        const page = await request(app).post('/poppy/device').type('form').send({ user_code: device.user_code });
        const cookie = page.headers['set-cookie'][0].split(';')[0];
        const csrf = /"csrf":"([^"]+)"/.exec(page.text)![1];
        const decideUrl = /"decideUrl":"([^"]+)"/.exec(page.text)![1].replace(ISSUER, '/poppy');
        const walletChallenge = decodeURIComponent(/challenge=([^"&]+)/.exec(page.text)![1]);
        await request(app).post('/poppy/signin/response')
            .send({ response: JSON.stringify({ challenge: walletChallenge, responder: ALICE }) }).expect(200);
        await request(app).post(decideUrl).set('Cookie', cookie).set('X-Poppy-CSRF', csrf)
            .send({ decision: 'approve', scope: ['profile:read'] }).expect(200);

        const poll = async () => token({
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            device_code: device.device_code,
            ...await agent.clientAuth(),
        }, await agent.proof('POST', TOKEN));
        const results = await Promise.all([poll(), poll(), poll()]);
        expect(results.filter(result => result.status === 200)).toHaveLength(1);
        expect(await poppy.listConnections(ALICE)).toHaveLength(1);
    });

    it('keeps a device decision when a poll writes its polling state afterwards', async () => {
        const store = new PoppyStore(kv);
        const device = { clientId: AGENT_ID, scope: ['profile:read'], userCode: 'BCDF-GHJK', interval: 5, expiresAt: Date.now() + 60_000 };
        await store.putDevice('pdc_test', device);
        const hash = crypto.createHash('sha256').update('pdc_test').digest('base64url');
        expect(await store.decideDevice(hash, device, { approved: true, did: ALICE, scope: ['profile:read'] })).toBe(true);
        await store.putDevicePolling(hash, device, { interval: 5, lastPollAt: Date.now() });
        expect(await store.getDeviceDecision(hash)).toMatchObject({ approved: true, did: ALICE });
        expect(await store.decideDevice(hash, device, { approved: false })).toBe(false);
    });

    it('does not recreate a grant that was revoked while a refresh was in flight', async () => {
        const { signIn } = await signedIn();
        const store = new PoppyStore(kv);
        const grant = (await store.getGrantByToken(signIn.refresh_token))!;
        await store.revokeGrant(grant);
        expect(await store.touchGrant(grant)).toBe(false);
        expect(await store.getGrant(grant.id)).toBeNull();
        expect(await poppy.listConnections(ALICE)).toEqual([]);
    });

    it('disconnects every grant an agent holds for the account', async () => {
        const first = await signedIn(ALICE, 'profile:read');
        const second = await signedIn(ALICE, 'name:write');
        const connections = await poppy.listConnections(ALICE);
        expect(connections).toHaveLength(1);
        expect(connections[0].scope).toEqual(['name:write', 'profile:read']);

        expect(await poppy.disconnect(ALICE, connections[0].id)).toBe(true);
        for (const { signIn } of [first, second]) {
            const account = await api('get', '/account', signIn.access_token);
            expect(account.status).toBe(401);
        }
        expect(await poppy.listConnections(ALICE)).toEqual([]);
    });
});

describe('agent metadata fetching', () => {
    it('shares one fetch between concurrent requests for the same agent', async () => {
        const directory = new AgentDirectory(fetcherFor(() => docs));
        fetches.length = 0;
        await Promise.all([directory.get(AGENT_ID), directory.get(AGENT_ID), directory.get(AGENT_ID)]);
        expect(fetches.filter(url => url === AGENT_ID)).toHaveLength(1);
        expect(fetches.filter(url => url.endsWith('/jwks.json'))).toHaveLength(1);
    });

    it('caches a bounded number of documents', async () => {
        const directory = new AgentDirectory(fetcherFor(() => ({})));
        for (let i = 0; i < 1005; i++) {
            await directory.get(`https://agent${i}.example/agent.json`).catch(() => undefined);
        }
        fetches.length = 0;
        // The earliest entries were evicted, so they are fetched again.
        await directory.get('https://agent0.example/agent.json').catch(() => undefined);
        expect(fetches).toEqual(['https://agent0.example/agent.json']);
    });

    it('spends the new-client budget before fetching for an unknown agent at /authorize', async () => {
        // The budget is Drawbridge's global allowance, 1200 a minute.
        for (let i = 0; i < 1200; i++) {
            await request(app).get('/poppy/authorize').query({ client_id: `https://a${i}.example/agent.json`, redirect_uri: REDIRECT });
        }
        fetches.length = 0;
        const response = await request(app).get('/poppy/authorize').query({ client_id: 'https://late.example/agent.json', redirect_uri: REDIRECT });
        expect(response.status).toBe(400);
        expect(response.text).toContain('too many new client_id values');
        expect(fetches).toEqual([]);
    });
});

describe('second review', () => {
    async function openDevicePage(userCode: string, did: string) {
        const page = await request(app).post('/poppy/device').type('form').send({ user_code: userCode });
        expect(page.status).toBe(200);
        const cookie = page.headers['set-cookie'][0].split(';')[0];
        const csrf = /"csrf":"([^"]+)"/.exec(page.text)![1];
        const decideUrl = /"decideUrl":"([^"]+)"/.exec(page.text)![1].replace(ISSUER, '/poppy');
        const walletChallenge = decodeURIComponent(/challenge=([^"&]+)/.exec(page.text)![1]);
        await request(app).post('/poppy/signin/response')
            .send({ response: JSON.stringify({ challenge: walletChallenge, responder: did }) }).expect(200);
        return () => request(app).post(decideUrl).set('Cookie', cookie).set('X-Poppy-CSRF', csrf)
            .send({ decision: 'approve', scope: ['profile:read'] });
    }

    async function authorizeDevice() {
        return (await request(app).post('/poppy/device_authorization').type('form')
            .send({ scope: 'profile:read', ...await agent.clientAuth() })).body;
    }

    it('accepts one device decision even from two open consent pages', async () => {
        const device = await authorizeDevice();
        const first = await openDevicePage(device.user_code, ALICE);
        const second = await openDevicePage(device.user_code, ALICE);

        expect((await first()).status).toBe(200);
        expect((await pollDevice(device.device_code)).status).toBe(200);
        // The second page answers after the decision was consumed.
        expect((await second()).status).toBe(410);
        expect((await pollDevice(device.device_code)).body.error).toBe('invalid_grant');
        expect((await poppy.listConnections(ALICE))).toHaveLength(1);
    });

    it('accepts the DPoP authentication scheme in any case', async () => {
        const { signIn } = await signedIn();
        const url = `${API}/account`;
        const response = await request(app).get('/poppy/api/account')
            .set('Authorization', `dpop ${signIn.access_token}`)
            .set('DPoP', await agent.proof('GET', url, signIn.access_token))
            .set('Poppy-Session', await agent.session('GET', url, SESSION, {}, signIn.access_token))
            .set('Poppy-Version', '0.4');
        expect(response.status).toBe(200);
    });

    it('issues what the User granted at a sign-in exchange, whatever scope it is sent', async () => {
        const { redirect, verifier } = await directSignIn(ALICE, 'profile:read');
        const response = await exchange(redirect, verifier, { scope: 'profile:read name:write' });
        expect(response.status).toBe(200);
        expect(response.body.scope).toBe('profile:read');
    });
});

describe('independent review', () => {
    it('tells the wallet which agent a sign-in connects, with what access', async () => {
        await directSignIn(ALICE);
        expect(descriptions[0]).toContain('“Example Agent” from agent.example');
        expect(descriptions[0]).toContain('archon.test account');
        expect(descriptions[0]).toContain('Claim, change or release your Herald name');
        expect(descriptions[0]).toContain('Continue only if you started this from your own agent');
    });

    it('includes the user code in a device sign-in challenge', async () => {
        const device = (await request(app).post('/poppy/device_authorization').type('form')
            .send({ scope: 'profile:read', ...await agent.clientAuth() })).body;
        await request(app).post('/poppy/device').type('form').send({ user_code: device.user_code }).expect(200);
        expect(descriptions.at(-1)).toContain(`Code ${device.user_code}`);
    });

    it('renders the wallet QR code as inline SVG and loads no third-party script', async () => {
        const { page } = await directSignIn(ALICE, 'profile:read');
        expect(page.text).toContain('<svg');
        expect(page.text).not.toContain('cdn.jsdelivr.net');
        expect(page.headers['content-security-policy']).not.toContain('https://cdn');
        expect(page.headers['content-security-policy']).toMatch(/script-src 'nonce-[^']+';/);
    });

    it('limits sign-in pages per agent, so one agent cannot block another', async () => {
        const open = (clientId: string, redirectUri: string) => request(app).get('/poppy/authorize').query({
            response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: 'profile:read',
            code_challenge: 'x'.repeat(43), code_challenge_method: 'S256',
        });
        for (let i = 0; i < 60; i++) {
            expect((await open(AGENT_ID, REDIRECT)).status).toBe(200);
        }
        expect((await open(AGENT_ID, REDIRECT)).status).toBe(429);

        const other = await new TestAgent('https://other.example/agent.json').init();
        const otherDocs = other.docs() as Record<string, any>;
        docs['https://other.example/agent.json'] = {
            ...otherDocs['https://other.example/agent.json'],
            jwks_uri: 'https://other.example/jwks.json',
            redirect_uris: ['https://other.example/cb'],
        };
        docs['https://other.example/jwks.json'] = { keys: [other.publicJwk] };
        expect((await open('https://other.example/agent.json', 'https://other.example/cb')).status).toBe(200);
    });

    it('counts only failed user codes, so junk entries do not block a valid one', async () => {
        const device = (await request(app).post('/poppy/device_authorization').type('form')
            .send({ scope: 'profile:read', ...await agent.clientAuth() })).body;
        for (let i = 0; i < 100; i++) {
            await request(app).post('/poppy/device').type('form').send({ user_code: 'BBBB-BBBB' }).expect(400);
        }
        await request(app).post('/poppy/device').type('form').send({ user_code: device.user_code }).expect(200);
    });

    it('answers expired_token to every poll after a device code expires', async () => {
        // Device codes that expire as soon as they are issued.
        const local = createPoppy({
            config: { ...createPoppyConfig(ORIGIN, 'archon.test', 'https://wallet.archon.test'), deviceCodeSeconds: 0 },
            store: new PoppyStore(new MemoryKV()),
            agents: new AgentDirectory(fetcherFor(() => docs)),
            accounts: fakeAccounts().accounts,
        });
        const localApp = express();
        localApp.use(express.urlencoded({ extended: true }));
        localApp.use('/poppy', local.router);
        const post = async (form: Record<string, string>) => request(localApp).post('/poppy/token').type('form')
            .set('DPoP', await agent.proof('POST', TOKEN)).send({ ...form, ...await agent.clientAuth() });

        const device = (await request(localApp).post('/poppy/device_authorization').type('form')
            .send({ scope: 'profile:read', ...await agent.clientAuth() })).body;
        for (let i = 0; i < 2; i++) {
            const poll = await post({
                grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
                device_code: device.device_code,
            });
            expect(poll.body.error).toBe('expired_token');
        }
    });
});

describe('token endpoint refusals', () => {
    // Reaches the grant only if client authentication and the resource pass.
    const refreshing = async (extra: Record<string, string> = {}) => token({
        grant_type: 'refresh_token',
        refresh_token: 'prt_unknown',
        ...await agent.clientAuth(),
        ...extra,
    }, await agent.proof('POST', TOKEN));

    it('requires private_key_jwt client authentication', async () => {
        const response = await refreshing({ client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:saml2-bearer' });
        expect(response.status).toBe(401);
        expect(response.body).toMatchObject({ error: 'invalid_client', error_description: 'private_key_jwt client authentication is required' });
    });

    it('rejects a client assertion whose sub is not the client_id', async () => {
        const response = await refreshing({ client_assertion: await agent.assertion({ sub: 'usr_1' }) });
        expect(response.status).toBe(401);
        expect(response.body).toMatchObject({ error: 'invalid_client', error_description: 'client assertion sub must be the client_id' });
    });

    it('rejects a grant type it does not support', async () => {
        const response = await token({ grant_type: 'password', ...await agent.clientAuth() }, await agent.proof('POST', TOKEN));
        expect(response.status).toBe(400);
        expect(response.body.error).toBe('unsupported_grant_type');
    });

    it('issues tokens for the domain as a resource, and for no other', async () => {
        const other = await refreshing({ resource: 'https://other.example/api' });
        expect(other.status).toBe(400);
        expect(other.body.error).toBe('invalid_target');
        expect((await refreshing({ resource: API })).body.error).toBe('invalid_target');

        const { signIn } = await signedIn();
        expect((await refresh(signIn.refresh_token, { resource: 'https://archon.test' })).status).toBe(200);
    });

    it('refuses a refresh without a refresh token', async () => {
        const response = await token({ grant_type: 'refresh_token', ...await agent.clientAuth() }, await agent.proof('POST', TOKEN));
        expect(response.status).toBe(400);
        expect(response.body.error).toBe('invalid_grant');
    });

    it('rejects a code_verifier that does not match, and the code cannot be retried', async () => {
        const { redirect, verifier } = await directSignIn(ALICE, 'profile:read');
        const wrong = await exchange(redirect, crypto.randomBytes(32).toString('base64url'));
        expect(wrong.status).toBe(400);
        expect(wrong.body).toMatchObject({ error: 'invalid_grant', error_description: 'code_verifier does not match' });

        const retry = await exchange(redirect, verifier);
        expect(retry.body.error).toBe('invalid_grant');
        expect(await poppy.listConnections(ALICE)).toEqual([]);
    });

    it('rejects a code_verifier too short to be a PKCE verifier', async () => {
        const { redirect } = await directSignIn(ALICE, 'profile:read');
        const response = await exchange(redirect, 'short');
        expect(response.body).toMatchObject({ error: 'invalid_grant', error_description: 'code_verifier does not match' });
    });

    it('limits token requests per client to 300 a minute, naming when to retry', async () => {
        const revoke = async () => request(app).post('/poppy/revoke').type('form')
            .send({ token: 'prt_unknown', ...await agent.clientAuth() });
        for (let i = 0; i < 300; i++) {
            expect((await revoke()).status).toBe(200);
        }
        const limited = await revoke();
        expect(limited.status).toBe(429);
        expect(limited.body.error).toBeUndefined();
        expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('requires at least one scope for device authorization', async () => {
        for (const scope of [undefined, ' ']) {
            const form: Record<string, string> = { ...await agent.clientAuth() };
            if (scope !== undefined) {
                form.scope = scope;
            }
            const response = await request(app).post('/poppy/device_authorization').type('form').send(form);
            expect(response.status).toBe(400);
            expect(response.body).toMatchObject({ error: 'invalid_scope', error_description: 'scope is required' });
        }
    });

    it('answers server_error, not success, when a revocation cannot reach the store', async () => {
        const { signIn } = await signedIn();
        const get = jest.spyOn(kv, 'get').mockRejectedValue(new Error('store unavailable'));
        const response = await request(app).post('/poppy/revoke').type('form')
            .send({ token: signIn.refresh_token, ...await agent.clientAuth() });
        get.mockRestore();
        expect(response.status).toBe(500);
        expect(response.body.error).toBe('server_error');
        expect(await poppy.listConnections(ALICE)).toHaveLength(1);
    });
});

describe('authorization request refusals', () => {
    const query = {
        response_type: 'code', client_id: AGENT_ID, redirect_uri: REDIRECT, scope: 'profile:read', state: 'st-2',
        code_challenge: 'x'.repeat(43), code_challenge_method: 'S256',
    };

    it('shows an error page, without redirecting, when client_id is missing', async () => {
        const { client_id: _omitted, ...rest } = query;
        const response = await request(app).get('/poppy/authorize').query(rest);
        expect(response.status).toBe(400);
        expect(response.text).toContain('client_id is missing');
        expect(response.headers.location).toBeUndefined();
    });

    it('redirects unsupported_response_type with state and iss for anything but code', async () => {
        const response = await request(app).get('/poppy/authorize').query({ ...query, response_type: 'token' });
        expect(response.status).toBe(303);
        const location = new URL(response.headers.location);
        expect(location.searchParams.get('error')).toBe('unsupported_response_type');
        expect(location.searchParams.get('state')).toBe('st-2');
        expect(location.searchParams.get('iss')).toBe(ISSUER);
    });

    it('redirects server_error when the wallet challenge cannot be created', async () => {
        jest.spyOn(accounts, 'createChallenge').mockRejectedValue(new Error('keymaster unavailable'));
        const response = await request(app).get('/poppy/authorize').query(query);
        expect(response.status).toBe(303);
        expect(new URL(response.headers.location).searchParams.get('error')).toBe('server_error');
    });
});

describe('sign-in page and wallet response refusals', () => {
    async function openPage() {
        const page = await request(app).get('/poppy/authorize').query({
            response_type: 'code', client_id: AGENT_ID, redirect_uri: REDIRECT, scope: 'profile:read',
            code_challenge: 'x'.repeat(43), code_challenge_method: 'S256',
        });
        expect(page.status).toBe(200);
        return {
            cookie: page.headers['set-cookie'][0].split(';')[0],
            csrf: /"csrf":"([^"]+)"/.exec(page.text)![1],
            statusUrl: /"statusUrl":"([^"]+)"/.exec(page.text)![1].replace(ISSUER, '/poppy'),
            decideUrl: /"decideUrl":"([^"]+)"/.exec(page.text)![1].replace(ISSUER, '/poppy'),
            walletChallenge: decodeURIComponent(/challenge=([^"&]+)/.exec(page.text)![1]),
        };
    }

    it('reports sign-in status only to the browser that opened the page', async () => {
        const { cookie, statusUrl } = await openPage();
        expect((await request(app).get(statusUrl).set('Cookie', cookie)).body).toEqual({ status: 'pending' });

        expect((await request(app).get('/poppy/signin/sgn_unknown/status').set('Cookie', cookie)).status).toBe(404);
        const noCookie = await request(app).get(statusUrl);
        expect(noCookie.status).toBe(404);
        expect(noCookie.body.error).toBe('sign_in_not_found');
        const [name] = cookie.split('=');
        expect((await request(app).get(statusUrl).set('Cookie', `${name}=wrong-secret`)).status).toBe(404);
        expect((await request(app).get(statusUrl).set('Cookie', `other=1; ${name}=`)).status).toBe(404);
    });

    it('refuses a decision before the wallet has answered', async () => {
        const { cookie, csrf, decideUrl } = await openPage();
        const response = await request(app).post(decideUrl).set('Cookie', cookie).set('X-Poppy-CSRF', csrf)
            .send({ decision: 'approve', scope: ['profile:read'] });
        expect(response.status).toBe(409);
        expect(response.body.error_description).toBe('Sign in with your wallet first.');
    });

    it('refuses wallet responses that are missing, unverified, unknown or unreadable', async () => {
        const { walletChallenge, cookie, statusUrl } = await openPage();
        const respond = (body: object) => request(app).post('/poppy/signin/response').send(body);

        expect((await respond({})).status).toBe(400);
        expect((await respond({})).body.error).toBe('missing_response');

        const unverified = await respond({ response: JSON.stringify({ challenge: walletChallenge }) });
        expect(unverified.status).toBe(401);
        expect(unverified.body.error).toBe('invalid_response');

        const unknown = await respond({ response: JSON.stringify({ challenge: 'did:cid:other-challenge', responder: ALICE }) });
        expect(unknown.status).toBe(400);
        expect(unknown.body.error).toBe('unknown_challenge');

        const unreadable = await respond({ response: 'not json' });
        expect(unreadable.status).toBe(500);
        expect(unreadable.body.error).toBe('server_error');

        // None of them signed the page in.
        expect((await request(app).get(statusUrl).set('Cookie', cookie)).body).toEqual({ status: 'pending' });
    });
});

describe('device page limits', () => {
    async function authorizeDevice() {
        return (await request(app).post('/poppy/device_authorization').type('form')
            .send({ scope: 'profile:read', ...await agent.clientAuth() })).body;
    }

    it('limits device sign-in pages per agent', async () => {
        const device = await authorizeDevice();
        for (let i = 0; i < 60; i++) {
            expect((await request(app).post('/poppy/device').type('form').send({ user_code: device.user_code })).status).toBe(200);
        }
        const limited = await request(app).post('/poppy/device').type('form').send({ user_code: device.user_code });
        expect(limited.status).toBe(429);
        expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
        expect(limited.headers['set-cookie']).toBeUndefined();
    });

    it('stops accepting user codes after 1200 failed entries a minute', async () => {
        const device = await authorizeDevice();
        for (let i = 0; i < 1200; i++) {
            await request(app).post('/poppy/device').type('form').send({ user_code: 'BBBB-BBBB' });
        }
        const blocked = await request(app).post('/poppy/device').type('form').send({ user_code: device.user_code });
        expect(blocked.status).toBe(429);
        expect(blocked.text).toContain('Too many attempts');
        expect(blocked.headers['set-cookie']).toBeUndefined();
    });

    it('shows an error when the agent’s metadata can no longer be loaded', async () => {
        let clock = Date.now();
        const local = createPoppy({
            config: createPoppyConfig(ORIGIN, 'archon.test', 'https://wallet.archon.test'),
            store: new PoppyStore(new MemoryKV(() => clock), () => clock),
            agents: new AgentDirectory(fetcherFor(() => docs), () => clock),
            accounts,
            now: () => clock,
        });
        const localApp = express();
        localApp.use('/poppy', local.router);
        const device = (await request(localApp).post('/poppy/device_authorization').type('form')
            .send({ scope: 'profile:read', ...await agent.clientAuth() })).body;

        // The agent withdraws its metadata and Herald's cached copy expires.
        delete docs[AGENT_ID];
        clock += 301_000;
        const response = await request(localApp).post('/poppy/device').type('form').send({ user_code: device.user_code });
        expect(response.status).toBe(400);
        expect(response.text).toContain('could not be loaded');
        expect(response.headers['set-cookie']).toBeUndefined();
    });
});

describe('OpenAPI interface refusals', () => {
    it('rejects an access token it did not issue', async () => {
        const forged = 'pat_forged';
        const response = await api('get', '/directory', forged);
        expect(response.status).toBe(401);
        expect(response.headers['www-authenticate']).toContain('error="invalid_token"');
    });

    it('rejects a proof that does not cover the access token', async () => {
        const { signIn } = await signedIn();
        const url = `${API}/account`;
        const response = await request(app).get('/poppy/api/account')
            .set('Authorization', `DPoP ${signIn.access_token}`)
            .set('DPoP', await agent.proof('GET', url))
            .set('Poppy-Session', await agent.session('GET', url, SESSION, {}, signIn.access_token))
            .set('Poppy-Version', '0.4');
        expect(response.status).toBe(401);
        expect(response.headers['www-authenticate']).toContain('error="invalid_dpop_proof"');
    });

    it('limits each Session to 120 requests a minute, with Retry-After and no error code', async () => {
        for (let i = 0; i < 120; i++) {
            expect((await api('get', '/directory')).status).toBe(200);
        }
        const limited = await api('get', '/directory');
        expect(limited.status).toBe(429);
        expect(limited.body).toEqual({});
        expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
        // Another Session of the same User is not held back by it.
        expect((await api('get', '/directory', undefined, undefined, { sid: 'another-session', sub: SESSION.sub })).status).toBe(200);
    });

    it('spends the new-client budget on a Session header from an agent it has not seen', async () => {
        // A verified agent is known from here on.
        expect((await api('get', '/directory')).status).toBe(200);
        // The budget is Drawbridge's global allowance, 1200 a minute.
        for (let i = 0; i < 1200; i++) {
            await request(app).get('/poppy/authorize').query({ client_id: `https://a${i}.example/agent.json`, redirect_uri: REDIRECT });
        }
        const stranger = await new TestAgent('https://late.example/agent.json').init();
        await stranger.newSessionKey();
        fetches.length = 0;
        const response = await request(app).get('/poppy/api/directory')
            .set('Poppy-Session', await stranger.session('GET', `${API}/directory`, SESSION))
            .set('Poppy-Version', '0.4');
        expect(response.status).toBe(429);
        expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
        expect(fetches).toEqual([]);

        expect((await api('get', '/directory')).status).toBe(200);
    });

    it('fails closed when the store cannot be read', async () => {
        const { signIn } = await signedIn();
        const url = `${API}/account`;
        const proof = await agent.proof('GET', url, signIn.access_token);
        const header = await agent.session('GET', url, SESSION, {}, signIn.access_token);
        jest.spyOn(kv, 'get').mockRejectedValue(new Error('store unavailable'));
        const response = await request(app).get('/poppy/api/account')
            .set('Authorization', `DPoP ${signIn.access_token}`).set('DPoP', proof)
            .set('Poppy-Session', header).set('Poppy-Version', '0.4');
        expect(response.status).toBe(500);
        expect(response.body).not.toHaveProperty('did');
    });

    it('answers server_error when Herald cannot answer', async () => {
        jest.spyOn(accounts, 'directory').mockRejectedValue(new Error('db unavailable'));
        const response = await api('get', '/directory');
        expect(response.status).toBe(500);
        expect(response.body).toEqual({ error: 'server_error' });
        expect(response.headers['cache-control']).toBe('no-store');
    });
});

describe('the OpenAPI account and member operations', () => {
    it('resolves a member by name, and 404s an unknown one', async () => {
        const found = await api('get', '/members/alice');
        expect(found.status).toBe(200);
        expect(found.body).toEqual({ didDocument: { id: 'alice' } });
        const missing = await api('get', '/members/nobody');
        expect(missing.status).toBe(404);
        expect(missing.body.error).toBe('name_not_found');
    });

    it('returns the signed-in User’s membership credential', async () => {
        const { signIn } = await signedIn(ALICE, 'profile:read');
        const response = await api('get', '/account/credential', signIn.access_token);
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ credentialDid: 'did:cid:alice-credential' });
    });

    it('releases the signed-in User’s name', async () => {
        const { signIn } = await signedIn(ALICE);
        const released = await api('delete', '/account/name', signIn.access_token);
        expect(released.status).toBe(200);
        const account = await api('get', '/account', signIn.access_token);
        expect(account.body.name).toBeUndefined();
    });

    it('lists connected agents most recently used first', async () => {
        const store = new PoppyStore(kv);
        const base = { did: ALICE, scope: ['profile:read'], createdAt: Date.now(), expiresAt: Date.now() + 60_000 };
        await store.putGrant({ ...base, id: 'grt_old', tokenHash: hashSecret('prt_old'), clientId: AGENT_ID, clientName: 'Example Agent', domain: 'agent.example', lastUsedAt: Date.now() - 5000 });
        await store.putGrant({ ...base, id: 'grt_new', tokenHash: hashSecret('prt_new'), clientId: 'https://other.example/agent.json', clientName: 'Other Agent', domain: 'other.example', lastUsedAt: Date.now() });
        expect((await poppy.listConnections(ALICE)).map(connection => connection.name)).toEqual(['Other Agent', 'Example Agent']);
    });
});
