import express from 'express';
import request from 'supertest';
import CipherNode from '@didcid/cipher/node';
import Gatekeeper from '@didcid/gatekeeper';
import ChangeLog from '../../packages/gatekeeper/src/change-log.ts';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory.ts';
import MemoryClient from '@didcid/ipfs/memory';
import type { ListChangesOptions } from '@didcid/gatekeeper/types';
import TestHelper, { anchorEvent } from './helper.ts';
import { createV1Router } from '../../services/gatekeeper/server/src/v1-router.ts';
import defaultConfig from '../../services/gatekeeper/server/src/config.js';

// The events feed is ordered by event time, which follows a block or a signer
// and not arrival, so a reader could not ask it what was new (#1689). The change
// feed numbers each change to an accepted history as this node makes it.

const mockConsole = {
    log: (): void => { },
    error: (): void => { },
    time: (): void => { },
    timeEnd: (): void => { },
} as unknown as typeof console;

const cipher = new CipherNode();
const ipfs = new MemoryClient();
let db: DbJsonMemory;
let gatekeeper: Gatekeeper;
let helper: TestHelper;

function createGatekeeper(): Gatekeeper {
    return new Gatekeeper({ db, ipfs, console: mockConsole, registries: ['local', 'hyperswarm', 'BTC:signet'] });
}

beforeAll(async () => {
    await ipfs.start();
});

afterAll(async () => {
    await ipfs.stop();
});

