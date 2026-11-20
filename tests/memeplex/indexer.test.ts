import request from 'supertest';
import Gatekeeper from '@didcid/gatekeeper';
import Keymaster from '@didcid/keymaster';
import CipherNode from '@didcid/cipher/node';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory';
import WalletJsonMemory from '@didcid/keymaster/wallet/json-memory';
import MemoryClient from '@didcid/ipfs/memory';
import { MemeplexIndex } from '@didcid/memeplex';
import { Sync } from '../../services/memeplex-indexer/src/sync.ts';
import type { FeedGatekeeper } from '../../services/memeplex-indexer/src/sync.ts';
import { createIndexerApp } from '../../services/memeplex-indexer/src/api.ts';

// The indexer service: docs/plans/memeplex-1436.md, "A graph anyone can
// reconstruct". A user and a client publish through Keymasters to an in-memory
// Gatekeeper, whose own events feed and export the indexer reads.

const REGISTRY = 'BTC:mainnet';
const blockTime = (block: number) => new Date(Date.UTC(2026, 10, 2, 0, block)).toISOString();

let gatekeeper: Gatekeeper;
let user: Keymaster;
let client: Keymaster;
let userDid: string;
let clientDid: string;
let grant: string;

// What a mediator does: return the operations queued for the chain as anchored.
async function anchor(block: number) {
    const operations = await gatekeeper.getQueue(REGISTRY);

    await gatekeeper.importBatch(operations.map((operation, index) => ({
        registry: REGISTRY,
        time: blockTime(block),
        ordinal: [block, 0, index],
        registration: { height: block, index: 0, txid: `tx-${block}`, batch: `did:cid:batch-${block}`, opidx: index },
        operation,
    })) as never);
    await gatekeeper.processEvents();
    await gatekeeper.clearQueue(REGISTRY, operations);
    at(block);
}

// The indexer's clock. Blocks here carry times in the past, so the clock is set
// to the block being anchored, as a node's clock is close to its chain's.
let clock = 0;
const at = (block: number) => { clock = Date.parse(blockTime(block)); };
const syncing = (index: MemeplexIndex, source = feed(), more: Record<string, unknown> = {}) =>
    new Sync({ gatekeeper: source, index, now: () => clock, ...more });

// The Gatekeeper as the indexer reads it, counting what it is asked.
function feed(): FeedGatekeeper & { exported: string[][] } {
    const exported: string[][] = [];

    return {
        exported,
        listEvents: options => gatekeeper.listEvents(options) as never,
        exportDIDs: async dids => {
            exported.push(dids);
            return JSON.parse(JSON.stringify(await gatekeeper.exportDIDs(dids)));
        },
    };
}

const post = (text: string, more: Record<string, unknown> = {}) =>
    client.createAsset({ memeplex: { v: 1, kind: 'post', author: userDid, grant, text, ...more } }, { registry: REGISTRY });

beforeEach(async () => {
    gatekeeper = new Gatekeeper({
        db: new DbJsonMemory('indexer'), ipfs: new MemoryClient(), registries: ['hyperswarm', REGISTRY],
        console: { log: () => undefined, error: () => undefined, time: () => undefined, timeEnd: () => undefined } as never,
    });
    const keymaster = async (name: string) => {
        const made = new Keymaster({ gatekeeper, wallet: new WalletJsonMemory(), cipher: new CipherNode(), passphrase: name });
        await made.loadOrCreateWallet();
        return { keymaster: made, did: await made.createId(name, { registry: 'hyperswarm' }) };
    };

    ({ keymaster: user, did: userDid } = await keymaster('alice'));
    ({ keymaster: client, did: clientDid } = await keymaster('memepool'));
    grant = await user.createAsset({ memeplexGrant: { v: 1, client: clientDid, nonce: 'Qm9vdHN0cmFwIG5vbmNlMTIz' } }, { registry: REGISTRY });
    await anchor(100);
});

