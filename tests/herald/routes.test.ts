import { jest } from '@jest/globals';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';

// config.ts reads the environment at module-evaluation time, and oauth/index.ts
// (imported transitively) would otherwise write its signing key to /app/server/data.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-routes-'));
process.env.ARCHON_HERALD_JWT_KEY_PATH = path.join(tmpDir, 'oauth-signing-key.json');
process.env.ARCHON_HERALD_DOMAIN = 'archon.test';
process.env.ARCHON_HERALD_NAME = 'name-service';
process.env.ARCHON_HERALD_OWNER_DID = 'did:cid:owner';
process.env.ARCHON_DRAWBRIDGE_PUBLIC_HOST = 'https://archon.test';

let createHeraldRoutes: any;
let logSpy: any;
let warnSpy: any;
let errorSpy: any;

beforeAll(async () => {
    ({ createHeraldRoutes } = await import('../../services/herald/server/src/routes'));
});

beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
});

afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

function createDb(users: Record<string, any> = {}) {
    return {
        getUser: jest.fn<any>(async (did: string) => users[did] ?? null),
        setUser: jest.fn<any>(async (did: string, user: any) => { users[did] = user; }),
        deleteUser: jest.fn<any>(async (did: string) => {
            if (!users[did]) return false;
            delete users[did];
            return true;
        }),
        listUsers: jest.fn<any>(async () => users),
        findDidByName: jest.fn<any>(async (name: string) =>
            Object.entries(users).find(([, u]: any) => u.name === name)?.[0] ?? null),
        setReplyToken: jest.fn<any>(), getReplyToken: jest.fn<any>(),
        deleteExpiredReplyTokens: jest.fn<any>(async () => 0),
        setEmailMapping: jest.fn<any>(), getEmailMapping: jest.fn<any>(),
    };
}

function mount(overrides: { db?: any; keymaster?: any; session?: any } = {}) {
    const db = overrides.db ?? createDb();
    const ctx: any = {
        keymaster: overrides.keymaster ?? {},
        db,
        emailBridge: null,
        serviceDID: 'did:cid:service',
    };

    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    // Stand in for express-session, which the bootstrap installs.
    app.use((req: any, _res, next) => {
        req.session = { ...(overrides.session ?? {}), destroy: (cb: any) => cb?.() };
        next();
    });
    const { router } = createHeraldRoutes(ctx);
    app.use(router);

    return { app, ctx, db };
}

describe('herald public endpoints', () => {
    it('reports service configuration', async () => {
        const { app } = mount();

        const response = await request(app).get('/api/config');

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            serviceName: 'name-service',
            serviceDID: 'did:cid:service',
            serviceDomain: 'archon.test',
        });
    });

    it('builds the name registry from users that have a name', async () => {
        const db = createDb({
            'did:cid:alice': { name: 'alice' },
            'did:cid:bob': { name: 'bob' },
            'did:cid:anon': { logins: 3 },
        });
        const { app } = mount({ db });

        const response = await request(app).get('/api/registry');

        expect(response.status).toBe(200);
        expect(response.body.names).toEqual({ alice: 'did:cid:alice', bob: 'did:cid:bob' });
        expect(response.body.version).toBe(1);
    });

    it('resolves a name to its DID, and 404s an unknown one', async () => {
        const db = createDb({ 'did:cid:alice': { name: 'alice' } });
        const { app } = mount({ db });

        const found = await request(app).get('/api/name/alice');
        expect(found.status).toBe(200);
        expect(found.body).toMatchObject({ name: 'alice', did: 'did:cid:alice' });

        const missing = await request(app).get('/api/name/nobody');
        expect(missing.status).toBe(404);
    });

    it('serves the directory document', async () => {
        const db = createDb({ 'did:cid:alice': { name: 'alice' } });
        const { app } = mount({ db });

        const response = await request(app).get('/directory.json');

        expect(response.status).toBe(200);
        expect(response.body.names).toEqual({ alice: 'did:cid:alice' });
    });

    it('serves the well-known names list and lookup', async () => {
        const db = createDb({ 'did:cid:alice': { name: 'alice' } });
        const { app } = mount({ db });

        const list = await request(app).get('/.well-known/names');
        expect(list.status).toBe(200);

        const one = await request(app).get('/.well-known/names/alice');
        expect(one.status).toBe(200);

        const missing = await request(app).get('/.well-known/names/nobody');
        expect(missing.status).toBe(404);
    });
});

