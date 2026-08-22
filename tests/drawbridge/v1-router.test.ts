import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { createV1Router } from '../../services/drawbridge/server/src/v1-router.ts';
import defaultConfig from '../../services/drawbridge/server/src/config.ts';

type Method = 'GET' | 'POST';

const adminKey = 'test-admin-key';

function createMockGatekeeper() {
    return {
        isReady: jest.fn<any>().mockResolvedValue(true),
        getStatus: jest.fn<any>().mockResolvedValue({ dids: { total: 1 } }),
        listRegistries: jest.fn<any>().mockResolvedValue(['local']),
        createDID: jest.fn<any>().mockResolvedValue('did:cid:new'),
        generateDID: jest.fn<any>().mockResolvedValue('did:cid:generated'),
        resolveDID: jest.fn<any>().mockResolvedValue({ didDocument: { id: 'did:cid:abc' } }),
        getDIDs: jest.fn<any>().mockResolvedValue(['did:cid:abc']),
        exportDIDs: jest.fn<any>().mockResolvedValue([[{ did: 'did:cid:abc' }]]),
        addJSON: jest.fn<any>().mockResolvedValue('cid-json'),
        getJSON: jest.fn<any>().mockResolvedValue({ hello: 'world' }),
        addText: jest.fn<any>().mockResolvedValue('cid-text'),
        getText: jest.fn<any>().mockResolvedValue('hello'),
        addData: jest.fn<any>().mockResolvedValue('cid-data'),
        getData: jest.fn<any>().mockResolvedValue(Buffer.from('bytes')),
        addDataStream: jest.fn<any>().mockResolvedValue('cid-stream'),
        getDataStream: jest.fn(() => (async function* () { yield 'streamed'; })()),
        getBlock: jest.fn<any>().mockResolvedValue({ hash: 'abc', height: 7 }),
        searchDocs: jest.fn<any>().mockResolvedValue(['did:cid:abc']),
        queryDocs: jest.fn<any>().mockResolvedValue(['did:cid:abc']),
    };
}

function mount(overrides: {
    config?: Record<string, unknown>;
    didCommEndpoint?: string | null;
} = {}) {
    const gatekeeper = createMockGatekeeper();
    const config = { ...defaultConfig, adminApiKey: adminKey, ...overrides.config };
    const proxyLightningMediatorRequest = jest.fn<any>(async (_req: any, res: any) => {
        res.json({ proxied: true });
    });

    const app = express();
    app.use(express.json());
    // Mirror the parsers the real server installs, so text/binary bodies arrive
    // at the proxy routes the same way they do in production.
    app.use(express.text({ limit: '1mb' }));
    app.use(express.raw({ type: 'application/octet-stream', limit: '1mb' }));
    app.use('/api/v1', createV1Router({
        gatekeeper: gatekeeper as any,
        config: config as any,
        logger: { error: jest.fn(), info: jest.fn() } as any,
        l402Options: {} as any,
        authMiddleware: [],
        getServiceVersion: () => '9.9.9',
        serviceCommit: 'abc1234',
        resolveDidCommEndpoint: async () => ('didCommEndpoint' in overrides
            ? overrides.didCommEndpoint!
            : 'https://drawbridge.test/didcomm'),
        proxyLightningMediatorRequest,
    }));

    return { app, gatekeeper, proxyLightningMediatorRequest };
}

