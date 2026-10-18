import crypto from 'crypto';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import request from 'supertest';

import { proxyHeraldRequest } from '../../services/drawbridge/server/src/herald-proxy.ts';
import { AgentDirectory } from '../../services/herald/server/src/poppy/agents.ts';
import { createPoppyConfig } from '../../services/herald/server/src/poppy/config.ts';
import { MemoryKV } from '../../services/herald/server/src/poppy/kv.ts';
import { createPoppy } from '../../services/herald/server/src/poppy/router.ts';
import { PoppyStore } from '../../services/herald/server/src/poppy/store.ts';
import {
    ALICE, API, ISSUER, ORIGIN, REDIRECT, TOKEN, AGENT_ID,
    TestAgent, fakeAccounts, fetcherFor, type Docs,
} from '../herald/poppy-helpers.ts';

// A Personal Agent talking to Herald's Poppy endpoints through Drawbridge's
// real Herald proxy, as deployed: Drawbridge parses and re-serializes bodies,
// strips `/names`, and forwards headers and cookies. The agent signs DPoP
// Proofs for the public URLs, which Herald rebuilds from its configured origin.

let herald: Server;
let drawbridge: express.Express;
let agent: TestAgent;
let docs: Docs;

beforeAll(async () => {
    agent = await new TestAgent().init();
    docs = agent.docs();
    const poppy = createPoppy({
        config: createPoppyConfig(ORIGIN, 'archon.test', 'https://wallet.archon.test'),
        store: new PoppyStore(new MemoryKV()),
        agents: new AgentDirectory(fetcherFor(() => docs)),
        accounts: fakeAccounts().accounts,
    });
    // Herald's own parsers, as in its index.ts.
    const heraldApp = express();
    heraldApp.use(express.json());
    heraldApp.use(express.urlencoded({ extended: true }));
    heraldApp.use('/poppy', poppy.router);
    heraldApp.use(poppy.wellKnown);
    herald = heraldApp.listen(0, '127.0.0.1');
    await new Promise(resolve => herald.once('listening', resolve));
    const heraldURL = `http://127.0.0.1:${(herald.address() as AddressInfo).port}`;

    // Drawbridge's parsers and Herald mounts, as in drawbridge-api.ts.
    drawbridge = express();
    drawbridge.use(express.json({ limit: '10mb' }));
    drawbridge.use(express.urlencoded({ extended: false, limit: '10mb' }));
    drawbridge.use('/.well-known', (req, res) => { void proxyHeraldRequest(req, res, heraldURL, ''); });
    drawbridge.use('/names', (req, res) => { void proxyHeraldRequest(req, res, heraldURL); });
});

afterAll(async () => {
    await new Promise(resolve => herald.close(resolve));
});

async function token(form: Record<string, string>) {
    return request(drawbridge).post('/names/poppy/token').type('form')
        .set('DPoP', await agent.proof('POST', TOKEN))
        .send({ ...form, ...await agent.clientAuth() });
}

async function api(method: 'get' | 'put', path: string, accessToken: string, body?: object) {
    const req = request(drawbridge)[method](`/names/poppy/api${path}`)
        .set('Authorization', `DPoP ${accessToken}`)
        .set('DPoP', await agent.proof(method.toUpperCase(), `${API}${path}`, accessToken));
    return body ? req.send(body) : req;
}

describe('Poppy through the Drawbridge Herald proxy', () => {
    it('serves discovery through the /.well-known mount', async () => {
        const poppy = await request(drawbridge).get('/.well-known/poppy.json');
        expect(poppy.status).toBe(200);
        expect(poppy.body.auth.issuer).toBe(ISSUER);

        const metadata = await request(drawbridge).get('/.well-known/oauth-authorization-server/names/poppy');
        expect(metadata.status).toBe(200);
        expect(metadata.body.token_endpoint).toBe(TOKEN);
    });

    it('starts a Session and calls the API with DPoP-bound tokens', async () => {
        const session = await token({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: await agent.assertion({ sub: 'usr_proxy' }),
        });
        expect(session.status).toBe(200);
        expect(session.headers['cache-control']).toBe('no-store');

        const lookup = await api('get', '/names/alice', session.body.access_token);
        expect(lookup.status).toBe(200);
        expect(lookup.body.did).toBe(ALICE);

        const signedOut = await api('get', '/account', session.body.access_token);
        expect(signedOut.status).toBe(403);
        expect(signedOut.headers['www-authenticate']).toContain('sign_in_required');
    });

    it('keeps repeated form parameters repeated, so Herald still refuses them', async () => {
        const response = await request(drawbridge).post('/names/poppy/token').type('form')
            .set('DPoP', await agent.proof('POST', TOKEN))
            .send('grant_type=refresh_token&grant_type=authorization_code');
        expect(response.body.error).toBe('invalid_request');
    });

    it('completes Direct Sign-In: cookie, wallet response, redirect and code exchange', async () => {
        const session = await token({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: await agent.assertion({ sub: 'usr_proxy_signin' }),
        });
        const verifier = crypto.randomBytes(32).toString('base64url');
        const page = await request(drawbridge).get('/names/poppy/authorize').query({
            response_type: 'code',
            client_id: AGENT_ID,
            redirect_uri: REDIRECT,
            scope: 'poppy:read poppy:write',
            state: 'st',
            code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
            code_challenge_method: 'S256',
        });
        expect(page.status).toBe(200);
        const setCookie = page.headers['set-cookie'][0];
        expect(setCookie).toMatch(/Path=\/names\/poppy/);
        const cookie = setCookie.split(';')[0];
        const csrf = /"csrf":"([^"]+)"/.exec(page.text)![1];
        const at = (url: string) => new URL(url).pathname;
        const statusUrl = at(/"statusUrl":"([^"]+)"/.exec(page.text)![1]);
        const decideUrl = at(/"decideUrl":"([^"]+)"/.exec(page.text)![1]);
        const challenge = decodeURIComponent(/challenge=([^"&]+)/.exec(page.text)![1]);

        await request(drawbridge).post('/names/poppy/signin/response')
            .send({ response: JSON.stringify({ challenge, responder: ALICE }) })
            .expect(200);
        const status = await request(drawbridge).get(statusUrl).set('Cookie', cookie);
        expect(status.body).toMatchObject({ status: 'authenticated', did: ALICE });

        const decided = await request(drawbridge).post(decideUrl).set('Cookie', cookie).set('X-Poppy-CSRF', csrf)
            .send({ decision: 'approve', scope: ['poppy:read', 'poppy:write'] });
        expect(decided.status).toBe(200);
        const redirect = new URL(decided.body.redirect);
        expect(redirect.searchParams.get('iss')).toBe(ISSUER);

        const signIn = await token({
            grant_type: 'authorization_code',
            code: redirect.searchParams.get('code')!,
            redirect_uri: REDIRECT,
            code_verifier: verifier,
            session_id: session.body.session_id,
        });
        expect(signIn.status).toBe(200);
        expect(signIn.body.signed_in).toBe(true);

        const renamed = await api('put', '/account/name', signIn.body.access_token, { name: 'alicia' });
        expect(renamed.status).toBe(200);
    });

    it('passes the 303 error redirect from /authorize through unchanged', async () => {
        const response = await request(drawbridge).get('/names/poppy/authorize').query({
            response_type: 'code', client_id: AGENT_ID, redirect_uri: REDIRECT, scope: 'poppy:admin',
            code_challenge: 'x'.repeat(43), code_challenge_method: 'S256',
        });
        expect(response.status).toBe(303);
        expect(new URL(response.headers.location).searchParams.get('error')).toBe('invalid_scope');
    });
});