describe('herald authentication gates', () => {
    it('rejects unauthenticated access to protected routes', async () => {
        const { app } = mount();

        for (const path of ['/api/users', '/api/credential']) {
            const response = await request(app).get(path);
            expect([path, response.status]).toEqual([path, 401]);
        }
    });

    it('rejects a non-owner from owner-only routes', async () => {
        const { app } = mount({ session: { user: { did: 'did:cid:notowner' } } });

        const response = await request(app).get('/api/admin');

        expect(response.status).toBe(403);
    });

    it('admits the configured owner', async () => {
        const db = createDb({ 'did:cid:owner': { name: 'owner' } });
        const { app } = mount({ db, session: { user: { did: 'did:cid:owner' } } });

        const response = await request(app).get('/api/admin');

        expect(response.status).toBe(200);
    });

    it('lists users for an authenticated caller', async () => {
        const db = createDb({ 'did:cid:alice': { name: 'alice' } });
        const { app } = mount({ db, session: { user: { did: 'did:cid:alice' } } });

        const response = await request(app).get('/api/users');

        expect(response.status).toBe(200);
        expect(response.body).toContain('did:cid:alice');
    });
});

describe('herald name validation', () => {
    const cases: Array<[string, any, number]> = [
        ['missing', undefined, 400],
        ['too short', 'ab', 400],
        ['too long', 'a'.repeat(33), 400],
        ['illegal characters', 'bad name!', 400],
        ['non-string', 12345, 400],
    ];

    it.each(cases)('rejects a %s name', async (_label, name, expected) => {
        // The route authenticates before it validates, so a valid bearer token is
        // needed to reach the name checks at all.
        const keymaster = {
            verifyResponse: jest.fn<any>().mockResolvedValue({ match: true, responder: 'did:cid:alice' }),
        };
        const { app } = mount({ keymaster, session: { user: { did: 'did:cid:alice' } } });

        const response = await request(app)
            .put('/api/name')
            .set('Authorization', 'Bearer valid-response')
            .send({ name });

        expect(response.status).toBe(expected);
    });

    it('rejects a name already taken by someone else', async () => {
        const db = createDb({
            'did:cid:alice': { name: 'taken' },
            'did:cid:bob': {},
        });
        const keymaster = {
            verifyResponse: jest.fn<any>().mockResolvedValue({ match: true, responder: 'did:cid:bob' }),
        };
        const { app } = mount({ db, keymaster, session: { user: { did: 'did:cid:bob' } } });

        const response = await request(app)
            .put('/api/name')
            .set('Authorization', 'Bearer some-response')
            .send({ name: 'taken' });

        expect([400, 409]).toContain(response.status);
    });
});

describe('herald bearer token handling', () => {
    it('rejects a request with no bearer token', async () => {
        const { app } = mount();

        const response = await request(app).put('/api/name').send({ name: 'alice' });

        expect(response.status).toBe(401);
    });

    it('rejects a bearer token that does not verify', async () => {
        const keymaster = {
            verifyResponse: jest.fn<any>().mockResolvedValue({ match: false }),
        };
        const { app } = mount({ keymaster });

        const response = await request(app)
            .put('/api/name')
            .set('Authorization', 'Bearer bad-response')
            .send({ name: 'alice' });

        expect(response.status).toBe(401);
    });
});

describe('herald avatar content type', () => {
    it('404s an avatar for an unknown name', async () => {
        const { app } = mount();

        const response = await request(app).get('/api/name/nobody/avatar');

        expect(response.status).toBe(404);
    });
});

