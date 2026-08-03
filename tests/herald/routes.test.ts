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
    const { router, startDmailPollLoop } = createHeraldRoutes(ctx);
    app.use(router);

    return { app, ctx, db, startDmailPollLoop };
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

    it('points profile-page at a route the client serves', async () => {
        const db = createDb({ 'did:cid:alice': { name: 'alice' } });
        const { app } = mount({ db });

        const response = await request(app).get('/.well-known/webfinger?resource=acct:alice@archon.test');

        const profilePage = response.body.links.find(
            (link: any) => link.rel === 'http://webfinger.net/rel/profile-page');

        // Regression guard: this used to be `/name/alice`, which the client has no
        // route for — following it landed on the home page instead of the profile.
        expect(profilePage.href).toContain('/id/alice');
        expect(profilePage.href).not.toContain('/name/alice');
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

describe('herald inbound email webhook', () => {
    function bridge(overrides: Record<string, any> = {}) {
        return {
            isConfigured: jest.fn<any>().mockReturnValue(true),
            parseInboundEmail: jest.fn<any>((body: any) =>
                body.from && body.to ? { ...body, subject: body.subject ?? '(no subject)', text: body.text ?? '' } : null),
            extractReplyToken: jest.fn<any>().mockReturnValue(null),
            extractEmailAddress: jest.fn<any>((v: string) => v),
            extractRecipientName: jest.fn<any>().mockReturnValue(null),
            lookupToken: jest.fn<any>().mockResolvedValue(null),
            storeEmailMapping: jest.fn<any>().mockResolvedValue(undefined),
            ...overrides,
        };
    }

    function mountBridge(emailBridge: any, over: { db?: any; keymaster?: any } = {}) {
        const m = mount(over);
        m.ctx.emailBridge = emailBridge;
        return m;
    }

    it('404s when no email bridge is configured', async () => {
        const { app } = mount();

        const response = await request(app).post('/api/inbound-email').send({ from: 'a@b.com', to: 'c@d.com' });

        expect(response.status).toBe(404);
        expect(response.body).toEqual({ error: 'Email bridge not configured' });
    });

    it('400s an email missing from or to', async () => {
        const { app } = mountBridge(bridge());

        const response = await request(app).post('/api/inbound-email').send({ subject: 'orphan' });

        expect(response.status).toBe(400);
        expect(response.body).toEqual({ error: 'Missing from or to fields' });
    });

    it('drops spam above the score threshold without delivering', async () => {
        const { app, ctx } = mountBridge(bridge());
        ctx.keymaster = { setCurrentId: jest.fn<any>(), createDmail: jest.fn<any>(), sendDmail: jest.fn<any>() };

        const response = await request(app)
            .post('/api/inbound-email')
            .send({ from: 'spam@bad.test', to: 'alice@archon.test', spam_score: '9.5' });

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ ok: true, action: 'spam-rejected' });
        expect(ctx.keymaster.createDmail).not.toHaveBeenCalled();
    });

    it('ignores an expired reply token', async () => {
        const eb = bridge({ extractReplyToken: jest.fn<any>().mockReturnValue('tok') });
        const { app } = mountBridge(eb);

        const response = await request(app)
            .post('/api/inbound-email')
            .send({ from: 'a@b.com', to: 'reply+tok@parse.archon.test' });

        expect(response.body).toEqual({ ok: true, action: 'token-expired' });
    });

    it('delivers a reply as a dmail referencing the original', async () => {
        const eb = bridge({
            extractReplyToken: jest.fn<any>().mockReturnValue('tok'),
            lookupToken: jest.fn<any>().mockResolvedValue({
                senderDid: 'did:cid:alice',
                originalDmailDid: 'did:cid:orig',
            }),
        });
        const keymaster = {
            setCurrentId: jest.fn<any>().mockResolvedValue(undefined),
            createDmail: jest.fn<any>().mockResolvedValue('did:cid:dmail'),
            sendDmail: jest.fn<any>().mockResolvedValue('did:cid:notice'),
        };
        const { app } = mountBridge(eb, { keymaster });

        const response = await request(app)
            .post('/api/inbound-email')
            .send({ from: 'bob@ext.test', to: 'reply+tok@parse.archon.test', subject: 'Re: hi', text: 'body' });

        expect(response.body).toMatchObject({ ok: true, action: 'delivered', dmailDid: 'did:cid:dmail' });
        expect(keymaster.createDmail).toHaveBeenCalledWith(
            expect.objectContaining({
                to: ['did:cid:alice'],
                reference: 'did:cid:orig',
                subject: expect.stringContaining('bob@ext.test'),
            }),
            { registry: 'hyperswarm' },
        );
        expect(eb.storeEmailMapping).toHaveBeenCalled();
    });

    it('ignores mail with no recognizable recipient', async () => {
        const { app } = mountBridge(bridge());

        const response = await request(app)
            .post('/api/inbound-email')
            .send({ from: 'a@b.com', to: 'postmaster@archon.test' });

        expect(response.body).toEqual({ ok: true, action: 'no-recipient-ignored' });
    });

    it('ignores mail addressed to an unknown herald name', async () => {
        const eb = bridge({ extractRecipientName: jest.fn<any>().mockReturnValue('nobody') });
        const { app } = mountBridge(eb);

        const response = await request(app)
            .post('/api/inbound-email')
            .send({ from: 'a@b.com', to: 'nobody@archon.test' });

        expect(response.body).toEqual({ ok: true, action: 'unknown-name-ignored' });
    });

    it('delivers unsolicited mail to a known herald name', async () => {
        const eb = bridge({ extractRecipientName: jest.fn<any>().mockReturnValue('alice') });
        const db = createDb({ 'did:cid:alice': { name: 'alice' } });
        const keymaster = {
            setCurrentId: jest.fn<any>().mockResolvedValue(undefined),
            createDmail: jest.fn<any>().mockResolvedValue('did:cid:dmail'),
            sendDmail: jest.fn<any>().mockResolvedValue('did:cid:notice'),
        };
        const { app } = mountBridge(eb, { db, keymaster });

        const response = await request(app)
            .post('/api/inbound-email')
            .send({ from: 'bob@ext.test', to: 'alice@archon.test', subject: 'hello' });

        expect(response.body).toMatchObject({ ok: true, action: 'delivered' });
        expect(keymaster.createDmail).toHaveBeenCalledWith(
            expect.objectContaining({ to: ['did:cid:alice'] }),
            { registry: 'hyperswarm' },
        );
    });

    it('swallows a processing failure as a 200 so the provider does not retry', async () => {
        const eb = bridge({
            extractRecipientName: jest.fn<any>().mockReturnValue('alice'),
        });
        const db = createDb({ 'did:cid:alice': { name: 'alice' } });
        const keymaster = { setCurrentId: jest.fn<any>().mockRejectedValue(new Error('keymaster down')) };
        const { app } = mountBridge(eb, { db, keymaster });

        const response = await request(app)
            .post('/api/inbound-email')
            .send({ from: 'bob@ext.test', to: 'alice@archon.test' });

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ ok: true, action: 'error' });
    });
});

