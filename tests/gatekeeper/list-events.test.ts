import express from 'express';
import request from 'supertest';
import CipherNode from '@didcid/cipher/node';
import Gatekeeper from '@didcid/gatekeeper';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory.ts';
import MemoryClient from '@didcid/ipfs/memory';
import type { GatekeeperEvent, ListEventsOptions } from '@didcid/gatekeeper/types';
import TestHelper, { anchorEvent } from './helper.ts';
import { createV1Router } from '../../services/gatekeeper/server/src/v1-router.ts';
import defaultConfig from '../../services/gatekeeper/server/src/config.js';

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

// What listEvents must return, computed from the stored histories directly.
async function expected(options: ListEventsOptions = {}) {
    const { after, before, registry, limit = 50, offset = 0 } = options;
    const dids = await gatekeeper.getDIDs() as string[];
    const exported = await gatekeeper.exportDIDs(dids);
    const all = exported.flatMap((events, i) => events.map((event, position) =>
        ({ event: { ...event, did: event.did ?? dids[i] }, key: dids[i].split(':').pop()!, position })))
        .filter(({ event }) => (after === undefined || Date.parse(event.time) > Date.parse(after))
            && (before === undefined || Date.parse(event.time) < Date.parse(before))
            && (registry === undefined || event.registry === registry))
        .sort((a, b) => Date.parse(b.event.time) - Date.parse(a.event.time)
            || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
            || b.position - a.position);
    return { total: all.length, events: all.slice(offset, offset + limit).map(({ event }) => event) };
}

async function createAgent(registry = 'local'): Promise<string> {
    const keypair = cipher.generateRandomJwk();
    return gatekeeper.createDID(await helper.createAgentOp(keypair, { registry }));
}

async function createAgentWithUpdates(updates: number, registry = 'local') {
    const keypair = cipher.generateRandomJwk();
    const did = await gatekeeper.createDID(await helper.createAgentOp(keypair, { registry }));
    for (let i = 0; i < updates; i++) {
        const doc = await gatekeeper.resolveDID(did);
        doc.didDocumentData = { update: i };
        await gatekeeper.updateDID(await helper.createUpdateOp(keypair, did, doc));
    }
    return { did, keypair };
}

