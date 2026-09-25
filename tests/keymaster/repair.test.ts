import Gatekeeper from '@didcid/gatekeeper';
import Keymaster from '@didcid/keymaster';
import CipherNode from '@didcid/cipher/node';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory';
import WalletJsonMemory from '@didcid/keymaster/wallet/json-memory';
import MemoryClient from '@didcid/ipfs/memory';

let keymaster: Keymaster;
let gatekeeper: Gatekeeper;
let db: DbJsonMemory;
let ipfs: MemoryClient;
let wallet: WalletJsonMemory;
const cipher = new CipherNode();
beforeEach(async () => {
    ipfs = new MemoryClient();
    await ipfs.start();
    db = new DbJsonMemory('repair');
    gatekeeper = new Gatekeeper({ db, ipfs, registries: ['local', 'hyperswarm'] });
    wallet = new WalletJsonMemory();
    keymaster = new Keymaster({ gatekeeper, wallet, cipher, passphrase: 'test' });
    await keymaster.loadOrCreateWallet();
});
afterEach(async () => { await ipfs.stop(); });

async function damagedAgent(absolute = false) {
    const did = await keymaster.createId('Alice', { registry: 'local' });
    const doc = await keymaster.resolveDID(did);
    const document = doc.didDocument!;
    document.verificationMethod![0].id = absolute ? `${did}#key-1` : '#key-1';
    document.capabilityInvocation = ['#removed'];
    await keymaster.updateDID(did, { didDocument: document, didDocumentData: { keep: 'data' } });
    return did;
}

test.each([false, true])('repairs signed documents and remains correct after rotation/restart (absolute=%s)', async absolute => {
    const did = await damagedAgent(absolute);
    const before = await keymaster.resolveDID(did);
    const check = await keymaster.checkDID('Alice');
    expect(check.canRepair).toBe(true);
    expect(check.issues.map(issue => issue.code)).toEqual(['stale-operation-permissions', 'missing-operation-permission']);
    expect((await keymaster.resolveDID(did)).didDocumentMetadata!.versionId).toBe(before.didDocumentMetadata!.versionId);
    const repaired = await keymaster.repairDID(did);
    expect(repaired).toMatchObject({ submitted: true, confirmed: true, issues: [], changes: null });
    const after = await keymaster.resolveDID(did);
    expect(after.didDocument).toEqual({ ...before.didDocument, capabilityInvocation: [absolute ? `${did}#key-1` : '#key-1'] });
    expect(after.didDocumentData).toEqual(before.didDocumentData);
    expect(after.didDocumentRegistration).toEqual(before.didDocumentRegistration);
    expect((await keymaster.repairDID(did)).submitted).toBe(false);
    expect((await keymaster.resolveDID(did)).didDocumentMetadata!.versionId).toBe(after.didDocumentMetadata!.versionId);
    await keymaster.rotateKeys();
    expect((await keymaster.checkDID(did)).issues).toEqual([]);
    expect((await keymaster.resolveDID(did)).didDocument!.capabilityInvocation).toEqual(['#key-2']);
    // A fresh instance replays the persisted signed evidence.
    gatekeeper = new Gatekeeper({ db, ipfs, registries: ['local', 'hyperswarm'] });
    await gatekeeper.checkDIDs();
    keymaster = new Keymaster({ gatekeeper, wallet, cipher, passphrase: 'test' });
    expect((await keymaster.checkDID(did)).issues).toEqual([]);
});

test('preserves valid relationships and does not grant all published keys operation authority', async () => {
    const did = await damagedAgent();
    await keymaster.publishAssertionKey();
    await keymaster.publishDidComm('https://relay.example/didcomm');
    const doc = await keymaster.resolveDID(did);
    const document = doc.didDocument!;
    // A separately permitted published method stays permitted; another does not gain permission.
    const extra = document.verificationMethod![1].id!;
    document.capabilityInvocation = [extra, '#removed'];
    await keymaster.updateDID(did, { didDocument: document });
    await keymaster.repairDID(did);
    const after = (await keymaster.resolveDID(did)).didDocument!;
    expect(after).toEqual({ ...document, capabilityInvocation: [extra, '#key-1'] });
});

test('checks without a wallet or control, but cannot repair', async () => {
    const did = await damagedAgent();
    const empty = new WalletJsonMemory();
    const stranger = new Keymaster({ gatekeeper, wallet: empty, cipher, passphrase: 'test' });
    const report = await stranger.checkDID(did);
    expect(report).toMatchObject({ canRepair: false, changes: null });
    expect(report.issues).toHaveLength(2);
    await expect(stranger.repairDID(did)).rejects.toThrow('unavailable');
    expect(await empty.loadWallet()).toBeFalsy();
});

