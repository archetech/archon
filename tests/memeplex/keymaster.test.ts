import Gatekeeper from '@didcid/gatekeeper';
import Keymaster from '@didcid/keymaster';
import CipherNode from '@didcid/cipher/node';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory';
import WalletJsonMemory from '@didcid/keymaster/wallet/json-memory';
import MemoryClient from '@didcid/ipfs/memory';
import { attribute, authorityAt, readGrant } from '@didcid/memeplex';
import type { AcceptedEvent } from '@didcid/memeplex';

// Milestone 4 of docs/plans/memeplex-reference-1436.md: a user and a client
// publish with the asset commands a Keymaster already has, and the verifier reads
// the result. The other Memeplex fixtures are signed by hand; these operations are
// the ones a Keymaster writes. `mergeData` and `transferAsset` send the one
// component they change, and `updateDID` sends whatever document it is given.

const REGISTRY = 'BTC:mainnet';
const blockTime = (block: number) => new Date(Date.UTC(2026, 10, 2, 0, block)).toISOString();

let gatekeeper: Gatekeeper;
let user: Keymaster;
let client: Keymaster;
let userDid: string;
let clientDid: string;

// What a mediator does: take the operations queued for the chain, and return
// them to the Gatekeeper as anchored in a block.
async function anchor(block: number) {
    const operations = await gatekeeper.getQueue(REGISTRY);

    expect(operations.length).toBeGreaterThan(0);
    await gatekeeper.importBatch(operations.map((operation, index) => ({
        registry: REGISTRY,
        time: blockTime(block),
        ordinal: [block, 0, index],
        registration: { height: block, index: 0, txid: `tx-${block}`, batch: `did:cid:batch-${block}`, opidx: index },
        operation,
    })) as never);
    await gatekeeper.processEvents();
    await gatekeeper.clearQueue(REGISTRY, operations);
}

const history = async (did: string) => JSON.parse(JSON.stringify(await gatekeeper.exportDID(did))) as AcceptedEvent[];
const publication = async (object: string, grant: string) => attribute(await history(object), await history(grant));

beforeEach(async () => {
    const ipfs = new MemoryClient();
    gatekeeper = new Gatekeeper({
        db: new DbJsonMemory('memeplex'), ipfs, registries: ['hyperswarm', REGISTRY],
        console: { log: () => undefined, error: () => undefined, time: () => undefined, timeEnd: () => undefined } as never,
    });
    const keymaster = async (name: string) => {
        const made = new Keymaster({ gatekeeper, wallet: new WalletJsonMemory(), cipher: new CipherNode(), passphrase: name });
        await made.loadOrCreateWallet();
        return { keymaster: made, did: await made.createId(name, { registry: 'hyperswarm' }) };
    };

    ({ keymaster: user, did: userDid } = await keymaster('alice'));
    ({ keymaster: client, did: clientDid } = await keymaster('memepool'));
});

it('publishes, edits and withdraws under a grant, with a Keymaster\'s own operations', async () => {
    const grant = await user.createAsset({ memeplexGrant: { v: 1, client: clientDid, nonce: 'Qm9vdHN0cmFwIG5vbmNlMTIz' } }, { registry: REGISTRY });
    await anchor(100);

    const post = { v: 1, kind: 'post', author: userDid, grant, text: 'Every post is a DID.' };
    const object = await client.createAsset({ memeplex: post }, { registry: REGISTRY });

    expect((await publication(object, grant)).state).toBe('pending');
    await anchor(200);
    expect(await publication(object, grant)).toMatchObject({ state: 'published', current: 0, did: object, memeplex: post });

    const edited = { ...post, text: 'Every post is a DID, and so is every reply.' };
    expect(await client.mergeData(object, { memeplex: edited })).toBe(true);
    await anchor(300);
    expect(await publication(object, grant)).toMatchObject({ state: 'published', current: 1, memeplex: edited });

    expect(await client.revokeDID(object)).toBe(true);
    await anchor(400);
    expect(await publication(object, grant)).toMatchObject({ state: 'withdrawn', current: 2, memeplex: edited });
}, 60_000);

it('reads a Keymaster\'s update of a grant as a scope update, and its revocation as the end', async () => {
    const scope = { v: 1, client: clientDid, nonce: 'Qm9vdHN0cmFwIG5vbmNlMTIz' };
    const grant = await user.createAsset({ memeplexGrant: scope }, { registry: REGISTRY });
    await anchor(100);

    const post = await client.createAsset({ memeplex: { v: 1, kind: 'post', author: userDid, grant, text: 'First.' } }, { registry: REGISTRY });
    await anchor(200);

    expect(await user.mergeData(grant, { memeplexGrant: { ...scope, actions: ['memeplex:tag'] } })).toBe(true);
    await anchor(300);

    const read = readGrant(await history(grant));
    expect(read).toMatchObject({ status: 'valid', user: userDid, client: clientDid, registry: REGISTRY, pending: 0 });
    expect(read.status === 'valid' && read.ended).toBeUndefined();
    expect(read.status === 'valid' && read.versions.map(version => version.actions)).toStrictEqual([undefined, ['memeplex:tag']]);

    // The grant no longer permits a post, and still covers the one it permitted.
    const late = await client.createAsset({ memeplex: { v: 1, kind: 'post', author: userDid, grant, text: 'Late.' } }, { registry: REGISTRY });
    expect(await client.mergeData(post, { memeplex: { v: 1, kind: 'post', author: userDid, grant, text: 'First, edited.' } })).toBe(true);
    await anchor(400);
    expect((await publication(late, grant)).versions[0]).toMatchObject({ outcome: 'unattributed', reason: 'authority', authority: 'scope' });
    expect(await publication(post, grant)).toMatchObject({ state: 'published', current: 1 });

    expect(await user.revokeDID(grant)).toBe(true);
    await anchor(500);
    const ended = readGrant(await history(grant));
    expect(ended.status === 'valid' && ended.ended).toStrictEqual({ block: 500, time: blockTime(500) });
    expect(ended.status === 'valid' && authorityAt(ended, { block: 499, time: blockTime(499) })).toBe('permitted');

    // A deletion after the revocation withdraws nothing.
    expect(await client.revokeDID(post)).toBe(true);
    await anchor(600);
    const after = await publication(post, grant);
    expect(after).toMatchObject({ state: 'published', current: 1 });
    expect(after.versions[2]).toMatchObject({ outcome: 'unattributed', reason: 'authority', authority: 'after-end' });
}, 60_000);