describe('Sync', () => {
    it('fills an index from the feed, and keeps only objects and grants', async () => {
        const first = await post('First.');
        await client.createAsset({ note: 'not a Memeplex object' }, { registry: REGISTRY });
        await anchor(200);

        const index = new MemeplexIndex();
        const source = feed();
        const result = await syncing(index, source).poll();

        expect(index.publication(first)).toMatchObject({ state: 'published', did: first });
        expect(index.dids().sort()).toStrictEqual([first, grant].sort());
        // The two agents and the other asset were read from the feed and not exported.
        expect(result.histories).toBe(2);
        expect(result.events).toBeGreaterThan(2);
        expect(source.exported.flat().sort()).toStrictEqual([first, grant].sort());
    }, 60_000);

    it('follows edits, deletions and a revocation by polling', async () => {
        const index = new MemeplexIndex();
        const sync = syncing(index);
        const first = await post('First.');
        await anchor(200);
        const second = await post('Second.');
        await anchor(210);
        await sync.poll();
        expect(index.timeline([userDid]).map(each => each.memeplex!.text)).toStrictEqual(['Second.', 'First.']);

        await client.mergeData(first, { memeplex: { v: 1, kind: 'post', author: userDid, grant, text: 'First, edited.' } });
        await client.revokeDID(second);
        await anchor(300);
        await sync.poll();
        expect(index.timeline([userDid]).map(each => each.memeplex!.text)).toStrictEqual(['First, edited.']);
        expect(index.publication(second)!.state).toBe('withdrawn');

        // The grant ends; a deletion after that withdraws nothing.
        await user.revokeDID(grant);
        await anchor(400);
        await client.revokeDID(first);
        await anchor(500);
        await sync.poll();
        expect(index.publication(first)).toMatchObject({ state: 'published', current: 1 });
    }, 60_000);

    it('reads only what is new after the first poll', async () => {
        const index = new MemeplexIndex();
        const source = feed();
        const sync = syncing(index, source);

        await post('First.');
        await anchor(200);
        await sync.poll();
        source.exported.length = 0;

        const second = await post('Second.');
        await anchor(300);
        const result = await sync.poll();

        expect(source.exported.flat()).toStrictEqual([second]);
        expect(result).toStrictEqual({ events: 1, histories: 1 });
        // The next poll reads the same stretch of the feed and finds nothing new in it.
        source.exported.length = 0;
        expect(await sync.poll()).toStrictEqual({ events: 0, histories: 0 });
        expect(source.exported).toStrictEqual([]);
    }, 60_000);

    it('reads the feed in pages and exports in batches', async () => {
        const dids = [];
        for (let n = 0; n < 7; n++) dids.push(await post(`Post ${n}.`));
        await anchor(200);

        const index = new MemeplexIndex();
        const source = feed();
        await syncing(index, source, { pageSize: 3, exportSize: 4 }).poll();

        expect(index.timeline([userDid]).map(each => each.did).sort()).toStrictEqual([...dids].sort());
        expect(source.exported.map(batch => batch.length)).toStrictEqual([4, 4]);
    }, 60_000);

    // A poll reads a little way back from the previous one. Evidence that
    // arrives carrying a time further back than that is found by reconciling.
    it('finds by reconciling what arrives with a time a poll has passed', async () => {
        const index = new MemeplexIndex();
        const sync = syncing(index);
        const late = await post('Late.');
        const operations = await gatekeeper.getQueue(REGISTRY);
        await gatekeeper.clearQueue(REGISTRY, operations);

        await post('On time.');
        await anchor(300);
        await sync.poll();
        expect(index.publication(late)).toBeUndefined();
        at(310);
        await sync.poll();

        // The earlier post's anchor at block 200 reaches this node only now.
        await gatekeeper.importBatch(operations.map((operation, position) => ({
            registry: REGISTRY, time: blockTime(200), ordinal: [200, 0, position],
            registration: { height: 200, index: 0, txid: 'tx-200', batch: 'did:cid:batch-200', opidx: position }, operation,
        })) as never);
        await gatekeeper.processEvents();

        at(320);
        await sync.poll();
        expect(index.publication(late)).toBeUndefined();

        await sync.reconcile();
        expect(index.publication(late)).toMatchObject({ state: 'published' });
    }, 60_000);

    it('is not blinded by an event dated ahead of the clock', async () => {
        const index = new MemeplexIndex();
        const sync = syncing(index);

        // An anchor claiming a block time a day ahead.
        await post('From the future.');
        const operations = await gatekeeper.getQueue(REGISTRY);
        await gatekeeper.importBatch(operations.map((operation, position) => ({
            registry: REGISTRY, time: blockTime(200 + 24 * 60), ordinal: [200, 0, position],
            registration: { height: 200, index: 0, txid: 'tx-200', batch: 'did:cid:batch-200', opidx: position }, operation,
        })) as never);
        await gatekeeper.processEvents();
        await gatekeeper.clearQueue(REGISTRY, operations);
        at(200);
        await sync.poll();

        const next = await post('After it.');
        await anchor(210);
        await sync.poll();

        expect(index.publication(next)).toMatchObject({ state: 'published' });
    }, 60_000);

    // A pass that could not export is not over: the next one tries the same again.
    it.each(['poll', 'reconcile'] as const)('recovers by a %s from an export that failed', async pass => {
        const index = new MemeplexIndex();
        const source = feed();
        const exportDIDs = source.exportDIDs;
        const sync = syncing(index, source);
        await sync.poll();

        const first = await post('First.');
        await anchor(200);
        source.exportDIDs = async () => { throw new Error('the Gatekeeper is restarting'); };
        await expect(sync[pass]()).rejects.toThrow('restarting');
        expect(index.publication(first)).toBeUndefined();

        source.exportDIDs = exportDIDs;
        await sync[pass]();
        expect(index.publication(first)).toMatchObject({ state: 'published' });
    }, 60_000);

    it('removes by reconciling a history the Gatekeeper no longer has', async () => {
        const index = new MemeplexIndex();
        const sync = syncing(index);
        const first = await post('First.');
        await anchor(200);
        await sync.poll();

        await gatekeeper.removeDIDs([first]);
        await sync.poll();
        expect(index.publication(first)).toMatchObject({ state: 'published' });

        await sync.reconcile();
        expect(index.publication(first)).toBeUndefined();
        expect(index.dids()).toStrictEqual([grant]);
    }, 60_000);

    it('builds from nothing the same index as one kept up to date', async () => {
        const running = new MemeplexIndex();
        const sync = syncing(running);
        const first = await post('First.');
        await anchor(200);
        await sync.poll();
        const reply = await client.createAsset({
            memeplex: { v: 1, kind: 'reply', author: userDid, grant, target: first, targetVersion: running.publication(first)!.versions[0].opid, text: 'Reply.' },
        }, { registry: REGISTRY });
        await anchor(300);
        await sync.poll();
        await client.mergeData(first, { memeplex: { v: 1, kind: 'post', author: userDid, grant, text: 'First, edited.' } });
        await client.revokeDID(reply);
        await anchor(400);
        await sync.poll();
        await user.revokeDID(grant);
        await anchor(500);
        await sync.poll();

        const fresh = new MemeplexIndex();
        await syncing(fresh).reconcile();

        expect(fresh.snapshot()).toStrictEqual(running.snapshot());
        expect(fresh.thread(first)).toStrictEqual(running.thread(first));
        expect(running.snapshot()).toHaveLength(2);
    }, 60_000);
});