describe('herald outbound email', () => {
    function configuredBridge() {
        return {
            isConfigured: jest.fn<any>().mockReturnValue(true),
            sendEmail: jest.fn<any>().mockResolvedValue({ token: 'tok123' }),
        };
    }

    it('404s when the bridge is not configured', async () => {
        const { app } = mount();

        const response = await request(app).post('/api/send-email').send({});

        expect(response.status).toBe(404);
    });

    it('requires a bearer token and a herald name', async () => {
        const noAuth = mount();
        noAuth.ctx.emailBridge = configuredBridge();
        await expect(request(noAuth.app).post('/api/send-email').send({}))
            .resolves.toMatchObject({ status: 401 });

        const nameless = mount({
            db: createDb({ 'did:cid:alice': { logins: 1 } }),
            keymaster: { verifyResponse: jest.fn<any>().mockResolvedValue({ match: true, responder: 'did:cid:alice' }) },
        });
        nameless.ctx.emailBridge = configuredBridge();
        const response = await request(nameless.app)
            .post('/api/send-email')
            .set('Authorization', 'Bearer valid')
            .send({});
        expect(response.status).toBe(403);
        expect(response.body).toEqual({ error: 'Herald name required to send email' });
    });

    it('validates the required body fields', async () => {
        const m = mount({
            db: createDb({ 'did:cid:alice': { name: 'alice' } }),
            keymaster: { verifyResponse: jest.fn<any>().mockResolvedValue({ match: true, responder: 'did:cid:alice' }) },
        });
        m.ctx.emailBridge = configuredBridge();

        const response = await request(m.app)
            .post('/api/send-email')
            .set('Authorization', 'Bearer valid')
            .send({ to: 'x@y.com', subject: 'hi' });

        expect(response.status).toBe(400);
        expect(response.body.error).toMatch(/Missing required fields/);
    });

    it('sends and returns the reply token', async () => {
        const eb = configuredBridge();
        const m = mount({
            db: createDb({ 'did:cid:alice': { name: 'alice' } }),
            keymaster: { verifyResponse: jest.fn<any>().mockResolvedValue({ match: true, responder: 'did:cid:alice' }) },
        });
        m.ctx.emailBridge = eb;

        const response = await request(m.app)
            .post('/api/send-email')
            .set('Authorization', 'Bearer valid')
            .send({ to: 'x@y.com', subject: 'hi', body: 'text', dmailDid: 'did:cid:dmail' });

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ ok: true, token: 'tok123' });
        expect(eb.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
            senderName: 'alice',
            senderDid: 'did:cid:alice',
            dmailDid: 'did:cid:dmail',
        }));
    });

    it('reports a send failure as 500', async () => {
        const m = mount({
            db: createDb({ 'did:cid:alice': { name: 'alice' } }),
            keymaster: { verifyResponse: jest.fn<any>().mockResolvedValue({ match: true, responder: 'did:cid:alice' }) },
        });
        m.ctx.emailBridge = {
            isConfigured: jest.fn<any>().mockReturnValue(true),
            sendEmail: jest.fn<any>().mockRejectedValue(new Error('sendgrid down')),
        };

        const response = await request(m.app)
            .post('/api/send-email')
            .set('Authorization', 'Bearer valid')
            .send({ to: 'x@y.com', subject: 'hi', body: 'b', dmailDid: 'did:cid:d' });

        expect(response.status).toBe(500);
        expect(response.body).toEqual({ error: 'Failed to send email' });
    });
});

