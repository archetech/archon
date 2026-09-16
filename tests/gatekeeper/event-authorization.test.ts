import CipherNode from '@didcid/cipher/node';
import Gatekeeper from '@didcid/gatekeeper';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory.ts';
import MemoryClient from '@didcid/ipfs/memory';
import type { Operation } from '@didcid/gatekeeper/types';
import TestHelper from './helper.ts';

const cipher = new CipherNode();
const ipfs = new MemoryClient();
const db = new DbJsonMemory('event-authorization');
const gatekeeper = new Gatekeeper({ db, ipfs, registries: ['local', 'hyperswarm', 'BTC:signet'] });
const helper = new TestHelper(gatekeeper, cipher);

beforeEach(async () => { await gatekeeper.resetDb(); });
afterAll(async () => { await ipfs.stop(); });

async function commit(operation: Operation, height: number, time: number) {
    const cid = await gatekeeper.generateCID(operation, true);
    await gatekeeper.importBatchByCids([cid], {
        registry: 'BTC:signet', time: new Date(time).toISOString(), ordinal: [height, 0],
        registration: { height, index: 0, txid: `tx${height}`, batch: `batch${height}` },
    });
    return gatekeeper.processEvents();
}

it.each(['create', 'update', 'delete'] as const)('selects one authority for asset %s on import and replay', async (kind) => {
    const now = Date.now();
    const k1 = cipher.generateRandomJwk();
    const k2 = cipher.generateRandomJwk();
    const genesis = await helper.createAgentOp(k1, { registry: 'BTC:signet' });
    const alice = await gatekeeper.createDID(genesis);
    const assetCreate = await helper.createAssetOp(alice, k1, { registry: 'BTC:signet' });
    let asset = await gatekeeper.createDID(assetCreate);
    await commit(genesis, 100, now);
    await commit(assetCreate, 110, now + 1000);

    const controller = await gatekeeper.resolveDID(alice);
    controller.didDocument!.verificationMethod![0].publicKeyJwk = k2.publicJwk;
    const rotation = await helper.createUpdateOp(k1, alice, controller);
    await commit(rotation, 200, now + 2000);

    let operation: Operation;
    if (kind === 'create') {
        operation = await helper.createAssetOp(alice, k2, { registry: 'BTC:signet', data: { authorized: true } });
        asset = await gatekeeper.generateDID(operation);
    } else if (kind === 'delete') {
        operation = await helper.createDeleteOp(k2, asset);
    } else {
        const doc = await gatekeeper.resolveDID(asset);
        doc.didDocumentData = { authorized: true };
        operation = await helper.createUpdateOp(k2, asset, doc);
    }
    // K2 was not authorized at the claimed proof time, but is authorized at
    // the event's position. Requiring both documents would change the policy.
    operation.proof!.created = new Date(now).toISOString();
    if (kind === 'create') {
        asset = await gatekeeper.generateDID(operation);
    }
    expect(await gatekeeper.verifyOperation(operation)).toBe(false);
    expect(await commit(operation, 300, now + 3000)).toMatchObject({ added: 1, rejected: 0, pending: 0 });

    const plain = await gatekeeper.resolveDID(asset, { confirm: true });
    const replayed = await gatekeeper.resolveDID(asset, { confirm: true, verify: true });
    expect(replayed.didDocument).toEqual(plain.didDocument);
    expect(replayed.didDocumentData).toEqual(plain.didDocumentData);
    expect(replayed.didDocumentMetadata).toEqual(plain.didDocumentMetadata);
    if (kind === 'delete') {
        expect(replayed.didDocumentMetadata?.deactivated).toBe(true);
    } else {
        expect(replayed.didDocumentData).toEqual({ authorized: true });
    }
});

it('verifies against supplied authority without consulting stored controller history', async () => {
    const key = cipher.generateRandomJwk();
    const alice = await gatekeeper.createDID(await helper.createAgentOp(key));
    const controller = await gatekeeper.resolveDID(alice);
    const create = await helper.createAssetOp(alice, key);
    const asset = await gatekeeper.createDID(create);
    const doc = await gatekeeper.resolveDID(asset);
    doc.didDocumentData = { updated: true };
    const update = await helper.createUpdateOp(key, asset, doc);
    await gatekeeper.resetDb();

    expect(await gatekeeper.verifyCreateOperation(create, controller)).toBe(true);
    expect(await gatekeeper.verifyUpdateOperation(update, controller)).toBe(true);
    const wrong = cipher.generateRandomJwk();
    controller.didDocument!.verificationMethod![0].publicKeyJwk = wrong.publicJwk;
    expect(await gatekeeper.verifyCreateOperation(create, controller)).toBe(false);
    expect(await gatekeeper.verifyUpdateOperation(update, controller)).toBe(false);
});

it('authorizes a competing rotation against its predecessor during reorganization', async () => {
    const now = Date.now();
    const k1 = cipher.generateRandomJwk();
    const k2 = cipher.generateRandomJwk();
    const k3 = cipher.generateRandomJwk();
    const genesis = await helper.createAgentOp(k1, { registry: 'BTC:signet' });
    const alice = await gatekeeper.createDID(genesis);
    await commit(genesis, 100, now);
    const v1 = await gatekeeper.resolveDID(alice);
    const firstDoc = structuredClone(v1);
    firstDoc.didDocument!.verificationMethod![0].publicKeyJwk = k2.publicJwk;
    const first = await helper.createUpdateOp(k1, alice, firstDoc);
    const earlierDoc = structuredClone(v1);
    earlierDoc.didDocument!.verificationMethod![0].publicKeyJwk = k3.publicJwk;
    const earlier = await helper.createUpdateOp(k1, alice, earlierDoc);

    expect(await commit(first, 300, now + 3000)).toMatchObject({ added: 1 });
    // The earlier competing operation is signed by K1, which is absent from
    // the latest state but present in the operation's named predecessor.
    expect(await commit(earlier, 200, now + 2000)).toMatchObject({ added: 1, rejected: 0, pending: 0 });
    const replayed = await gatekeeper.resolveDID(alice, { confirm: true, verify: true });
    expect(replayed.didDocument!.verificationMethod![0].publicKeyJwk).toEqual(k3.publicJwk);
    expect(replayed.didDocumentMetadata?.versionSequence).toBe('2');
});
