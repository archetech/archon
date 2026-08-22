import { jest } from '@jest/globals';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';

// The module reads ARCHON_HERALD_JWT_KEY_PATH at evaluation time and defaults it
// to /app/server/data, so the env has to be set before the dynamic import below.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-oauth-'));
process.env.ARCHON_HERALD_JWT_KEY_PATH = path.join(tmpDir, 'oauth-signing-key.json');
process.env.ARCHON_ADMIN_API_KEY = 'test-admin-key';

const adminKey = 'test-admin-key';

let app: express.Express;
let logSpy: any;

// createOAuthRoutes registers onto a module-scope Router and can only be called
// once per module instance, so the dependencies are mutable holders that each
// test can point at — the factory reads them lazily on every request.
let keymasterImpl: Record<string, any> = {};
let memberImpl: (did: string) => any = (_did: string) => null;

beforeAll(async () => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { createOAuthRoutes } = await import('../../services/herald/server/src/oauth/index.ts');

    const router = createOAuthRoutes(
        () => keymasterImpl,
        (did: string) => memberImpl(did),
    );

    app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use('/oauth', router);
});

beforeEach(() => {
    keymasterImpl = {};
    memberImpl = (_did: string) => null;
});

afterAll(() => {
    logSpy?.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('OIDC discovery', () => {
    const saved = process.env.ARCHON_DRAWBRIDGE_PUBLIC_HOST;

    afterEach(() => {
        if (saved === undefined) delete process.env.ARCHON_DRAWBRIDGE_PUBLIC_HOST;
        else process.env.ARCHON_DRAWBRIDGE_PUBLIC_HOST = saved;
    });

    it('advertises endpoints under the configured public host', async () => {
        process.env.ARCHON_DRAWBRIDGE_PUBLIC_HOST = 'https://archon.test';

        const response = await request(app).get('/oauth/.well-known/openid-configuration');

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            issuer: 'https://archon.test/names/oauth',
            authorization_endpoint: 'https://archon.test/names/oauth/authorize',
            token_endpoint: 'https://archon.test/names/oauth/token',
            userinfo_endpoint: 'https://archon.test/names/oauth/userinfo',
            jwks_uri: 'https://archon.test/names/oauth/.well-known/jwks.json',
            response_types_supported: ['code'],
            id_token_signing_alg_values_supported: ['ES256'],
        });
    });

    it('strips a trailing slash from the public host', async () => {
        process.env.ARCHON_DRAWBRIDGE_PUBLIC_HOST = 'https://archon.test/';

        const response = await request(app).get('/oauth/.well-known/openid-configuration');

        expect(response.body.issuer).toBe('https://archon.test/names/oauth');
    });

    it('falls back to a localhost host when none is configured', async () => {
        delete process.env.ARCHON_DRAWBRIDGE_PUBLIC_HOST;

        const response = await request(app).get('/oauth/.well-known/openid-configuration');

        expect(response.body.issuer).toMatch(/^http:\/\/localhost:\d+\/names\/oauth$/);
    });
});

describe('JWKS endpoint', () => {
    it('publishes an ES256 public key and never the private component', async () => {
        const response = await request(app).get('/oauth/.well-known/jwks.json');

        expect(response.status).toBe(200);
        expect(response.body.keys).toHaveLength(1);

        const [key] = response.body.keys;
        expect(key).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' });
        expect(key.kid).toBeTruthy();
        expect(key.d).toBeUndefined();
    });

    it('persists the signing key so it survives a restart', async () => {
        await request(app).get('/oauth/.well-known/jwks.json');

        const keyFile = process.env.ARCHON_HERALD_JWT_KEY_PATH!;
        expect(fs.existsSync(keyFile)).toBe(true);

        const persisted = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
        expect(persisted.kid).toBeTruthy();
        expect(persisted.privateJwk).toBeTruthy();
    });

    it('returns a stable key across repeated requests', async () => {
        const first = await request(app).get('/oauth/.well-known/jwks.json');
        const second = await request(app).get('/oauth/.well-known/jwks.json');

        expect(first.body.keys[0].kid).toBe(second.body.keys[0].kid);
        expect(first.body.keys[0].x).toBe(second.body.keys[0].x);
    });
});