describe('herald registry publication', () => {
    const originalFetch = global.fetch;

    afterEach(() => { global.fetch = originalFetch; });

    function ownerApp() {
        const db = createDb({ 'did:cid:owner': { name: 'owner' }, 'did:cid:alice': { name: 'alice' } });
        return mount({ db, session: { user: { did: 'did:cid:owner' } } });
    }

    it('pins the registry to IPFS and publishes it to IPNS', async () => {
        const { app } = ownerApp();
        global.fetch = jest.fn<any>()
            .mockResolvedValueOnce({ ok: true, json: async () => ({ Hash: 'bafycid' }) })
            .mockResolvedValueOnce({ ok: true, json: async () => ({ Name: 'k51ipns' }) });

        const response = await request(app).post('/api/admin/publish');

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ ok: true, cid: 'bafycid', ipns: 'k51ipns' });
        expect(response.body.registry.names).toEqual({ owner: 'did:cid:owner', alice: 'did:cid:alice' });

        const [addUrl] = (global.fetch as any).mock.calls[0];
        expect(String(addUrl)).toContain('/add?pin=true');
        const [pubUrl] = (global.fetch as any).mock.calls[1];
        expect(String(pubUrl)).toContain('/name/publish?arg=/ipfs/bafycid');
    });

    it('reports an IPFS add failure', async () => {
        const { app } = ownerApp();
        global.fetch = jest.fn<any>().mockResolvedValue({ ok: false, statusText: 'Service Unavailable' });

        const response = await request(app).post('/api/admin/publish');

        expect(response.status).toBe(500);
        expect(response.body.error).toMatch(/IPFS add failed/);
    });

    it('reports an IPNS publish failure', async () => {
        const { app } = ownerApp();
        global.fetch = jest.fn<any>()
            .mockResolvedValueOnce({ ok: true, json: async () => ({ Hash: 'bafycid' }) })
            .mockResolvedValueOnce({ ok: false, statusText: 'Gateway Timeout' });

        const response = await request(app).post('/api/admin/publish');

        expect(response.status).toBe(500);
        expect(response.body.error).toMatch(/IPNS publish failed/);
    });

    it('is owner-only', async () => {
        const { app } = mount({ session: { user: { did: 'did:cid:alice' } } });

        await expect(request(app).post('/api/admin/publish')).resolves.toMatchObject({ status: 403 });
    });
});

describe('herald session-based profile name', () => {
    function keymasterFull() {
        return {
            setCurrentId: jest.fn<any>().mockResolvedValue(undefined),
            bindCredential: jest.fn<any>().mockResolvedValue({}),
            issueCredential: jest.fn<any>().mockResolvedValue('did:cid:cred'),
            getCredential: jest.fn<any>().mockResolvedValue({ credentialSubject: {} }),
            updateCredential: jest.fn<any>().mockResolvedValue(true),
            revokeCredential: jest.fn<any>().mockResolvedValue(true),
        };
    }

    it('reads back the current name', async () => {
        const db = createDb({ 'did:cid:alice': { name: 'alice' } });
        const { app } = mount({ db, session: { user: { did: 'did:cid:alice' } } });

        const found = await request(app).get('/api/profile/did:cid:alice/name');
        expect(found.body).toEqual({ name: 'alice' });

        const missing = await request(app).get('/api/profile/did:cid:ghost/name');
        expect(missing.status).toBe(404);
    });

    it('forbids editing another user name', async () => {
        const { app } = mount({ session: { user: { did: 'did:cid:alice' } } });

        const put = await request(app).put('/api/profile/did:cid:bob/name').send({ name: 'stolen' });
        expect(put.status).toBe(403);

        const del = await request(app).delete('/api/profile/did:cid:bob/name');
        expect(del.status).toBe(403);
    });

    it('rejects an invalid name and a name already taken', async () => {
        const db = createDb({ 'did:cid:alice': {}, 'did:cid:bob': { name: 'taken' } });
        const { app } = mount({ db, keymaster: keymasterFull(), session: { user: { did: 'did:cid:alice' } } });

        const invalid = await request(app).put('/api/profile/did:cid:alice/name').send({ name: 'no' });
        expect(invalid.status).toBe(400);

        const taken = await request(app).put('/api/profile/did:cid:alice/name').send({ name: 'taken' });
        expect(taken.status).toBe(409);
        expect(taken.body).toMatchObject({ ok: false, message: 'Name already taken' });
    });

    it('sets a name and issues a credential', async () => {
        const db = createDb({ 'did:cid:alice': {} });
        const keymaster = keymasterFull();
        const { app } = mount({ db, keymaster, session: { user: { did: 'did:cid:alice' } } });

        const response = await request(app).put('/api/profile/did:cid:alice/name').send({ name: 'Alice' });

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ ok: true });
        expect(db.setUser).toHaveBeenCalledWith('did:cid:alice', expect.objectContaining({ name: 'alice' }));
        expect(keymaster.issueCredential).toHaveBeenCalled();
    });

    it('deletes a name and revokes the credential', async () => {
        const db = createDb({ 'did:cid:alice': { name: 'alice', credentialDid: 'did:cid:cred' } });
        const keymaster = keymasterFull();
        const { app } = mount({ db, keymaster, session: { user: { did: 'did:cid:alice' } } });

        const response = await request(app).delete('/api/profile/did:cid:alice/name');

        expect(response.status).toBe(200);
        expect(keymaster.revokeCredential).toHaveBeenCalledWith('did:cid:cred');
    });

    it('404s a delete for a user with no record', async () => {
        const { app } = mount({ session: { user: { did: 'did:cid:ghost' } } });

        const response = await request(app).delete('/api/profile/did:cid:ghost/name');

        expect(response.status).toBe(404);
    });
});

