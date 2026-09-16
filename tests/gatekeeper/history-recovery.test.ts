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
                const resolved = await g.resolveDID(target, { confirm: true, verify: true });
                if (scenario === 'create') {
                    expect(resolved.didResolutionMetadata?.error).toBe('notFound');
                    expect(await g.searchDocs('')).not.toContain(target);
                    expect((await db.getCandidates())[target]).toHaveLength(1);
                    return 'notFound';
                }
                expect(resolved.didDocumentData).toBe(expected);
                const events = await g.exportDID(target);
                expect(events).toHaveLength(scenario === 'new-key' ? 3 : scenario === 'early' || scenario === 'delegation' ? 2 : 1);
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

it.each([false, true])('controller removal replays transitive dependents before returning (restart=%s)', async (restart) => {
    const vector = vectors[0];
    const db = new DbJsonMemory('remove-controller');
    const options = { db, ipfs: new MemoryClient() };
    let g = new Gatekeeper(options);
    for (const event of [...vector.base, ...vector.delegation, vector.old, vector.delegated]) await g.importEvent(event);
    const candidates = await db.getCandidates();
    if (restart) g = new Gatekeeper(options);
    await g.removeDIDs([vector.controller]);
    for (const did of [vector.asset, vector.child]) {
        expect(await db.getEvents(did)).toHaveLength(did === vector.asset ? 0 : 2);
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

it.each(['candidate', 'dependency'] as const)('isolates a nonconverging %s history across restart and retries when evidence can resolve', async (cycle) => {
    const vector = vectors[0];
    const db = new DbJsonMemory('cycles');
    const options = { db, ipfs: new MemoryClient() };
    // Inject oscillating projections at the importer boundary to exercise both
    // replay guards without coupling this test to a particular signature bug.
    type ImportStatus = Awaited<ReturnType<Gatekeeper['importEvent']>>;
    type Replay = { db: DbJsonMemory; importEventOnce(event: GatekeeperEvent): Promise<ImportStatus> };
    const prototype = Gatekeeper.prototype as unknown as Replay;
    const original = prototype.importEventOnce;
    let oscillate = true;
    const mock = jest.spyOn(prototype, 'importEventOnce').mockImplementation(async function (this: Replay, event) {
        if (!oscillate || (event.did !== vector.controller && event.did !== vector.asset)) {
            return original.call(this, event);
        }
        const target = event.did!;
        const events = await this.db.getEvents(target);
        const controller = await this.db.getEvents(vector.controller);
        const asset = await this.db.getEvents(vector.asset);
        const present = cycle === 'candidate' ? events.length === 0
            : target === vector.controller ? asset.length === 0 : controller.length > 0;
        await this.db.setEvents(target, present ? [event] : []);
        return 'added' as ImportStatus;
    });
    try {
        let g = new Gatekeeper(options);
        // Journal both together, including the reverse edge for the dependency cycle.
        const controller = structuredClone(vector.base[0]);
        if (cycle === 'dependency') controller.operation.controller = vector.asset;
        await db.setCandidates(vector.controller, [controller]);
        await db.setCandidates(vector.asset, [vector.base[1]]);
        for (let restart = 0; restart < 2; restart++) {
            g = new Gatekeeper(options);
            expect((await g.resolveDID(vector.asset)).didResolutionMetadata?.error).toBe('notFound');
            await g.importEvent(vectors[1].base[0]);
            expect((await g.resolveDID(vectors[1].controller)).didResolutionMetadata?.error).toBeUndefined();
            expect((await db.getCandidates())[vector.asset]).toHaveLength(1);
        }
        oscillate = false;
        // Restore the original valid controller evidence; re-evaluate retained dependents.
        await g.importEvent(vector.base[0]);
        expect((await g.resolveDID(vector.asset)).didDocumentData).toBe('original');
    } finally {
        mock.mockRestore();
    }
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
