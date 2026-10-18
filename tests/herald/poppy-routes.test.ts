import { jest } from '@jest/globals';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';

// Herald with the Personal Agent Protocol enabled. config.ts reads the
// environment when it is first imported, so this lives in its own file.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-poppy-'));
process.env.ARCHON_HERALD_JWT_KEY_PATH = path.join(tmpDir, 'oauth-signing-key.json');
process.env.ARCHON_HERALD_DOMAIN = 'archon.test';
process.env.ARCHON_HERALD_NAME = 'name-service';
process.env.ARCHON_DRAWBRIDGE_PUBLIC_HOST = 'https://archon.test';
process.env.ARCHON_HERALD_POPPY_ENABLED = 'true';
process.env.ARCHON_HERALD_POPPY_STORE = 'memory';

let createHeraldRoutes: any;
let MemoryKV: any;

beforeAll(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    ({ createHeraldRoutes } = await import('../../services/herald/server/src/routes.ts'));
    ({ MemoryKV } = await import('../../services/herald/server/src/poppy/kv.ts'));
});

afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

function mount(session: any = {}) {
    const ctx: any = {
        keymaster: { resolveDID: jest.fn() },
        db: { getUser: jest.fn(async () => null), findDidByName: jest.fn(async () => null), listUsers: jest.fn(async () => ({})) },
        emailBridge: null,
        serviceDID: 'did:cid:service',
        poppyKv: new MemoryKV(),
    };
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
        req.session = { ...session };
        next();
    });
    app.use(createHeraldRoutes(ctx).router);
    return { app, ctx };
}

describe('herald with the Personal Agent Protocol enabled', () => {
    it('serves poppy.json and the issuer metadata at the paths Drawbridge forwards', async () => {
        const { app } = mount();

        const poppy = await request(app).get('/.well-known/poppy.json');
        expect(poppy.status).toBe(200);
        expect(poppy.body.organization).toEqual({ name: 'archon.test', domain: 'archon.test' });
        expect(poppy.body.auth.issuer).toBe('https://archon.test/names/poppy');

        const metadata = await request(app).get('/.well-known/oauth-authorization-server/names/poppy');
        expect(metadata.status).toBe(200);
        expect(metadata.body.poppy_domains).toEqual(['archon.test']);
    });

    it('mounts the token endpoint under /poppy', async () => {
        const { app } = mount();

        const response = await request(app).post('/poppy/token').type('form').send({ grant_type: 'refresh_token' });

        expect(response.status).toBe(400);
        expect(response.body.error).toBe('invalid_request');
    });

    it('leaves the OIDC issuer unchanged', async () => {
        const { app } = mount();

        const response = await request(app).get('/.well-known/openid-configuration');

        expect(response.body.issuer).toBe('https://archon.test/names');
        expect(response.body.dpop_signing_alg_values_supported).toBeUndefined();
    });

    it('lists connected agents only for a signed-in User', async () => {
        expect((await request(mount().app).get('/api/poppy/connections')).status).toBe(401);

        const { app } = mount({ user: { did: 'did:cid:alice' } });
        const response = await request(app).get('/api/poppy/connections');
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ connections: [] });

        const missing = await request(app).delete('/api/poppy/connections/grt_unknown');
        expect(missing.status).toBe(404);
    });
});
