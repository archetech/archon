import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Gatekeeper from '@didcid/gatekeeper';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory.ts';
import DbJson from '@didcid/gatekeeper/db/json.ts';
import DbSqlite from '@didcid/gatekeeper/db/sqlite.ts';
import MemoryClient from '@didcid/ipfs/memory';
import type { GatekeeperEvent } from '@didcid/gatekeeper/types';

type Vector = { registry: string; controller: string; asset: string; child: string; delegation: GatekeeperEvent[]; base: GatekeeperEvent[] } &
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
