import { jest } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Gatekeeper from '@didcid/gatekeeper';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory.ts';
import DbJson from '@didcid/gatekeeper/db/json.ts';
import DbSqlite from '@didcid/gatekeeper/db/sqlite.ts';
import MemoryClient from '@didcid/ipfs/memory';
import type { GatekeeperEvent } from '@didcid/gatekeeper/types';

type Vector = { gc?: { controller: string; asset: string; base: GatekeeperEvent[] }; registry: string; controller: string; asset: string; child: string; delegation: GatekeeperEvent[]; base: GatekeeperEvent[] } &
    Record<'delegated' | 'deletion' | 'rotation' | 'old' | 'oldNext' | 'fresh' | 'freshNext' | 'early' | 'migration' | 'migrationRotation', GatekeeperEvent>;
const vectors: Vector[] = JSON.parse(readFileSync('tests/gatekeeper/history-recovery-vectors.json', 'utf8'));
const scenarios = ['retired', 'new-key', 'early', 'migration', 'delegation', 'deletion', 'create'] as const;

describe.each([DbJsonMemory, DbJson, DbSqlite])('%s authorization recovery', (Database) => {
    it.each(vectors.flatMap(vector => scenarios.map(scenario => ({ vector, scenario }))))(
        '$vector.registry $scenario converges across arrival orders and restart', async ({ vector, scenario }) => {
            const folder = mkdtempSync(join(tmpdir(), 'archon-history-'));
            let db = new Database('recovery', folder);
            const ipfs = new MemoryClient();
            const options = () => ({ db, ipfs, registries: ['local', 'hyperswarm', 'BTC:signet', 'ETH:sepolia'] });
            let g = new Gatekeeper(options());
            await db.start();
            const base = [...(scenario === 'create' ? vector.base.slice(0, 1) : vector.base), ...(scenario === 'migration' ? [vector.migration] : []), ...(scenario === 'delegation' ? vector.delegation : [])];
            const target = scenario === 'delegation' ? vector.child : vector.asset;
            const rotation = scenario === 'migration' ? vector.migrationRotation : vector.rotation;
            const tail = scenario === 'create' ? [{ ...vector.base[1], time: vector.old.time, ordinal: vector.old.ordinal, registration: vector.old.registration }]
                : scenario === 'delegation' ? [vector.delegated]
                    : scenario === 'deletion' ? [vector.deletion]
                        : scenario === 'retired' ? [vector.old, vector.oldNext]
                            : scenario === 'early' ? [vector.early] : [vector.fresh, vector.freshNext];
            const expected = scenario === 'new-key' ? 'new-key-successor'
                : scenario === 'early' ? 'before-rotation' : 'original';
            async function run(rotationFirst: boolean) {
                await g.resetDb();
                for (const event of base) await g.importEvent(event);
                if (rotationFirst) await g.importEvent(rotation);
                for (const event of tail) await g.importEvent(event);
                await db.stop();
                if (Database !== DbJsonMemory) db = new Database('recovery', folder);
                await db.start();
                g = new Gatekeeper(options());
                if (!rotationFirst) await g.importEvent(rotation);
                if (scenario === 'migration') expect((await g.resolveDID(vector.controller)).didDocumentMetadata?.versionSequence).toBe('3');
                const resolved = await g.resolveDID(target, { confirm: true, verify: true });
                if (scenario === 'create') {
                    expect(resolved.didResolutionMetadata?.error).toBe('notFound');
                    expect(await g.searchDocs('')).not.toContain(target);
                    expect((await db.getCandidates())[target]).toHaveLength(1);
                    return 'notFound';
                }
                expect(resolved.didDocumentData).toBe(expected);
                const events = await g.exportDID(target);
                expect(events).toHaveLength(scenario === 'new-key' ? 3 : scenario === 'early' ? 2 : 1);
                expect((await db.getCandidates())[target]).toHaveLength(tail.length + (scenario === 'delegation' ? 2 : 1));
                return resolved.didDocumentMetadata?.versionId;
            }
            try {
                expect(await run(false)).toBe(await run(true));
            } finally {
                await db.stop();
                rmSync(folder, { recursive: true, force: true });
            }
        });
});