describe('herald admin user deletion', () => {
    it('deletes a user', async () => {
        const db = createDb({ 'did:cid:owner': {}, 'did:cid:alice': { name: 'alice' } });
        const { app } = mount({ db, session: { user: { did: 'did:cid:owner' } } });

        const response = await request(app).delete('/api/admin/user/did%3Acid%3Aalice');

        expect(response.status).toBe(200);
        expect(response.body.ok).toBe(true);
        expect(db.deleteUser).toHaveBeenCalledWith('did:cid:alice');
    });

    it('refuses to delete the owner account', async () => {
        const db = createDb({ 'did:cid:owner': { name: 'owner' } });
        const { app } = mount({ db, session: { user: { did: 'did:cid:owner' } } });

        const response = await request(app).delete('/api/admin/user/did%3Acid%3Aowner');

        expect(response.status).toBe(403);
        expect(response.body).toEqual({ error: 'Cannot delete the owner account' });
    });

    it('404s an unknown user', async () => {
        const db = createDb({ 'did:cid:owner': {} });
        const { app } = mount({ db, session: { user: { did: 'did:cid:owner' } } });

        const response = await request(app).delete('/api/admin/user/did%3Acid%3Aghost');

        expect(response.status).toBe(404);
    });
});

describe('herald member lookup', () => {
    it('resolves a member DID document', async () => {
        const db = createDb({ 'did:cid:alice': { name: 'alice' } });
        const keymaster = { resolveDID: jest.fn<any>().mockResolvedValue({ didDocument: { id: 'did:cid:alice' } }) };
        const { app } = mount({ db, keymaster });

        const response = await request(app).get('/api/member/Alice');

        expect(response.status).toBe(200);
        expect(response.body.didDocument.id).toBe('did:cid:alice');
        // The name is normalized before lookup.
        expect(db.findDidByName).toHaveBeenCalledWith('alice');
    });

    it('404s an unknown member and 500s a resolver failure', async () => {
        const unknown = mount();
        await expect(request(unknown.app).get('/api/member/nobody')).resolves.toMatchObject({ status: 404 });

        const db = createDb({ 'did:cid:alice': { name: 'alice' } });
        const failing = mount({
            db,
            keymaster: { resolveDID: jest.fn<any>().mockRejectedValue(new Error('resolver down')) },
        });
        const response = await request(failing.app).get('/api/member/alice');
        expect(response.status).toBe(500);
        expect(response.body.error).toBe('resolver down');
    });
});

describe('herald LNURLp', () => {
    function withLightning(endpoint: string) {
        const db = createDb({ 'did:cid:alice': { name: 'alice' } });
        const keymaster = {
            resolveDID: jest.fn<any>().mockResolvedValue({
                didDocument: { service: [{ type: 'Lightning', serviceEndpoint: endpoint }] },
            }),
        };
        return mount({ db, keymaster });
    }

    it('reports an error for a name with no Lightning service', async () => {
        const db = createDb({ 'did:cid:alice': { name: 'alice' } });
        const { app } = mount({
            db,
            keymaster: { resolveDID: jest.fn<any>().mockResolvedValue({ didDocument: {} }) },
        });

        const response = await request(app).get('/.well-known/lnurlp/alice');

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ status: 'ERROR' });
    });

    it('returns a payRequest document for a name with Lightning', async () => {
        const { app } = withLightning('https://ln.test/invoice');

        const response = await request(app).get('/.well-known/lnurlp/Alice');

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ tag: 'payRequest' });
        expect(response.body.callback).toContain('/api/lnurlp/alice/callback');
        expect(JSON.parse(response.body.metadata)[1][1]).toBe('alice@archon.test');
    });

    it('rejects a callback amount outside the sendable range', async () => {
        const { app } = withLightning('https://ln.test/invoice');

        for (const amount of ['0', '1', '999999999999']) {
            const response = await request(app).get(`/api/lnurlp/alice/callback?amount=${amount}`);
            expect([amount, response.body.status]).toEqual([amount, 'ERROR']);
        }
    });

    it('errors when the name has no Lightning endpoint', async () => {
        const db = createDb({ 'did:cid:alice': { name: 'alice' } });
        const { app } = mount({
            db,
            keymaster: { resolveDID: jest.fn<any>().mockResolvedValue({ didDocument: {} }) },
        });

        const response = await request(app).get('/api/lnurlp/alice/callback?amount=100000');

        expect(response.body).toMatchObject({ status: 'ERROR' });
    });
});

describe('herald login challenge', () => {
    it('mints a challenge and returns its wallet URL', async () => {
        const keymaster = {
            createChallenge: jest.fn<any>().mockResolvedValue('did:cid:challenge'),
            resolveDID: jest.fn<any>().mockResolvedValue({ didDocument: {} }),
        };
        const { app } = mount({ keymaster });

        const response = await request(app).get('/api/challenge');

        expect(response.status).toBe(200);
        expect(response.body.challenge).toBe('did:cid:challenge');
        expect(response.body.challengeURL).toContain('challenge=did:cid:challenge');
        expect(keymaster.createChallenge).toHaveBeenCalledWith(
            expect.objectContaining({ callback: expect.stringContaining('/api/login') }),
        );
    });

    it('reports a challenge failure as 500', async () => {
        const keymaster = { createChallenge: jest.fn<any>().mockRejectedValue(new Error('keymaster down')) };
        const { app } = mount({ keymaster });

        const response = await request(app).get('/api/challenge');

        expect(response.status).toBe(500);
    });
});

