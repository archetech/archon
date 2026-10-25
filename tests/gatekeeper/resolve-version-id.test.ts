import CipherNode from '@didcid/cipher/node';
import Gatekeeper from '@didcid/gatekeeper';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory.ts';
import { copyJSON } from '@didcid/common/utils';
import MemoryClient from '@didcid/ipfs/memory';
import TestHelper from './helper.ts';

const mockConsole = {
    log: (): void => { },
    error: (): void => { },
    time: (): void => { },
    timeEnd: (): void => { },
} as unknown as typeof console;

const cipher = new CipherNode();
const db = new DbJsonMemory('test');
const ipfs = new MemoryClient();
const gatekeeper = new Gatekeeper({ db, ipfs, console: mockConsole, registries: ['local', 'hyperswarm', 'BTC:signet'] });
const helper = new TestHelper(gatekeeper, cipher);

beforeAll(async () => {
    await ipfs.start();
});

afterAll(async () => {
    await ipfs.stop();
});

beforeEach(async () => {
    await gatekeeper.resetDb();
});

async function agentWithVersions(registry: string, updates: number) {
    const keypair = cipher.generateRandomJwk();
    const did = await gatekeeper.createDID(await helper.createAgentOp(keypair, { version: 1, registry }));

    for (let i = 0; i < updates; i++) {
        const doc = await gatekeeper.resolveDID(did);
        doc.didDocumentData = { mock: i + 1 };
        await gatekeeper.updateDID(await helper.createUpdateOp(keypair, did, doc));
    }

    const versionIds = [];
    for (let sequence = 1; sequence <= updates + 1; sequence++) {
        const doc = await gatekeeper.resolveDID(did, { versionSequence: sequence });
        versionIds.push(doc.didDocumentMetadata!.versionId!);
    }

    return { keypair, did, versionIds };
}

describe('resolveDID versionId', () => {
    it('resolves the document as of the named operation', async () => {
        const { did, versionIds } = await agentWithVersions('local', 3);

        for (const verify of [false, true]) {
            for (const [index, versionId] of versionIds.entries()) {
                const doc = await gatekeeper.resolveDID(did, { versionId, verify });

                expect(doc.didResolutionMetadata?.error).toBeUndefined();
                expect(doc.didDocumentMetadata!.versionId).toBe(versionId);
                expect(doc.didDocumentMetadata!.versionSequence).toBe(String(index + 1));
                const bySequence = await gatekeeper.resolveDID(did, { versionSequence: index + 1, verify });
                expect({ ...doc, didResolutionMetadata: {} }).toStrictEqual({ ...bySequence, didResolutionMetadata: {} });
            }
        }
    });

    it('returns notFound, not the latest version, for an operation outside the history', async () => {
        const { did } = await agentWithVersions('local', 2);
        const other = await agentWithVersions('local', 0);

        for (const versionId of ['bafkreinosuchoperation', other.versionIds[0]]) {
            const doc = await gatekeeper.resolveDID(did, { versionId });

            expect(doc.didResolutionMetadata?.error).toBe('notFound');
            expect(doc.didDocumentMetadata).toStrictEqual({});
        }
    });

    it('returns notFound for an unconfirmed operation when confirm is set', async () => {
        const { did, versionIds } = await agentWithVersions('BTC:signet', 1);

        const genesis = await gatekeeper.resolveDID(did, { versionId: versionIds[0], confirm: true });
        expect(genesis.didDocumentMetadata!.versionSequence).toBe('1');

        const pending = await gatekeeper.resolveDID(did, { versionId: versionIds[1], confirm: true });
        expect(pending.didResolutionMetadata?.error).toBe('notFound');

        const unconfirmed = await gatekeeper.resolveDID(did, { versionId: versionIds[1] });
        expect(unconfirmed.didDocumentMetadata!.versionSequence).toBe('2');
    });

    it('returns notFound for a competing successor displaced by the preferred one', async () => {
        const keypair = cipher.generateRandomJwk();
        const did = await gatekeeper.createDID(await helper.createAgentOp(keypair));
        const genesis = await gatekeeper.resolveDID(did);

        const operations = [];
        for (let i = 0; i < 3; i++) {
            const doc = copyJSON(genesis);
            doc.didDocumentData = { sibling: i };
            operations.push(await helper.createUpdateOp(keypair, did, doc));
        }

        await gatekeeper.importBatch(operations.map((operation, i) => ({
            registry: 'local',
            operation,
            ordinal: [i],
            time: new Date().toISOString(),
        })));
        await gatekeeper.processEvents();

        const ids = await Promise.all(operations.map(operation => gatekeeper.generateCID(operation)));
        const [accepted, ...displaced] = [...ids].sort();

        const doc = await gatekeeper.resolveDID(did, { versionId: accepted });
        expect(doc.didDocumentMetadata!.versionSequence).toBe('2');

        for (const versionId of displaced) {
            const missing = await gatekeeper.resolveDID(did, { versionId });
            expect(missing.didResolutionMetadata?.error).toBe('notFound');
        }
    });

    it('rejects versionId combined with another version selector', async () => {
        const { did, versionIds } = await agentWithVersions('local', 1);
        const versionId = versionIds[1];

        for (const options of [
            { versionId, versionSequence: 2 },
            { versionId, versionTime: new Date().toISOString() },
            { versionId: '' },
        ]) {
            const doc = await gatekeeper.resolveDID(did, options);
            expect(doc.didResolutionMetadata?.error).toBe('invalidOptions');
        }
    });

    it('still reports invalidDid before checking options', async () => {
        const doc = await gatekeeper.resolveDID('did:cid:not-a-cid', { versionId: 'x', versionSequence: 1 });
        expect(doc.didResolutionMetadata?.error).toBe('invalidDid');
    });
});