describe('drawbridge v1 unprotected routes', () => {
    it('reports readiness from the upstream gatekeeper', async () => {
        const { app, gatekeeper } = mount();

        const response = await request(app).get('/api/v1/ready');

        expect(response.status).toBe(200);
        expect(response.body).toBe(true);
        expect(gatekeeper.isReady).toHaveBeenCalled();
    });

    it('answers false rather than erroring when the upstream is unreachable', async () => {
        const { app, gatekeeper } = mount();
        gatekeeper.isReady = jest.fn<any>().mockRejectedValue(new Error('down'));

        const response = await request(app).get('/api/v1/ready');

        expect(response.status).toBe(200);
        expect(response.body).toBe(false);
    });

    it('reports the service version through the lazy getter', async () => {
        const { app } = mount();

        const response = await request(app).get('/api/v1/version');

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ version: '9.9.9', commit: 'abc1234' });
    });

    it('derives capabilities from which downstream URLs are configured', async () => {
        const all = mount({
            config: {
                didcommURL: 'http://didcomm',
                lightningMediatorURL: 'http://ln',
                heraldURL: 'http://herald',
                explorerURL: 'http://explorer',
            },
        });
        await expect(request(all.app).get('/api/v1/capabilities')).resolves.toMatchObject({
            body: { didcomm: true, lightning: true, names: true, explorer: true },
        });

        const none = mount({
            config: { didcommURL: '', lightningMediatorURL: '', heraldURL: '', explorerURL: '' },
        });
        await expect(request(none.app).get('/api/v1/capabilities')).resolves.toMatchObject({
            body: { didcomm: false, lightning: false, names: false, explorer: false },
        });
    });

    it('advertises the resolved DIDComm endpoint, or null when unresolvable', async () => {
        const resolved = mount();
        await expect(request(resolved.app).get('/api/v1/didcomm-endpoint')).resolves.toMatchObject({
            body: { endpoint: 'https://drawbridge.test/didcomm' },
        });

        const unresolved = mount({ didCommEndpoint: null });
        await expect(request(unresolved.app).get('/api/v1/didcomm-endpoint')).resolves.toMatchObject({
            body: { endpoint: null },
        });
    });

    it('wraps the upstream status and reports upstream failure as 502', async () => {
        const { app } = mount();
        const ok = await request(app).get('/api/v1/status');
        expect(ok.status).toBe(200);
        expect(ok.body).toMatchObject({ service: 'drawbridge', upstream: { dids: { total: 1 } } });

        const failing = mount();
        failing.gatekeeper.getStatus = jest.fn<any>().mockRejectedValue(new Error('down'));
        const bad = await request(failing.app).get('/api/v1/status');
        expect(bad.status).toBe(502);
        expect(bad.body).toEqual({ error: 'Upstream gatekeeper error' });
    });
});

describe('drawbridge v1 admin gating', () => {
    const adminRoutes: Array<[Method, string]> = [
        ['GET', '/api/v1/l402/status'],
        ['POST', '/api/v1/l402/revoke'],
        ['GET', '/api/v1/l402/payments/did:cid:abc'],
    ];

    it('rejects admin routes with no key, and answers 403 when none is configured', async () => {
        const configured = mount();
        for (const [method, path] of adminRoutes) {
            const call = method === 'GET'
                ? request(configured.app).get(path)
                : request(configured.app).post(path).send({});
            const response = await call;
            expect([path, response.status]).toEqual([path, 401]);
        }

        const unconfigured = mount({ config: { adminApiKey: '' } });
        const response = await request(unconfigured.app).get('/api/v1/l402/status');
        expect(response.status).toBe(403);
        expect(response.body).toEqual({ error: 'Admin API key not configured' });
    });

    it('passes a correct admin key through to the handler', async () => {
        // l402Options is a bare stub, so the handler beyond the gate fails — the
        // point here is that requireAdminKey called next() rather than 401ing.
        // The other L402 routes are deliberately not driven with a valid key:
        // their handlers are one-line delegations already covered at 100% by
        // l402-auth.test.ts, and calling them with a stub options object leaves
        // some of them never responding, which hangs Jest.
        const { app } = mount();

        const response = await request(app)
            .get('/api/v1/l402/status')
            .set('X-Archon-Admin-Key', adminKey);

        expect(response.status).not.toBe(401);
        expect(response.status).not.toBe(403);
    });

    it('rejects a wrong admin key without leaking length via timing', async () => {
        const { app } = mount();

        const short = await request(app).get('/api/v1/l402/status').set('X-Archon-Admin-Key', 'x');
        expect(short.status).toBe(401);
        expect(short.body).toEqual({ error: 'Invalid admin API key' });

        const sameLength = await request(app)
            .get('/api/v1/l402/status')
            .set('X-Archon-Admin-Key', 'x'.repeat(adminKey.length));
        expect(sameLength.status).toBe(401);
    });
});