describe('herald avatar serving', () => {
    function withAvatar(image: any, avatarDid: string | undefined = 'did:cid:avatar') {
        const db = createDb({ 'did:cid:alice': { name: 'alice' } });
        const keymaster = {
            resolveDID: jest.fn<any>().mockResolvedValue({ didDocumentData: { avatar: avatarDid } }),
            getImage: jest.fn<any>().mockResolvedValue(image),
        };
        return mount({ db, keymaster });
    }

    it('serves the image bytes with a safe content type', async () => {
        const { app } = withAvatar({
            file: { data: Buffer.from('png-bytes'), type: 'image/png', filename: 'me.png' },
            image: { width: 1, height: 1 },
        });

        const response = await request(app).get('/api/name/Alice/avatar');

        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toContain('image/png');
        expect(response.headers['x-content-type-options']).toBe('nosniff');
        expect(response.headers['content-disposition']).toContain('me.png');
    });

    it('falls back to octet-stream for a content type that is not an allowed image', async () => {
        const { app } = withAvatar({
            file: { data: Buffer.from('<svg/>'), type: 'image/svg+xml' },
            image: { width: 1 },
        });

        const response = await request(app).get('/api/name/alice/avatar');

        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toContain('application/octet-stream');
    });

    it('404s when the member has no avatar or the image has no bytes', async () => {
        const noAvatar = withAvatar(null, '');
        await expect(request(noAvatar.app).get('/api/name/alice/avatar'))
            .resolves.toMatchObject({ status: 404 });

        const noBytes = withAvatar({ file: { type: 'image/png' }, image: {} });
        await expect(request(noBytes.app).get('/api/name/alice/avatar'))
            .resolves.toMatchObject({ status: 404 });
    });
});

describe('herald LNURLp callback invoice fetch', () => {
    const originalFetch = global.fetch;
    afterEach(() => { global.fetch = originalFetch; });

    function withLightning() {
        const db = createDb({ 'did:cid:alice': { name: 'alice' } });
        const keymaster = {
            resolveDID: jest.fn<any>().mockResolvedValue({
                didDocument: { service: [{ type: 'Lightning', serviceEndpoint: 'https://ln.test/invoice' }] },
            }),
        };
        return mount({ db, keymaster });
    }

    it('converts msats to sats and normalizes the invoice response', async () => {
        const { app } = withLightning();
        global.fetch = jest.fn<any>().mockResolvedValue({
            ok: true,
            json: async () => ({ pr: 'lnbc1...', routes: [] }),
        });

        const response = await request(app).get('/api/lnurlp/alice/callback?amount=150000');

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ pr: 'lnbc1...', routes: [] });
        // 150000 msat -> 150 sat
        expect(String((global.fetch as any).mock.calls[0][0])).toContain('amount=150');
    });

    it('accepts the paymentRequest spelling from the endpoint', async () => {
        const { app } = withLightning();
        global.fetch = jest.fn<any>().mockResolvedValue({
            ok: true,
            json: async () => ({ paymentRequest: 'lnbc2...' }),
        });

        const response = await request(app).get('/api/lnurlp/alice/callback?amount=100000');

        expect(response.body).toMatchObject({ pr: 'lnbc2...', routes: [] });
    });

    it('reports an error when the lightning endpoint fails or throws', async () => {
        const notOk = withLightning();
        global.fetch = jest.fn<any>().mockResolvedValue({ ok: false });
        const first = await request(notOk.app).get('/api/lnurlp/alice/callback?amount=100000');
        expect(first.body).toMatchObject({ status: 'ERROR' });

        const threw = withLightning();
        global.fetch = jest.fn<any>().mockRejectedValue(new Error('network down'));
        const second = await request(threw.app).get('/api/lnurlp/alice/callback?amount=100000');
        expect(second.body).toMatchObject({ status: 'ERROR', reason: 'network down' });
    });
});

// --- dmail poll loop --------------------------------------------------------
// Deferred from #820/#821: startDmailPollLoop installs a setTimeout and then a
// 60s setInterval, and a live timer keeps Jest alive (CI has no --forceExit).
// Fake timers make it safe — the timers never reach the real event loop, and
// clearAllTimers in afterEach disposes of them.

