import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

import { AgentDirectory } from '../../services/herald/server/src/poppy/agents.ts';
import { createPoppyConfig } from '../../services/herald/server/src/poppy/config.ts';
import { MemoryKV } from '../../services/herald/server/src/poppy/kv.ts';
import { createPoppy, type Poppy } from '../../services/herald/server/src/poppy/router.ts';
import { PoppyStore } from '../../services/herald/server/src/poppy/store.ts';
import {
    AGENT_ID, ALICE, API, BOB, ISSUER, ORIGIN, REDIRECT, TOKEN,
    TestAgent, fakeAccounts, fetcherFor, fetches, type Docs,
} from './poppy-helpers.ts';

// Herald as a Personal Agent Protocol Company (draft 0.2), exercised by a test
// Personal Agent (poppy-helpers.ts). Client metadata is served by an injected
// fetcher, since the production transport refuses anything but public HTTPS.

let agent: TestAgent;
let docs: Docs;
let poppy: Poppy;
let app: express.Express;
let kv: MemoryKV;
let descriptions: string[];

beforeEach(async () => {
    fetches.length = 0;
    agent = await new TestAgent().init();
    docs = agent.docs();
    kv = new MemoryKV();
    const fake = fakeAccounts();
    descriptions = fake.descriptions;
    const config = createPoppyConfig(ORIGIN, 'archon.test', 'https://wallet.archon.test');
    poppy = createPoppy({
        config,
        store: new PoppyStore(kv),
        agents: new AgentDirectory(fetcherFor(() => docs)),
        accounts: fake.accounts,
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

async function startSession(userId = 'usr_alice_1', sessionId?: string) {
    const form: Record<string, string> = {
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: await agent.assertion({ sub: userId }),
        ...await agent.clientAuth(),
    };
    if (sessionId) {
        form.session_id = sessionId;
    }
    return token(form, await agent.proof('POST', TOKEN));
}

async function api(method: 'get' | 'put' | 'delete', path: string, accessToken: string, body?: object) {
    const url = `${API}${path}`;
    const req = request(app)[method](`/poppy/api${path}`)
        .set('Authorization', `DPoP ${accessToken}`)
        .set('DPoP', await agent.proof(method.toUpperCase(), url, accessToken));
    return body === undefined ? req : req.send(body);
}

// Drives Direct Sign-In through the consent page, the wallet response and the
// User's decision, and returns the redirect the browser is sent to.
async function directSignIn(did: string, scope = 'poppy:read poppy:write', approve: string[] | null = scope.split(' ')) {
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

async function signedIn(did = ALICE, scope = 'poppy:read poppy:write') {
    const session = await startSession();
    const { redirect, verifier } = await directSignIn(did, scope);
    const response = await token({
        grant_type: 'authorization_code',
        code: redirect.searchParams.get('code')!,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
        session_id: session.body.session_id,
        ...await agent.clientAuth(),
    }, await agent.proof('POST', TOKEN));
    expect(response.status).toBe(200);
    return { session: session.body, signIn: response.body };
}

describe('discovery', () => {
    it('publishes poppy.json naming the issuer, sign-in types and the OpenAPI interface', async () => {
        const response = await request(app).get('/.well-known/poppy.json').expect(200);
        expect(response.body).toEqual({
            protocol_version: '0.2',
            organization: { name: 'archon.test', domain: 'archon.test' },
            auth: {
                issuer: ISSUER,
                direct: { scopes: ['poppy:read', 'poppy:write'] },
                device: { scopes: ['poppy:read', 'poppy:write'] },
            },
            apis: [expect.objectContaining({ type: 'openapi', url: `${ISSUER}/openapi.json` })],
        });
    });

    it('publishes RFC 8414 metadata at the issuer path with poppy_domains and ES256 DPoP', async () => {
        const response = await request(app).get('/.well-known/oauth-authorization-server/names/poppy').expect(200);
        expect(response.body).toMatchObject({
            issuer: ISSUER,
            token_endpoint: TOKEN,
            revocation_endpoint: `${ISSUER}/revoke`,
            authorization_endpoint: `${ISSUER}/authorize`,
            device_authorization_endpoint: `${ISSUER}/device_authorization`,
            poppy_domains: ['archon.test'],
        });
        expect(response.body.dpop_signing_alg_values_supported).toContain('ES256');
    });

    it('serves an OpenAPI 3.1 description whose server is the API base', async () => {
        const response = await request(app).get('/poppy/openapi.json').expect(200);
        expect(response.body.openapi).toBe('3.1.0');
        expect(response.body.servers).toEqual([{ url: API }]);
    });
});

describe('signed-out Sessions', () => {
    it('starts a DPoP-bound signed-out Session and renews it', async () => {
        const first = await startSession();
        expect(first.status).toBe(200);
        expect(first.headers['cache-control']).toBe('no-store');
        expect(first.body).toMatchObject({ token_type: 'DPoP', scope: '', signed_in: false });
        expect(first.body.expires_in).toBeGreaterThan(0);

        const renewed = await startSession('usr_alice_1', first.body.session_id);
        expect(renewed.status).toBe(200);
        expect(renewed.body.session_id).toBe(first.body.session_id);
        expect(renewed.body.access_token).not.toBe(first.body.access_token);
    });

    it('refuses to renew a Session for a different User ID', async () => {
        const first = await startSession('usr_alice_1');
        const other = await startSession('usr_bob_1', first.body.session_id);
        expect(other.status).toBe(400);
        expect(other.body.error).toBe('invalid_session');
    });

    it('rejects a client assertion addressed to the token endpoint', async () => {
        const response = await token({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: await agent.assertion({ sub: 'usr_1' }),
            client_id: AGENT_ID,
            client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
            client_assertion: await agent.assertion({ aud: TOKEN }),
        }, await agent.proof('POST', TOKEN));
        expect(response.status).toBe(401);
        expect(response.body.error).toBe('invalid_client');
    });

    it('rejects a Session assertion with an audience array', async () => {
        const now = Math.floor(Date.now() / 1000);
        const array = await new SignJWT({ jti: crypto.randomBytes(16).toString('base64url'), aud: [ISSUER, 'https://other.example'] })
            .setProtectedHeader({ alg: 'ES256', kid: 'agent-key-1' })
            .setIssuer(AGENT_ID).setSubject('usr_1').setIssuedAt(now).setExpirationTime(now + 60)
            .sign((agent as any).key);
        const response = await token({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: array,
            ...await agent.clientAuth(),
        }, await agent.proof('POST', TOKEN));
        expect(response.status).toBe(400);
        expect(response.body.error).toBe('invalid_grant');
    });

    it('rejects a reused assertion jti', async () => {
        const clientAuth = await agent.clientAuth();
        const form = {
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: await agent.assertion({ sub: 'usr_1' }),
            ...clientAuth,
        };
        expect((await token(form, await agent.proof('POST', TOKEN))).status).toBe(200);
        const replay = await token({ ...form, assertion: await agent.assertion({ sub: 'usr_1' }) }, await agent.proof('POST', TOKEN));
        expect(replay.status).toBe(401);
        expect(replay.body.error).toBe('invalid_client');
    });

    it('rejects a browser assertion at the token endpoint', async () => {
        const response = await token({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: await agent.assertion({ sub: 'usr_1' }, { typ: 'poppy-browser+jwt' }),
            ...await agent.clientAuth(),
        }, await agent.proof('POST', TOKEN));
        expect(response.body.error).toBe('invalid_grant');
    });

    it('rejects an agent whose metadata does not name itself', async () => {
        docs[AGENT_ID] = { ...(docs[AGENT_ID] as object), client_id: 'https://agent.example/other.json' };
        const response = await startSession();
        expect(response.status).toBe(401);
        expect(response.body.error).toBe('invalid_client');
    });

    it('rejects an agent whose key set is on another domain', async () => {
        docs[AGENT_ID] = { ...(docs[AGENT_ID] as object), jwks_uri: 'https://keys.example/jwks.json' };
        const response = await startSession();
        expect(response.body.error).toBe('invalid_client');
    });

    it('rejects a key set holding a private key', async () => {
        docs['https://agent.example/jwks.json'] = { keys: [{ ...agent.publicJwk, d: 'secret' }] };
        const response = await startSession();
        expect(response.body.error).toBe('invalid_client');
    });

    it('requires a DPoP Proof at the token endpoint', async () => {
        const response = await token({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: await agent.assertion({ sub: 'usr_1' }),
            ...await agent.clientAuth(),
        });
        expect(response.status).toBe(400);
        expect(response.body.error).toBe('invalid_dpop_proof');
    });

    it('rejects a replayed DPoP Proof at the token endpoint', async () => {
        const proof = await agent.proof('POST', TOKEN);
        const form = async () => ({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: await agent.assertion({ sub: 'usr_1' }),
            ...await agent.clientAuth(),
        });
        expect((await token(await form(), proof)).status).toBe(200);
        const replay = await token(await form(), proof);
        expect(replay.body.error).toBe('invalid_dpop_proof');
    });

    it('rejects a DPoP Proof for another URL', async () => {
        const response = await token({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: await agent.assertion({ sub: 'usr_1' }),
            ...await agent.clientAuth(),
        }, await agent.proof('POST', 'https://archon.test/names/oauth/token'));
        expect(response.body.error).toBe('invalid_dpop_proof');
    });

    it('rejects repeated form parameters', async () => {
        const response = await request(app).post('/poppy/token')
            .type('form')
            .send('grant_type=refresh_token&grant_type=authorization_code')
            .set('DPoP', await agent.proof('POST', TOKEN));
        expect(response.body.error).toBe('invalid_request');
    });
});

describe('the OpenAPI interface', () => {
    it('answers guest lookups with a signed-out Session Token', async () => {
        const session = await startSession();
        const response = await api('get', '/names/alice', session.body.access_token);
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ name: 'alice', did: ALICE });
    });

    it('requires a Session Token on every request', async () => {
        const response = await request(app).get('/poppy/api/directory');
        expect(response.status).toBe(401);
        expect(response.headers['www-authenticate']).toMatch(/^DPoP /);
    });

    it('refuses a Bearer Session Token outside MCP', async () => {
        const session = await startSession();
        const response = await request(app).get('/poppy/api/directory').set('Authorization', `Bearer ${session.body.access_token}`);
        expect(response.status).toBe(401);
        expect(response.headers['www-authenticate']).toContain('error="invalid_token"');
    });

    it('refuses a token in the URL', async () => {
        const session = await startSession();
        const response = await request(app).get('/poppy/api/directory').query({ access_token: session.body.access_token });
        expect(response.status).toBe(400);
    });

    it('refuses a proof from a key other than the one the token is bound to', async () => {
        const session = await startSession();
        const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
        const proof = await agent.proof('GET', `${API}/directory`, session.body.access_token, privateKey as CryptoKey, await exportJWK(publicKey));
        const response = await request(app).get('/poppy/api/directory')
            .set('Authorization', `DPoP ${session.body.access_token}`).set('DPoP', proof);
        expect(response.status).toBe(401);
        expect(response.headers['www-authenticate']).toContain('error="invalid_dpop_proof"');
    });

    it('asks a signed-out Session to sign in for account access', async () => {
        const session = await startSession();
        const response = await api('get', '/account', session.body.access_token);
        expect(response.status).toBe(403);
        expect(response.headers['www-authenticate']).toContain('error="sign_in_required"');
    });

    it('does not resolve wallet aliases as DIDs', async () => {
        const session = await startSession();
        const response = await api('get', '/dids/herald', session.body.access_token);
        expect(response.status).toBe(404);
    });
});

describe('Direct Sign-In', () => {
    it('shows the agent, its domain and the scopes, and blocks framing', async () => {
        const { page } = await directSignIn(ALICE);
        expect(page.text).toContain('Example Agent');
        expect(page.text).toContain('agent.example');
        expect(page.text).toContain('poppy:write');
        expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    });

    it('redirects with a code, the state and iss, and signs the Session in', async () => {
        const { session, signIn } = await signedIn();
        expect(signIn).toMatchObject({
            token_type: 'DPoP',
            scope: 'poppy:read poppy:write',
            session_id: session.session_id,
            signed_in: true,
        });
        expect(signIn.refresh_token).toMatch(/^pat_/);

        const account = await api('get', '/account', signIn.access_token);
        expect(account.status).toBe(200);
        expect(account.body).toMatchObject({ did: ALICE, name: 'alice' });

        const renamed = await api('put', '/account/name', signIn.access_token, { name: 'alicia' });
        expect(renamed.status).toBe(200);
    });

    it('includes iss and state in the redirect', async () => {
        await startSession();
        const { redirect } = await directSignIn(ALICE);
        expect(redirect.origin + redirect.pathname).toBe(REDIRECT);
        expect(redirect.searchParams.get('state')).toBe('st-1');
        expect(redirect.searchParams.get('iss')).toBe(ISSUER);
    });

    it('grants only the scopes the User approved', async () => {
        const session = await startSession();
        const { redirect, verifier } = await directSignIn(ALICE, 'poppy:read poppy:write', ['poppy:read']);
        const response = await token({
            grant_type: 'authorization_code',
            code: redirect.searchParams.get('code')!,
            redirect_uri: REDIRECT,
            code_verifier: verifier,
            session_id: session.body.session_id,
            ...await agent.clientAuth(),
        }, await agent.proof('POST', TOKEN));
        expect(response.body.scope).toBe('poppy:read');
        const write = await api('put', '/account/name', response.body.access_token, { name: 'x' });
        expect(write.status).toBe(403);
        expect(write.headers['www-authenticate']).toContain('error="insufficient_scope"');
    });

    it('sends access_denied with iss when the User declines', async () => {
        const { redirect } = await directSignIn(ALICE, 'poppy:read', null);
        expect(redirect.searchParams.get('error')).toBe('access_denied');
        expect(redirect.searchParams.get('iss')).toBe(ISSUER);
        expect(redirect.searchParams.has('code')).toBe(false);
    });

    it('does not redirect to a redirect_uri the agent did not register', async () => {
        const response = await request(app).get('/poppy/authorize').query({
            response_type: 'code', client_id: AGENT_ID, redirect_uri: 'https://evil.example/cb',
            scope: 'poppy:read', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256',
        });
        expect(response.status).toBe(400);
        expect(response.headers.location).toBeUndefined();
    });

    it('redirects invalid_scope with iss for an unknown scope', async () => {
        const response = await request(app).get('/poppy/authorize').query({
            response_type: 'code', client_id: AGENT_ID, redirect_uri: REDIRECT, state: 's',
            scope: 'poppy:admin', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256',
        });
        expect(response.status).toBe(303);
        const location = new URL(response.headers.location);
        expect(location.searchParams.get('error')).toBe('invalid_scope');
        expect(location.searchParams.get('iss')).toBe(ISSUER);
    });

    it('requires PKCE with S256', async () => {
        const response = await request(app).get('/poppy/authorize').query({
            response_type: 'code', client_id: AGENT_ID, redirect_uri: REDIRECT, scope: 'poppy:read',
            code_challenge: 'x'.repeat(43), code_challenge_method: 'plain',
        });
        expect(new URL(response.headers.location).searchParams.get('error')).toBe('invalid_request');
    });

    it('refuses a decision without the page’s CSRF value', async () => {
        const page = await request(app).get('/poppy/authorize').query({
            response_type: 'code', client_id: AGENT_ID, redirect_uri: REDIRECT, scope: 'poppy:read',
            code_challenge: 'x'.repeat(43), code_challenge_method: 'S256',
        });
        const cookie = page.headers['set-cookie'][0].split(';')[0];
        const decideUrl = /"decideUrl":"([^"]+)"/.exec(page.text)![1].replace(ISSUER, '/poppy');
        const response = await request(app).post(decideUrl).set('Cookie', cookie)
            .send({ decision: 'approve', scope: ['poppy:read'] });
        expect(response.status).toBe(403);
    });

    it('accepts a code only once', async () => {
        const session = await startSession();
        const { redirect, verifier } = await directSignIn(ALICE, 'poppy:read');
        const exchange = async () => token({
            grant_type: 'authorization_code',
            code: redirect.searchParams.get('code')!,
            redirect_uri: REDIRECT,
            code_verifier: verifier,
            session_id: session.body.session_id,
            ...await agent.clientAuth(),
        }, await agent.proof('POST', TOKEN));
        expect((await exchange()).status).toBe(200);
        const again = await exchange();
        expect(again.body.error).toBe('invalid_grant');
    });

    it('refuses to sign a Session in to a second account', async () => {
        const { session } = await signedIn(ALICE);
        const { redirect, verifier } = await directSignIn(BOB, 'poppy:read');
        const response = await token({
            grant_type: 'authorization_code',
            code: redirect.searchParams.get('code')!,
            redirect_uri: REDIRECT,
            code_verifier: verifier,
            session_id: session.session_id,
            ...await agent.clientAuth(),
        }, await agent.proof('POST', TOKEN));
        expect(response.body.error).toBe('account_mismatch');
    });
});

describe('Account Tokens and signing out', () => {
    async function refresh(accountToken: string, extra: Record<string, string> = {}) {
        return token({
            grant_type: 'refresh_token',
            refresh_token: accountToken,
            ...extra,
            ...await agent.clientAuth(),
        }, await agent.proof('POST', TOKEN));
    }

    it('starts a new signed-in Session from an Account Token, narrowed on request', async () => {
        const { signIn } = await signedIn();
        const response = await refresh(signIn.refresh_token, { scope: 'poppy:read' });
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ signed_in: true, scope: 'poppy:read' });
        expect(response.body.session_id).not.toBe(signIn.session_id);
        expect(response.body.refresh_token).toBeUndefined();
    });

    it('cannot widen the scopes of an Account Token', async () => {
        const session = await startSession();
        const { redirect, verifier } = await directSignIn(ALICE, 'poppy:read');
        const signIn = (await token({
            grant_type: 'authorization_code',
            code: redirect.searchParams.get('code')!,
            redirect_uri: REDIRECT,
            code_verifier: verifier,
            session_id: session.body.session_id,
            ...await agent.clientAuth(),
        }, await agent.proof('POST', TOKEN))).body;
        const response = await refresh(signIn.refresh_token, { scope: 'poppy:read poppy:write' });
        expect(response.body.error).toBe('invalid_scope');
    });

    it('accepts an Account Token only from the client it was issued to', async () => {
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

    it('signs out at once when the Account Token is revoked', async () => {
        const { signIn } = await signedIn();
        const revoked = await request(app).post('/poppy/revoke').type('form').send({
            token: signIn.refresh_token,
            token_type_hint: 'refresh_token',
            ...await agent.clientAuth(),
        });
        expect(revoked.status).toBe(200);

        const account = await api('get', '/account', signIn.access_token);
        expect(account.status).toBe(403);
        expect(account.headers['www-authenticate']).toContain('error="sign_in_required"');
        expect((await refresh(signIn.refresh_token)).body.error).toBe('invalid_grant');

        // The Session continues signed out, and only for the same account.
        const renewed = await startSession('usr_alice_1', signIn.session_id);
        expect(renewed.body.signed_in).toBe(false);
    });

    it('lists connected agents for account settings and disconnects them', async () => {
        const { signIn } = await signedIn();
        const connections = await poppy.listConnections(ALICE);
        expect(connections).toEqual([expect.objectContaining({
            clientId: AGENT_ID,
            name: 'Example Agent',
            domain: 'agent.example',
            scope: ['poppy:read', 'poppy:write'],
        })]);
        expect(await poppy.disconnect(BOB, connections[0].id)).toBe(false);
        expect(await poppy.disconnect(ALICE, connections[0].id)).toBe(true);
        expect(await poppy.listConnections(ALICE)).toEqual([]);
        expect((await refresh(signIn.refresh_token)).body.error).toBe('invalid_grant');
    });
});

describe('Device Sign-In', () => {
    async function authorizeDevice(scope = 'poppy:read') {
        const response = await request(app).post('/poppy/device_authorization').type('form')
            .send({ scope, ...await agent.clientAuth() });
        expect(response.status).toBe(200);
        return response.body;
    }

    async function poll(deviceCode: string, sessionId: string) {
        return token({
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            device_code: deviceCode,
            session_id: sessionId,
            ...await agent.clientAuth(),
        }, await agent.proof('POST', TOKEN));
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
            .send({ decision, scope: ['poppy:read'] });
    }

    it('issues a device code and user code', async () => {
        const device = await authorizeDevice();
        expect(device.user_code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
        expect(device.verification_uri).toBe(`${ISSUER}/device`);
        expect(device.verification_uri_complete).toContain(encodeURIComponent(device.user_code));
        expect(device.interval).toBe(5);
    });

    it('stays pending until the User approves, and does not approve on opening the link', async () => {
        const session = await startSession();
        const device = await authorizeDevice();
        await request(app).get('/poppy/device').query({ user_code: device.user_code });
        expect((await poll(device.device_code, session.body.session_id)).body.error).toBe('authorization_pending');
        expect((await poll(device.device_code, session.body.session_id)).body.error).toBe('slow_down');

        const decided = await approveOnPage(device.user_code, ALICE, 'approve');
        expect(decided.status).toBe(200);


        const signIn = await poll(device.device_code, session.body.session_id);
        expect(signIn.status).toBe(200);
        expect(signIn.body).toMatchObject({ signed_in: true, scope: 'poppy:read' });
        expect(signIn.body.refresh_token).toMatch(/^pat_/);
    });

    it('returns access_denied when the User declines', async () => {
        const session = await startSession();
        const device = await authorizeDevice();
        await approveOnPage(device.user_code, ALICE, 'decline');
        expect((await poll(device.device_code, session.body.session_id)).body.error).toBe('access_denied');
    });

    it('rejects an unknown user code without starting a sign-in', async () => {
        const response = await request(app).post('/poppy/device').type('form').send({ user_code: 'BBBB-BBBB' });
        expect(response.status).toBe(400);
        expect(response.headers['set-cookie']).toBeUndefined();
    });
});

describe('concurrent and repeated requests', () => {
    async function exchange(redirect: URL, verifier: string, sessionId: string) {
        return token({
            grant_type: 'authorization_code',
            code: redirect.searchParams.get('code')!,
            redirect_uri: REDIRECT,
            code_verifier: verifier,
            session_id: sessionId,
            ...await agent.clientAuth(),
        }, await agent.proof('POST', TOKEN));
    }

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

    it('binds a Session to one account when two code exchanges race', async () => {
        const session = await startSession();
        const alice = await directSignIn(ALICE, 'poppy:read');
        const bob = await directSignIn(BOB, 'poppy:read');
        const results = await Promise.all([
            exchange(alice.redirect, alice.verifier, session.body.session_id),
            exchange(bob.redirect, bob.verifier, session.body.session_id),
        ]);
        expect(results.map(result => result.status).sort()).toEqual([200, 400]);
        expect(results.find(result => result.status === 400)!.body.error).toBe('account_mismatch');
        // The losing account is left with no Account Token.
        const connected = [...await poppy.listConnections(ALICE), ...await poppy.listConnections(BOB)];
        expect(connected).toHaveLength(1);
    });

    it('acts on a consent decision only once', async () => {
        const page = await request(app).get('/poppy/authorize').query({
            response_type: 'code', client_id: AGENT_ID, redirect_uri: REDIRECT, scope: 'poppy:read',
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
            .send({ decision: 'approve', scope: ['poppy:read'] });
        const results = await Promise.all([decide(), decide()]);
        expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    });

    it('issues one Account Token from one device approval, however many polls race', async () => {
        const session = await startSession();
        const device = (await request(app).post('/poppy/device_authorization').type('form')
            .send({ scope: 'poppy:read', ...await agent.clientAuth() })).body;
        const page = await request(app).post('/poppy/device').type('form').send({ user_code: device.user_code });
        const cookie = page.headers['set-cookie'][0].split(';')[0];
        const csrf = /"csrf":"([^"]+)"/.exec(page.text)![1];
        const decideUrl = /"decideUrl":"([^"]+)"/.exec(page.text)![1].replace(ISSUER, '/poppy');
        const walletChallenge = decodeURIComponent(/challenge=([^"&]+)/.exec(page.text)![1]);
        await request(app).post('/poppy/signin/response')
            .send({ response: JSON.stringify({ challenge: walletChallenge, responder: ALICE }) }).expect(200);
        await request(app).post(decideUrl).set('Cookie', cookie).set('X-Poppy-CSRF', csrf)
            .send({ decision: 'approve', scope: ['poppy:read'] }).expect(200);

        const poll = async () => token({
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            device_code: device.device_code,
            session_id: session.body.session_id,
            ...await agent.clientAuth(),
        }, await agent.proof('POST', TOKEN));
        const results = await Promise.all([poll(), poll(), poll()]);
        expect(results.filter(result => result.status === 200)).toHaveLength(1);
        expect(await poppy.listConnections(ALICE)).toHaveLength(1);
    });

    it('keeps a device decision when a poll writes its polling state afterwards', async () => {
        const store = new PoppyStore(kv);
        const device = { clientId: AGENT_ID, scope: ['poppy:read'], userCode: 'BCDF-GHJK', interval: 5, expiresAt: Date.now() + 60_000 };
        await store.putDevice('pdc_test', device);
        const hash = crypto.createHash('sha256').update('pdc_test').digest('base64url');
        expect(await store.decideDevice(hash, device, { approved: true, did: ALICE, scope: ['poppy:read'] })).toBe(true);
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
        const first = await signedIn(ALICE, 'poppy:read');
        const second = await signedIn(ALICE, 'poppy:write');
        const connections = await poppy.listConnections(ALICE);
        expect(connections).toHaveLength(1);
        expect(connections[0].scope).toEqual(['poppy:read', 'poppy:write']);

        expect(await poppy.disconnect(ALICE, connections[0].id)).toBe(true);
        for (const { signIn } of [first, second]) {
            const account = await api('get', '/account', signIn.access_token);
            expect(account.status).toBe(403);
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

describe('index lifetimes', () => {
    it('expires Session and grant indexes with their grant', async () => {
        let now = 1_000_000;
        const memory = new MemoryKV(() => now);
        await memory.addToSet('grant-sessions:g', 'ses_1', 60);
        expect(await memory.members('grant-sessions:g')).toEqual(['ses_1']);
        now += 61_000;
        expect(await memory.members('grant-sessions:g')).toEqual([]);
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
            .send({ decision: 'approve', scope: ['poppy:read'] });
    }

    async function authorizeDevice() {
        return (await request(app).post('/poppy/device_authorization').type('form')
            .send({ scope: 'poppy:read', ...await agent.clientAuth() })).body;
    }

    async function poll(deviceCode: string, sessionId: string, extra: Record<string, string> = {}) {
        return token({
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            device_code: deviceCode,
            session_id: sessionId,
            ...extra,
            ...await agent.clientAuth(),
        }, await agent.proof('POST', TOKEN));
    }

    it('accepts one device decision even from two open consent pages', async () => {
        const session = await startSession();
        const device = await authorizeDevice();
        const first = await openDevicePage(device.user_code, ALICE);
        const second = await openDevicePage(device.user_code, ALICE);

        expect((await first()).status).toBe(200);
        expect((await poll(device.device_code, session.body.session_id)).status).toBe(200);
        // The second page answers after the decision was consumed.
        expect((await second()).status).toBe(410);
        expect((await poll(device.device_code, session.body.session_id)).body.error).toBe('invalid_grant');
        expect((await poppy.listConnections(ALICE))).toHaveLength(1);
    });

    it('lets a revocation clear only the grant it revoked from a Session', async () => {
        const store = new PoppyStore(kv);
        const session = { id: 'ses_x', clientId: AGENT_ID, userId: 'usr_1', createdAt: Date.now(), expiresAt: Date.now() + 60_000 };
        await store.putSession(session);
        expect(await store.setSessionGrant(session, 'grt_a')).toBe(true);
        // A concurrent sign-in moves the Session to grant B before A's revocation clears it.
        expect(await store.setSessionGrant(session, 'grt_b')).toBe(true);
        await store.clearSessionGrant(session.id, 'grt_a');
        expect(await store.getSessionGrant(session.id)).toBe('grt_b');
        await store.clearSessionGrant(session.id, 'grt_b');
        expect(await store.getSessionGrant(session.id)).toBeNull();
    });

    it('accepts the DPoP authentication scheme in any case', async () => {
        const session = await startSession();
        const response = await request(app).get('/poppy/api/directory')
            .set('Authorization', `dpop ${session.body.access_token}`)
            .set('DPoP', await agent.proof('GET', `${API}/directory`, session.body.access_token));
        expect(response.status).toBe(200);
    });

    it('narrows the Session Token at the code exchange and keeps the Account Token whole', async () => {
        const session = await startSession();
        const { redirect, verifier } = await directSignIn(ALICE);
        const response = await token({
            grant_type: 'authorization_code',
            code: redirect.searchParams.get('code')!,
            redirect_uri: REDIRECT,
            code_verifier: verifier,
            session_id: session.body.session_id,
            scope: 'poppy:read',
            ...await agent.clientAuth(),
        }, await agent.proof('POST', TOKEN));
        expect(response.body.scope).toBe('poppy:read');
        expect((await api('put', '/account/name', response.body.access_token, { name: 'x' })).status).toBe(403);
        expect((await poppy.listConnections(ALICE))[0].scope).toEqual(['poppy:read', 'poppy:write']);
    });

    it('rejects widening scopes at the code exchange', async () => {
        const session = await startSession();
        const { redirect, verifier } = await directSignIn(ALICE, 'poppy:read');
        const response = await token({
            grant_type: 'authorization_code',
            code: redirect.searchParams.get('code')!,
            redirect_uri: REDIRECT,
            code_verifier: verifier,
            session_id: session.body.session_id,
            scope: 'poppy:read poppy:write',
            ...await agent.clientAuth(),
        }, await agent.proof('POST', TOKEN));
        expect(response.body.error).toBe('invalid_scope');
    });

    it('narrows and rejects scopes at the device exchange', async () => {
        const session = await startSession();
        const device = await authorizeDevice();
        await (await openDevicePage(device.user_code, ALICE))();
        expect((await poll(device.device_code, session.body.session_id, { scope: 'poppy:write' })).body.error).toBe('invalid_scope');

        // A rejected request leaves the approval for a correct one.
        const signIn = await poll(device.device_code, session.body.session_id, { scope: 'poppy:read' });
        expect(signIn.status).toBe(200);
        expect(signIn.body.scope).toBe('poppy:read');
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
            .send({ scope: 'poppy:read', ...await agent.clientAuth() })).body;
        await request(app).post('/poppy/device').type('form').send({ user_code: device.user_code }).expect(200);
        expect(descriptions.at(-1)).toContain(`Code ${device.user_code}`);
    });

    it('renders the wallet QR code as inline SVG and loads no third-party script', async () => {
        const { page } = await directSignIn(ALICE, 'poppy:read');
        expect(page.text).toContain('<svg');
        expect(page.text).not.toContain('cdn.jsdelivr.net');
        expect(page.headers['content-security-policy']).not.toContain('https://cdn');
        expect(page.headers['content-security-policy']).toMatch(/script-src 'nonce-[^']+';/);
    });

    it('limits sign-in pages per agent, so one agent cannot block another', async () => {
        const open = (clientId: string, redirectUri: string) => request(app).get('/poppy/authorize').query({
            response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: 'poppy:read',
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
            .send({ scope: 'poppy:read', ...await agent.clientAuth() })).body;
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

        const session = (await post({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: await agent.assertion({ sub: 'usr_late' }),
        })).body;
        const device = (await request(localApp).post('/poppy/device_authorization').type('form')
            .send({ scope: 'poppy:read', ...await agent.clientAuth() })).body;
        for (let i = 0; i < 2; i++) {
            const poll = await post({
                grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
                device_code: device.device_code,
                session_id: session.session_id,
            });
            expect(poll.body.error).toBe('expired_token');
        }
    });
});