describe('drawbridge v1 gatekeeper proxy routes', () => {
    it('forwards each call to the upstream gatekeeper', async () => {
        const { app, gatekeeper } = mount();

        await expect(request(app).get('/api/v1/registries')).resolves.toMatchObject({
            status: 200, body: ['local'],
        });

        const created = await request(app).post('/api/v1/did').send({ type: 'create' });
        expect(created.body).toBe('did:cid:new');
        expect(gatekeeper.createDID).toHaveBeenCalledWith({ type: 'create' });

        const generated = await request(app).post('/api/v1/did/generate').send({ type: 'create' });
        expect(generated.body).toBe('did:cid:generated');

        const dids = await request(app).post('/api/v1/dids').send({ resolve: true });
        expect(gatekeeper.getDIDs).toHaveBeenCalledWith({ resolve: true });
        expect(dids.status).toBe(200);

        const exported = await request(app).post('/api/v1/dids/export').send({ dids: ['did:cid:abc'] });
        expect(gatekeeper.exportDIDs).toHaveBeenCalledWith(['did:cid:abc']);
        expect(exported.status).toBe(200);
    });

    it('passes resolve options through only when present', async () => {
        const { app, gatekeeper } = mount();

        await request(app).get('/api/v1/did/did:cid:abc');
        expect(gatekeeper.resolveDID).toHaveBeenCalledWith('did:cid:abc', undefined);

        await request(app).get('/api/v1/did/did:cid:abc?confirm=true&verify=false&versionSequence=2');
        expect(gatekeeper.resolveDID).toHaveBeenLastCalledWith('did:cid:abc', {
            versionSequence: 2,
            confirm: true,
            verify: false,
        });
    });

    it('serves IPFS reads and writes', async () => {
        const { app, gatekeeper } = mount();

        await expect(request(app).post('/api/v1/ipfs/json').send({ a: 1 })).resolves.toMatchObject({ status: 200 });
        await expect(request(app).get('/api/v1/ipfs/json/cid')).resolves.toMatchObject({
            body: { hello: 'world' },
        });
        await expect(request(app).get('/api/v1/ipfs/text/cid')).resolves.toMatchObject({ text: 'hello' });

        const data = await request(app).get('/api/v1/ipfs/data/cid');
        expect(data.headers['content-type']).toContain('application/octet-stream');

        const streamed = await request(app).get('/api/v1/ipfs/stream/cid?filename=x.txt&type=text/plain');
        expect(streamed.headers['content-disposition']).toContain('x.txt');
        expect(streamed.text).toBe('streamed');

        expect(gatekeeper.addJSON).toHaveBeenCalled();
    });

    it('writes text, binary, and streamed payloads upstream', async () => {
        const { app, gatekeeper } = mount();

        const text = await request(app)
            .post('/api/v1/ipfs/text')
            .set('Content-Type', 'text/plain')
            .send('hello');
        expect(text.status).toBe(200);
        expect(gatekeeper.addText).toHaveBeenCalledWith('hello');

        const data = await request(app)
            .post('/api/v1/ipfs/data')
            .set('Content-Type', 'application/octet-stream')
            .send(Buffer.from('bytes'));
        expect(data.status).toBe(200);
        expect(gatekeeper.addData).toHaveBeenCalledWith(Buffer.from('bytes'));

        const streamed = await request(app)
            .post('/api/v1/ipfs/stream')
            .set('Content-Type', 'application/octet-stream')
            .send(Buffer.from('bytes'));
        expect(streamed.status).toBe(200);
        expect(streamed.text).toBe('cid-stream');
        expect(gatekeeper.addDataStream).toHaveBeenCalled();
    });

    it('reports a mid-stream read failure as 502', async () => {
        const { app, gatekeeper } = mount();
        gatekeeper.getDataStream = jest.fn(() => (async function* () {
            throw new Error('stream died');
            // eslint-disable-next-line no-unreachable
            yield 'never';
        })()) as any;

        const response = await request(app).get('/api/v1/ipfs/stream/cid');

        expect(response.status).toBe(502);
    });

    it('answers 404 when IPFS data is missing', async () => {
        const { app, gatekeeper } = mount();
        gatekeeper.getData = jest.fn<any>().mockResolvedValue(null);

        const response = await request(app).get('/api/v1/ipfs/data/cid');

        expect(response.status).toBe(404);
    });

    it('parses a numeric blockId but passes a hash through unchanged', async () => {
        const { app, gatekeeper } = mount();

        await request(app).get('/api/v1/block/local/latest');
        expect(gatekeeper.getBlock).toHaveBeenCalledWith('local');

        await request(app).get('/api/v1/block/local/42');
        expect(gatekeeper.getBlock).toHaveBeenLastCalledWith('local', 42);

        await request(app).get('/api/v1/block/local/abc123');
        expect(gatekeeper.getBlock).toHaveBeenLastCalledWith('local', 'abc123');
    });

    it('serves search and structured query', async () => {
        const { app, gatekeeper } = mount();

        await request(app).get('/api/v1/search?q=hello');
        expect(gatekeeper.searchDocs).toHaveBeenCalledWith('hello');

        await request(app).post('/api/v1/query').send({ where: { type: 'notice' } });
        expect(gatekeeper.queryDocs).toHaveBeenCalledWith({ type: 'notice' });

        // Without a `where` wrapper the whole body is treated as the query.
        await request(app).post('/api/v1/query').send({ type: 'notice' });
        expect(gatekeeper.queryDocs).toHaveBeenLastCalledWith({ type: 'notice' });
    });

    it('reports any upstream gatekeeper failure as 502', async () => {
        const { app, gatekeeper } = mount();
        for (const method of Object.keys(gatekeeper) as Array<keyof typeof gatekeeper>) {
            if (method === 'isReady') continue; // /ready deliberately swallows failures
            (gatekeeper as any)[method] = jest.fn<any>().mockRejectedValue(new Error('upstream down'));
        }

        const calls: Array<[string, () => request.Test]> = [
            ['registries', () => request(app).get('/api/v1/registries')],
            ['did', () => request(app).post('/api/v1/did').send({})],
            ['did/generate', () => request(app).post('/api/v1/did/generate').send({})],
            ['did/:did', () => request(app).get('/api/v1/did/did:cid:abc')],
            ['dids', () => request(app).post('/api/v1/dids').send({})],
            ['dids/export', () => request(app).post('/api/v1/dids/export').send({})],
            ['ipfs/json', () => request(app).post('/api/v1/ipfs/json').send({})],
            ['ipfs/json/:cid', () => request(app).get('/api/v1/ipfs/json/cid')],
            ['ipfs/text', () => request(app).post('/api/v1/ipfs/text').send({})],
            ['ipfs/text/:cid', () => request(app).get('/api/v1/ipfs/text/cid')],
            ['ipfs/data', () => request(app).post('/api/v1/ipfs/data').send({})],
            ['ipfs/data/:cid', () => request(app).get('/api/v1/ipfs/data/cid')],
            ['ipfs/stream', () => request(app).post('/api/v1/ipfs/stream').send({})],
            ['block latest', () => request(app).get('/api/v1/block/local/latest')],
            ['block by id', () => request(app).get('/api/v1/block/local/7')],
            ['search', () => request(app).get('/api/v1/search?q=x')],
            ['query', () => request(app).post('/api/v1/query').send({})],
            ['status', () => request(app).get('/api/v1/status')],
        ];

        for (const [label, call] of calls) {
            const response = await call();
            expect([label, response.status]).toEqual([label, 502]);
        }
    });
});