describe('token endpoint', () => {
    const basic = (id: string, secret: string) => {
        const encoded = Buffer.from(`${id}:${secret}`).toString('base64');
        return `Basic ${encoded}`;
    };

    it('rejects an unsupported grant type', async () => {
        const response = await request(app)
            .post('/oauth/token')
            .send({ grant_type: 'client_credentials', client_id: 'demo-client', client_secret: 'demo-secret' });

        expect(response.status).toBe(400);
        expect(response.body).toEqual({ error: 'unsupported_grant_type' });
    });

    it('rejects a Basic header with no colon separator', async () => {
        const response = await request(app)
            .post('/oauth/token')
            .set('Authorization', `Basic ${Buffer.from('no-separator').toString('base64')}`)
            .send({ grant_type: 'authorization_code', code: 'x' });

        expect(response.status).toBe(401);
        expect(response.body).toEqual({ error: 'invalid_client' });
    });

    it('rejects an unknown client or a wrong secret', async () => {
        const unknown = await request(app)
            .post('/oauth/token')
            .send({ grant_type: 'authorization_code', code: 'x', client_id: 'nope', client_secret: 'nope' });
        expect(unknown.status).toBe(401);
        expect(unknown.body).toEqual({ error: 'invalid_client' });

        const wrongSecret = await request(app)
            .post('/oauth/token')
            .send({ grant_type: 'authorization_code', code: 'x', client_id: 'demo-client', client_secret: 'wrong' });
        expect(wrongSecret.status).toBe(401);
    });

    it('accepts client credentials via the Basic header as well as the body', async () => {
        // Correct credentials get past client auth and fail at the code check instead.
        const response = await request(app)
            .post('/oauth/token')
            .set('Authorization', basic('demo-client', 'demo-secret'))
            .send({ grant_type: 'authorization_code', code: 'not-a-real-code' });

        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({ error: 'invalid_grant' });
    });

    it('rejects an unknown authorization code', async () => {
        const response = await request(app)
            .post('/oauth/token')
            .send({
                grant_type: 'authorization_code',
                code: 'never-issued',
                client_id: 'demo-client',
                client_secret: 'demo-secret',
            });

        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({
            error: 'invalid_grant',
            error_description: 'Invalid or expired code',
        });
    });
});

describe('authorize endpoint', () => {
    const validQuery = '?client_id=demo-client&redirect_uri=http://localhost:3001/callback&response_type=code';

    it('rejects requests missing required parameters', async () => {
        for (const query of [
            '?redirect_uri=http://localhost:3001/callback&response_type=code',
            '?client_id=demo-client&response_type=code',
            '?client_id=demo-client&redirect_uri=http://localhost:3001/callback&response_type=token',
        ]) {
            const response = await request(app).get(`/oauth/authorize${query}`);
            expect([query, response.status]).toEqual([query, 400]);
            expect(response.body.error).toBe('invalid_request');
        }
    });

    it('rejects an unknown client', async () => {
        const response = await request(app)
            .get('/oauth/authorize?client_id=nope&redirect_uri=http://localhost:3001/callback&response_type=code');

        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({ error: 'invalid_client' });
    });

    it('rejects a redirect_uri the client did not register', async () => {
        const response = await request(app)
            .get('/oauth/authorize?client_id=demo-client&redirect_uri=https://evil.test/cb&response_type=code');

        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({
            error: 'invalid_request',
            error_description: 'Invalid redirect_uri',
        });
    });

    it('returns the challenge as JSON when the client asks for it', async () => {
        keymasterImpl = { createChallenge: jest.fn<any>().mockResolvedValue('did:cid:challenge') };

        const response = await request(app)
            .get(`/oauth/authorize${validQuery}&scope=openid&state=xyz`)
            .set('Accept', 'application/json');

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            challenge: 'did:cid:challenge',
            client_name: 'Demo Application',
            scope: 'openid',
        });
        expect(response.body.challengeURL).toContain('challenge=did:cid:challenge');
        expect(keymasterImpl.createChallenge).toHaveBeenCalledWith(expect.objectContaining({
            oauth: expect.objectContaining({ client_id: 'demo-client', state: 'xyz' }),
        }));
    });

    it('serves an HTML consent page by default', async () => {
        keymasterImpl = { createChallenge: jest.fn<any>().mockResolvedValue('did:cid:challenge-html') };

        const response = await request(app).get(`/oauth/authorize${validQuery}`);

        expect(response.status).toBe(200);
        expect(response.text).toContain('<!DOCTYPE html>');
    });

    it('reports a challenge-creation failure as a server error', async () => {
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        keymasterImpl = { createChallenge: jest.fn<any>().mockRejectedValue(new Error('keymaster down')) };

        try {
            const response = await request(app).get(`${'/oauth/authorize'}${validQuery}`);
            expect(response.status).toBe(500);
        } finally {
            errorSpy.mockRestore();
        }
    });
});