describe('dmail poll loop', () => {
    const dmailItem = (over: Record<string, any> = {}) => ({
        tags: ['unread'],
        sender: 'did:cid:sender',
        message: { subject: 'hello', body: 'body text', to: [], cc: [] },
        ...over,
    });

    function pollBridge(over: Record<string, any> = {}) {
        return {
            isConfigured: jest.fn<any>().mockReturnValue(true),
            lookupEmailMapping: jest.fn<any>().mockResolvedValue(null),
            sendEmail: jest.fn<any>().mockResolvedValue({ token: 'tok' }),
            ...over,
        };
    }

    function pollKeymaster(dmails: Record<string, any>) {
        return {
            setCurrentId: jest.fn<any>().mockResolvedValue(undefined),
            refreshNotices: jest.fn<any>().mockResolvedValue(undefined),
            listDmail: jest.fn<any>().mockResolvedValue(dmails),
            fileDmail: jest.fn<any>().mockResolvedValue(true),
        };
    }

    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    // Drive the initial 5s delay, then let the poll's promise chain settle.
    async function runFirstPoll(start: () => void) {
        start();
        await jest.advanceTimersByTimeAsync(5000);
    }

    it('does nothing when the email bridge is not configured', async () => {
        const m = mount({ keymaster: pollKeymaster({}) });
        m.ctx.emailBridge = pollBridge({ isConfigured: jest.fn<any>().mockReturnValue(false) });

        await runFirstPoll(m.startDmailPollLoop);

        expect(m.ctx.keymaster.listDmail).not.toHaveBeenCalled();
    });

    it('skips dmails that are not unread', async () => {
        const keymaster = pollKeymaster({ 'did:cid:d1': dmailItem({ tags: ['inbox'] }) });
        const m = mount({ keymaster });
        m.ctx.emailBridge = pollBridge();

        await runFirstPoll(m.startDmailPollLoop);

        expect(m.ctx.emailBridge.sendEmail).not.toHaveBeenCalled();
    });

    it('forwards a reply to the bridged email address', async () => {
        const keymaster = pollKeymaster({
            'did:cid:d1': dmailItem({ message: { subject: 'Re: hi', body: 'b', to: [], cc: [], reference: 'did:cid:orig' } }),
        });
        const db = createDb({ 'did:cid:sender': { name: 'alice' } });
        const m = mount({ keymaster, db });
        m.ctx.emailBridge = pollBridge({
            lookupEmailMapping: jest.fn<any>().mockResolvedValue({
                emailAddress: 'bob@ext.test',
                recipientDid: 'did:cid:bob',
            }),
        });

        await runFirstPoll(m.startDmailPollLoop);

        expect(m.ctx.emailBridge.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
            to: 'bob@ext.test',
            senderName: 'alice',
            fromEmail: 'alice@archon.test',
            dmailDid: 'did:cid:d1',
        }));
        expect(keymaster.fileDmail).toHaveBeenCalledWith('did:cid:d1', ['inbox']);
    });

    it('falls back to a generic sender when the DID has no named user', async () => {
        const keymaster = pollKeymaster({
            'did:cid:d1': dmailItem({ message: { subject: 'Re: hi', body: 'b', to: [], cc: [], reference: 'did:cid:orig' } }),
        });
        const m = mount({ keymaster, db: createDb({}) });
        m.ctx.emailBridge = pollBridge({
            lookupEmailMapping: jest.fn<any>().mockResolvedValue({
                emailAddress: 'bob@ext.test',
                recipientDid: 'did:cid:bob',
            }),
        });

        await runFirstPoll(m.startDmailPollLoop);

        expect(m.ctx.emailBridge.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
            senderName: 'dmail-user',
        }));
    });

    it('uses a non-DID sender verbatim, and Unknown for a non-string one', async () => {
        const keymaster = pollKeymaster({
            'did:cid:d1': dmailItem({
                sender: 'alice',
                message: { subject: 'Re: hi', body: 'b', to: [], cc: [], reference: 'did:cid:orig' },
            }),
            'did:cid:d2': dmailItem({
                sender: { not: 'a string' },
                message: { subject: 'Re: hi', body: 'b', to: [], cc: [], reference: 'did:cid:orig' },
            }),
        });
        const m = mount({ keymaster });
        m.ctx.emailBridge = pollBridge({
            lookupEmailMapping: jest.fn<any>().mockResolvedValue({
                emailAddress: 'bob@ext.test',
                recipientDid: 'did:cid:bob',
            }),
        });

        await runFirstPoll(m.startDmailPollLoop);

        const senders = (m.ctx.emailBridge.sendEmail as any).mock.calls.map((c: any) => c[0].senderName);
        expect(senders).toContain('alice');
        expect(senders).toContain('Unknown');
    });

    it('leaves a reply alone when no email mapping exists', async () => {
        const keymaster = pollKeymaster({
            'did:cid:d1': dmailItem({ message: { subject: 'Re: hi', body: 'b', to: [], cc: [], reference: 'did:cid:orig' } }),
        });
        const m = mount({ keymaster });
        m.ctx.emailBridge = pollBridge({ lookupEmailMapping: jest.fn<any>().mockResolvedValue(null) });

        await runFirstPoll(m.startDmailPollLoop);

        expect(m.ctx.emailBridge.sendEmail).not.toHaveBeenCalled();
    });

    it('composes a new email from the "[email to addr]" subject convention', async () => {
        const keymaster = pollKeymaster({
            'did:cid:d1': dmailItem({
                message: {
                    subject: '[email to bob@ext.test] Real subject',
                    body: 'b',
                    to: ['did:cid:service'],
                    cc: [],
                },
            }),
        });
        const m = mount({ keymaster });
        m.ctx.emailBridge = pollBridge();

        await runFirstPoll(m.startDmailPollLoop);

        expect(m.ctx.emailBridge.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
            to: 'bob@ext.test',
            subject: 'Real subject',
        }));
    });

    it('defaults an empty composed subject', async () => {
        const keymaster = pollKeymaster({
            'did:cid:d1': dmailItem({
                message: { subject: '[email to bob@ext.test]', body: 'b', to: [], cc: ['did:cid:service'] },
            }),
        });
        const m = mount({ keymaster });
        m.ctx.emailBridge = pollBridge();

        await runFirstPoll(m.startDmailPollLoop);

        expect(m.ctx.emailBridge.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
            subject: '(no subject)',
        }));
    });

    it('ignores a dmail addressed to the service whose subject does not match', async () => {
        const keymaster = pollKeymaster({
            'did:cid:d1': dmailItem({
                message: { subject: 'just a normal subject', body: 'b', to: ['did:cid:service'], cc: [] },
            }),
        });
        const m = mount({ keymaster });
        m.ctx.emailBridge = pollBridge();

        await runFirstPoll(m.startDmailPollLoop);

        expect(m.ctx.emailBridge.sendEmail).not.toHaveBeenCalled();
    });

    it('ignores a composed email when the service DID is not a recipient', async () => {
        const keymaster = pollKeymaster({
            'did:cid:d1': dmailItem({
                message: { subject: '[email to bob@ext.test] hi', body: 'b', to: ['did:cid:someone'], cc: [] },
            }),
        });
        const m = mount({ keymaster });
        m.ctx.emailBridge = pollBridge();

        await runFirstPoll(m.startDmailPollLoop);

        expect(m.ctx.emailBridge.sendEmail).not.toHaveBeenCalled();
    });

    it('logs a poll failure instead of throwing', async () => {
        const keymaster = pollKeymaster({});
        keymaster.listDmail = jest.fn<any>().mockRejectedValue(new Error('keymaster down'));
        const m = mount({ keymaster });
        m.ctx.emailBridge = pollBridge();

        await runFirstPoll(m.startDmailPollLoop);

        expect(errorSpy).toHaveBeenCalledWith('Dmail poll error:', expect.anything());
    });

    it('polls again on the interval and skips a run already in flight', async () => {
        const keymaster = pollKeymaster({});
        const m = mount({ keymaster });
        m.ctx.emailBridge = pollBridge();

        await runFirstPoll(m.startDmailPollLoop);
        expect(keymaster.listDmail).toHaveBeenCalledTimes(1);

        // The 60s interval fires a second poll.
        await jest.advanceTimersByTimeAsync(60_000);
        expect(keymaster.listDmail).toHaveBeenCalledTimes(2);
    });
});