it('recovers an interrupted projection and keeps explicit removals removed', async () => {
    const vector = vectors[0];
    const db = new DbJsonMemory('recovery');
    const options = { db, ipfs: new MemoryClient() };
    let g = new Gatekeeper(options);
    for (const event of [...vector.base, vector.old, vector.oldNext]) await g.importEvent(event);
    // Simulate a crash after journaling a rotation but before publishing either
    // the controller or dependent asset projection.
    const journal = await db.getCandidates();
    await db.setCandidates(vector.controller, [...journal[vector.controller], vector.rotation]);
    g = new Gatekeeper(options);
    expect((await g.resolveDID(vector.asset, { confirm: true })).didDocumentData).toBe('original');
    await g.removeDIDs([vector.asset]);
    g = new Gatekeeper(options);
    expect((await g.resolveDID(vector.asset)).didResolutionMetadata?.error).toBe('notFound');
});


it('reconsiders a duplicate operation discovered at an earlier chain position', async () => {
    const vector = vectors[0];
    const db = new DbJsonMemory('positions');
    const g = new Gatekeeper({ db, ipfs: new MemoryClient() });
    async function importEvents(events: GatekeeperEvent[]) {
        const result = await g.importBatch(events);
        expect(result.queued).toBe(events.length);
        await g.processEvents();
    }
    await importEvents(vector.base);
    const late = { ...vector.rotation, ordinal: [350, 0], time: '2026-01-01T00:05:50Z',
        registration: { ...vector.rotation.registration!, height: 350 } };
    await importEvents([late, vector.old]);
    expect((await g.resolveDID(vector.asset, { confirm: true })).didDocumentData).toBe('retired');
    await importEvents([vector.rotation]);
    expect((await g.resolveDID(vector.asset, { confirm: true })).didDocumentData).toBe('original');
    expect((await db.getCandidates())[vector.controller]).toHaveLength(3);
});


it('repairs pre-upgrade accepted histories without an existing journal', async () => {
    const vector = vectors[0];
    class LegacyDb extends DbJsonMemory {
        seed(dids: Record<string, GatekeeperEvent[]>) { this.writeDb({ dids }); }
    }
    const db = new LegacyDb('upgrade');
    const withoutOpid = (event: GatekeeperEvent) => { const copy = { ...event }; delete copy.opid; return copy; };
    db.seed({
        [vector.controller.split(':').pop()!]: [vector.base[0], vector.rotation].map(withoutOpid),
        [vector.asset.split(':').pop()!]: [vector.base[1], vector.old].map(withoutOpid),
    });
    const g = new Gatekeeper({ db, ipfs: new MemoryClient() });
    expect((await g.resolveDID(vector.asset, { confirm: true })).didDocumentData).toBe('original');
    expect((await db.getCandidates())[vector.asset]).toHaveLength(2);
});

it.each(['check', 'list', 'filtered'] as const)('%s repairs interrupted history on its first public read', async (read) => {
    const vector = vectors[0];
    const db = new DbJsonMemory('first-read');
    const options = { db, ipfs: new MemoryClient() };
    const original = new Gatekeeper(options);
    for (const event of [...vector.base, vector.old]) await original.importEvent(event);
    const journal = await db.getCandidates();
    await db.setCandidates(vector.controller, [...journal[vector.controller], vector.rotation]);
    const restarted = new Gatekeeper(options);
    if (read === 'check') {
        const result = await restarted.checkDIDs({ dids: [vector.asset] });
        expect(result.byVersion).toEqual({ 1: 1 });
    } else if (read === 'list') {
        const docs = await restarted.getDIDs({ dids: [vector.asset], resolve: true });
        expect(docs).toEqual([expect.objectContaining({ didDocumentData: 'original' })]);
    } else {
        const dids = await restarted.getDIDs({ dids: [vector.asset], updatedAfter: vector.old.time });
        expect(dids).toEqual([]);
    }
    expect(await db.getEvents(vector.asset)).toHaveLength(1);
});