describe('callback endpoint', () => {
    let errorSpy: any;

    beforeEach(() => {
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        errorSpy.mockRestore();
    });

    it('requires a response body', async () => {
        const response = await request(app).post('/oauth/callback').send({});

        expect(response.status).toBe(400);
        expect(response.body).toEqual({ error: 'missing_response' });
    });

    it('rejects a response that does not verify', async () => {
        keymasterImpl = { verifyResponse: jest.fn<any>().mockResolvedValue({ match: false }) };

        const response = await request(app).post('/oauth/callback').send({ response: 'did:cid:response' });

        expect(response.status).toBe(401);
        expect(response.body).toEqual({ error: 'invalid_response' });
    });

    it('rejects a challenge that was never issued', async () => {
        keymasterImpl = {
            verifyResponse: jest.fn<any>().mockResolvedValue({
                match: true,
                challenge: 'did:cid:never-issued',
                responder: 'did:cid:user',
            }),
        };

        const response = await request(app).post('/oauth/callback').send({ response: 'did:cid:response' });

        expect(response.status).toBe(400);
        expect(response.body).toEqual({ error: 'unknown_challenge' });
    });

    it('reports a verification failure as a server error', async () => {
        keymasterImpl = { verifyResponse: jest.fn<any>().mockRejectedValue(new Error('verify blew up')) };

        const response = await request(app).post('/oauth/callback').send({ response: 'did:cid:response' });

        expect(response.status).toBe(500);
        expect(response.body).toMatchObject({ error: 'server_error' });
    });
});

describe('grafana membership gate', () => {
    async function authorizeThenCallback(member: any) {
        keymasterImpl = { createChallenge: jest.fn<any>().mockResolvedValue('did:cid:grafana-challenge') };
        await request(app)
            .get('/oauth/authorize?client_id=grafana-dashboard&redirect_uri=http://localhost:4180/oauth2/callback&response_type=code')
            .set('Accept', 'application/json');

        keymasterImpl = {
            verifyResponse: jest.fn<any>().mockResolvedValue({
                match: true,
                challenge: 'did:cid:grafana-challenge',
                responder: 'did:cid:user',
            }),
        };
        memberImpl = (_did: string) => member;

        return request(app).post('/oauth/callback').send({ response: 'did:cid:response' });
    }

    it('denies a non-member', async () => {
        const response = await authorizeThenCallback(null);

        expect(response.status).toBe(403);
        expect(response.body).toMatchObject({ error: 'access_denied' });
    });

    it('denies a member without a credential', async () => {
        const response = await authorizeThenCallback({ name: 'Alice' });

        expect(response.status).toBe(403);
    });

    it('admits a member holding a credential', async () => {
        const response = await authorizeThenCallback({ name: 'Alice', credentialDid: 'did:cid:cred' });

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
    });
});