describe('herald webfinger', () => {
    it('requires a resource parameter in acct: form', async () => {
        const { app } = mount();

        const missing = await request(app).get('/.well-known/webfinger');
        expect(missing.status).toBe(400);
        expect(missing.body.error).toMatch(/resource/i);

        const malformed = await request(app).get('/.well-known/webfinger?resource=not-an-acct');
        expect(malformed.status).toBe(400);
        expect(malformed.body.error).toMatch(/acct:name@domain/);
    });

    it('rejects a domain that is not this service', async () => {
        const { app } = mount();

        const response = await request(app).get('/.well-known/webfinger?resource=acct:alice@elsewhere.test');

        expect(response.status).toBe(404);
        expect(response.body).toEqual({ error: 'Unknown domain' });
    });

    it('404s a name this service does not host', async () => {
        const { app } = mount();

        const response = await request(app).get('/.well-known/webfinger?resource=acct:nobody@archon.test');

        expect(response.status).toBe(404);
        expect(response.body).toEqual({ error: 'Name not found' });
    });

    it('returns a JRD document for a known name', async () => {
        const db = createDb({ 'did:cid:alice': { name: 'alice' } });
        const { app } = mount({ db });

        const response = await request(app).get('/.well-known/webfinger?resource=acct:alice@archon.test');

        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toContain('application/jrd+json');
        expect(response.body.subject).toBe('acct:alice@archon.test');
        expect(response.body.aliases).toEqual(['did:cid:alice']);

        const rels = response.body.links.map((l: any) => l.rel);
        expect(rels).toEqual(expect.arrayContaining([
            'self',
            'http://webfinger.net/rel/profile-page',
            'https://w3id.org/did',
            'http://webfinger.net/rel/avatar',
        ]));
        expect(response.body.links[0].href).toContain('/api/name/alice');
    });
});

describe('herald session login', () => {
    function keymasterVerifying(result: any) {
        return { verifyResponse: jest.fn<any>().mockResolvedValue(result) };
    }

    it('rejects a GET login with no response parameter', async () => {
        const { app } = mount();

        const response = await request(app).get('/api/login');

        expect(response.status).toBe(400);
        expect(response.body).toEqual({ error: 'Missing or invalid response param' });
    });

    it('reports not authenticated when the response carries no challenge', async () => {
        const keymaster = keymasterVerifying({ match: false });
        const { app } = mount({ keymaster });

        const get = await request(app).get('/api/login?response=abc');
        expect(get.status).toBe(200);
        expect(get.body).toEqual({ authenticated: false });

        const post = await request(app).post('/api/login').send({ response: 'abc' });
        expect(post.body).toEqual({ authenticated: false });
    });

    it('authenticates a verified response and records the login', async () => {
        const db = createDb();
        const keymaster = keymasterVerifying({
            match: true,
            challenge: 'did:cid:challenge',
            responder: 'did:cid:alice',
        });
        const { app } = mount({ db, keymaster });

        const response = await request(app).get('/api/login?response=abc');

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ authenticated: true });
        expect(db.setUser).toHaveBeenCalledWith('did:cid:alice', expect.objectContaining({ logins: 1 }));
    });

    it('increments the login count for a returning user', async () => {
        const db = createDb({ 'did:cid:alice': { logins: 4, firstLogin: 'earlier' } });
        const keymaster = keymasterVerifying({
            match: true,
            challenge: 'did:cid:challenge2',
            responder: 'did:cid:alice',
        });
        const { app } = mount({ db, keymaster });

        await request(app).post('/api/login').send({ response: 'abc' });

        expect(db.setUser).toHaveBeenCalledWith('did:cid:alice', expect.objectContaining({ logins: 5 }));
    });

    it('reports a login failure as 500', async () => {
        const keymaster = { verifyResponse: jest.fn<any>().mockRejectedValue(new Error('gatekeeper down')) };
        const { app } = mount({ keymaster });

        const response = await request(app).get('/api/login?response=abc');

        expect(response.status).toBe(500);
    });

    it('destroys the session on logout', async () => {
        const { app } = mount({ session: { user: { did: 'did:cid:alice' } } });

        const response = await request(app).post('/api/logout');

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ ok: true });
    });
});

