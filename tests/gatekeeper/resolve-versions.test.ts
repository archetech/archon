import express from 'express';
import request from 'supertest';
import CipherNode from '@didcid/cipher/node';
import Gatekeeper from '@didcid/gatekeeper';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory.ts';
import MemoryClient from '@didcid/ipfs/memory';
import TestHelper, { anchorEvent } from './helper.ts';
import { createV1Router } from '../../services/gatekeeper/server/src/v1-router.ts';
import defaultConfig from '../../services/gatekeeper/server/src/config.js';

// A reader that needs every version of a DID, as an indexer does, had to export
// the node's events and apply their operations itself, repeating what resolution
// does. `resolveVersions` gives it the versions as this node resolves them.

const mockConsole = {
    log: (): void => { },
    error: (): void => { },
    time: (): void => { },
    timeEnd: (): void => { },
} as unknown as typeof console;

const cipher = new CipherNode();
const ipfs = new MemoryClient();
let gatekeeper: Gatekeeper;
let helper: TestHelper;

beforeAll(async () => {
    await ipfs.start();
});

afterAll(async () => {
    await ipfs.stop();
});

beforeEach(async () => {
    gatekeeper = new Gatekeeper({ db: new DbJsonMemory('test'), ipfs, console: mockConsole, registries: ['local', 'hyperswarm', 'BTC:signet'] });
    helper = new TestHelper(gatekeeper, cipher);
    await gatekeeper.resetDb();
});

async function createAgent(registry = 'local') {
    const keypair = cipher.generateRandomJwk();
    const did = await gatekeeper.createDID(await helper.createAgentOp(keypair, { registry }));
    return { did, keypair };
}

async function update(did: string, keypair: ReturnType<typeof cipher.generateRandomJwk>, data: unknown) {
    const doc = await gatekeeper.resolveDID(did);
    doc.didDocumentData = data as never;
    await gatekeeper.updateDID(await helper.createUpdateOp(keypair, did, doc));
}

// What resolveVersions must return for a DID: each versionSequence, resolved.
async function expected(did: string) {
    const versions = [];

    for (let sequence = 1; ; sequence++) {
        const doc = await gatekeeper.resolveDID(did, { versionSequence: sequence });

        if (doc.didResolutionMetadata?.error) {
            return versions;
        }
        delete doc.didResolutionMetadata;
        versions.push(doc);
    }
}

describe('resolveVersions', () => {
    it('returns each version as resolution returns it for that sequence', async () => {
        const { did, keypair } = await createAgent();
        await update(did, keypair, { n: 1 });
        await update(did, keypair, { n: 2 });

        const [versions] = await gatekeeper.resolveVersions([did]);

        expect(versions).toHaveLength(3);
        expect(versions).toStrictEqual(await expected(did));
        expect(versions.map(version => version.didDocumentMetadata?.versionSequence)).toStrictEqual(['1', '2', '3']);
        expect(versions.map(version => version.didDocumentData)).toStrictEqual([{}, { n: 1 }, { n: 2 }]);
        expect(new Set(versions.map(version => version.didDocumentMetadata?.versionId)).size).toBe(3);
        expect(versions.every(version => version.didResolutionMetadata === undefined)).toBe(true);
    });

    it('is aligned with the request, with no versions for a DID it cannot resolve', async () => {
        const first = await createAgent();
        const second = await createAgent();
        await update(second.did, second.keypair, { n: 1 });

        const result = await gatekeeper.resolveVersions(['did:cid:mock', second.did, 'not a did', first.did, second.did]);

        expect(result.map(versions => versions.length)).toStrictEqual([0, 2, 0, 1, 2]);
        expect(result[1]).toStrictEqual(await expected(second.did));
        expect(result[3]).toStrictEqual(await expected(first.did));
        expect(await gatekeeper.resolveVersions([])).toStrictEqual([]);
    });

    it('ends with the deactivated version of a deleted DID', async () => {
        const { did, keypair } = await createAgent();
        await update(did, keypair, { n: 1 });
        await gatekeeper.deleteDID(await helper.createDeleteOp(keypair, did));

        const [versions] = await gatekeeper.resolveVersions([did]);

        expect(versions).toStrictEqual(await expected(did));
        expect(versions.map(version => version.didDocumentMetadata?.deactivated ?? false)).toStrictEqual([false, false, true]);
        expect(versions[1].didDocumentData).toStrictEqual({ n: 1 });
    });

    it('carries the block that anchored a version, where the node has that block', async () => {
        const { did, keypair } = await createAgent('BTC:signet');
        await update(did, keypair, { n: 1 });

        const before = (await gatekeeper.resolveVersions([did]))[0];
        expect(before.map(version => version.didDocumentMetadata?.timestamp?.upperBound)).toStrictEqual([undefined, undefined]);
        expect(before.map(version => version.didDocumentMetadata?.confirmed)).toStrictEqual([true, false]);

        const ops = await gatekeeper.exportBatch([did]);
        anchorEvent(ops[0], 'BTC:signet', 100);
        anchorEvent(ops[1], 'BTC:signet', 101);
        await gatekeeper.addBlock('BTC:signet', { height: 100, hash: 'hash-100', time: 1_800_000_000 });
        await gatekeeper.addBlock('BTC:signet', { height: 101, hash: 'hash-101', time: 1_800_000_600 });
        await gatekeeper.importBatch(ops);
        await gatekeeper.processEvents();

        const [versions] = await gatekeeper.resolveVersions([did]);

        expect(versions).toStrictEqual(await expected(did));
        expect(versions.map(version => version.didDocumentMetadata?.confirmed)).toStrictEqual([true, true]);
        expect(versions.map(version => version.didDocumentMetadata?.timestamp)).toMatchObject([
            { chain: 'BTC:signet', upperBound: { height: 100, time: 1_800_000_000 } },
            { chain: 'BTC:signet', upperBound: { height: 101, time: 1_800_000_600 } },
        ]);
    });

    it('rejects a request that is not a list of DIDs', async () => {
        for (const dids of [undefined, 'did:cid:mock', { did: 'did:cid:mock' }, [1], ['did:cid:mock', null]]) {
            await expect(gatekeeper.resolveVersions(dids as never)).rejects.toThrow('Invalid parameter: dids');
        }
    });

    it('is served over HTTP, with 400 for a body that is not a list of DIDs', async () => {
        const app = express();
        app.use(express.json());
        app.use('/api/v1', createV1Router({
            gatekeeper,
            config: { ...defaultConfig, adminApiKey: 'test-admin-key', fallbackURL: '', confirmFallbackURL: '' } as any,
            logger: { error: () => { } } as any,
            isReady: () => true,
            getStatus: async () => ({}),
        } as any));
        const { did, keypair } = await createAgent();
        await update(did, keypair, { n: 1 });

        const response = await request(app).post('/api/v1/dids/versions').send({ dids: [did, 'did:cid:mock'] });
        expect(response.status).toBe(200);
        expect(response.body).toStrictEqual(JSON.parse(JSON.stringify([await expected(did), []])));

        for (const body of [{}, { dids: 'did:cid:mock' }, { dids: [1] }]) {
            const refused = await request(app).post('/api/v1/dids/versions').send(body);
            expect([body, refused.status]).toStrictEqual([body, 400]);
            expect(refused.body).toStrictEqual({ error: 'Invalid parameter: dids' });
        }
    });
});
