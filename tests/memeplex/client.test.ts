import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import Gatekeeper from '@didcid/gatekeeper';
import Keymaster from '@didcid/keymaster';
import CipherNode from '@didcid/cipher/node';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory';
import WalletJsonMemory from '@didcid/keymaster/wallet/json-memory';
import MemoryClient from '@didcid/ipfs/memory';
import { MemeplexIndex, decodeGrantLink, validateGrantRequest } from '@didcid/memeplex';
import { IndexerClient, MemeplexClient, usable } from '@didcid/memeplex/client';
import type { ClientGatekeeper } from '@didcid/memeplex/client';
import { Sync } from '../../services/memeplex-indexer/src/sync.ts';
import { createIndexerApp } from '../../services/memeplex-indexer/src/api.ts';

// The client library, and with it the whole flow of
// docs/plans/memeplex-reference-1436.md, "Grant request flow": a client asks for
// a grant with a link, a wallet grants it, the client finds the grant and
// publishes, and a reader sees the result through the indexer's HTTP views. The
// Gatekeeper, the Keymasters, the indexer and its server are the real ones; the
// chain is the test, which anchors what is queued as a mediator does.

const REGISTRY = 'BTC:mainnet';
const blockTime = (block: number) => new Date(Date.UTC(2026, 10, 2, 0, block)).toISOString();

let gatekeeper: Gatekeeper;
let wallet: Keymaster;
let userDid: string;
let client: MemeplexClient;
let clientKeymaster: Keymaster;
let index: MemeplexIndex;
let sync: Sync;
let server: Server;
let indexer: IndexerClient;
let block: number;

async function anchor() {
    const operations = await gatekeeper.getQueue(REGISTRY);

    block += 100;
    await gatekeeper.addBlock(REGISTRY, { height: block, hash: `block-${block}`, time: Date.parse(blockTime(block)) / 1000 });
    await gatekeeper.importBatch(operations.map((operation, position) => ({
        registry: REGISTRY,
        time: blockTime(block),
        ordinal: [block, 0, position],
        registration: { height: block, index: 0, txid: `tx-${block}`, batch: `did:cid:batch-${block}`, opidx: position },
        operation,
    })) as never);
    await gatekeeper.processEvents();
    await gatekeeper.clearQueue(REGISTRY, operations);
    await sync.poll();
}

// What a wallet does with a grant link: read the request and create the grant it
// asks for, as the Grants tab does.
async function grantFrom(link: string, keymaster = wallet, more: Record<string, unknown> = {}): Promise<string> {
    const decoded = decodeGrantLink(link);

    if ('error' in decoded) {
        throw new Error(decoded.error);
    }

    const { client: named, actions, nonce, expiresAt } = decoded.request;

    return keymaster.createAsset({
        memeplexGrant: { v: 1, client: named, ...(actions ? { actions } : {}), nonce, ...(expiresAt ? { expiresAt } : {}), ...more },
    }, { registry: REGISTRY });
}

async function keymasterFor(name: string) {
    const made = new Keymaster({ gatekeeper, wallet: new WalletJsonMemory(), cipher: new CipherNode(), passphrase: name });

    await made.loadOrCreateWallet();

    return { keymaster: made, did: await made.createId(name, { registry: 'hyperswarm' }) };
}