describe('full authorization code flow', () => {
    it('runs authorize -> callback -> poll -> token -> userinfo', async () => {
        const challenge = 'did:cid:flow-challenge';
        const userDid = 'did:cid:flowuser';

        // 1. Authorize — mints a challenge and records the pending authorization.
        keymasterImpl = { createChallenge: jest.fn<any>().mockResolvedValue(challenge) };
        const authorize = await request(app)
            .get('/oauth/authorize?client_id=demo-client&redirect_uri=http://localhost:3001/callback&response_type=code&state=st8&scope=openid%20profile')
            .set('Accept', 'application/json');
        expect(authorize.status).toBe(200);

        // 2. Callback — the wallet's verified response yields an authorization code.
        keymasterImpl = {
            verifyResponse: jest.fn<any>().mockResolvedValue({
                match: true,
                challenge,
                responder: userDid,
            }),
        };
        memberImpl = (_did: string) => ({ name: 'Flow User', handle: 'flow', avatar: 'https://img.test/a.png' });

        const callback = await request(app).post('/oauth/callback').send({ response: 'did:cid:response' });
        expect(callback.status).toBe(200);
        expect(callback.body.redirect).toContain('state=st8');

        const code = new URL(callback.body.redirect).searchParams.get('code')!;
        expect(code).toMatch(/^[0-9a-f]{64}$/);

        // 3. Poll — returns the stored redirect once, then goes back to pending.
        const polled = await request(app).get(`/oauth/poll?challenge=${challenge}`);
        expect(polled.body.redirect).toBe(callback.body.redirect);
        const polledAgain = await request(app).get(`/oauth/poll?challenge=${challenge}`);
        expect(polledAgain.body).toEqual({ pending: true });

        // 4. Token — exchanges the code for an access token and a signed id_token.
        const token = await request(app).post('/oauth/token').send({
            grant_type: 'authorization_code',
            code,
            redirect_uri: 'http://localhost:3001/callback',
            client_id: 'demo-client',
            client_secret: 'demo-secret',
        });
        expect(token.status).toBe(200);
        expect(token.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600 });

        const [header, payload] = token.body.id_token
            .split('.')
            .slice(0, 2)
            .map((part: string) => JSON.parse(Buffer.from(part, 'base64url').toString()));
        expect(header).toMatchObject({ alg: 'ES256', typ: 'JWT' });
        expect(payload).toMatchObject({
            sub: userDid,
            aud: 'demo-client',
            name: 'Flow User',
            preferred_username: 'flow',
            email: 'flow@archon.social',
            email_verified: true,
            did: userDid,
        });

        // 5. The code is single-use.
        const replay = await request(app).post('/oauth/token').send({
            grant_type: 'authorization_code',
            code,
            redirect_uri: 'http://localhost:3001/callback',
            client_id: 'demo-client',
            client_secret: 'demo-secret',
        });
        expect(replay.status).toBe(400);
        expect(replay.body).toMatchObject({ error: 'invalid_grant' });

        // 6. Userinfo — the access token resolves to the same subject.
        const userinfo = await request(app)
            .get('/oauth/userinfo')
            .set('Authorization', `Bearer ${token.body.access_token}`);
        expect(userinfo.status).toBe(200);
        expect(userinfo.body).toMatchObject({
            sub: userDid,
            name: 'Flow User',
            preferred_username: 'flow',
            email: 'flow@archon.social',
        });
    });

    it('rejects a code issued to a different redirect_uri', async () => {
        const challenge = 'did:cid:mismatch-challenge';
        keymasterImpl = { createChallenge: jest.fn<any>().mockResolvedValue(challenge) };
        await request(app)
            .get('/oauth/authorize?client_id=demo-client&redirect_uri=http://localhost:3001/callback&response_type=code')
            .set('Accept', 'application/json');

        keymasterImpl = {
            verifyResponse: jest.fn<any>().mockResolvedValue({
                match: true, challenge, responder: 'did:cid:user',
            }),
        };
        const callback = await request(app).post('/oauth/callback').send({ response: 'did:cid:response' });
        const code = new URL(callback.body.redirect).searchParams.get('code')!;

        const token = await request(app).post('/oauth/token').send({
            grant_type: 'authorization_code',
            code,
            redirect_uri: 'http://localhost:4000/callback',
            client_id: 'demo-client',
            client_secret: 'demo-secret',
        });

        expect(token.status).toBe(400);
        expect(token.body).toMatchObject({
            error: 'invalid_grant',
            error_description: 'Code was issued to different client/redirect',
        });
    });

    it('synthesizes an email from the DID when the member has no handle', async () => {
        const challenge = 'did:cid:nohandle-challenge';
        const userDid = 'did:cid:abcdefghijklmnopqrstuvwxyz';
        keymasterImpl = { createChallenge: jest.fn<any>().mockResolvedValue(challenge) };
        await request(app)
            .get('/oauth/authorize?client_id=demo-client&redirect_uri=http://localhost:3001/callback&response_type=code')
            .set('Accept', 'application/json');

        keymasterImpl = {
            verifyResponse: jest.fn<any>().mockResolvedValue({ match: true, challenge, responder: userDid }),
        };
        memberImpl = (_did: string) => null;
        const callback = await request(app).post('/oauth/callback').send({ response: 'did:cid:response' });
        const code = new URL(callback.body.redirect).searchParams.get('code')!;

        const token = await request(app).post('/oauth/token').send({
            grant_type: 'authorization_code',
            code,
            redirect_uri: 'http://localhost:3001/callback',
            client_id: 'demo-client',
            client_secret: 'demo-secret',
        });

        const userinfo = await request(app)
            .get('/oauth/userinfo')
            .set('Authorization', `Bearer ${token.body.access_token}`);

        expect(userinfo.body.sub).toBe(userDid);
        expect(userinfo.body.name).toBe(userDid);
        expect(userinfo.body.email).toBe('abcdefghijklmnop@archon.social');
    });
});

