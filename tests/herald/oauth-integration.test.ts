import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const did = 'did:cid:alice';
let oldHost: string | undefined;
beforeEach(() => {
    oldHost = process.env.ARCHON_DRAWBRIDGE_PUBLIC_HOST;
    process.env.ARCHON_DRAWBRIDGE_PUBLIC_HOST = 'https://herald.example';
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
    jest.restoreAllMocks();
    if (oldHost === undefined) delete process.env.ARCHON_DRAWBRIDGE_PUBLIC_HOST;
    else process.env.ARCHON_DRAWBRIDGE_PUBLIC_HOST = oldHost;
});

async function mount(member: Record<string, unknown> | null = null) {
    jest.resetModules();
    const { createHeraldRoutes } = await import('../../services/herald/server/src/routes.ts');
    const browserSession: Record<string, unknown> = {};
    const db = {
        getUser: jest.fn<any>().mockImplementation(async () => member),
        setUser: jest.fn<any>().mockImplementation(async (_did: string, user: Record<string, unknown>) => { member = user; }),
    };
    const keymaster = {
        createChallenge: jest.fn<any>().mockResolvedValue('did:cid:challenge'),
        resolveDID: jest.fn<any>().mockResolvedValue({}),
        verifyResponse: jest.fn<any>().mockResolvedValue({ match: true, challenge: 'did:cid:challenge', responder: did }),
    };
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
        req.session = req.headers['x-wallet-callback'] ? {} : browserSession;
        next();
    });
    app.use(createHeraldRoutes({ db, keymaster, serviceDID: 'did:cid:service', emailBridge: null } as any).router);
    return { app, db, keymaster, browserSession };
}

test('root discovery points to the mounted OAuth endpoints', async () => {
    const { app } = await mount();
    const root = await request(app).get('/.well-known/openid-configuration').expect(200);
    expect(root.body).toMatchObject({ issuer: 'https://herald.example/names',
        authorization_endpoint: 'https://herald.example/names/oauth/authorize',
        token_endpoint: 'https://herald.example/names/oauth/token',
        userinfo_endpoint: 'https://herald.example/names/oauth/userinfo' });
    await request(app).get(new URL(root.body.authorization_endpoint).pathname.replace('/names', '')).expect(400);
});

test.each([null, { name: 'alice' }, { name: 'alice', credentialDid: 'did:cid:membership' }])(
    'the mounted OAuth membership check uses Herald storage (%j)', async member => {
        const { app, db } = await mount(member);
        await request(app).get('/oauth/authorize').query({ client_id: 'grafana-dashboard',
            redirect_uri: 'http://localhost:4180/oauth2/callback', response_type: 'code' })
            .set('Accept', 'application/json').expect(200);
        const callback = await request(app).post('/oauth/callback').send({ response: 'did:cid:response' });
        expect(db.getUser).toHaveBeenCalledWith(did);
        if (member && 'credentialDid' in member) {
            expect(callback.status).toBe(200);
            expect(callback.body.success).toBe(true);
        } else {
            expect(callback.status).toBe(403);
            expect(callback.body.error).toBe('access_denied');
        }
    });

test('a browser session recovers a successful login delivered by a separate wallet session', async () => {
    const { app, browserSession } = await mount({ name: 'alice' });
    await request(app).get('/api/challenge').expect(200);
    expect(browserSession.user).toBeUndefined();
    await request(app).post('/api/login').set('x-wallet-callback', 'true')
        .send({ response: 'did:cid:response' }).expect(200);
    expect(browserSession.user).toBeUndefined();
    const recovered = await request(app).get('/api/check-auth').expect(200);
    expect(recovered.body).toMatchObject({ isAuthenticated: true, userDID: did, profile: { name: 'alice' } });
    expect(browserSession.user).toEqual({ did });
});

test('a rejected wallet response cannot authenticate the browser session', async () => {
    const { app, keymaster, browserSession } = await mount();
    await request(app).get('/api/challenge').expect(200);
    keymaster.verifyResponse.mockResolvedValue({ match: false });
    await request(app).post('/api/login').set('x-wallet-callback', 'true')
        .send({ response: 'did:cid:response' }).expect(200);
    expect((await request(app).get('/api/check-auth').expect(200)).body.isAuthenticated).toBe(false);
    expect(browserSession.user).toBeUndefined();
});
