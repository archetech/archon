import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { createV1Router } from '../../services/gatekeeper/server/src/v1-router';
import { checkAdminApiKey, MIN_ADMIN_API_KEY_LENGTH } from '../../services/gatekeeper/server/src/v1-admin';
import defaultConfig from '../../services/gatekeeper/server/src/config';

const adminKey = 'test-admin-key';
const testConfig = {
    ...defaultConfig,
    adminApiKey: adminKey,
    fallbackURL: '',
    confirmFallbackURL: '',
    jsonLimit: '1mb',
    uploadLimit: '1mb',
};

function streamChunks(chunks: Array<Buffer | string>) {
    return (async function* () {
        for (const chunk of chunks) {
            yield chunk;
        }
    })();
}

function createMockGatekeeper() {
    return {
        createDID: jest.fn().mockResolvedValue('did:cid:new'),
        updateDID: jest.fn().mockResolvedValue(true),
        generateDID: jest.fn().mockResolvedValue('did:cid:generated'),
        resolveDID: jest.fn().mockResolvedValue({ didDocument: { id: 'did:cid:abc' }, didResolutionMetadata: {} }),
        getDIDs: jest.fn().mockResolvedValue(['did:cid:abc']),
        removeDIDs: jest.fn().mockResolvedValue(true),
        exportDIDs: jest.fn().mockResolvedValue([[{ did: 'did:cid:abc' }]]),
        importDIDs: jest.fn().mockResolvedValue({ queued: 1, processed: 0, rejected: 0, total: 1 }),
        exportBatch: jest.fn().mockResolvedValue([{ did: 'did:cid:abc' }]),
        importBatch: jest.fn().mockResolvedValue({ queued: 1, processed: 0, rejected: 0, total: 1 }),
        importBatchByCids: jest.fn().mockResolvedValue({ queued: 1, processed: 0, rejected: 0, total: 1 }),
        getQueue: jest.fn().mockResolvedValue([{ type: 'create' }]),
        clearQueue: jest.fn().mockResolvedValue([]),
        listRegistries: jest.fn().mockResolvedValue(['local', 'pin']),
        resetDb: jest.fn().mockResolvedValue(undefined),
        verifyDb: jest.fn().mockResolvedValue({ total: 1, verified: 1, expired: 0, invalid: 0 }),
        processEvents: jest.fn().mockResolvedValue({ added: 1, merged: 0, rejected: 0, pending: 0 }),
        addJSON: jest.fn().mockResolvedValue('cid-json'),
        getJSON: jest.fn().mockResolvedValue({ hello: 'world' }),
        addText: jest.fn().mockResolvedValue('cid-text'),
        getText: jest.fn().mockResolvedValue('hello'),
        addData: jest.fn().mockResolvedValue('cid-data'),
        getData: jest.fn().mockResolvedValue(Buffer.from('bytes')),
        addDataStream: jest.fn().mockResolvedValue('cid-stream'),
        getDataStream: jest.fn().mockReturnValue(streamChunks(['streamed'])),
        getBlock: jest.fn().mockResolvedValue({ hash: 'abc', height: 7, time: 123 }),
        addBlock: jest.fn().mockResolvedValue(true),
        searchDocs: jest.fn().mockResolvedValue(['did:cid:abc']),
        queryDocs: jest.fn().mockResolvedValue(['did:cid:abc']),
        checkDIDs: jest.fn().mockResolvedValue({
            total: 0,
            byType: { agents: 0, assets: 0, confirmed: 0, unconfirmed: 0, ephemeral: 0, invalid: 0 },
            byRegistry: {},
            byVersion: {},
            eventsQueue: [],
        }),
    };
}

function mount(configOverrides: Record<string, unknown> = {}) {
    const gatekeeper = createMockGatekeeper();
    const config = { ...testConfig, ...configOverrides };
    const app = express();
    app.use(express.json({ limit: config.jsonLimit }));
    app.use('/api/v1', createV1Router({
        gatekeeper: gatekeeper as any,
        config: config as any,
        logger: { error: jest.fn() } as any,
        isReady: () => true,
        getStatus: async () => ({
            uptimeSeconds: 0,
            dids: {
                total: 0,
                byType: { agents: 0, assets: 0, confirmed: 0, unconfirmed: 0, ephemeral: 0, invalid: 0 },
                byRegistry: {},
                byVersion: {},
                eventsQueue: [],
            },
            memoryUsage: {},
        }),
        didOperationsTotal: { inc: jest.fn() } as any,
    }));

    return { app, gatekeeper };
}