// --- remaining guard branches ----------------------------------------------

describe('credential issuance guards', () => {
    function keymasterWith(over: Record<string, any> = {}) {
        return {
            setCurrentId: jest.fn<any>().mockResolvedValue(undefined),
            bindCredential: jest.fn<any>().mockResolvedValue({}),
            issueCredential: jest.fn<any>().mockResolvedValue('did:cid:cred'),
            getCredential: jest.fn<any>().mockResolvedValue({ credentialSubject: {} }),
            updateCredential: jest.fn<any>().mockResolvedValue(true),
            revokeCredential: jest.fn<any>().mockResolvedValue(true),
            verifyResponse: jest.fn<any>().mockResolvedValue({ match: true, responder: 'did:cid:alice' }),
            ...over,
        };
    }

    it('surfaces a failed credential fetch during an update', async () => {
        const db = createDb({ 'did:cid:alice': { name: 'old', credentialDid: 'did:cid:cred' } });
        const { app } = mount({
            db,
            keymaster: keymasterWith({ getCredential: jest.fn<any>().mockResolvedValue(null) }),
        });

        const response = await request(app)
            .put('/api/name')
            .set('Authorization', 'Bearer valid')
            .send({ name: 'newname' });

        expect(response.status).toBe(500);
    });

    it('surfaces a failed credential update', async () => {
        const db = createDb({ 'did:cid:alice': { name: 'old', credentialDid: 'did:cid:cred' } });
        const { app } = mount({
            db,
            keymaster: keymasterWith({ updateCredential: jest.fn<any>().mockResolvedValue(false) }),
        });

        const response = await request(app)
            .put('/api/name')
            .set('Authorization', 'Bearer valid')
            .send({ name: 'newname' });

        expect(response.status).toBe(500);
    });
});

describe('credential endpoint fallbacks', () => {
    it('reports a null name when the user has none', async () => {
        const db = createDb({ 'did:cid:alice': { logins: 1 } });
        const { app } = mount({ db, session: { user: { did: 'did:cid:alice' } } });

        const response = await request(app).get('/api/credential');

        expect(response.body).toMatchObject({ hasCredential: false, name: null });
    });

    it('falls back through message, error, then stringified value', async () => {
        const db = createDb({ 'did:cid:alice': { credentialDid: 'did:cid:cred' } });

        // An object carrying `error` rather than `message`.
        const withError = mount({
            db,
            keymaster: { getCredential: jest.fn<any>().mockRejectedValue({ error: 'upstream said no' }) },
            session: { user: { did: 'did:cid:alice' } },
        });
        const first = await request(withError.app).get('/api/credential');
        expect(first.body.error).toBe('upstream said no');

        // A bare string rejection.
        const withString = mount({
            db,
            keymaster: { getCredential: jest.fn<any>().mockRejectedValue('plain failure') },
            session: { user: { did: 'did:cid:alice' } },
        });
        const second = await request(withString.app).get('/api/credential');
        expect(second.body.error).toBe('plain failure');
    });
});

