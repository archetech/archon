import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { createV1Router } from '../../services/gatekeeper/server/src/v1-router';
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

function mount() {
    const gatekeeper = createMockGatekeeper();
    const app = express();
    app.use(express.json({ limit: testConfig.jsonLimit }));
    app.use('/api/v1', createV1Router({
        gatekeeper: gatekeeper as any,
        config: testConfig,
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