const boom = () => jest.fn<() => Promise<never>>().mockRejectedValue(new Error('boom'));

describe('/api/v1 route handlers', () => {
    it('serves health, version, status, and registry routes without bootstrapping the service', async () => {
        const { app, gatekeeper } = mount();

        await expect(request(app).get('/api/v1/ready')).resolves.toMatchObject({ status: 200, body: true });

        const version = await request(app).get('/api/v1/version');
        expect(version.status).toBe(200);
        expect(version.body.version).toEqual(expect.any(String));
        expect(version.body.commit).toEqual(expect.any(String));

        const status = await request(app).get('/api/v1/status');
        expect(status.status).toBe(200);
        expect(status.body.dids.total).toBe(0);

        const registries = await request(app).get('/api/v1/registries');
        expect(registries.status).toBe(200);
        expect(registries.body).toEqual(['local', 'pin']);
        expect(gatekeeper.listRegistries).toHaveBeenCalled();
    });

    it('routes DID creation, generation, listing, and resolution through the injected gatekeeper', async () => {
        const { app, gatekeeper } = mount();
        const op = { type: 'create', registration: { registry: 'local' } };

        const create = await request(app).post('/api/v1/did').send(op);
        expect(create.status).toBe(200);
        expect(create.body).toBe('did:cid:new');
        expect(gatekeeper.createDID).toHaveBeenCalledWith(op);

        const generate = await request(app).post('/api/v1/did/generate').send(op);
        expect(generate.status).toBe(200);
        expect(generate.body).toBe('did:cid:generated');
        expect(gatekeeper.generateDID).toHaveBeenCalledWith(op);

        const resolved = await request(app).get('/api/v1/did/did:cid:abc?versionSequence=2&confirm=true&verify=true');
        expect(resolved.status).toBe(200);
        expect(gatekeeper.resolveDID).toHaveBeenCalledWith('did:cid:abc', {
            versionSequence: 2,
            confirm: true,
            verify: true,
        });

        const dids = await request(app).post('/api/v1/dids').send({ resolve: true });
        expect(dids.status).toBe(200);
        expect(dids.body).toEqual(['did:cid:abc']);
        expect(gatekeeper.getDIDs).toHaveBeenCalledWith({ resolve: true });
    });

    it('enforces the admin key on protected routes and passes through when authorized', async () => {
        const { app, gatekeeper } = mount();

        const rejected = await request(app).get('/api/v1/queue/local');
        expect(rejected.status).toBe(401);
        expect(gatekeeper.getQueue).not.toHaveBeenCalled();

        const accepted = await request(app)
            .get('/api/v1/queue/local')
            .set('X-Archon-Admin-Key', adminKey);
        expect(accepted.status).toBe(200);
        expect(accepted.body).toEqual([{ type: 'create' }]);
        expect(gatekeeper.getQueue).toHaveBeenCalledWith('local');

        const processed = await request(app)
            .post('/api/v1/events/process')
            .set('X-Archon-Admin-Key', adminKey);
        expect(processed.status).toBe(200);
        expect(gatekeeper.processEvents).toHaveBeenCalled();
    });

    it('exercises IPFS body parsing and retrieval routes', async () => {
        const { app, gatekeeper } = mount();

        const json = await request(app).post('/api/v1/ipfs/json').send({ hello: 'world' });
        expect(json.status).toBe(200);
        expect(json.text).toBe('cid-json');
        expect(gatekeeper.addJSON).toHaveBeenCalledWith({ hello: 'world' });

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

        const streamed = await request(app).get('/api/v1/ipfs/stream/cid-stream?type=text/plain&filename=test.txt');
        expect(streamed.status).toBe(200);
        expect(streamed.text).toBe('streamed');
        expect(streamed.headers['content-disposition']).toContain('test.txt');
    });

    it('routes block, search, and structured query endpoints', async () => {
        const { app, gatekeeper } = mount();

        const latest = await request(app).get('/api/v1/block/local/latest');
        expect(latest.status).toBe(200);
        expect(gatekeeper.getBlock).toHaveBeenCalledWith('local');

        const byHeight = await request(app).get('/api/v1/block/local/7');
        expect(byHeight.status).toBe(200);
        expect(gatekeeper.getBlock).toHaveBeenCalledWith('local', 7);

        const search = await request(app).get('/api/v1/search?q=hello');
        expect(search.status).toBe(200);
        expect(gatekeeper.searchDocs).toHaveBeenCalledWith('hello');

        const badQuery = await request(app).post('/api/v1/query').send({});
        expect(badQuery.status).toBe(400);

        const query = await request(app).post('/api/v1/query').send({ where: { type: 'notice' } });
        expect(query.status).toBe(200);
        expect(gatekeeper.queryDocs).toHaveBeenCalledWith({ type: 'notice' });
    });
});