describe('admin user deletion fallbacks', () => {
    it('names a user by DID when they have no name', async () => {
        const db = createDb({ 'did:cid:owner': {}, 'did:cid:anon': { logins: 2 } });
        const { app } = mount({ db, session: { user: { did: 'did:cid:owner' } } });

        const response = await request(app).delete('/api/admin/user/did%3Acid%3Aanon');

        expect(response.status).toBe(200);
        expect(response.body.message).toContain('did:cid:anon');
    });

    it('reports a delete failure as 500', async () => {
        const db = createDb({ 'did:cid:owner': {}, 'did:cid:alice': { name: 'alice' } });
        (db as any).deleteUser = jest.fn<any>().mockRejectedValue(new Error('db down'));
        const { app } = mount({ db, session: { user: { did: 'did:cid:owner' } } });

        const response = await request(app).delete('/api/admin/user/did%3Acid%3Aalice');

        expect(response.status).toBe(500);
        expect(response.body.error).toBe('db down');
    });
});

describe('lightning endpoint resolution', () => {
    function withService(service: any) {
        const db = createDb({ 'did:cid:alice': { name: 'alice' } });
        return mount({
            db,
            keymaster: { resolveDID: jest.fn<any>().mockResolvedValue({ didDocument: { service } }) },
        });
    }

    it('accepts a service identified by a #lightning fragment rather than by type', async () => {
        const { app } = withService([{ id: 'did:cid:alice#lightning', serviceEndpoint: 'https://ln.test/i' }]);

        const response = await request(app).get('/.well-known/lnurlp/alice');

        expect(response.body.tag).toBe('payRequest');
    });

    it('reports an error when the matching service has no endpoint', async () => {
        const { app } = withService([{ type: 'Lightning' }]);

        const response = await request(app).get('/.well-known/lnurlp/alice');

        expect(response.body).toMatchObject({ status: 'ERROR' });
    });

    it('reports an error when resolution itself fails', async () => {
        const db = createDb({ 'did:cid:alice': { name: 'alice' } });
        const { app } = mount({
            db,
            keymaster: { resolveDID: jest.fn<any>().mockRejectedValue(new Error('resolver down')) },
        });

        const response = await request(app).get('/.well-known/lnurlp/alice');

        expect(response.body).toMatchObject({ status: 'ERROR', reason: 'resolver down' });
    });
});

describe('inbound email fallbacks', () => {
    function bridge(over: Record<string, any> = {}) {
        return {
            isConfigured: jest.fn<any>().mockReturnValue(true),
            parseInboundEmail: jest.fn<any>((body: any) =>
                body.from && body.to
                    ? { ...body, subject: body.subject ?? '(no subject)', text: body.text ?? '' }
                    : null),
            extractReplyToken: jest.fn<any>().mockReturnValue(null),
            // Returning null forces the `|| email.from` fallback below.
            extractEmailAddress: jest.fn<any>().mockReturnValue(null),
            extractRecipientName: jest.fn<any>().mockReturnValue('alice'),
            lookupToken: jest.fn<any>().mockResolvedValue(null),
            storeEmailMapping: jest.fn<any>().mockResolvedValue(undefined),
            ...over,
        };
    }

    function keymaster() {
        return {
            setCurrentId: jest.fn<any>().mockResolvedValue(undefined),
            createDmail: jest.fn<any>().mockResolvedValue('did:cid:dmail'),
            sendDmail: jest.fn<any>().mockResolvedValue('did:cid:notice'),
        };
    }

    it('falls back to the raw From header when no address can be extracted', async () => {
        const km = keymaster();
        const m = mount({ db: createDb({ 'did:cid:alice': { name: 'alice' } }), keymaster: km });
        m.ctx.emailBridge = bridge();

        await request(m.app)
            .post('/api/inbound-email')
            .send({ from: 'Weird Header <<>>', to: 'alice@archon.test', subject: 'hi', text: 'body' });

        expect(km.createDmail).toHaveBeenCalledWith(
            expect.objectContaining({ subject: expect.stringContaining('Weird Header') }),
            { registry: 'hyperswarm' },
        );
    });

    it('substitutes placeholder text for an empty body', async () => {
        const km = keymaster();
        const m = mount({ db: createDb({ 'did:cid:alice': { name: 'alice' } }), keymaster: km });
        m.ctx.emailBridge = bridge();

        await request(m.app)
            .post('/api/inbound-email')
            .send({ from: 'bob@ext.test', to: 'alice@archon.test', subject: 'hi' });

        expect(km.createDmail).toHaveBeenCalledWith(
            expect.objectContaining({ body: '(no text content)' }),
            { registry: 'hyperswarm' },
        );
    });

    it('applies the same fallbacks on the reply path', async () => {
        const km = keymaster();
        const m = mount({ db: createDb(), keymaster: km });
        m.ctx.emailBridge = bridge({
            extractReplyToken: jest.fn<any>().mockReturnValue('tok'),
            lookupToken: jest.fn<any>().mockResolvedValue({
                senderDid: 'did:cid:alice',
                originalDmailDid: 'did:cid:orig',
            }),
        });

        await request(m.app)
            .post('/api/inbound-email')
            .send({ from: 'Unparseable', to: 'reply+tok@parse.archon.test' });

        expect(km.createDmail).toHaveBeenCalledWith(
            expect.objectContaining({
                subject: expect.stringContaining('Unparseable'),
                body: '(no text content)',
                reference: 'did:cid:orig',
            }),
            { registry: 'hyperswarm' },
        );
    });
});