describe('listEvents', () => {
    it('returns accepted events across DIDs, newest first, with their DIDs', async () => {
        await createAgentWithUpdates(2);
        await createAgentWithUpdates(1, 'hyperswarm');
        await createAgent();

        const result = await gatekeeper.listEvents();

        expect(result.total).toBe(6);
        expect(result).toStrictEqual(await expected());
        for (const event of result.events) expect(event.did).toMatch(/^did:cid:/);
    });

    it('pages with limit and offset while reporting the full total', async () => {
        await createAgentWithUpdates(3);
        await createAgentWithUpdates(2);

        const first = await gatekeeper.listEvents({ limit: 4 });
        const second = await gatekeeper.listEvents({ limit: 4, offset: 4 });

        expect(first).toStrictEqual(await expected({ limit: 4 }));
        expect(second).toStrictEqual(await expected({ limit: 4, offset: 4 }));
        expect(first.total).toBe(7);
        expect(second.events).toHaveLength(3);
    });

    it('filters by registry and by exclusive time bounds', async () => {
        await createAgentWithUpdates(2);
        await createAgentWithUpdates(2, 'hyperswarm');

        const all = await gatekeeper.listEvents();
        const middle = all.events[2].time;

        for (const options of [
            { registry: 'hyperswarm' },
            { registry: 'BTC:signet' },
            { after: middle },
            { before: middle },
            { after: all.events[5].time, before: all.events[0].time },
        ]) {
            expect(await gatekeeper.listEvents(options)).toStrictEqual(await expected(options));
        }
        expect((await gatekeeper.listEvents({ after: middle })).events.map(event => event.time)).not.toContain(middle);
    });

    it('follows a confirmation that replaces an event registry and time', async () => {
        const { did } = await createAgentWithUpdates(1, 'BTC:signet');
        expect((await gatekeeper.listEvents({ registry: 'BTC:signet' })).total).toBe(0);

        const ops = await gatekeeper.exportDID(did);
        let timestamp = Date.now();
        for (const op of ops) {
            anchorEvent(op, 'BTC:signet', timestamp);
            timestamp += 3600000;
            op.time = new Date(timestamp).toISOString();
        }
        await gatekeeper.importBatch(ops);
        await gatekeeper.processEvents();

        const confirmed = await gatekeeper.listEvents({ registry: 'BTC:signet' });
        expect(confirmed.total).toBe(2);
        expect(await gatekeeper.listEvents()).toStrictEqual(await expected());
    });

    it('drops removed DIDs and empties on reset', async () => {
        const { did } = await createAgentWithUpdates(1);
        await createAgent();

        await gatekeeper.removeDIDs([did]);
        const afterRemove = await gatekeeper.listEvents();
        expect(afterRemove.total).toBe(1);
        expect(afterRemove).toStrictEqual(await expected());

        await gatekeeper.resetDb();
        expect(await gatekeeper.listEvents()).toStrictEqual({ total: 0, events: [] });

        await createAgent();
        expect((await gatekeeper.listEvents()).total).toBe(1);
    });

    it('rebuilds from stored histories on restart', async () => {
        await createAgentWithUpdates(2);
        await createAgentWithUpdates(1, 'hyperswarm');
        const before = await gatekeeper.listEvents();

        gatekeeper = createGatekeeper();
        helper = new TestHelper(gatekeeper, cipher);

        expect(await gatekeeper.listEvents()).toStrictEqual(before);
        await createAgent();
        expect(await gatekeeper.listEvents()).toStrictEqual(await expected());
    });

    it('rejects invalid parameters', async () => {
        const invalid: [ListEventsOptions, string][] = [
            [{ after: 'yesterday' }, 'after'],
            [{ before: 'not a time' }, 'before'],
            // Date accepts these; the RFC 3339 grammar both ports share does not.
            [{ after: '2026-01-01' }, 'after'],
            [{ after: '2026-02-30T00:00:00Z' }, 'after'],
            [{ before: '2026-01-01T24:00:00Z' }, 'before'],
            [{ registry: '' }, 'registry'],
            [{ limit: 0 }, 'limit'],
            [{ limit: 1001 }, 'limit'],
            [{ limit: 2.5 }, 'limit'],
            [{ offset: -1 }, 'offset'],
        ];
        for (const [options, field] of invalid) {
            await expect(gatekeeper.listEvents(options)).rejects.toThrow(`Invalid parameter: ${field}`);
        }
    });

    it('returns stored event records unchanged apart from the DID', async () => {
        const { did } = await createAgentWithUpdates(1);
        const stored = await gatekeeper.exportDID(did);

        const listed = (await gatekeeper.listEvents()).events.reverse();

        expect(listed).toStrictEqual(stored.map((event: GatekeeperEvent) => ({ ...event, did })));
    });
});

describe('GET /api/v1/events', () => {
    function app() {
        const server = express();
        server.use('/api/v1', createV1Router({
            gatekeeper,
            config: { ...defaultConfig, adminApiKey: 'test-admin-key', fallbackURL: '', confirmFallbackURL: '' } as any,
            logger: { error: () => { } } as any,
            isReady: () => true,
            getStatus: async () => ({}),
        } as any));
        return server;
    }

    it('passes query parameters through and returns the page', async () => {
        await createAgentWithUpdates(2);
        await createAgentWithUpdates(1, 'hyperswarm');
        const newest = (await gatekeeper.listEvents()).events[0].time;

        const response = await request(app())
            .get('/api/v1/events')
            .query({ registry: 'local', limit: '2', offset: '1', before: newest });

        expect(response.status).toBe(200);
        expect(response.body).toStrictEqual(await expected({ registry: 'local', limit: 2, offset: 1, before: newest }));
    });

    it('answers 400 for invalid or repeated parameters', async () => {
        for (const query of ['limit=abc', 'limit=', 'limit=%205', 'limit=1e1', 'limit=5.0', 'offset=-1', 'offset=9007199254740992',
            'after=yesterday', 'after=2026-01-01', 'limit=1&limit=2', 'registry=', 'registry=local&registry=local']) {
            const response = await request(app()).get(`/api/v1/events?${query}`);
            expect([query, response.status]).toStrictEqual([query, 400]);
            expect(response.body.error).toMatch(/^Invalid parameter/);
        }
    });
});