describe('/api/v1 sync routes', () => {
    const admin = (req: request.Test) => req.set('X-Archon-Admin-Key', adminKey);

    it('routes batch export, import, and import-by-cids through the gatekeeper', async () => {
        const { app, gatekeeper } = mount();

        const exported = await admin(request(app).post('/api/v1/batch/export')).send({ dids: ['did:cid:abc'] });
        expect(exported.status).toBe(200);
        expect(exported.body).toEqual([{ did: 'did:cid:abc' }]);
        expect(gatekeeper.exportBatch).toHaveBeenCalledWith(['did:cid:abc']);

        const imported = await admin(request(app).post('/api/v1/batch/import')).send([{ did: 'did:cid:abc' }]);
        expect(imported.status).toBe(200);
        expect(imported.body).toMatchObject({ queued: 1, total: 1 });
        expect(gatekeeper.importBatch).toHaveBeenCalledWith([{ did: 'did:cid:abc' }]);

        const byCids = await admin(request(app).post('/api/v1/batch/import/cids'))
            .send({ cids: ['cid-1'], metadata: { source: 'test' } });
        expect(byCids.status).toBe(200);
        expect(gatekeeper.importBatchByCids).toHaveBeenCalledWith(['cid-1'], { source: 'test' });
    });

    it('clears the queue and runs db maintenance routes', async () => {
        const { app, gatekeeper } = mount();

        const cleared = await admin(request(app).post('/api/v1/queue/local/clear')).send([{ type: 'create' }]);
        expect(cleared.status).toBe(200);
        expect(gatekeeper.clearQueue).toHaveBeenCalledWith('local', [{ type: 'create' }]);

        const reset = await admin(request(app).get('/api/v1/db/reset'));
        expect(reset.status).toBe(200);
        expect(gatekeeper.resetDb).toHaveBeenCalled();

        const verified = await admin(request(app).get('/api/v1/db/verify'));
        expect(verified.status).toBe(200);
        expect(verified.body).toMatchObject({ total: 1, verified: 1 });
    });

    it('refuses to reset the database in production', async () => {
        const { app, gatekeeper } = mount();
        const previous = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';

        try {
            const reset = await admin(request(app).get('/api/v1/db/reset'));
            expect(reset.status).toBe(403);
            expect(gatekeeper.resetDb).not.toHaveBeenCalled();
        } finally {
            process.env.NODE_ENV = previous;
        }
    });

    it('reports gatekeeper failures on sync routes as 500', async () => {
        const { app, gatekeeper } = mount();
        for (const method of [
            'exportBatch', 'importBatch', 'importBatchByCids', 'getQueue',
            'clearQueue', 'listRegistries', 'resetDb', 'verifyDb', 'processEvents',
        ] as const) {
            (gatekeeper as any)[method] = boom();
        }

        // Build each request lazily: supertest's Test binds a server on construction,
        // so eagerly created requests that never run would leak handles and hang Jest.
        const calls: Array<[string, () => request.Test]> = [
            ['batch/export', () => admin(request(app).post('/api/v1/batch/export')).send({ dids: [] })],
            ['batch/import', () => admin(request(app).post('/api/v1/batch/import')).send([])],
            ['batch/import/cids', () => admin(request(app).post('/api/v1/batch/import/cids')).send({ cids: [] })],
            ['queue', () => admin(request(app).get('/api/v1/queue/local'))],
            ['queue/clear', () => admin(request(app).post('/api/v1/queue/local/clear')).send([])],
            ['registries', () => request(app).get('/api/v1/registries')],
            ['db/reset', () => admin(request(app).get('/api/v1/db/reset'))],
            ['db/verify', () => admin(request(app).get('/api/v1/db/verify'))],
            ['events/process', () => admin(request(app).post('/api/v1/events/process'))],
        ];

        for (const [label, call] of calls) {
            const response = await call();
            expect([label, response.status]).toEqual([label, 500]);
        }
    });
});