beforeEach(async () => {
    block = 0;
    gatekeeper = new Gatekeeper({
        db: new DbJsonMemory('client'), ipfs: new MemoryClient(), registries: ['hyperswarm', REGISTRY],
        console: { log: () => undefined, error: () => undefined, time: () => undefined, timeEnd: () => undefined } as never,
    });
    ({ keymaster: wallet, did: userDid } = await keymasterFor('alice'));
    ({ keymaster: clientKeymaster } = await keymasterFor('memepool'));

    const reading: ClientGatekeeper = {
        queryDocs: where => gatekeeper.queryDocs(where),
        resolveVersions: async dids => JSON.parse(JSON.stringify(await gatekeeper.resolveVersions(dids))),
    };

    client = new MemeplexClient({ keymaster: clientKeymaster, gatekeeper: reading, identity: 'memepool' });

    index = new MemeplexIndex();
    sync = new Sync({
        index,
        gatekeeper: {
            getDIDs: () => gatekeeper.getDIDs() as Promise<string[]>,
            listChanges: options => gatekeeper.listChanges(options),
            resolveVersions: reading.resolveVersions,
        },
    });
    await sync.poll();

    const app = createIndexerApp({ index, status: () => ({ ready: true, ...index.size }), version: { version: 'test', commit: 'test' } });

    server = await new Promise<Server>(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    indexer = new IndexerClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
});

afterEach(async () => {
    await new Promise(resolve => server.close(resolve));
});

it('asks for a grant with a link that carries a valid request with a nonce of its own', async () => {
    const first = await client.requestGrant({ name: 'Memepool', actions: ['memeplex:post', 'memeplex:reply'] });
    const second = await client.requestGrant({ name: 'Memepool' });

    expect(first.request).toStrictEqual({
        v: 1, client: await client.did(), name: 'Memepool', actions: ['memeplex:post', 'memeplex:reply'], nonce: first.request.nonce,
    });
    expect(validateGrantRequest(first.request)).toBe('valid');
    expect(first.request.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(second.request.nonce).not.toBe(first.request.nonce);
    expect(decodeGrantLink(first.link)).toStrictEqual({ request: first.request });

    // A Gatekeeper as it is, with no adapter, is what the client reads from.
    const direct = new MemeplexClient({ keymaster: clientKeymaster, gatekeeper, identity: 'memepool' });
    expect(await direct.did()).toBe(first.request.client);
});

it('carries a user from a grant link to a thread a reader sees', async () => {
    const { request, link } = await client.requestGrant({ name: 'Memepool' });

    expect(await client.findGrants(request)).toStrictEqual([]);

    const grantDid = await grantFrom(link);

    // Created, and not yet anchored: found, and not to be published under.
    let found = await client.findGrants(request);
    expect(found).toMatchObject([{ did: grantDid, grant: { status: 'pending', user: userDid } }]);
    expect(usable(found)).toBeUndefined();

    await anchor();
    found = await client.findGrants(request);
    const grant = usable(found)!;
    expect(grant).toStrictEqual({ did: grantDid, user: userDid, registry: REGISTRY });

    const post = await client.publish(grant, { kind: 'post', text: 'Every post is a DID.' });
    expect((await client.publication(post, grant.did)).state).toBe('pending');
    expect(await indexer.publication(post)).toBeUndefined();

    await anchor();
    const published = await client.publication(post, grant.did);
    expect(published).toMatchObject({ state: 'published', memeplex: { kind: 'post', author: userDid, text: 'Every post is a DID.' } });
    expect(await indexer.publication(post)).toEqual(JSON.parse(JSON.stringify(published)));

    const reply = await client.publish(grant, {
        kind: 'reply', target: post, targetVersion: published.versions[0].opid, text: 'And so is every reply.',
    });
    await anchor();

    expect(await indexer.ready()).toBe(true);
    expect((await indexer.thread(post)).map(each => [each.publication.did, each.depth])).toStrictEqual([[reply, 1]]);
    const timeline = await indexer.timeline([userDid]);
    expect(timeline.total).toBe(2);
    expect(timeline.publications.map(each => each.did)).toStrictEqual([reply, post]);
    expect((await indexer.timeline([userDid], { limit: 1, offset: 1 })).publications.map(each => each.did)).toStrictEqual([post]);

    await client.edit(post, grant, { kind: 'post', text: 'Every post is a DID, and so is every reply.' });
    await anchor();
    expect(await indexer.publication(post)).toMatchObject({ state: 'published', current: 1, memeplex: { text: 'Every post is a DID, and so is every reply.' } });

    await client.withdraw(reply);
    await anchor();
    expect(await indexer.publication(reply)).toMatchObject({ state: 'withdrawn' });
    expect((await indexer.timeline([userDid])).publications.map(each => each.did)).toStrictEqual([post]);
}, 120_000);

it('publishes nothing that counts once the user has revoked the grant', async () => {
    const { request, link } = await client.requestGrant({ name: 'Memepool' });
    const grantDid = await grantFrom(link);
    await anchor();
    const grant = usable(await client.findGrants(request))!;

    const before = await client.publish(grant, { kind: 'post', text: 'Before.' });
    await anchor();
    expect(await wallet.revokeDID(grantDid)).toBe(true);
    await anchor();

    expect(usable(await client.findGrants(request))).toBeUndefined();

    const after = await client.publish(grant, { kind: 'post', text: 'After.' });
    await anchor();

    expect(await indexer.publication(before)).toMatchObject({ state: 'published' });
    expect(await indexer.publication(after)).toBeUndefined();
    expect((await client.publication(after, grantDid)).state).toBe('none');
}, 120_000);

it('finds each grant made from a request, and takes none as its own when there are two', async () => {
    const { request, link } = await client.requestGrant({ name: 'Memepool' });
    const { keymaster: other, did: otherDid } = await keymasterFor('mallory');

    const grantDid = await grantFrom(link);
    const otherGrant = await grantFrom(link, other);
    // A grant to this client from another request.
    await wallet.createAsset({ memeplexGrant: { v: 1, client: request.client, nonce: 'YW5vdGhlciByZXF1ZXN0IG5vbmNl' } }, { registry: REGISTRY });
    await anchor();

    const found = await client.findGrants(request);

    expect(found.map(each => [each.did, each.grant.status === 'valid' && each.grant.user]).sort())
        .toStrictEqual([[grantDid, userDid], [otherGrant, otherDid]].sort());
    expect(usable(found)).toBeUndefined();
    expect(usable(found.filter(each => each.grant.status === 'valid' && each.grant.user === userDid)))
        .toStrictEqual({ did: grantDid, user: userDid, registry: REGISTRY });
}, 120_000);

it('refuses to publish what is not a valid object, and what the grant does not allow is not attributed', async () => {
    const { request, link } = await client.requestGrant({ name: 'Memepool', actions: ['memeplex:post'] });
    await grantFrom(link);
    await anchor();
    const grant = usable(await client.findGrants(request))!;

    await expect(client.publish(grant, { kind: 'post' })).rejects.toThrow('not a valid post: schema');
    await expect(client.publish(grant, { kind: 'essay', text: 'x' })).rejects.toThrow('not a valid essay: kind');

    const post = await client.publish(grant, { kind: 'post', text: 'Allowed.' });
    await anchor();
    const reply = await client.publish(grant, {
        kind: 'reply', target: post, targetVersion: (await client.publication(post, grant.did)).versions[0].opid, text: 'Not allowed.',
    });
    await anchor();

    expect(await indexer.publication(post)).toMatchObject({ state: 'published' });
    expect(await indexer.publication(reply)).toBeUndefined();
}, 120_000);

it('states the grant\'s user and DID in what it publishes, whatever it is handed', async () => {
    const { request, link } = await client.requestGrant({ name: 'Memepool' });
    await grantFrom(link);
    await anchor();
    const grant = usable(await client.findGrants(request))!;

    const post = await client.publish(grant, { kind: 'post', text: 'Mine.', author: 'did:cid:someoneelse', grant: 'did:cid:another', v: 7 });
    await anchor();

    expect(await indexer.publication(post)).toMatchObject({ state: 'published', memeplex: { v: 1, author: userDid, grant: grant.did } });
}, 120_000);

it('tells a missing publication from an indexer that is failing or is not one', async () => {
    const failing = new IndexerClient('http://indexer.invalid', async () => new Response('{}', { status: 503 }));
    const absent = new IndexerClient('http://indexer.invalid', async () => new Response('{}', { status: 404 }));

    await expect(failing.publication('did:cid:any')).rejects.toThrow('the indexer answered 503');
    expect(await indexer.publication('did:cid:bagaaieranothing')).toBeUndefined();
    await expect(absent.ready()).rejects.toThrow('the indexer answered 404');
    await expect(absent.timeline(['did:cid:any'])).rejects.toThrow('the indexer answered 404');
    await expect(absent.thread('did:cid:any')).rejects.toThrow('the indexer answered 404');
});

it('refuses an edit that would change what an object is', async () => {
    const { request, link } = await client.requestGrant({ name: 'Memepool' });
    await grantFrom(link);
    await anchor();
    const grant = usable(await client.findGrants(request))!;
    const post = await client.publish(grant, { kind: 'post', text: 'First.' });
    const other = await client.publish(grant, { kind: 'post', text: 'Second.' });
    await anchor();
    const targetVersion = (await client.publication(post, grant.did)).versions[0].opid;
    const reply = await client.publish(grant, { kind: 'reply', target: post, targetVersion, text: 'A reply.' });
    await anchor();

    await expect(client.edit(reply, grant, { kind: 'reply', target: other, targetVersion, text: 'Moved.' })).rejects.toThrow('cannot change an object\'s target');
    await expect(client.edit(post, grant, { kind: 'reply', target: other, targetVersion, text: 'Now a reply.' })).rejects.toThrow('cannot change an object\'s kind');
    await expect(client.edit(post, { ...grant, did: other }, { kind: 'post', text: 'Another grant.' })).rejects.toThrow('cannot change an object\'s grant');
    await expect(client.edit(grant.did, grant, { kind: 'post', text: 'Not an object.' })).rejects.toThrow('is not a published object');

    await client.edit(reply, grant, { kind: 'reply', target: post, targetVersion, text: 'A better reply.' });
    await anchor();
    expect(await indexer.publication(reply)).toMatchObject({ state: 'published', current: 1, memeplex: { text: 'A better reply.' } });
}, 120_000);

it('does not take an expired grant as one to publish under', async () => {
    const { request, link } = await client.requestGrant({ name: 'Memepool', expiresAt: '2027-01-01T00:00:00Z' });
    await grantFrom(link);
    await anchor();
    const found = await client.findGrants(request);

    expect(usable(found, new Date('2026-12-31T23:59:59Z'))).toBeDefined();
    expect(usable(found, new Date('2027-01-01T00:00:00Z'))).toBeUndefined();
}, 120_000);