describe('herald check-auth', () => {
    it('reports an anonymous caller', async () => {
        const { app } = mount();

        const response = await request(app).get('/api/check-auth');

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ isAuthenticated: false, userDID: null, isOwner: false });
    });

    it('reports an authenticated non-owner with their profile', async () => {
        const db = createDb({ 'did:cid:alice': { name: 'alice', logins: 2 } });
        const { app } = mount({ db, session: { user: { did: 'did:cid:alice' } } });

        const response = await request(app).get('/api/check-auth');

        expect(response.body).toMatchObject({
            isAuthenticated: true,
            userDID: 'did:cid:alice',
            isOwner: false,
            profile: { name: 'alice' },
        });
    });

    it('flags the configured owner', async () => {
        const db = createDb({ 'did:cid:owner': { name: 'owner' } });
        const { app } = mount({ db, session: { user: { did: 'did:cid:owner' } } });

        const response = await request(app).get('/api/check-auth');

        expect(response.body.isOwner).toBe(true);
    });
});

describe('herald profile', () => {
    it('404s an unknown profile', async () => {
        const { app } = mount({ session: { user: { did: 'did:cid:alice' } } });

        const response = await request(app).get('/api/profile/did:cid:nobody');

        expect(response.status).toBe(404);
    });

    it('marks the caller own profile', async () => {
        const db = createDb({
            'did:cid:alice': { name: 'alice' },
            'did:cid:bob': { name: 'bob' },
        });
        const { app } = mount({ db, session: { user: { did: 'did:cid:alice' } } });

        const own = await request(app).get('/api/profile/did:cid:alice');
        expect(own.status).toBe(200);
        expect(own.body).toMatchObject({ did: 'did:cid:alice', isUser: true });

        const other = await request(app).get('/api/profile/did:cid:bob');
        expect(other.body).toMatchObject({ did: 'did:cid:bob', isUser: false });
    });
});

describe('herald credential', () => {
    it('404s when the authenticated user has no record', async () => {
        const { app } = mount({ session: { user: { did: 'did:cid:ghost' } } });

        const response = await request(app).get('/api/credential');

        expect(response.status).toBe(404);
        expect(response.body).toEqual({ error: 'User not found' });
    });

    it('reports no credential issued yet', async () => {
        const db = createDb({ 'did:cid:alice': { name: 'alice' } });
        const { app } = mount({ db, session: { user: { did: 'did:cid:alice' } } });

        const response = await request(app).get('/api/credential');

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ hasCredential: false, name: 'alice' });
    });

    it('returns the issued credential', async () => {
        const db = createDb({
            'did:cid:alice': { name: 'alice', credentialDid: 'did:cid:cred', credentialIssuedAt: 'then' },
        });
        const keymaster = { getCredential: jest.fn<any>().mockResolvedValue({ id: 'vc-1' }) };
        const { app } = mount({ db, keymaster, session: { user: { did: 'did:cid:alice' } } });

        const response = await request(app).get('/api/credential');

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            hasCredential: true,
            credentialDid: 'did:cid:cred',
            credential: { id: 'vc-1' },
        });
    });

    it('reports a credential fetch failure as 500 with a message', async () => {
        const db = createDb({ 'did:cid:alice': { credentialDid: 'did:cid:cred' } });
        const keymaster = { getCredential: jest.fn<any>().mockRejectedValue(new Error('resolver down')) };
        const { app } = mount({ db, keymaster, session: { user: { did: 'did:cid:alice' } } });

        const response = await request(app).get('/api/credential');

        expect(response.status).toBe(500);
        expect(response.body.error).toBe('resolver down');
    });
});

