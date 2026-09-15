import CipherNode from '@didcid/cipher/node';
import Gatekeeper from '@didcid/gatekeeper';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory.ts';
import MemoryClient from '@didcid/ipfs/memory';
import TestHelper from './helper.ts';
import { base64url } from 'multiformats/bases/base64';

function hexToBase64url(hex: string): string {
    return base64url.baseEncode(Buffer.from(hex, 'hex'));
}

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

const hour = 60 * 60 * 1000;

beforeAll(async () => { await ipfs.start(); });
afterAll(async () => { await ipfs.stop(); });
beforeEach(async () => { await gatekeeper.resetDb(); });

// A controller keyed K1 that owns an asset, then rotates to K2. Returns what
// an attacker holding the retired K1 needs to forge with.
async function rotatedController(registry: string, rotationCreated: string) {
    const k1 = cipher.generateRandomJwk();
    const alice = await gatekeeper.createDID(await helper.createAgentOp(k1, { registry }));
    const asset = await gatekeeper.createDID(await helper.createAssetOp(alice, k1, { registry }));

    const k2 = cipher.generateRandomJwk();
    const aliceDoc = await gatekeeper.resolveDID(alice);
    aliceDoc.didDocument!.verificationMethod![0].publicKeyJwk = k2.publicJwk;
    const rotation = await helper.createUpdateOp(k1, alice, aliceDoc);
    rotation.proof!.created = rotationCreated;
    expect(await gatekeeper.updateDID(rotation)).toBe(true);

    const rotated = await gatekeeper.resolveDID(alice);
    expect(rotated.didDocument!.verificationMethod![0].publicKeyJwk).toEqual(k2.publicJwk);

    return { k1, k2, alice, asset };
}

// An update to the asset signed with the retired key, dated as given. The
// legacy proof signs the operation without the proof, so `created` can be set
// after signing without invalidating the signature.
async function forgery(k1: ReturnType<typeof cipher.generateRandomJwk>, asset: string, created: string) {
    const assetDoc = await gatekeeper.resolveDID(asset);
    assetDoc.didDocumentData = { stolen: true };
    const forged = await helper.createUpdateOp(k1, asset, assetDoc);
    forged.proof!.created = created;
    return forged;
}

// Off chain there is no timestamp the signer does not control, so a retired
// key can date an operation into its own validity window and be authorized by
// it. That is inherent to an unanchored registry and is not what #1131 closes;
// these two pin that the fix leaves it alone.
describe('backdating a proof off chain', () => {
    it('a rotated-out key can still author an asset operation', async () => {
        const now = Date.now();
        const { k1, asset } = await rotatedController('local', new Date(now + hour).toISOString());

        const forged = await forgery(k1, asset, new Date(now + 2 * hour).toISOString());
        expect(await gatekeeper.updateDID(forged)).toBe(false);

        forged.proof!.created = new Date(now).toISOString();
        expect(await gatekeeper.updateDID(forged)).toBe(true);
        expect((await gatekeeper.resolveDID(asset)).didDocumentData).toEqual({ stolen: true });
    });

    // The bound suite (#1087) signs `created` into the proof, which stops a
    // third party moving it on an existing signature. The key holder simply
    // signs a fresh proof for whatever date they want.
    it('the proof suite makes no difference', async () => {
        const now = Date.now();
        const { k1, alice, asset } = await rotatedController('local', new Date(now + hour).toISOString());

        async function boundForgery(created: string) {
            const current = await gatekeeper.resolveDID(asset);
            const doc = JSON.parse(JSON.stringify(current));
            doc.didDocumentData = { stolen: true };
            const unsecured = { type: 'update' as const, did: asset, previd: current.didDocumentMetadata?.versionId, doc };
            const config = {
                type: 'DataIntegrityProof' as const,
                cryptosuite: 'archon-ecdsa-secp256k1-jcs-2026' as const,
                created,
                verificationMethod: `${alice}#key-1`,
                proofPurpose: 'capabilityInvocation' as const,
            };
            const digests = cipher.hashJSON(config) + cipher.hashJSON(unsecured);
            const msgHash = cipher.hashMessage(Uint8Array.from(Buffer.from(digests, 'hex')));
            return { ...unsecured, proof: { ...config, proofValue: hexToBase64url(cipher.signHash(msgHash, k1.privateJwk)) } };
        }

        expect(await gatekeeper.updateDID(await boundForgery(new Date(now + 2 * hour).toISOString()))).toBe(false);
        expect(await gatekeeper.updateDID(await boundForgery(new Date(now).toISOString()))).toBe(true);
    });
});