beforeEach(async () => {
    db = new DbJsonMemory('test');
    gatekeeper = createGatekeeper();
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

// Follows the feed from a sequence to its end, as a reader does.
async function follow(since: number, limit = 1000) {
    const dids: string[] = [];
    let cursor = since;

    for (;;) {
        const page = await gatekeeper.listChanges({ since: cursor, limit });

        for (const change of page.changes) {
            expect(change.sequence).toBeGreaterThan(cursor);
            cursor = change.sequence;
            dids.push(change.did);
        }
        if (page.changes.length < limit) {
            return { dids, cursor, epoch: page.epoch, sequence: page.sequence };
        }
    }
}

describe('ChangeLog', () => {
    it('lists each key once, at its latest change, oldest first', () => {
        const log = new ChangeLog();

        for (const key of ['a', 'b', 'a', 'c', 'b', 'a']) log.record(key);

        expect(log.since(0, 10)).toMatchObject({ sequence: 6, changes: [{ key: 'c', sequence: 4 }, { key: 'b', sequence: 5 }, { key: 'a', sequence: 6 }] });
        expect(log.since(4, 10).changes).toStrictEqual([{ key: 'b', sequence: 5 }, { key: 'a', sequence: 6 }]);
        expect(log.since(6, 10).changes).toStrictEqual([]);
        expect(log.since(99, 10).changes).toStrictEqual([]);
    });

    it('pages by limit, and gives only where it stands when asked for no sequence', () => {
        const log = new ChangeLog();

        for (const key of ['a', 'b', 'c']) log.record(key);

        expect(log.since(0, 2).changes.map(change => change.key)).toStrictEqual(['a', 'b']);
        expect(log.since(2, 2).changes.map(change => change.key)).toStrictEqual(['c']);
        expect(log.since(undefined, 2)).toMatchObject({ sequence: 3, changes: [] });
    });

    it('starts a new epoch from zero when reset', () => {
        const log = new ChangeLog();

        log.record('a');
        const before = log.since(0, 10);
        log.reset();
        const after = log.since(0, 10);

        expect(after.epoch).not.toBe(before.epoch);
        expect(after).toMatchObject({ sequence: 0, changes: [] });
    });

    it('answers the same after many changes to few keys as a log that kept them all', () => {
        const log = new ChangeLog();
        const latest = new Map<string, number>();

        // Enough repeats to have the log drop its superseded entries many times.
        for (let n = 1; n <= 20_000; n++) {
            const key = `key-${(n * 7919) % 13}`;

            log.record(key);
            latest.set(key, n);
        }

        const expected = [...latest].map(([key, sequence]) => ({ key, sequence })).sort((a, b) => a.sequence - b.sequence);

        expect(log.since(0, 1000).changes).toStrictEqual(expected);
        expect(log.since(expected[5].sequence, 1000).changes).toStrictEqual(expected.slice(6));
    });
});

describe('listChanges', () => {
    it('reports no changes and a sequence of zero on an empty node', async () => {
        const result = await gatekeeper.listChanges({ since: 0 });

        expect(result).toMatchObject({ sequence: 0, changes: [] });
        expect(typeof result.epoch).toBe('string');
        expect(result.epoch).not.toBe('');
    });

    it('lists a DID when it is created and again when it is updated, in the order changed', async () => {
        const first = await createAgent();
        const second = await createAgent();
        const mark = (await gatekeeper.listChanges()).sequence;

        expect((await follow(0)).dids).toStrictEqual([first.did, second.did]);

        await update(first.did, first.keypair, { n: 1 });

        expect((await follow(0)).dids).toStrictEqual([second.did, first.did]);
        expect((await follow(mark)).dids).toStrictEqual([first.did]);
        expect((await follow((await gatekeeper.listChanges()).sequence)).dids).toStrictEqual([]);
    });

    it('returns no changes without a sequence, only where the node stands', async () => {
        await createAgent();
        const head = await gatekeeper.listChanges();

        expect(head.changes).toStrictEqual([]);
        expect(head.sequence).toBeGreaterThan(0);
        expect(head.epoch).toBe((await gatekeeper.listChanges({ since: 0 })).epoch);
    });

    it('pages through many changes without missing or repeating a DID', async () => {
        const dids = [];
        for (let n = 0; n < 7; n++) dids.push((await createAgent()).did);

        const read = await follow(0, 3);

        expect(read.dids).toStrictEqual(dids);
        expect(read.cursor).toBe(read.sequence);
    });

    // What the events feed could not show: an anchor carries its block's time,
    // which sorts it among old events, yet it is the newest thing to happen.
    it('lists a DID when an event of its history is anchored, whatever the anchor\'s time', async () => {
        const { did } = await createAgent('BTC:signet');
        const other = await createAgent();
        const mark = (await gatekeeper.listChanges()).sequence;

        const ops = await gatekeeper.exportBatch([did]);
        for (const op of ops) {
            anchorEvent(op, 'BTC:signet', 0);
            op.time = '2020-01-01T00:00:00.000Z';
        }
        await gatekeeper.importBatch(ops);
        await gatekeeper.processEvents();

        expect((await gatekeeper.listEvents()).events[0].did).toBe(other.did);
        expect((await follow(mark)).dids).toStrictEqual([did]);
    });

    it('lists a removed DID as a change', async () => {
        const { did } = await createAgent();
        const mark = (await gatekeeper.listChanges()).sequence;

        await gatekeeper.removeDIDs([did]);

        expect((await follow(mark)).dids).toStrictEqual([did]);
        expect(await gatekeeper.exportDIDs([did])).toStrictEqual([[]]);
    });

    it('begins a new epoch on reset and on restart', async () => {
        await createAgent();
        const first = await gatekeeper.listChanges({ since: 0 });

        await gatekeeper.resetDb();
        const reset = await gatekeeper.listChanges({ since: 0 });
        expect(reset.epoch).not.toBe(first.epoch);
        expect(reset).toMatchObject({ sequence: 0, changes: [] });

        const { did } = await createAgent();
        gatekeeper = createGatekeeper();
        helper = new TestHelper(gatekeeper, cipher);
        const restarted = await gatekeeper.listChanges({ since: 0 });

        // What was there before the restart is not a change: a reader that sees
        // the new epoch reads everything again by other means.
        expect(restarted.epoch).not.toBe(reset.epoch);
        expect(restarted).toMatchObject({ sequence: 0, changes: [] });
        expect(await gatekeeper.getDIDs()).toStrictEqual([did]);
    });

    it('rejects invalid parameters', async () => {
        const invalid: [ListChangesOptions, string][] = [
            [{ since: -1 }, 'since'],
            [{ since: 1.5 }, 'since'],
            [{ since: NaN }, 'since'],
            [{ since: Number.MAX_SAFE_INTEGER + 1 }, 'since'],
            [{ limit: 0 }, 'limit'],
            [{ limit: 1001 }, 'limit'],
            [{ limit: NaN }, 'limit'],
        ];

        for (const [options, field] of invalid) {
            await expect(gatekeeper.listChanges(options)).rejects.toThrow(`Invalid parameter: ${field}`);
        }
    });

    it('is served over HTTP, with 400 for a parameter that is not plain digits or is repeated', async () => {
        const app = express();
        app.use('/api/v1', createV1Router({
            gatekeeper,
            config: { ...defaultConfig, adminApiKey: 'test-admin-key', fallbackURL: '', confirmFallbackURL: '' } as any,
            logger: { error: () => { } } as any,
            isReady: () => true,
            getStatus: async () => ({}),
        } as any));
        const { did } = await createAgent();

        const head = await request(app).get('/api/v1/changes');
        expect(head.status).toBe(200);
        expect(head.body.changes).toStrictEqual([]);

        const listed = await request(app).get('/api/v1/changes?since=0&limit=10');
        expect(listed.status).toBe(200);
        expect(listed.body).toMatchObject({ epoch: head.body.epoch, sequence: head.body.sequence, changes: [{ did }] });

        for (const query of ['since=-1', 'since=1e1', 'since=1&since=2', 'since=', 'limit=0', 'limit=1001', 'limit=ten']) {
            const response = await request(app).get(`/api/v1/changes?${query}`);
            expect([query, response.status]).toStrictEqual([query, 400]);
            expect(response.body.error).toMatch(/^Invalid parameter: (since|limit)$/);
        }
    });
});