describe('the HTTP views', () => {
    const version = { version: '1.2.3', commit: 'abcdef0' };

    async function serving(ready = true) {
        const index = new MemeplexIndex();
        const first = await post('First.');
        await anchor(200);
        await syncing(index).poll();

        const reply = await client.createAsset({
            memeplex: { v: 1, kind: 'reply', author: userDid, grant, target: first, targetVersion: index.publication(first)!.versions[0].opid, text: 'Reply.' },
        }, { registry: REGISTRY });
        const rating = await client.createAsset({
            memeplex: { v: 1, kind: 'rating', author: userDid, grant, target: first, targetVersion: index.publication(first)!.versions[0].opid, rating: 4, min: 1, max: 5 },
        }, { registry: REGISTRY });
        const tag = await client.createAsset({
            memeplex: { v: 1, kind: 'tag', author: userDid, grant, target: first, targetVersion: index.publication(first)!.versions[0].opid, tag: 'archon' },
        }, { registry: REGISTRY });
        await anchor(300);
        await syncing(index).reconcile();

        const status = () => ({ ready, ...index.size });

        return { app: createIndexerApp({ index, status, version }), first, reply, rating, tag };
    }

    it('answers readiness, version and status', async () => {
        const { app } = await serving();

        expect((await request(app).get('/api/v1/ready')).body).toBe(true);
        expect((await request(app).get('/api/v1/version')).body).toStrictEqual(version);
        expect((await request(app).get('/api/v1/status')).body).toStrictEqual({ ready: true, dids: 5, publications: 4 });
    }, 60_000);

    it('serves a publication, and 404 for a DID with none', async () => {
        const { app, first } = await serving();
        const found = await request(app).get(`/api/v1/publications/${first}`);

        expect(found.status).toBe(200);
        expect(found.body).toMatchObject({ state: 'published', did: first, memeplex: { text: 'First.' } });
        expect((await request(app).get(`/api/v1/publications/${grant}`)).status).toBe(404);
        expect((await request(app).get('/api/v1/publications/did:cid:nothing')).status).toBe(404);
    }, 60_000);

    it('serves a timeline in pages', async () => {
        const { app, first, reply } = await serving();
        const all = await request(app).get('/api/v1/timeline').query({ author: userDid });

        expect(all.body.total).toBe(2);
        expect(all.body.publications.map((each: { did: string }) => each.did)).toStrictEqual([reply, first]);

        const page = await request(app).get('/api/v1/timeline').query({ author: [userDid, clientDid], limit: 1, offset: 1 });
        expect(page.body).toMatchObject({ total: 2, publications: [{ did: first }] });
    }, 60_000);

    it.each([
        ['no author', {}],
        ['a limit of zero', { author: 'did:cid:a', limit: 0 }],
        ['a limit too large', { author: 'did:cid:a', limit: 501 }],
        ['a limit that is not a number', { author: 'did:cid:a', limit: 'ten' }],
        ['a negative offset', { author: 'did:cid:a', offset: -1 }],
    ])('refuses a timeline with %s', async (_name, query) => {
        const { app } = await serving();

        expect((await request(app).get('/api/v1/timeline').query(query)).status).toBe(400);
    }, 60_000);

    it('serves the responses to an object', async () => {
        const { app, first, reply, rating } = await serving();

        expect((await request(app).get(`/api/v1/threads/${first}`)).body).toMatchObject([{ depth: 1, publication: { did: reply } }]);
        expect((await request(app).get(`/api/v1/ratings/${first}`)).body).toMatchObject({ mean: 0.75, ratings: [{ did: rating }] });
        expect((await request(app).get(`/api/v1/tags/${first}`)).body).toStrictEqual([{ tag: 'archon', authors: [userDid] }]);
        expect((await request(app).get(`/api/v1/boosts/${first}`)).body).toStrictEqual([]);
        expect((await request(app).get(`/api/v1/coauthors/${first}`)).body).toStrictEqual([]);
        expect((await request(app).get('/api/v1/threads/did:cid:nothing')).body).toStrictEqual([]);
    }, 60_000);

    it('answers no view until the index has read the whole feed', async () => {
        const { app, first } = await serving(false);

        expect((await request(app).get('/api/v1/ready')).body).toBe(false);
        expect((await request(app).get('/api/v1/status')).status).toBe(200);
        for (const path of [`/api/v1/publications/${first}`, `/api/v1/timeline?author=${userDid}`, `/api/v1/threads/${first}`]) {
            expect((await request(app).get(path)).status).toBe(503);
        }
    }, 60_000);
});