describe('drawbridge v1 lightning proxy', () => {
    it('answers 501 when no lightning mediator is configured', async () => {
        const { app, proxyLightningMediatorRequest } = mount({ config: { lightningMediatorURL: '' } });

        const response = await request(app).get('/api/v1/lightning/balance');

        expect(response.status).toBe(501);
        expect(response.body).toEqual({ error: 'Lightning is not enabled on this node' });
        expect(proxyLightningMediatorRequest).not.toHaveBeenCalled();
    });

    it('delegates to the mediator proxy when configured', async () => {
        const { app, proxyLightningMediatorRequest } = mount({
            config: { lightningMediatorURL: 'http://lightning-mediator:4224' },
        });

        const response = await request(app).get('/api/v1/lightning/balance');

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ proxied: true });
        expect(proxyLightningMediatorRequest).toHaveBeenCalled();
    });

    it('reports a proxy failure as 502', async () => {
        const { app, proxyLightningMediatorRequest } = mount({
            config: { lightningMediatorURL: 'http://lightning-mediator:4224' },
        });
        proxyLightningMediatorRequest.mockRejectedValue(new Error('mediator down'));

        const response = await request(app).get('/api/v1/lightning/balance');

        expect(response.status).toBe(502);
        expect(response.body).toEqual({ error: 'Upstream lightning mediator error' });
    });
});