test('asset checks refer to controller repairs without updating either DID', async () => {
    const agent = await damagedAgent();
    const asset = await keymaster.createAsset({ keep: true }, { registry: 'local' });
    const before = await keymaster.resolveDID(asset);
    expect(await keymaster.checkDID(asset)).toMatchObject({ canRepair: false, changes: null,
        issues: [{ code: 'controller-needs-repair', relatedDid: agent }] });
    await expect(keymaster.repairDID(asset)).rejects.toThrow('controlling agent separately');
    await keymaster.repairDID(agent);
    expect((await keymaster.repairDID(asset)).submitted).toBe(false);
    const after = await keymaster.resolveDID(asset);
    expect(after.didDocument).toEqual(before.didDocument);
    expect(after.didDocumentMetadata).toEqual(before.didDocumentMetadata);
});

test('reports deactivated and unresolved DIDs', async () => {
    const did = await damagedAgent();
    await keymaster.revokeDID(did);
    expect(await keymaster.checkDID(did)).toMatchObject({ canRepair: false, issues: [{ code: 'deactivated' }] });
    await expect(keymaster.repairDID(did)).rejects.toThrow('Deactivated');
    await expect(keymaster.checkDID('did:cid:missing')).rejects.toThrow();
});

test('repairs a missing relationship and preserves unrelated asset verification methods', async () => {
    const did = await damagedAgent();
    const doc = await keymaster.resolveDID(did);
    delete doc.didDocument!.capabilityInvocation;
    await keymaster.updateDID(did, { didDocument: doc.didDocument });
    expect((await keymaster.checkDID(did)).issues.map(issue => issue.code)).toEqual(['missing-operation-permission']);
    await keymaster.repairDID(did);
    const asset = await keymaster.createAsset({}, { registry: 'local' });
    const assetDoc = await keymaster.resolveDID(asset);
    assetDoc.didDocument!.verificationMethod = doc.didDocument!.verificationMethod;
    await keymaster.updateDID(asset, { didDocument: assetDoc.didDocument });
    expect(await keymaster.checkDID(asset)).toMatchObject({ issues: [], changes: null, canRepair: false });
});

test('reports pending chain updates separately from accepted repairs', async () => {
    // Enable a chain registry in this isolated Gatekeeper; genesis is confirmed by definition.
    gatekeeper = new Gatekeeper({ db, ipfs, registries: ['local', 'BTC:signet'] });
    keymaster = new Keymaster({ gatekeeper, wallet, cipher, passphrase: 'test' });
    const did = await keymaster.createId('Alice', { registry: 'BTC:signet' });
    const document = (await keymaster.resolveDID(did)).didDocument!;
    delete document.capabilityInvocation;
    await keymaster.updateDID(did, { didDocument: document });
    expect(await keymaster.checkDID(did)).toMatchObject({ confirmed: false, canRepair: false });
    await expect(keymaster.repairDID(did)).rejects.toThrow('confirmed');
});

test('keeps non-fragment method IDs distinct during inspection, repair and rotation', async () => {
    const did = await damagedAgent();
    const document = (await keymaster.resolveDID(did)).didDocument!;
    document.verificationMethod!.push({ ...document.verificationMethod![0], id: 'keys/op#key-1' });
    document.capabilityInvocation = ['keys/op#key-1'];
    await keymaster.updateDID(did, { didDocument: document });
    expect((await keymaster.checkDID(did)).issues.map(issue => issue.code)).toEqual(['missing-operation-permission']);
    await keymaster.repairDID(did);
    await keymaster.rotateKeys();
    const after = (await keymaster.resolveDID(did)).didDocument!;
    expect(after.capabilityInvocation).toEqual(['keys/op#key-1', '#key-2']);
    expect(after.verificationMethod![1]).toEqual(document.verificationMethod![1]);
    after.capabilityInvocation!.push('#key-1');
    await keymaster.updateDID(did, { didDocument: after });
    expect((await keymaster.checkDID(did)).issues.map(issue => issue.code)).toEqual(['stale-operation-permissions']);
    await keymaster.repairDID(did);
    expect((await keymaster.resolveDID(did)).didDocument!.capabilityInvocation).toEqual(['keys/op#key-1', '#key-2']);
});

test('reports a non-fragment relative signing method as unsupported instead of promising repair', async () => {
    const did = await damagedAgent();
    const document = (await keymaster.resolveDID(did)).didDocument!;
    document.verificationMethod![0].id = 'keys/op#key-1';
    await keymaster.updateDID(did, { didDocument: document });
    expect(await keymaster.checkDID(did)).toMatchObject({ canRepair: false, changes: null,
        issues: [{ code: 'unsupported-operation-key' }] });
});

