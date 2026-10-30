import crypto from 'crypto';
import { jest } from '@jest/globals';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';

import {
    AGENT_ID, API, ISSUER, REDIRECT, TOKEN, TestAgent, fetcherFor, type Docs,
} from './poppy-helpers.ts';

// Herald's own Personal Agent Protocol account adapter (poppyAccounts in
// routes.ts): what an agent signed in to a Herald account actually sees. The
// protocol itself is covered against a fake adapter in poppy.test.ts; here the
// adapter runs against Herald's database and keymaster.
//
// config.ts reads the environment when it is first imported, so this lives in
// its own file. Client metadata is fetched through the public-HTTPS transport,
// which refuses the test agent's documents, so that transport is replaced.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-routes-poppy-'));
process.env.ARCHON_HERALD_JWT_KEY_PATH = path.join(tmpDir, 'oauth-signing-key.json');
process.env.ARCHON_HERALD_DOMAIN = 'archon.test';
process.env.ARCHON_HERALD_NAME = 'name-service';
process.env.ARCHON_DRAWBRIDGE_PUBLIC_HOST = 'https://archon.test';
process.env.ARCHON_HERALD_POPPY_ENABLED = 'true';
process.env.ARCHON_HERALD_POPPY_STORE = 'memory';

const ALICE = 'did:cid:alice';
const CAROL = 'did:cid:carol';

let docs: Docs = {};
jest.unstable_mockModule('@didcid/common/net-node', () => ({
    fetchPublicHttpsOnce: fetcherFor(() => docs),
}));

let createHeraldRoutes: any;
let MemoryKV: any;
let agent: TestAgent;

beforeAll(async () => {
    ({ createHeraldRoutes } = await import('../../services/herald/server/src/routes.ts'));
    ({ MemoryKV } = await import('../../services/herald/server/src/poppy/kv.ts'));
});

beforeEach(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    agent = await new TestAgent().init();
    docs = agent.docs();
});

afterEach(() => {
    jest.restoreAllMocks();
});

afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

function createDb(users: Record<string, any> = {}) {
    return {
        getUser: jest.fn<any>(async (did: string) => users[did] ?? null),
        setUser: jest.fn<any>(async (did: string, user: any) => { users[did] = user; }),
        listUsers: jest.fn<any>(async () => users),
        findDidByName: jest.fn<any>(async (name: string) =>
            Object.entries(users).find(([, u]: any) => u.name === name)?.[0] ?? null),
        deleteExpiredReplyTokens: jest.fn<any>(async () => 0),
    };
}

// A wallet response is the JSON of the challenge it answers and who answered.
function createKeymaster() {
    let challenges = 0;
    return {
        createChallenge: jest.fn<any>(async () => `did:cid:challenge-${++challenges}`),
        verifyResponse: jest.fn<any>(async (response: string) => ({ match: true, ...JSON.parse(response) })),
        resolveDID: jest.fn<any>(async (did: string) => ({ didDocument: { id: did } })),
        setCurrentId: jest.fn<any>(async () => true),
        bindCredential: jest.fn<any>(async () => ({ bound: true })),
        issueCredential: jest.fn<any>(async () => 'did:cid:issued-credential'),
        getCredential: jest.fn<any>(async (did: string) => ({ id: did, credentialSubject: { id: 'subject' } })),
        revokeCredential: jest.fn<any>(async () => true),
    };
}

function mount({ users = {}, keymaster = createKeymaster(), kv = new MemoryKV(), session = {} }:
    { users?: Record<string, any>; keymaster?: any; kv?: any; session?: any } = {}) {
    const db = createDb(users);
    const ctx: any = {
        keymaster,
        db,
        emailBridge: null,
        serviceDID: 'did:cid:service',
        poppyKv: kv,
    };
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use((req: any, _res, next) => {
        req.session = { ...session };
        next();
    });
    app.use(createHeraldRoutes(ctx).router);
    return { app, db, keymaster, users };
}

type App = ReturnType<typeof mount>['app'];

async function startSession(app: App) {
    const response = await request(app).post('/poppy/token').type('form')
        .set('DPoP', await agent.proof('POST', TOKEN))
        .send({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: await agent.assertion({ sub: 'usr_1' }),
            ...await agent.clientAuth(),
        });
    expect(response.status).toBe(200);
    return response.body as { access_token: string; session_id: string };
}

