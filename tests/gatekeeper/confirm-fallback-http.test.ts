import { jest } from '@jest/globals';
import request from 'supertest';
import Gatekeeper from '@didcid/gatekeeper';
import CipherNode from '@didcid/cipher/node';
import Db from '@didcid/gatekeeper/db/json-memory.ts';
import MemoryClient from '@didcid/ipfs/memory';
import { createGatekeeperApp } from '../../services/gatekeeper/server/src/gatekeeper-api.ts';
import config from '../../services/gatekeeper/server/src/config.js';
import TestHelper from './helper.ts';

it('delegates a pending confirmed resolution without changing local history, respecting bounds and recursion', async () => {
    const gatekeeper = new Gatekeeper({ db: new Db('confirm-http'), ipfs: new MemoryClient() });
    const cipher = new CipherNode();
    const helper = new TestHelper(gatekeeper, cipher);
    const pair = cipher.generateRandomJwk();
    const did = await gatekeeper.createDID(await helper.createAgentOp(pair, { registry: 'hyperswarm' }));
    const initial = await gatekeeper.resolveDID(did);
    const operation = await helper.createUpdateOp(pair, did, { didDocumentData: { pending: true } });
    operation.proof!.created = '2030-01-01T00:00:00Z';
    await gatekeeper.updateDID(operation);
    const peer = await gatekeeper.resolveDID(did);
    peer.didDocumentMetadata!.confirmed = true;
    const originalFetch = global.fetch;
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(peer)));
    global.fetch = fetchMock;
    const { app } = createGatekeeperApp({ gatekeeper, config: { ...config, adminApiKey: '', fallbackURL: '', confirmFallbackURL: 'https://peer.example' }, logger: { error: jest.fn() } as any });
    try {
        const result = await request(app).get(`/api/v1/did/${did}?confirm=true`);
        expect(result.body).toEqual(peer);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect((await gatekeeper.resolveDID(did, { confirm: true })).didDocumentMetadata?.versionSequence).toBe('1');
        for (const query of ['confirm=false', 'confirm=true&versionSequence=1', 'confirm=true&versionTime=2029-01-01T00:00:00Z']) {
            await request(app).get(`/api/v1/did/${did}?${query}`);
        }
        const recursive = await request(app).get(`/api/v1/did/${did}?confirm=true`).set('X-Archon-Confirm-Fallback', '1');
        expect(recursive.body.didDocumentMetadata.versionSequence).toBe('1');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        fetchMock.mockResolvedValue(new Response(JSON.stringify(initial)));
        expect((await request(app).get(`/api/v1/did/${did}?confirm=true`)).body.didDocumentMetadata.versionSequence).toBe('1');
        await gatekeeper.removeDIDs([did]);
        fetchMock.mockResolvedValue(new Response(JSON.stringify(peer)));
        expect((await request(app).get(`/api/v1/did/${did}?confirm=true`)).body).toEqual(peer);
        expect((await gatekeeper.resolveDID(did)).didResolutionMetadata?.error).toBe('notFound');
    } finally {
        global.fetch = originalFetch;
    }
});