it('public status and list reads wait for active publication', async () => {
    const vector = vectors[0];
    let entered!: () => void;
    let release!: () => void;
    const publishing = new Promise<void>(resolve => { entered = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    class PausedDb extends DbJsonMemory {
        pause = false;
        override async addEvent(did: string, event: GatekeeperEvent) {
            await super.addEvent(did, event);
            if (this.pause && did === vector.controller) {
                this.pause = false;
                entered();
                await barrier;
            }
        }
    }
    const db = new PausedDb('read-lock');
    const g = new Gatekeeper({ db, ipfs: new MemoryClient() });
    for (const event of [...vector.base, vector.old]) await g.importEvent(event);
    db.pause = true;
    const importing = g.importEvent(vector.rotation);
    await publishing;
    let readsFinished = 0;
    const status = g.checkDIDs({ dids: [vector.asset] }).then(result => { readsFinished++; return result; });
    const list = g.getDIDs({ dids: [vector.asset], resolve: true }).then(result => { readsFinished++; return result; });
    await new Promise(resolve => setImmediate(resolve));
    expect(readsFinished).toBe(0);
    release();
    await importing;
    expect((await status).byVersion).toEqual({ 1: 1 });
    expect(await list).toEqual([expect.objectContaining({ didDocumentData: 'original' })]);
});

it.each([false, true])('controller removal replays dependents and leaves rejected delegation rejected before returning (restart=%s)', async (restart) => {
    const vector = vectors[0];
    const db = new DbJsonMemory('remove-controller');
    const options = { db, ipfs: new MemoryClient() };
    let g = new Gatekeeper(options);
    for (const event of [...vector.base, ...vector.delegation, vector.old, vector.delegated]) await g.importEvent(event);
    const candidates = await db.getCandidates();
    if (restart) g = new Gatekeeper(options);
    await g.removeDIDs([vector.controller]);
    for (const did of [vector.asset, vector.child]) {
        expect(await db.getEvents(did)).toHaveLength(did === vector.asset ? 0 : 1);
        const doc = await g.resolveDID(did);
        if (did === vector.asset) expect(doc.didResolutionMetadata?.error).toBe('notFound');
        else expect(doc.didDocumentData).toBe('original');
        expect((await db.getCandidates())[did]).toEqual(candidates[did]);
    }
    g = new Gatekeeper(options);
    expect((await g.resolveDID(vector.asset)).didResolutionMetadata?.error).toBe('notFound');
    await g.importEvent(vector.base[0]);
    expect((await g.resolveDID(vector.asset)).didDocumentData).toBe('retired');
});

it.each(['expired', 'invalid'] as const)('GC of an %s controller replays already verified dependents', async (reason) => {
    const vector = vectors[0].gc!;
    const db = new DbJsonMemory('gc-controller');
    const options = { db, ipfs: new MemoryClient() };
    const g = new Gatekeeper(options);
    for (const event of vector.base) await g.importEvent(event);
    // A preceding GC pass may already have cached the dependent as verified.
    (g as unknown as { verifiedDIDs: Record<string, boolean> }).verifiedDIDs[vector.asset] = true;
    if (reason === 'invalid') {
        const events = await db.getEvents(vector.controller);
        events[0].operation.proof!.proofValue = 'invalid';
        await db.setEvents(vector.controller, events);
    }
    const result = await g.verifyDb({ chatty: false });
    expect(result[reason]).toBe(1);
    expect(await db.getEvents(vector.asset)).toHaveLength(0);
    expect((await db.getCandidates())[vector.asset]).toHaveLength(1);
    expect((await db.getCandidates())[vector.controller]).toEqual([]);
    expect((await new Gatekeeper(options).resolveDID(vector.asset)).didResolutionMetadata?.error).toBe('notFound');
});

const controllerRules: { base: GatekeeperEvent[]; cases: { name: string; accepted: boolean; event: GatekeeperEvent; setup: GatekeeperEvent[] }[];
    cycle: { dids: string[]; events: GatekeeperEvent[] } } = JSON.parse(readFileSync('tests/gatekeeper/controller-rules-vectors.json', 'utf8'));

it.each(controllerRules.cases)('enforces controller rules for $name in direct submissions, imports, and startup repair', async ({ accepted, event, setup }) => {
    for (const mode of ['direct', 'import', 'repair']) {
        const db = new DbJsonMemory('controller-rules');
        const options = { db, ipfs: new MemoryClient(), registries: ['local', 'hyperswarm', 'BTC:signet'] };
        let g = new Gatekeeper(options);
        for (const base of [...controllerRules.base, ...setup]) await g.importEvent(base);
        const before = (await db.getEvents(event.did!)).length;
        if (mode === 'direct') {
            let result: boolean;
            try {
                result = event.operation.type === 'create' ? !!await g.createDID(event.operation) : await g.updateDID(event.operation);
            } catch { result = false; }
            expect(result).toBe(accepted);
        } else if (mode === 'import') {
            expect(await g.importEvent(event)).toBe(accepted ? 'added' : 'rejected');
        } else {
            // Legacy accepted state must not preserve an invalid controller assignment.
            const events = [...await db.getEvents(event.did!), event];
            await db.setEvents(event.did!, events);
            await db.setCandidates(event.did!, events);
            g = new Gatekeeper(options);
            await g.getDIDs();
        }
        expect(await db.getEvents(event.did!)).toHaveLength(before + (accepted ? 1 : 0));
    }
});

it('rejects the real signed oscillation case at controller assignment, including legacy repair', async () => {
    const { events, dids } = controllerRules.cycle;
    for (const repair of [false, true]) {
        const db = new DbJsonMemory('signed-cycle');
        const options = { db, ipfs: new MemoryClient() };
        const g = new Gatekeeper(options);
        if (repair) {
            for (const did of dids) {
                const history = events.filter(event => event.did === did);
                await db.setEvents(did, history);
                await db.setCandidates(did, history);
            }
        } else {
            for (const event of events) {
                const status = await g.importEvent(event);
                if (event.operation.doc?.didDocument?.controller) expect(status).toBe('rejected');
            }
        }
        for (const did of dids) {
            const doc = await g.resolveDID(did, { verify: true });
            expect(doc.didDocumentMetadata?.versionSequence).toBe('1');
            expect(doc.didDocument?.controller).toBeUndefined();
            expect(await db.getEvents(did)).toHaveLength(1);
            expect((await db.getCandidates())[did]).toHaveLength(3);
        }
    }
});

it('public verification repairs an interrupted controller projection before authorizing', async () => {
    const vector = vectors[0];
    const db = new DbJsonMemory('verify-repair');
    const options = { db, ipfs: new MemoryClient() };
    let g = new Gatekeeper(options);
    for (const event of vector.base) await g.importEvent(event);
    const operation = { ...vector.old.operation, proof: { ...vector.old.operation.proof!, created: vector.old.time } };
    expect(await g.verifyOperation(operation)).toBe(true);
    const journal = await db.getCandidates();
    await db.setCandidates(vector.controller, [...journal[vector.controller], vector.rotation]);
    g = new Gatekeeper(options);
    expect(await g.verifyOperation(operation)).toBe(false);
    expect(await db.getEvents(vector.controller)).toHaveLength(2);
});

it.each(['resolve', 'verify'] as const)('holds the history lock throughout an asynchronous %s read', async (mode) => {
    const vector = vectors[0];
    let entered!: () => void;
    let release!: () => void;
    const reading = new Promise<void>(resolve => { entered = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    class PausedReadDb extends DbJsonMemory {
        pause = false;
        override async getEvents(did: string) {
            const events = await super.getEvents(did);
            if (this.pause && did === vector.asset) {
                this.pause = false;
                entered();
                await barrier;
            }
            return events;
        }
    }
    const db = new PausedReadDb('read-snapshot');
    const g = new Gatekeeper({ db, ipfs: new MemoryClient() });
    for (const event of [...vector.base, vector.old]) await g.importEvent(event);
    db.pause = true;
    const operation = { ...vector.old.operation, proof: { ...vector.old.operation.proof!, created: vector.old.time } };
    const read = mode === 'resolve' ? g.resolveDID(vector.asset, { verify: true }) : g.verifyOperation(operation);
    await reading;
    let imported = false;
    const writing = g.importEvent(vector.rotation).then(() => { imported = true; });
    try {
        await new Promise(resolve => setImmediate(resolve));
        expect(imported).toBe(false);
        expect(await db.getEvents(vector.controller)).toHaveLength(1);
    } finally {
        release();
    }
    const result = await read;
    if (mode === 'verify') expect(result).toBe(true);
    else expect(result).toEqual(expect.objectContaining({ didDocumentData: 'retired' }));
    await writing;
    expect((await g.resolveDID(vector.asset, { verify: true })).didDocumentData).toBe('original');
});


it('startup verifies each creation once and leaves unchanged candidate journals untouched', async () => {
    const db = new DbJsonMemory('startup-work');
    const options = { db, ipfs: new MemoryClient() };
    const g = new Gatekeeper(options);
    // Includes both a controller and its asset, in multiple registry histories.
    for (const vector of vectors) {
        for (const event of vector.base) await g.importEvent(event);
    }
    const before = await db.getCandidates();
    const writes = jest.spyOn(db, 'setCandidates');
    const reads = jest.spyOn(db, 'getEvents');
    const verify = jest.spyOn(Gatekeeper.prototype, 'verifyCreateOperation');
    try {
        const restarted = new Gatekeeper(options);
        await restarted.getDIDs();
        const creations = Object.values(before).flat().filter(event => event.operation.type === 'create');
        expect(verify).toHaveBeenCalledTimes(creations.length);
        expect(writes).not.toHaveBeenCalled();
        expect(reads).toHaveBeenCalledTimes(Object.keys(before).length);
        expect(await db.getCandidates()).toEqual(before);
        for (const [did, events] of Object.entries(before)) {
            expect(await db.getEvents(did)).toEqual(events);
        }
    } finally {
        verify.mockRestore();
        writes.mockRestore();
        reads.mockRestore();
    }
});

it.each(['anchored', 'gossip', 'restamped-gossip'])('merges known %s sync events without reverifying controllers or reading dependent histories', async mode => {
    const vector = vectors[0];
    const db = new DbJsonMemory('duplicate-sync');
    const options = { db, ipfs: new MemoryClient() };
    let g = new Gatekeeper(options);
    for (const event of vector.base) {
        await g.importEvent(mode === 'anchored' ? event : {
            operation: event.operation, registry: 'hyperswarm', time: event.time, ordinal: event.ordinal,
        });
    }
    g = new Gatekeeper(options);
    await g.getDIDs();
    const before = await db.getCandidates();
    const duplicate = structuredClone(before[vector.controller][0]);
    if (mode === 'restamped-gossip') {
        duplicate.time = '2026-09-16T00:00:00.000Z';
        duplicate.ordinal = [Date.parse(duplicate.time), 42];
    }
    const verify = jest.spyOn(Gatekeeper.prototype, 'verifyCreateOperation');
    const reads = jest.spyOn(db, 'getEvents');
    const writes = jest.spyOn(db, 'setCandidates');
    try {
        expect(await g.importEvent(duplicate)).toBe('merged');
        expect(verify).not.toHaveBeenCalled();
        expect(reads.mock.calls.every(([did]) => did === vector.controller)).toBe(true);
        expect(writes).not.toHaveBeenCalled();
    } finally {
        verify.mockRestore();
        reads.mockRestore();
        writes.mockRestore();
    }
    expect(await db.getCandidates()).toEqual(before);
    // New controller evidence must still invalidate its dependent history.
    await g.importEvent(vector.old);
    await g.importEvent(vector.rotation);
    expect((await g.resolveDID(vector.asset, { verify: true })).didDocumentData).toBe('original');
});


describe('pending batch reporting', () => {
    it('preserves failed, remaining, deferred, and concurrent events after a journal write failure', async () => {
        const db = new DbJsonMemory('failed-journal');
        await db.start();
        const g = new Gatekeeper({ db, ipfs: new MemoryClient(), registries: ['BTC:signet'] });
        const vector = vectors[0];
        // The asset defers, then its controller fails; the rotation is still unvisited.
        await g.importBatch([vector.base[1], vector.base[0], vector.rotation]);
        const write = db.setCandidates.bind(db);
        const writes = jest.spyOn(db, 'setCandidates').mockImplementation(async (did, events) => {
            if (did === vector.controller) {
                // Simulate an import arriving while this processing pass is in flight.
                await g.importBatch([vector.old]);
                throw new Error('Candidate journal unavailable');
            }
            return write(did, events);
        });
        try {
            await expect(g.processEvents()).rejects.toThrow('Candidate journal unavailable');
        } finally {
            writes.mockRestore();
        }
        const queued = (await g.checkDIDs()).eventsQueue;
        expect(queued).toHaveLength(4);
        expect(queued.map(event => event.operation)).toEqual([
            vector.base[0].operation, vector.rotation.operation,
            vector.base[1].operation, vector.old.operation,
        ]);
        // A mediator reimport is deduplicated; recovery must use the preserved queue.
        expect(await g.importBatch([vector.base[0], vector.base[1], vector.rotation, vector.old]))
            .toMatchObject({ queued: 0, processed: 4 });
        expect(await g.processEvents()).toMatchObject({ pending: 0 });
        const candidates = await db.getCandidates();
        expect(candidates[vector.controller]).toHaveLength(2);
        expect(candidates[vector.asset]).toHaveLength(2);
        await db.stop();
    });

    it('identifies only batches still pending and clears them when dependencies arrive', async () => {
        const db = new DbJsonMemory('pending-batches');
        await db.start();
        const g = new Gatekeeper({ db, ipfs: new MemoryClient(), registries: ['BTC:signet', 'hyperswarm'] });
        const vector = vectors[0];
        const asset = { ...vector.base[1], registration: { ...vector.base[1].registration, batch: 'pending-batch' } };
        await g.importBatch([asset]);
        expect(await g.processEvents()).toMatchObject({ pending: 1, pendingBatches: ['pending-batch'] });
        await g.importBatch([vector.base[0]]);
        expect(await g.processEvents()).toMatchObject({ pending: 0 });
        await db.stop();
    });

    it('reports an empty batch list for deferred gossip', async () => {
        const db = new DbJsonMemory('pending-batches');
        await db.start();
        const g = new Gatekeeper({ db, ipfs: new MemoryClient(), registries: ['hyperswarm'] });
        const asset = { ...vectors[0].base[1], registry: 'hyperswarm', registration: undefined };
        await g.importBatch([asset]);
        expect(await g.processEvents()).toMatchObject({ pending: 1, pendingBatches: [] });
        await db.stop();
    });
});

it('does not rewrite known gossip content to IPFS', async () => {
    const vector = vectors[0];
    const db = new DbJsonMemory('known-content');
    const ipfs = new MemoryClient();
    const g = new Gatekeeper({ db, ipfs });
    for (const event of vector.base) await g.importEvent(event);
    const writes = jest.spyOn(ipfs, 'addJSON');
    try {
        const event = { ...vector.base[0], registry: 'hyperswarm', registration: undefined, opid: undefined, did: undefined };
        expect(await g.importEvent(event)).toBe('merged');
        expect(writes).not.toHaveBeenCalled();
    } finally { writes.mockRestore(); }
});

it('does not replay unchanged deferred evidence but recovers when its predecessor arrives', async () => {
    const vector = vectors[0];
    const db = new DbJsonMemory('deferred-replay');
    const g = new Gatekeeper({ db, ipfs: new MemoryClient() });
    for (const event of [...vector.base, vector.rotation]) await g.importEvent(event);
    expect(await g.importEvent(vector.freshNext)).toBe('deferred');
    const verify = jest.spyOn(Gatekeeper.prototype, 'verifyUpdateOperation');
    try {
        expect(await g.importEvent(vector.freshNext)).toBe('deferred');
        expect(verify).not.toHaveBeenCalled();
    } finally { verify.mockRestore(); }
    await g.importEvent(vector.fresh);
    expect((await g.resolveDID(vector.asset, { verify: true })).didDocumentData).toBe('new-key-successor');
});

it('retains a new gossip hint without replaying dependents of an unchanged controller projection', async () => {
    const vector = vectors[0];
    // Redis hydrates stripped records by appending operation, so object key
    // order can differ from the same event in the candidate journal.
    class HydratedDb extends DbJsonMemory {
        override async getEvents(did: string) {
            return (await super.getEvents(did)).map(({ operation, ...event }) => ({ ...event, operation }));
        }
    }
    const db = new HydratedDb('redundant-hint');
    const g = new Gatekeeper({ db, ipfs: new MemoryClient() });
    for (const event of [...vector.base, vector.old]) await g.importEvent(event);
    const before = await db.getEvents(vector.controller);
    const reads = jest.spyOn(db, 'getEvents');
    try {
        expect(await g.importEvent({ ...vector.base[0], registry: 'hyperswarm', registration: undefined })).toBe('merged');
        expect(reads.mock.calls.every(([did]) => did === vector.controller)).toBe(true);
    } finally { reads.mockRestore(); }
    expect(await db.getEvents(vector.controller)).toEqual(before);
    expect((await db.getCandidates())[vector.controller]).toHaveLength(2);
    await g.importEvent(vector.rotation);
    expect((await g.resolveDID(vector.asset, { verify: true })).didDocumentData).toBe('original');
});

it('lets interactive resolution finish between status scan chunks', async () => {
    const vector = vectors[0];
    let entered!: () => void;
    let release!: () => void;
    const reading = new Promise<void>(resolve => { entered = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    class PausedScanDb extends DbJsonMemory {
        pause = false;
        readCount = 0;
        override async getEvents(did: string) {
            this.readCount++;
            const events = await super.getEvents(did);
            if (this.pause && did === vector.asset) {
                this.pause = false;
                entered();
                await barrier;
            }
            return events;
        }
    }
    const db = new PausedScanDb('status-fairness');
    const g = new Gatekeeper({ db, ipfs: new MemoryClient() });
    for (const event of vector.base) await g.importEvent(event);
    db.pause = true;
    db.readCount = 0;
    let scanFinished = false;
    const scan = g.checkDIDs({ dids: Array(65).fill(vector.asset) }).then(result => {
        scanFinished = true;
        return result;
    });
    await reading;
    const read = g.resolveDID(vector.controller).then(result => {
        expect(scanFinished).toBe(false);
        expect(db.readCount).toBeLessThan(65);
        return result;
    });
    release();
    expect((await read).didDocument?.id).toBe(vector.controller);
    expect((await scan).byType.assets).toBe(65);
});
