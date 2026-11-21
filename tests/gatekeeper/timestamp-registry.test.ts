import CipherNode from '@didcid/cipher/node';
import Gatekeeper from '@didcid/gatekeeper';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory.ts';
import MemoryClient from '@didcid/ipfs/memory';
import type { GatekeeperEvent } from '@didcid/gatekeeper/types';
import TestHelper, { anchorEvent } from './helper.ts';

// `timestamp.upperBound` is the block that anchored a version. It is one of the
// chain the version's receipt is on (#1694).

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
    gatekeeper = new Gatekeeper({
        db: new DbJsonMemory('test'), ipfs, console: mockConsole,
        registries: ['local', 'hyperswarm', 'BTC:signet', 'ETH:sepolia'],
    });
    helper = new TestHelper(gatekeeper, cipher);
    await gatekeeper.resetDb();
    // Both chains have a block at the height the receipts below give.
    await gatekeeper.addBlock('BTC:signet', { height: 100, hash: 'btc-100', time: 1_800_000_000 });
    await gatekeeper.addBlock('ETH:sepolia', { height: 100, hash: 'eth-100', time: 1_700_000_000 });
});

// The creation of an agent registered on BTC:signet, arriving in a batch
// anchored on the registry given.
async function importCreation(operation: GatekeeperEvent['operation'], registry: string) {
    const event = { registry, time: '2026-01-01T00:00:00.000Z', operation } as GatekeeperEvent;

    anchorEvent(event, registry, 100);
    await gatekeeper.importBatch([event]);
    await gatekeeper.processEvents();
}

it('gives no upper bound to a version whose receipt is on another registry', async () => {
    const operation = await helper.createAgentOp(cipher.generateRandomJwk(), { registry: 'BTC:signet' });

    await importCreation(operation, 'ETH:sepolia');

    const [did] = await gatekeeper.getDIDs() as string[];
    const doc = await gatekeeper.resolveDID(did);

    expect((await gatekeeper.exportDID(did))[0].registry).toBe('ETH:sepolia');
    expect(doc.didDocumentRegistration?.registry).toBe('BTC:signet');
    expect(doc.didDocumentMetadata?.timestamp).toBeUndefined();
    expect((await gatekeeper.resolveDID(did, { verify: true })).didDocumentMetadata?.timestamp).toBeUndefined();
});

it('gives the upper bound once the version is anchored on its own registry', async () => {
    const operation = await helper.createAgentOp(cipher.generateRandomJwk(), { registry: 'BTC:signet' });

    await importCreation(operation, 'ETH:sepolia');
    await importCreation(operation, 'BTC:signet');

    const [did] = await gatekeeper.getDIDs() as string[];
    const expected = { chain: 'BTC:signet', upperBound: { blockid: 'btc-100', height: 100, time: 1_800_000_000, txid: 'tx100' } };

    expect((await gatekeeper.exportDID(did))[0].registry).toBe('BTC:signet');
    expect((await gatekeeper.resolveDID(did)).didDocumentMetadata?.timestamp).toMatchObject(expected);
    expect((await gatekeeper.resolveDID(did, { verify: true })).didDocumentMetadata?.timestamp).toMatchObject(expected);
});

it('gives no upper bound to a later version anchored on another registry than its DID\'s', async () => {
    const keypair = cipher.generateRandomJwk();
    const operation = await helper.createAgentOp(keypair, { registry: 'BTC:signet' });

    await importCreation(operation, 'BTC:signet');
    const [did] = await gatekeeper.getDIDs() as string[];
    const doc = await gatekeeper.resolveDID(did);
    doc.didDocumentData = { n: 1 };
    const update = { registry: 'ETH:sepolia', time: '2026-01-02T00:00:00.000Z', operation: await helper.createUpdateOp(keypair, did, doc) } as GatekeeperEvent;
    anchorEvent(update, 'ETH:sepolia', 100);
    await gatekeeper.importBatch([update]);
    await gatekeeper.processEvents();

    const versions = await gatekeeper.resolveVersions([did]);

    expect(versions[0].map(version => version.didDocumentMetadata?.confirmed)).toStrictEqual([true, false]);
    expect(versions[0].map(version => version.didDocumentMetadata?.timestamp?.upperBound?.blockid)).toStrictEqual(['btc-100', undefined]);
});