// What the command line's update does: resolve the document, change it, and send
// all of it back.
it('reads an update that resends the whole resolved document as a scope update or an edit', async () => {
    const scope = { v: 1, client: clientDid, nonce: 'Qm9vdHN0cmFwIG5vbmNlMTIz' };
    const grant = await user.createAsset({ memeplexGrant: scope }, { registry: REGISTRY });
    await anchor(100);

    const post = { v: 1, kind: 'post', author: userDid, grant, text: 'First.' };
    const object = await client.createAsset({ memeplex: post }, { registry: REGISTRY });
    await anchor(200);

    const grantDoc = await user.resolveDID(grant);
    grantDoc.didDocumentData = { memeplexGrant: { ...scope, actions: ['memeplex:post'] } };
    expect(await user.updateDID(grant, grantDoc)).toBe(true);

    const edited = { ...post, text: 'First, edited.' };
    const objectDoc = await client.resolveDID(object);
    objectDoc.didDocumentData = { memeplex: edited };
    expect(await client.updateDID(object, objectDoc)).toBe(true);
    await anchor(300);

    const sent = (await history(grant))[1].operation.doc;
    expect(Object.keys(sent).sort()).toStrictEqual(['didDocument', 'didDocumentData', 'didDocumentRegistration']);

    const read = readGrant(await history(grant));
    expect(read.status === 'valid' && read.ended).toBeUndefined();
    expect(read.status === 'valid' && read.versions.map(version => version.actions)).toStrictEqual([undefined, ['memeplex:post']]);
    // The edit shares a block with the scope update, so it is not ordered against it.
    expect((await publication(object, grant)).versions[1]).toMatchObject({ outcome: 'unattributed', authority: 'unordered' });
}, 60_000);

it('attributes an edit that resends the whole resolved document', async () => {
    const grant = await user.createAsset({ memeplexGrant: { v: 1, client: clientDid, nonce: 'Qm9vdHN0cmFwIG5vbmNlMTIz' } }, { registry: REGISTRY });
    await anchor(100);

    const post = { v: 1, kind: 'post', author: userDid, grant, text: 'First.' };
    const object = await client.createAsset({ memeplex: post }, { registry: REGISTRY });
    await anchor(200);

    const edited = { ...post, text: 'First, edited.' };
    const doc = await client.resolveDID(object);
    doc.didDocumentData = { memeplex: edited };
    expect(await client.updateDID(object, doc)).toBe(true);
    await anchor(300);

    expect(await publication(object, grant)).toMatchObject({ state: 'published', current: 1, memeplex: edited });
}, 60_000);

it('does not attribute what the user publishes directly, or what a client publishes in another\'s name', async () => {
    const grant = await user.createAsset({ memeplexGrant: { v: 1, client: clientDid, nonce: 'Qm9vdHN0cmFwIG5vbmNlMTIz' } }, { registry: REGISTRY });
    await anchor(100);

    const direct = await user.createAsset({ memeplex: { v: 1, kind: 'post', author: userDid, grant, text: 'Mine.' } }, { registry: REGISTRY });
    const forged = await client.createAsset({ memeplex: { v: 1, kind: 'post', author: clientDid, grant, text: 'Not yours.' } }, { registry: REGISTRY });
    await anchor(200);

    expect((await publication(direct, grant)).versions[0]).toMatchObject({ outcome: 'unattributed', reason: 'publisher' });
    expect((await publication(forged, grant)).versions[0]).toMatchObject({ outcome: 'unattributed', reason: 'author' });
}, 60_000);

it('ends attribution when the client transfers an object', async () => {
    const grant = await user.createAsset({ memeplexGrant: { v: 1, client: clientDid, nonce: 'Qm9vdHN0cmFwIG5vbmNlMTIz' } }, { registry: REGISTRY });
    await anchor(100);

    const object = await client.createAsset({ memeplex: { v: 1, kind: 'post', author: userDid, grant, text: 'First.' } }, { registry: REGISTRY });
    await anchor(200);
    expect(await client.transferAsset(object, userDid)).toBe(true);
    await anchor(300);

    const transferred = await publication(object, grant);
    expect(transferred).toMatchObject({ state: 'published', current: 0 });
    expect(transferred.versions[1]).toMatchObject({ outcome: 'unattributed', reason: 'identity' });
}, 60_000);