describe('/api/v1 DID routes', () => {
    const admin = (req: request.Test) => req.set('X-Archon-Admin-Key', adminKey);
    const originalFetch = global.fetch;

    afterEach(() => {
        global.fetch = originalFetch;
    });

    it('passes versionTime through and ignores an unparsable versionSequence', async () => {
        const { app, gatekeeper } = mount();

        await request(app).get('/api/v1/did/did:cid:abc?versionTime=2026-01-01T00:00:00Z&versionSequence=nope');
        expect(gatekeeper.resolveDID).toHaveBeenCalledWith('did:cid:abc', {
            versionTime: '2026-01-01T00:00:00Z',
        });
    });

    it('answers 404 when the gatekeeper throws while resolving', async () => {
        const { app, gatekeeper } = mount();
        gatekeeper.resolveDID = boom();

        const response = await request(app).get('/api/v1/did/did:cid:missing');
        expect(response.status).toBe(404);
        expect(response.body).toEqual({ error: 'DID not found' });
    });

    // The universal resolver is only consulted for FOREIGN methods, so these use
    // did:web rather than this node's own method (see the did:cid case below).
    it('falls back to the universal resolver when resolution returns an error', async () => {
        const { app, gatekeeper } = mount({ fallbackURL: 'https://resolver.test/' });
        gatekeeper.resolveDID = jest.fn<any>().mockResolvedValue({
            didDocument: {},
            didResolutionMetadata: { error: 'notFound' },
        });
        const upstream = { didDocument: { id: 'did:web:example.com' } };
        global.fetch = jest.fn<any>().mockResolvedValue({ ok: true, json: async () => upstream });

        const response = await request(app).get('/api/v1/did/did:web:example.com');
        expect(response.status).toBe(200);
        expect(response.body).toEqual(upstream);
        expect(global.fetch).toHaveBeenCalledWith(
            'https://resolver.test/1.0/identifiers/did%3Aweb%3Aexample.com',
            expect.objectContaining({ signal: expect.anything() }),
        );
    });

    it('returns the original document when the universal resolver rejects or errors', async () => {
        const errorDoc = { didDocument: {}, didResolutionMetadata: { error: 'notFound' } };

        const notOk = mount({ fallbackURL: 'https://resolver.test' });
        notOk.gatekeeper.resolveDID = jest.fn<any>().mockResolvedValue(errorDoc);
        global.fetch = jest.fn<any>().mockResolvedValue({ ok: false });
        const first = await request(notOk.app).get('/api/v1/did/did:web:example.com');
        expect(first.status).toBe(200);
        expect(first.body).toEqual(errorDoc);

        const threw = mount({ fallbackURL: 'https://resolver.test' });
        threw.gatekeeper.resolveDID = jest.fn<any>().mockResolvedValue(errorDoc);
        global.fetch = jest.fn<any>().mockRejectedValue(new Error('network down'));
        const second = await request(threw.app).get('/api/v1/did/did:web:example.com');
        expect(second.status).toBe(200);
        expect(second.body).toEqual(errorDoc);
    });

    it('skips the universal resolver for DIDs of its own method', async () => {
        // A universal resolver has no driver for this node's own method, so asking
        // it about our DIDs only burns fallbackTimeout. The node is the authority.
        const { app, gatekeeper } = mount({ fallbackURL: 'https://resolver.test' });
        const errorDoc = { didDocument: {}, didResolutionMetadata: { error: 'notFound' } };
        gatekeeper.resolveDID = jest.fn<any>().mockResolvedValue(errorDoc);
        global.fetch = jest.fn<any>();

        const response = await request(app).get('/api/v1/did/did:cid:abc');
        expect(response.status).toBe(200);
        expect(response.body).toEqual(errorDoc);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('still consults the universal resolver for foreign methods when a prefix is set', async () => {
        // Guards against the skip being too broad: only our own prefix is exempt.
        const { app, gatekeeper } = mount({
            fallbackURL: 'https://resolver.test',
            didPrefix: 'did:cid',
        });
        gatekeeper.resolveDID = jest.fn<any>().mockResolvedValue({
            didDocument: {},
            didResolutionMetadata: { error: 'notFound' },
        });
        const upstream = { didDocument: { id: 'did:ethr:0xabc' } };
        global.fetch = jest.fn<any>().mockResolvedValue({ ok: true, json: async () => upstream });

        const response = await request(app).get('/api/v1/did/did:ethr:0xabc');
        expect(response.status).toBe(200);
        expect(response.body).toEqual(upstream);
        expect(global.fetch).toHaveBeenCalled();
    });

    it('sends non-create operations to updateDID', async () => {
        const { app, gatekeeper } = mount();
        const op = { type: 'update', registration: { registry: 'local' } };

        const updated = await request(app).post('/api/v1/did').send(op);
        expect(updated.status).toBe(200);
        expect(gatekeeper.updateDID).toHaveBeenCalledWith(op);
        expect(gatekeeper.createDID).not.toHaveBeenCalled();
    });

    it('rejects a generate request with no operation body', async () => {
        const { app, gatekeeper } = mount();

        // express.json() ignores a non-JSON content type, so req.body stays undefined
        // (Express 5) and the handler's own "missing operation" guard is what answers.
        const response = await request(app)
            .post('/api/v1/did/generate')
            .set('Content-Type', 'text/plain')
            .send('');
        expect(response.status).toBe(400);
        expect(response.body).toEqual({ error: 'missing operation' });
        expect(gatekeeper.generateDID).not.toHaveBeenCalled();
    });

    it('skips the universal resolver when no fallback URL is configured', async () => {
        const { app, gatekeeper } = mount();
        const errorDoc = { didDocument: {}, didResolutionMetadata: { error: 'notFound' } };
        gatekeeper.resolveDID = jest.fn<any>().mockResolvedValue(errorDoc);
        global.fetch = jest.fn<any>();

        // Foreign method, so the missing fallbackURL is the only reason to skip.
        const response = await request(app).get('/api/v1/did/did:web:example.com');
        expect(response.status).toBe(200);
        expect(response.body).toEqual(errorDoc);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('serves a confirmed document from the confirm fallback', async () => {
        const { app, gatekeeper } = mount({ confirmFallbackURL: 'https://confirm.test' });
        gatekeeper.resolveDID = jest.fn<any>().mockResolvedValue({
            didDocument: { id: 'did:cid:abc' },
            didResolutionMetadata: {},
            didDocumentMetadata: { confirmed: false },
        });
        const confirmed = { didDocument: { id: 'did:cid:abc' }, didDocumentMetadata: { confirmed: true } };
        global.fetch = jest.fn<any>().mockResolvedValue({ ok: true, json: async () => confirmed });

        const response = await request(app).get('/api/v1/did/did:cid:abc?confirm=true');
        expect(response.status).toBe(200);
        expect(response.body).toEqual(confirmed);
    });

    it('falls through to the local document when the confirm fallback throws', async () => {
        const { app, gatekeeper } = mount({ confirmFallbackURL: 'https://confirm.test' });
        const local = {
            didDocument: { id: 'did:cid:abc' },
            didResolutionMetadata: {},
            didDocumentMetadata: { confirmed: false },
        };
        gatekeeper.resolveDID = jest.fn<any>().mockResolvedValue(local);
        global.fetch = jest.fn<any>().mockRejectedValue(new Error('fallback down'));

        const response = await request(app).get('/api/v1/did/did:cid:abc?confirm=true');
        expect(response.status).toBe(200);
        expect(response.body).toEqual(local);
    });

    it('routes DID removal, export, and import, and reports failures as 500', async () => {
        const { app, gatekeeper } = mount();

        const removed = await admin(request(app).post('/api/v1/dids/remove')).send(['did:cid:abc']);
        expect(removed.status).toBe(200);
        expect(gatekeeper.removeDIDs).toHaveBeenCalledWith(['did:cid:abc']);

        const exported = await request(app).post('/api/v1/dids/export').send({ dids: ['did:cid:abc'] });
        expect(exported.status).toBe(200);
        expect(gatekeeper.exportDIDs).toHaveBeenCalledWith(['did:cid:abc']);

        const imported = await admin(request(app).post('/api/v1/dids/import')).send([[{ did: 'did:cid:abc' }]]);
        expect(imported.status).toBe(200);
        expect(gatekeeper.importDIDs).toHaveBeenCalledWith([[{ did: 'did:cid:abc' }]]);

        const failing = mount();
        for (const method of ['createDID', 'generateDID', 'getDIDs', 'removeDIDs', 'exportDIDs', 'importDIDs'] as const) {
            (failing.gatekeeper as any)[method] = boom();
        }

        // `/did/generate` answers 400 (not 500) on failure — its catch returns the error body.
        const calls: Array<[string, number, () => request.Test]> = [
            ['did', 500, () => request(failing.app).post('/api/v1/did').send({ type: 'create' })],
            ['did/generate', 400, () => request(failing.app).post('/api/v1/did/generate').send({ type: 'create' })],
            ['dids', 500, () => request(failing.app).post('/api/v1/dids/').send({})],
            ['dids/remove', 500, () => admin(request(failing.app).post('/api/v1/dids/remove')).send([])],
            ['dids/export', 500, () => request(failing.app).post('/api/v1/dids/export').send({ dids: [] })],
            ['dids/import', 500, () => admin(request(failing.app).post('/api/v1/dids/import')).send([])],
        ];

        for (const [label, expected, call] of calls) {
            const response = await call();
            expect([label, response.status]).toEqual([label, expected]);
        }
    });
});

describe('/api/v1 block, search, health, and admin behaviour', () => {
    const admin = (req: request.Test) => req.set('X-Archon-Admin-Key', adminKey);

    it('adds a block and returns an empty result for a blank search', async () => {
        const { app, gatekeeper } = mount();

        const added = await admin(request(app).post('/api/v1/block/local')).send({ hash: 'abc', height: 8 });
        expect(added.status).toBe(200);
        expect(gatekeeper.addBlock).toHaveBeenCalledWith('local', { hash: 'abc', height: 8 });

        const blank = await request(app).get('/api/v1/search?q=');
        expect(blank.status).toBe(200);
        expect(blank.body).toEqual([]);
        expect(gatekeeper.searchDocs).not.toHaveBeenCalled();
    });

    it('reports block, search, and query failures as 500', async () => {
        const { app, gatekeeper } = mount();
        gatekeeper.getBlock = boom();
        gatekeeper.addBlock = boom();
        gatekeeper.searchDocs = boom();
        gatekeeper.queryDocs = boom();

        const calls: Array<[string, () => request.Test]> = [
            ['block latest', () => request(app).get('/api/v1/block/local/latest')],
            ['block by id', () => request(app).get('/api/v1/block/local/7')],
            ['add block', () => admin(request(app).post('/api/v1/block/local')).send({})],
            ['search', () => request(app).get('/api/v1/search?q=hello')],
            ['query', () => request(app).post('/api/v1/query').send({ where: { type: 'notice' } })],
        ];

        for (const [label, call] of calls) {
            const response = await call();
            expect([label, response.status]).toEqual([label, 500]);
        }
    });

    it('reports health route failures as 500', async () => {
        const gatekeeper = createMockGatekeeper();
        const app = express();
        app.use(express.json());
        app.use('/api/v1', createV1Router({
            gatekeeper: gatekeeper as any,
            config: testConfig as any,
            logger: { error: jest.fn() } as any,
            isReady: () => { throw new Error('not ready'); },
            getStatus: async () => { throw new Error('no status'); },
            didOperationsTotal: { inc: jest.fn() } as any,
        }));

        await expect(request(app).get('/api/v1/ready')).resolves.toMatchObject({ status: 500 });
        await expect(request(app).get('/api/v1/status')).resolves.toMatchObject({ status: 500 });
    });

    it('refuses admin routes when no admin key is configured', async () => {
        const { app, gatekeeper } = mount({ adminApiKey: '' });

        const response = await request(app).get('/api/v1/queue/local');
        expect(response.status).toBe(403);
        expect(response.body).toEqual({ error: 'Admin API key not configured' });
        expect(gatekeeper.getQueue).not.toHaveBeenCalled();
    });

    it('rejects an admin key of the wrong length without throwing', async () => {
        const { app, gatekeeper } = mount();

        const response = await request(app)
            .get('/api/v1/queue/local')
            .set('X-Archon-Admin-Key', `${adminKey}-longer`);
        expect(response.status).toBe(401);
        expect(gatekeeper.getQueue).not.toHaveBeenCalled();
    });
});

describe('/api/v1 IPFS routes', () => {
    it('retrieves json, text, and binary payloads by cid', async () => {
        const { app, gatekeeper } = mount();

        const json = await request(app).get('/api/v1/ipfs/json/cid-json');
        expect(json.status).toBe(200);
        expect(json.body).toEqual({ hello: 'world' });
        expect(gatekeeper.getJSON).toHaveBeenCalledWith('cid-json');

        const text = await request(app).get('/api/v1/ipfs/text/cid-text');
        expect(text.status).toBe(200);
        expect(gatekeeper.getText).toHaveBeenCalledWith('cid-text');

        const data = await request(app).get('/api/v1/ipfs/data/cid-data');
        expect(data.status).toBe(200);
        expect(gatekeeper.getData).toHaveBeenCalledWith('cid-data');

        const streamed = await request(app).post('/api/v1/ipfs/stream').send(Buffer.from('bytes'));
        expect(streamed.status).toBe(200);
        expect(gatekeeper.addDataStream).toHaveBeenCalled();
    });

    it('reports gatekeeper failures on IPFS routes as 500', async () => {
        const { app, gatekeeper } = mount();
        for (const method of ['addJSON', 'getJSON', 'addText', 'getText', 'addData', 'getData', 'addDataStream'] as const) {
            (gatekeeper as any)[method] = boom();
        }
        gatekeeper.getDataStream = jest.fn(() => { throw new Error('boom'); }) as any;

        const calls: Array<[string, () => request.Test]> = [
            ['post json', () => request(app).post('/api/v1/ipfs/json').send({ a: 1 })],
            ['get json', () => request(app).get('/api/v1/ipfs/json/cid')],
            ['post text', () => request(app).post('/api/v1/ipfs/text').set('Content-Type', 'text/plain').send('hi')],
            ['get text', () => request(app).get('/api/v1/ipfs/text/cid')],
            ['post data', () => request(app).post('/api/v1/ipfs/data').set('Content-Type', 'application/octet-stream').send(Buffer.from('x'))],
            ['get data', () => request(app).get('/api/v1/ipfs/data/cid')],
            ['post stream', () => request(app).post('/api/v1/ipfs/stream').send(Buffer.from('x'))],
            ['get stream', () => request(app).get('/api/v1/ipfs/stream/cid')],
        ];

        for (const [label, call] of calls) {
            const response = await call();
            expect([label, response.status]).toEqual([label, 500]);
        }
    });
});

describe('startup admin key validation', () => {
    // main() exits non-zero on a fatal result; these cover the rule itself,
    // since a route test constructs the app directly and never reaches main().
    it('is fatal when no admin key is configured', () => {
        const result = checkAdminApiKey('');

        expect(result.fatal).toBeDefined();
        expect(result.fatal).toContain('ARCHON_ADMIN_API_KEY must be set');
        expect(result.fatal).toContain('openssl rand -hex 32');
        expect(result.warning).toBeUndefined();
    });

    it('warns but does not block startup for a short key', () => {
        const result = checkAdminApiKey('short-key');

        expect(result.fatal).toBeUndefined();
        expect(result.warning).toContain(`shorter than ${MIN_ADMIN_API_KEY_LENGTH}`);
    });

    it('accepts a key at the minimum length with no warning', () => {
        const result = checkAdminApiKey('a'.repeat(MIN_ADMIN_API_KEY_LENGTH));

        expect(result.fatal).toBeUndefined();
        expect(result.warning).toBeUndefined();
    });

    it('accepts a generated 64-character key', () => {
        const result = checkAdminApiKey('0'.repeat(64));

        expect(result.fatal).toBeUndefined();
        expect(result.warning).toBeUndefined();
    });
});