describe('herald stateless name assignment', () => {
    function keymasterFor(responder: string, extra: Record<string, any> = {}) {
        return {
            verifyResponse: jest.fn<any>().mockResolvedValue({ match: true, responder }),
            setCurrentId: jest.fn<any>().mockResolvedValue(undefined),
            bindCredential: jest.fn<any>().mockResolvedValue({ bound: true }),
            issueCredential: jest.fn<any>().mockResolvedValue('did:cid:newcred'),
            getCredential: jest.fn<any>().mockResolvedValue({ id: 'vc-1', credentialSubject: {} }),
            updateCredential: jest.fn<any>().mockResolvedValue(true),
            revokeCredential: jest.fn<any>().mockResolvedValue(true),
            ...extra,
        };
    }

    it('assigns a name and issues a membership credential', async () => {
        const db = createDb({ 'did:cid:alice': {} });
        const keymaster = keymasterFor('did:cid:alice');
        const { app } = mount({ db, keymaster });

        const response = await request(app)
            .put('/api/name')
            .set('Authorization', 'Bearer valid')
            .send({ name: 'Alice' });

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ ok: true, name: 'alice', did: 'did:cid:alice' });
        // The name is normalized to lower case before storage.
        expect(db.setUser).toHaveBeenCalledWith('did:cid:alice', expect.objectContaining({ name: 'alice' }));
        expect(keymaster.issueCredential).toHaveBeenCalled();
        expect(response.body.credentialDid).toBe('did:cid:newcred');
    });

    it('updates an existing credential instead of issuing a second one', async () => {
        const db = createDb({ 'did:cid:alice': { name: 'old', credentialDid: 'did:cid:cred' } });
        const keymaster = keymasterFor('did:cid:alice');
        const { app } = mount({ db, keymaster });

        const response = await request(app)
            .put('/api/name')
            .set('Authorization', 'Bearer valid')
            .send({ name: 'newname' });

        expect(response.status).toBe(200);
        expect(keymaster.updateCredential).toHaveBeenCalledWith('did:cid:cred', expect.anything());
        expect(keymaster.issueCredential).not.toHaveBeenCalled();
    });

    it('deletes a name and revokes its credential', async () => {
        const db = createDb({ 'did:cid:alice': { name: 'alice', credentialDid: 'did:cid:cred' } });
        const keymaster = keymasterFor('did:cid:alice');
        const { app } = mount({ db, keymaster });

        const response = await request(app)
            .delete('/api/name')
            .set('Authorization', 'Bearer valid');

        expect(response.status).toBe(200);
        expect(response.body.ok).toBe(true);
        expect(keymaster.revokeCredential).toHaveBeenCalledWith('did:cid:cred');
        expect(db.setUser).toHaveBeenCalledWith('did:cid:alice', expect.not.objectContaining({ name: 'alice' }));
    });

    it('rejects a delete with no bearer token, unknown user, or no name', async () => {
        const noToken = mount();
        await expect(request(noToken.app).delete('/api/name')).resolves.toMatchObject({ status: 401 });

        const ghost = mount({ keymaster: keymasterFor('did:cid:ghost') });
        const missing = await request(ghost.app).delete('/api/name').set('Authorization', 'Bearer valid');
        expect(missing.status).toBe(404);

        const noName = mount({
            db: createDb({ 'did:cid:alice': { logins: 1 } }),
            keymaster: keymasterFor('did:cid:alice'),
        });
        const nameless = await request(noName.app).delete('/api/name').set('Authorization', 'Bearer valid');
        expect(nameless.status).toBe(404);
        expect(nameless.body.message).toMatch(/No name to delete/);
    });

    it('reports a keymaster failure during assignment as 500', async () => {
        const db = createDb({ 'did:cid:alice': {} });
        const keymaster = keymasterFor('did:cid:alice', {
            issueCredential: jest.fn<any>().mockRejectedValue(new Error('issuer down')),
        });
        const { app } = mount({ db, keymaster });

        const response = await request(app)
            .put('/api/name')
            .set('Authorization', 'Bearer valid')
            .send({ name: 'alice' });

        expect(response.status).toBe(500);
    });
});