// On chain the anchoring block is a timestamp the signer does not control. An
// operation the chain committed after the controller's rotation must not be
// authorized by the key that rotation retired, whatever `proof.created` claims.
describe('backdating a proof on chain', () => {
    it('an operation anchored after the rotation is rejected', async () => {
        const now = Date.now();
        const { k1, k2, alice, asset } = await rotatedController('BTC:signet', new Date(now).toISOString());

        // Confirm the controller on chain: create in block 100, rotation in
        // block 200 an hour later. The rotation's time is now the block time.
        const rotationBlockTime = new Date(now + hour).toISOString();
        const ops = await gatekeeper.exportDID(alice);
        ops[0].registry = 'BTC:signet';
        ops[0].registration = { height: 100, index: 0, txid: 'tx100', batch: 'b100' };
        ops[1].registry = 'BTC:signet';
        ops[1].registration = { height: 200, index: 0, txid: 'tx200', batch: 'b200' };
        ops[1].time = rotationBlockTime;
        ops[1].ordinal = [200, 0];
        await gatekeeper.importBatch(ops);
        await gatekeeper.processEvents();

        const confirmed = await gatekeeper.resolveDID(alice, { confirm: true });
        expect(confirmed.didDocumentMetadata?.confirmed).toBe(true);
        expect(confirmed.didDocument!.verificationMethod![0].publicKeyJwk).toEqual(k2.publicJwk);

        // The forgery: signed with the retired K1 and dated before the
        // rotation, but committed by the chain in block 300, after it.
        const forged = await forgery(k1, asset, new Date(now).toISOString());
        const anchored = {
            registry: 'BTC:signet',
            time: new Date(now + 2 * hour).toISOString(),
            ordinal: [300, 0],
            registration: { height: 300, index: 0, txid: 'tx300', batch: 'b300' },
            operation: forged,
        };

        await gatekeeper.importBatch([anchored]);
        const result = await gatekeeper.processEvents();

        expect(result).toMatchObject({ added: 0, rejected: 1 });
        expect((await gatekeeper.exportDID(asset)).length).toBe(1);
        expect((await gatekeeper.resolveDID(asset, { confirm: true })).didDocumentData).not.toEqual({ stolen: true });
    });

    // Every operation in a block shares the block's time, so time cannot
    // order a rotation against an operation committed earlier in the same
    // block. The ordinal can. An operation the chain placed before the
    // rotation was authorized by the key current at that point and must not
    // be judged by the rotation that came after it (#1136).
    it('an operation committed earlier in the same block as the rotation is accepted', async () => {
        const now = Date.now();
        const k1 = cipher.generateRandomJwk();
        const alice = await gatekeeper.createDID(await helper.createAgentOp(k1, { registry: 'BTC:signet' }));
        const asset = await gatekeeper.createDID(await helper.createAssetOp(alice, k1, { registry: 'BTC:signet' }));

        // Signed with K1 while K1 is current: a genuine operation.
        const assetDoc = await gatekeeper.resolveDID(asset);
        assetDoc.didDocumentData = { legit: true };
        const genuine = await helper.createUpdateOp(k1, asset, assetDoc);
        genuine.proof!.created = new Date(now).toISOString();

        // Then Alice rotates to K2.
        const k2 = cipher.generateRandomJwk();
        const aliceDoc = await gatekeeper.resolveDID(alice);
        aliceDoc.didDocument!.verificationMethod![0].publicKeyJwk = k2.publicJwk;
        const rotation = await helper.createUpdateOp(k1, alice, aliceDoc);
        rotation.proof!.created = new Date(now + 1000).toISOString();
        expect(await gatekeeper.updateDID(rotation)).toBe(true);

        // The chain commits both in block 200: the genuine operation at
        // index 0, the rotation at index 1. They share the block time.
        const blockTime = new Date(now + hour).toISOString();
        const ops = await gatekeeper.exportDID(alice);
        ops[0].registry = 'BTC:signet';
        ops[0].registration = { height: 100, index: 0, txid: 'tx100', batch: 'b100' };
        ops[1].registry = 'BTC:signet';
        ops[1].registration = { height: 200, index: 1, txid: 'tx200', batch: 'b200' };
        ops[1].time = blockTime;
        ops[1].ordinal = [200, 1];
        await gatekeeper.importBatch(ops);
        await gatekeeper.processEvents();

        const anchored = {
            registry: 'BTC:signet',
            time: blockTime,
            ordinal: [200, 0],
            registration: { height: 200, index: 0, txid: 'tx200', batch: 'b200' },
            operation: genuine,
        };
        await gatekeeper.importBatch([anchored]);
        const result = await gatekeeper.processEvents();

        expect(result).toMatchObject({ added: 1, rejected: 0 });
        expect((await gatekeeper.resolveDID(asset, { confirm: true })).didDocumentData).toEqual({ legit: true });
    });

    // Only the node's own registry mediator may assert that a chain committed
    // an event, and it does so block by block. Anything else -- a peer
    // relaying, an operator restoring an export -- cannot vouch for the chain
    // or for its order, so what it hands in is downgraded to an unconfirmed
    // hint. #1134 passed every test and still forked because nothing imported
    // the same events in a different order; the confirmed verdict must not
    // depend on the order relayed events arrive in.
    it('reaches the same confirmed verdict whichever order relayed events arrive in', async () => {
        async function run(forgeryFirst: boolean) {
            await gatekeeper.resetDb();
            const now = Date.now();
            const { k1, alice, asset } = await rotatedController('BTC:signet', new Date(now).toISOString());

            const ops = await gatekeeper.exportDID(alice);
            const create = { ...ops[0], registry: 'BTC:signet', registration: { height: 100, index: 0, txid: 'tx100', batch: 'b100' } };
            const rotation = { ...ops[1], registry: 'BTC:signet', time: new Date(now + hour).toISOString(), ordinal: [200, 0],
                registration: { height: 200, index: 0, txid: 'tx200', batch: 'b200' } };
            const forged = await forgery(k1, asset, new Date(now).toISOString());
            const forgeryEvent = { registry: 'BTC:signet', time: new Date(now + 2 * hour).toISOString(), ordinal: [300, 0],
                registration: { height: 300, index: 0, txid: 'tx300', batch: 'b300' }, operation: forged };

            // A peer relays both, in whichever order it has them. Neither is
            // trusted as confirmed.
            const relayed = forgeryFirst ? [forgeryEvent, rotation] : [rotation, forgeryEvent];
            for (const event of relayed) {
                await gatekeeper.importRelayedBatch([event]);
                await gatekeeper.processEvents();
            }

            // The node's own mediator then confirms them in the chain's order.
            for (const event of [create, rotation, forgeryEvent]) {
                await gatekeeper.importBatch([event]);
                await gatekeeper.processEvents();
            }

            const confirmed = await gatekeeper.resolveDID(asset, { confirm: true });
            return { data: confirmed.didDocumentData, confirmedEvents: (await gatekeeper.exportDID(asset)).filter(e => e.registry === 'BTC:signet').length };
        }

        const rotationFirst = await run(false);
        const forgeryFirst = await run(true);

        expect(rotationFirst).toEqual({ data: 'mockData', confirmedEvents: 0 });
        expect(forgeryFirst).toEqual(rotationFirst);
    });
});

describe('relayed events cannot assert chain confirmation', () => {
    it('downgrades a relayed chain event to an unconfirmed hint', async () => {
        const now = Date.now();
        const k1 = cipher.generateRandomJwk();
        const alice = await gatekeeper.createDID(await helper.createAgentOp(k1, { registry: 'BTC:signet' }));
        const ops = await gatekeeper.exportDID(alice);
        const claimed = { ...ops[0], registry: 'BTC:signet', time: new Date(now).toISOString(), ordinal: [100, 0],
            registration: { height: 100, index: 0, txid: 'tx100', batch: 'b100' } };

        // Relayed: the claim of confirmation is not honoured.
        await gatekeeper.importRelayedBatch([claimed]);
        await gatekeeper.processEvents();
        const afterRelay = await gatekeeper.exportDID(alice);
        expect(afterRelay[0].registry).toBe('local');
        expect(afterRelay[0].registration).toBeUndefined();

        // From the node's own mediator: it is.
        await gatekeeper.importBatch([claimed]);
        await gatekeeper.processEvents();
        const afterMediator = await gatekeeper.exportDID(alice);
        expect(afterMediator[0].registry).toBe('BTC:signet');
        expect(afterMediator[0].registration).toMatchObject({ height: 100 });
    });
});
