import { jest } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createLocalJWKSet, jwtVerify } from 'jose';

let directory: string;
let previousKeyPath: string | undefined;
beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-lifecycle-'));
    previousKeyPath = process.env.ARCHON_HERALD_JWT_KEY_PATH;
    process.env.ARCHON_HERALD_JWT_KEY_PATH = path.join(directory, 'key.json');
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    jest.restoreAllMocks();
    if (previousKeyPath === undefined) delete process.env.ARCHON_HERALD_JWT_KEY_PATH;
    else process.env.ARCHON_HERALD_JWT_KEY_PATH = previousKeyPath;
    fs.rmSync(directory, { recursive: true, force: true });
});

// A new module instance models a restart: keys, routers and opaque token stores
// are rebuilt, while the real signing-key file survives.
async function freshApp() {
    const app = express();
    app.use(express.json());
    jest.resetModules();
    const { createOAuthRoutes } = await import('../../services/herald/server/src/oauth/index.ts');
    app.use('/oauth', createOAuthRoutes(() => ({
        createChallenge: async () => 'did:cid:challenge',
        verifyResponse: async () => ({ match: true, challenge: 'did:cid:challenge', responder: 'did:cid:alice' }),
    }), async () => ({ name: 'Alice', handle: 'alice' })));
    return app;
}
async function authorize(app: express.Express) {
    await request(app).get('/oauth/authorize').query({
        client_id: 'demo-client', redirect_uri: 'http://localhost:3001/callback', response_type: 'code', scope: 'openid',
    }).set('Accept', 'application/json').expect(200);
    const callback = await request(app).post('/oauth/callback').send({ response: 'did:cid:response' }).expect(200);
    return new URL(callback.body.redirect).searchParams.get('code')!;
}
function exchange(app: express.Express, code: string) {
    return request(app).post('/oauth/token').send({ grant_type: 'authorization_code', code,
        redirect_uri: 'http://localhost:3001/callback', client_id: 'demo-client', client_secret: 'demo-secret' });
}

test('a fresh OAuth instance reloads its persisted key and verifies an earlier ID token', async () => {
    const first = await freshApp();
    const token = await exchange(first, await authorize(first)).expect(200);
    const before = await request(first).get('/oauth/.well-known/jwks.json').expect(200);
    const fileBefore = fs.readFileSync(process.env.ARCHON_HERALD_JWT_KEY_PATH!, 'utf8');
    const second = await freshApp();
    const after = await request(second).get('/oauth/.well-known/jwks.json').expect(200);
    expect(after.body).toEqual(before.body);
    expect(after.body.keys[0].d).toBeUndefined();
    expect(fs.readFileSync(process.env.ARCHON_HERALD_JWT_KEY_PATH!, 'utf8')).toBe(fileBefore);
    const verified = await jwtVerify(token.body.id_token, createLocalJWKSet(after.body), { audience: 'demo-client' });
    expect(verified.payload.sub).toBe('did:cid:alice');
    // Opaque access tokens are intentionally in-memory; key persistence does not
    // promise those sessions survive a restart.
    await request(second).get('/oauth/userinfo').set('Authorization', `Bearer ${token.body.access_token}`).expect(401);
    const next = await exchange(second, await authorize(second)).expect(200);
    await expect(jwtVerify(next.body.id_token, createLocalJWKSet(before.body))).resolves.toBeDefined();
});

test('a corrupt key file is replaced with a usable persisted signing key', async () => {
    fs.writeFileSync(process.env.ARCHON_HERALD_JWT_KEY_PATH!, '{broken');
    const app = await freshApp();
    const token = await exchange(app, await authorize(app)).expect(200);
    const jwks = await request(app).get('/oauth/.well-known/jwks.json').expect(200);
    await expect(jwtVerify(token.body.id_token, createLocalJWKSet(jwks.body))).resolves.toBeDefined();
    expect(JSON.parse(fs.readFileSync(process.env.ARCHON_HERALD_JWT_KEY_PATH!, 'utf8')).privateJwk.d).toBeTruthy();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to load persisted'), expect.any(Error));
});

test('expired authorization codes and access tokens are rejected and removed', async () => {
    const app = await freshApp();
    const code = await authorize(app);
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now + 3600_000);
    expect((await exchange(app, code).expect(400)).body.error_description).toBe('Code has expired');
    clock.mockReturnValue(now);
    expect((await exchange(app, code).expect(400)).body.error_description).toBe('Invalid or expired code');
    const token = await exchange(app, await authorize(app)).expect(200);
    clock.mockReturnValue(now + 3600_001);
    const expired = await request(app).get('/oauth/userinfo').set('Authorization', `Bearer ${token.body.access_token}`).expect(401);
    expect(expired.body.error).toBe('token_expired');
    clock.mockReturnValue(now);
    const removed = await request(app).get('/oauth/userinfo').set('Authorization', `Bearer ${token.body.access_token}`).expect(401);
    expect(removed.body.error).toBe('invalid_token');
});