test('repairs with an older wallet key when the agent returns to that key', async () => {
    const did = await damagedAgent();
    const original = (await keymaster.resolveDID(did)).didDocument!;
    await keymaster.rotateKeys();
    await keymaster.updateDID(did, { didDocument: original });
    expect((await keymaster.loadWallet()).ids.Alice.index).toBe(1);
    expect((await keymaster.checkDID(did)).canRepair).toBe(true);
    expect((await keymaster.repairDID(did)).submitted).toBe(true);
});

test('a rotation during repair is rejected by the predecessor check and leaves the rotation intact', async () => {
    const did = await damagedAgent();
    const getBlock = gatekeeper.getBlock.bind(gatekeeper);
    gatekeeper.getBlock = async (...args) => {
        gatekeeper.getBlock = getBlock;
        await keymaster.rotateKeys();
        return getBlock(...args);
    };
    await expect(keymaster.repairDID(did)).rejects.toThrow('previd');
    const document = (await keymaster.resolveDID(did)).didDocument!;
    expect(document.verificationMethod![0].id).toBe('#key-2');
    expect(document.capabilityInvocation).toEqual(['#removed']);
    expect((await keymaster.repairDID(did)).submitted).toBe(true);
});

test.each(['deactivated', 'unsupported-operation-key', 'uncontrolled'])(
    'asset inspection explains an unavailable controller repair (%s)', async state => {
        const agent = await damagedAgent();
        const asset = await keymaster.createAsset({ keep: true }, { registry: 'local' });
        if (state === 'deactivated') {
            await keymaster.revokeDID(agent);
        } else if (state === 'unsupported-operation-key') {
            const document = (await keymaster.resolveDID(agent)).didDocument!;
            document.verificationMethod![0].id = 'keys/op#key-1';
            await keymaster.updateDID(agent, { didDocument: document });
        } else {
            keymaster = new Keymaster({ gatekeeper, wallet: new WalletJsonMemory(), cipher, passphrase: 'test' });
        }
        const controller = await keymaster.checkDID(agent);
        const report = await keymaster.checkDID(asset);
        expect(controller.canRepair).toBe(false);
        expect(report).toMatchObject({ canRepair: false, changes: null,
            issues: [{ code: 'controller-repair-unavailable', relatedDid: agent }] });
        expect(report.issues[0].message).toContain(controller.reason || controller.issues[0].message);
        await expect(keymaster.repairDID(asset)).rejects.toThrow('Controller repair unavailable');
    },
);

test('cannot repair after a valid signed update moves authority to a key absent from the wallet', async () => {
    const did = await damagedAgent();
    // Another wallet supplies a valid public key; Alice authorizes the update
    // with her predecessor key, but does not possess the replacement secret.
    const other = new Keymaster({ gatekeeper, wallet: new WalletJsonMemory(), cipher, passphrase: 'other' });
    await other.loadOrCreateWallet();
    const otherDid = await other.createId('Other', { registry: 'local' });
    const replacement = (await other.resolveDID(otherDid)).didDocument!.verificationMethod![0].publicKeyJwk;
    const document = (await keymaster.resolveDID(did)).didDocument!;
    document.verificationMethod![0].publicKeyJwk = replacement;
    await keymaster.updateDID(did, { didDocument: document });
    const before = await keymaster.resolveDID(did);
    expect(await keymaster.checkDID(did)).toMatchObject({ canRepair: false, changes: null });
    await expect(keymaster.repairDID(did)).rejects.toThrow(/key|wallet/);
    expect(await keymaster.resolveDID(did)).toMatchObject({
        didDocument: before.didDocument, didDocumentMetadata: before.didDocumentMetadata,
    });
});

test('a rejected repair submission is reported as failure and leaves the document unchanged', async () => {
    const did = await damagedAgent();
    const before = await keymaster.resolveDID(did);
    const update = gatekeeper.updateDID.bind(gatekeeper);
    // Exercise the public transport's negative acknowledgment, not a new
    // protocol acceptance rule.
    gatekeeper.updateDID = async () => false;
    try {
        await expect(keymaster.repairDID(did)).rejects.toThrow('DID repair was not accepted');
        expect(await keymaster.resolveDID(did)).toMatchObject({
            didDocument: before.didDocument, didDocumentMetadata: before.didDocumentMetadata,
        });
    } finally {
        gatekeeper.updateDID = update;
    }
    expect((await keymaster.repairDID(did)).submitted).toBe(true);
});