async function api(app: App, method: 'get' | 'put' | 'delete', apiPath: string, accessToken: string, body?: object) {
    const req = request(app)[method](`/poppy/api${apiPath}`)
        .set('Authorization', `DPoP ${accessToken}`)
        .set('DPoP', await agent.proof(method.toUpperCase(), `${API}${apiPath}`, accessToken));
    return body === undefined ? req : req.send(body);
}

// Opens the consent page and answers its challenge from the wallet, returning
// what the browser needs to finish the sign-in.
async function answerChallenge(app: App, did: string) {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const page = await request(app).get('/poppy/authorize').query({
        response_type: 'code',
        client_id: AGENT_ID,
        redirect_uri: REDIRECT,
        scope: 'poppy:read poppy:write',
        state: 'st-1',
        code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
    });
    expect(page.status).toBe(200);
    const cookie = page.headers['set-cookie'][0].split(';')[0];
    const csrf = /"csrf":"([^"]+)"/.exec(page.text)![1];
    const statusUrl = /"statusUrl":"([^"]+)"/.exec(page.text)![1].replace(ISSUER, '/poppy');
    const decideUrl = /"decideUrl":"([^"]+)"/.exec(page.text)![1].replace(ISSUER, '/poppy');
    const challenge = decodeURIComponent(/challenge=([^"&]+)/.exec(page.text)![1]);

    const answered = await request(app).post('/poppy/signin/response')
        .send({ response: JSON.stringify({ challenge, responder: did }) });
    expect(answered.status).toBe(200);

    return { verifier, cookie, csrf, statusUrl, decideUrl };
}

async function signIn(app: App, did: string) {
    const session = await startSession(app);
    const { verifier, cookie, csrf, decideUrl } = await answerChallenge(app, did);
    const decided = await request(app).post(decideUrl).set('Cookie', cookie).set('X-Poppy-CSRF', csrf)
        .send({ decision: 'approve', scope: ['poppy:read', 'poppy:write'] });
    expect(decided.status).toBe(200);
    const code = new URL(decided.body.redirect).searchParams.get('code')!;

    const response = await request(app).post('/poppy/token').type('form')
        .set('DPoP', await agent.proof('POST', TOKEN))
        .send({
            grant_type: 'authorization_code',
            code,
            redirect_uri: REDIRECT,
            code_verifier: verifier,
            session_id: session.session_id,
            ...await agent.clientAuth(),
        });
    expect(response.status).toBe(200);
    return response.body.access_token as string;
}

describe('Herald accounts behind the Personal Agent Protocol', () => {
    describe('signing in from a wallet', () => {
        it('asks the wallet to answer at the sign-in callback, describing the agent', async () => {
            const { app, keymaster } = mount();

            await answerChallenge(app, ALICE);

            expect(keymaster.createChallenge).toHaveBeenCalledWith({
                callback: `${ISSUER}/signin/response`,
                description: expect.stringContaining('Connect the agent “Example Agent” from agent.example'),
            });
        });

        it('creates a Herald account for a DID signing in for the first time', async () => {
            const { app, users } = mount();

            const { statusUrl, cookie } = await answerChallenge(app, CAROL);

            expect(users[CAROL]).toMatchObject({ logins: 1 });
            expect(users[CAROL].firstLogin).toBe(users[CAROL].lastLogin);
            const status = await request(app).get(statusUrl).set('Cookie', cookie);
            expect(status.body).toEqual({ status: 'authenticated', did: CAROL });
        });

        it('shows an existing member their Herald name and leaves their record alone', async () => {
            const users = { [ALICE]: { name: 'alice', logins: 7 } };
            const { app, db } = mount({ users });

            const { statusUrl, cookie } = await answerChallenge(app, ALICE);

            expect(db.setUser).not.toHaveBeenCalled();
            const status = await request(app).get(statusUrl).set('Cookie', cookie);
            expect(status.body).toEqual({ status: 'authenticated', did: ALICE, name: 'alice' });
        });
    });

    describe('public lookups', () => {
        it('resolves a name case-insensitively and 404s an unknown one', async () => {
            const { app } = mount({ users: { [ALICE]: { name: 'alice' } } });
            const { access_token } = await startSession(app);

            const found = await api(app, 'get', '/names/Alice', access_token);
            expect(found.status).toBe(200);
            expect(found.body).toEqual({ name: 'alice', did: ALICE });

            const missing = await api(app, 'get', '/names/nobody', access_token);
            expect(missing.status).toBe(404);
            expect(missing.body).toEqual({ error: 'name_not_found' });
        });

        it('returns a member document with the status of its published credentials', async () => {
            const keymaster = createKeymaster();
            keymaster.resolveDID.mockResolvedValue({
                didDocument: { id: ALICE },
                // Issued to somebody else, so it is reported without a signature check.
                didDocumentData: { manifest: { 'did:cid:vc': { credentialSubject: { id: CAROL } } } },
            });
            const { app } = mount({ users: { [ALICE]: { name: 'alice' } }, keymaster });
            const { access_token } = await startSession(app);

            const response = await api(app, 'get', '/members/ALICE', access_token);

            expect(response.status).toBe(200);
            expect(response.body.didDocument).toEqual({ id: ALICE });
            expect(response.body.credentialStatus).toEqual({
                'did:cid:vc': { status: 'unverified', reason: 'issued to a different subject' },
            });

            const missing = await api(app, 'get', '/members/nobody', access_token);
            expect(missing.status).toBe(404);
        });

        it('reports a member with no manifest as having no credentials to check', async () => {
            const { app } = mount({ users: { [ALICE]: { name: 'alice' } } });
            const { access_token } = await startSession(app);

            const response = await api(app, 'get', '/members/alice', access_token);

            expect(response.status).toBe(200);
            expect(response.body.credentialStatus).toEqual({});
        });

        it('resolves a DID', async () => {
            const { app, keymaster } = mount();
            const { access_token } = await startSession(app);

            const response = await api(app, 'get', `/dids/${ALICE}`, access_token);

            expect(response.status).toBe(200);
            expect(response.body).toEqual({ didDocument: { id: ALICE } });
            expect(keymaster.resolveDID).toHaveBeenCalledWith(ALICE);
        });

        // The keymaster also resolves this wallet's own aliases, which are not
        // the agent's business.
        it('refuses to resolve anything that is not a DID', async () => {
            const { app, keymaster } = mount();
            const { access_token } = await startSession(app);

            const response = await api(app, 'get', '/dids/name-service', access_token);

            expect(response.status).toBe(404);
            expect(response.body).toEqual({ error: 'did_not_found' });
            expect(keymaster.resolveDID).not.toHaveBeenCalled();
        });

        it('reports a DID that cannot be resolved as not found', async () => {
            const keymaster = createKeymaster();
            keymaster.resolveDID.mockRejectedValue(new Error('unknown DID'));
            const { app } = mount({ keymaster });
            const { access_token } = await startSession(app);

            const response = await api(app, 'get', '/dids/did:cid:missing', access_token);

            expect(response.status).toBe(404);
            expect(response.body).toEqual({ error: 'did_not_found' });
        });

        it('serves the name directory', async () => {
            const { app } = mount({ users: { [ALICE]: { name: 'alice' }, [CAROL]: {} } });
            const { access_token } = await startSession(app);

            const response = await api(app, 'get', '/directory', access_token);

            expect(response.status).toBe(200);
            expect(response.body).toMatchObject({ version: 1, names: { alice: ALICE } });
        });
    });

    describe('the signed-in account', () => {
        it('returns the account profile', async () => {
            const users = {
                [ALICE]: { name: 'alice', credentialDid: 'did:cid:cred', credentialIssuedAt: '2026-01-01T00:00:00.000Z', logins: 3 },
            };
            const { app } = mount({ users });
            const accessToken = await signIn(app, ALICE);

            const response = await api(app, 'get', '/account', accessToken);

            expect(response.status).toBe(200);
            // Login bookkeeping is not part of what the agent is shown.
            expect(response.body).toEqual({
                did: ALICE,
                name: 'alice',
                credentialDid: 'did:cid:cred',
                credentialIssuedAt: '2026-01-01T00:00:00.000Z',
            });
        });

        it('returns the membership credential, or 404 before one is issued', async () => {
            const users: Record<string, any> = { [ALICE]: { name: 'alice' } };
            const { app } = mount({ users });
            const accessToken = await signIn(app, ALICE);

            const none = await api(app, 'get', '/account/credential', accessToken);
            expect(none.status).toBe(404);
            expect(none.body).toEqual({ error: 'credential_not_found' });

            users[ALICE].credentialDid = 'did:cid:cred';
            users[ALICE].credentialIssuedAt = '2026-01-01T00:00:00.000Z';
            const issued = await api(app, 'get', '/account/credential', accessToken);
            expect(issued.status).toBe(200);
            expect(issued.body).toEqual({
                credentialDid: 'did:cid:cred',
                credentialIssuedAt: '2026-01-01T00:00:00.000Z',
                credential: { id: 'did:cid:cred', credentialSubject: { id: 'subject' } },
            });
        });

        it('claims a name and issues the membership credential', async () => {
            const { app, users, keymaster } = mount();
            const accessToken = await signIn(app, CAROL);

            const response = await api(app, 'put', '/account/name', accessToken, { name: 'Carol' });

            expect(response.status).toBe(200);
            expect(response.body).toMatchObject({ ok: true, name: 'carol', did: CAROL, credentialDid: 'did:cid:issued-credential' });
            expect(users[CAROL]).toMatchObject({ name: 'carol', credentialDid: 'did:cid:issued-credential' });
            expect(keymaster.bindCredential).toHaveBeenCalledWith(CAROL, expect.objectContaining({
                claims: { name: 'carol@archon.test' },
            }));
        });

        it('deletes the name and revokes its credential', async () => {
            const users: Record<string, any> = { [ALICE]: { name: 'alice', credentialDid: 'did:cid:cred' } };
            const { app, keymaster } = mount({ users });
            const accessToken = await signIn(app, ALICE);

            const deleted = await api(app, 'delete', '/account/name', accessToken);

            expect(deleted.status).toBe(200);
            expect(deleted.body).toEqual({ ok: true, message: "name 'alice' deleted and credential revoked" });
            expect(keymaster.revokeCredential).toHaveBeenCalledWith('did:cid:cred');
            expect(users[ALICE].name).toBeUndefined();
            expect(users[ALICE].credentialDid).toBeUndefined();

            const again = await api(app, 'delete', '/account/name', accessToken);
            expect(again.status).toBe(404);
            expect(again.body).toEqual({ ok: false, message: 'No name to delete' });
        });
    });
});

describe('Herald account settings for connected agents', () => {
    // The connection list lives in the protocol store (Redis in production).
    function failingStore() {
        const kv = new MemoryKV();
        jest.spyOn(kv, 'members').mockRejectedValue(new Error('store unavailable'));
        return kv;
    }

    it('lists the agents connected to the account', async () => {
        const { app } = mount({ users: { [ALICE]: { name: 'alice' } }, session: { user: { did: ALICE } } });
        await signIn(app, ALICE);

        const response = await request(app).get('/api/poppy/connections');

        expect(response.status).toBe(200);
        expect(response.body.connections).toEqual([expect.objectContaining({
            clientId: AGENT_ID,
            name: 'Example Agent',
            domain: 'agent.example',
            scope: ['poppy:read', 'poppy:write'],
        })]);
    });

    it('disconnects an agent, after which its token no longer reaches the account', async () => {
        const { app } = mount({ users: { [ALICE]: { name: 'alice' } }, session: { user: { did: ALICE } } });
        const accessToken = await signIn(app, ALICE);
        const [connection] = (await request(app).get('/api/poppy/connections')).body.connections;

        const removed = await request(app).delete(`/api/poppy/connections/${connection.id}`);

        expect(removed.status).toBe(200);
        expect(removed.body).toEqual({ ok: true });
        expect((await request(app).get('/api/poppy/connections')).body.connections).toEqual([]);
        const account = await api(app, 'get', '/account', accessToken);
        expect(account.status).toBe(403);
    });

    it('reports a store failure while listing connections as 500', async () => {
        const { app } = mount({ kv: failingStore(), session: { user: { did: ALICE } } });

        const response = await request(app).get('/api/poppy/connections');

        expect(response.status).toBe(500);
        expect(response.body).toEqual({ error: 'Could not list connected agents' });
    });

    it('reports a store failure while disconnecting as 500', async () => {
        const { app } = mount({ kv: failingStore(), session: { user: { did: ALICE } } });

        const response = await request(app).delete('/api/poppy/connections/agt_anything');

        expect(response.status).toBe(500);
        expect(response.body).toEqual({ error: 'Could not disconnect the agent' });
    });
});