describe('userinfo endpoint', () => {
    it('requires a Bearer token', async () => {
        await expect(request(app).get('/oauth/userinfo')).resolves.toMatchObject({ status: 401 });
        await expect(
            request(app).get('/oauth/userinfo').set('Authorization', 'Basic abc'),
        ).resolves.toMatchObject({ status: 401 });
    });

    it('rejects an unknown token', async () => {
        const response = await request(app)
            .get('/oauth/userinfo')
            .set('Authorization', 'Bearer not-a-real-token');

        expect(response.status).toBe(401);
        expect(response.body).toEqual({ error: 'invalid_token' });
    });
});

describe('poll endpoint', () => {
    it('reports pending when no redirect has been recorded', async () => {
        const response = await request(app).get('/oauth/poll?challenge=did:cid:unknown');

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ pending: true });
    });
});

describe('client registration', () => {
    it('requires the admin key', async () => {
        const response = await request(app)
            .post('/oauth/clients')
            .send({ name: 'App', redirect_uris: ['https://app.test/cb'] });

        expect(response.status).toBe(401);
    });

    it('rejects a wrong admin key', async () => {
        const response = await request(app)
            .post('/oauth/clients')
            .set('X-Archon-Admin-Key', 'wrong')
            .send({ name: 'App', redirect_uris: ['https://app.test/cb'] });

        expect(response.status).toBe(401);
    });

    it('issues credentials for a new client when authorized', async () => {
        const response = await request(app)
            .post('/oauth/clients')
            .set('X-Archon-Admin-Key', adminKey)
            .send({ name: 'App', redirect_uris: ['https://app.test/cb'] });

        expect(response.status).toBe(200);
        expect(response.body.client_id).toMatch(/^[0-9a-f]{32}$/);
        expect(response.body.client_secret).toMatch(/^[0-9a-f]{64}$/);
        expect(response.body).toMatchObject({ name: 'App', redirect_uris: ['https://app.test/cb'] });
    });

    it('accepts a token request from a freshly registered client', async () => {
        const registered = await request(app)
            .post('/oauth/clients')
            .set('X-Archon-Admin-Key', adminKey)
            .send({ name: 'Another', redirect_uris: ['https://other.test/cb'] });

        const response = await request(app)
            .post('/oauth/token')
            .send({
                grant_type: 'authorization_code',
                code: 'no-such-code',
                client_id: registered.body.client_id,
                client_secret: registered.body.client_secret,
            });

        // Past client auth (would be 401 otherwise), failing on the code instead.
        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({ error: 'invalid_grant' });
    });
});
