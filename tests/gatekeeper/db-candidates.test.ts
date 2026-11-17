import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import DbJson from '../../packages/gatekeeper/src/db/json.ts';
import DbJsonCache from '../../packages/gatekeeper/src/db/json-cache.ts';
import DbJsonMemory from '../../packages/gatekeeper/src/db/json-memory.ts';
import DbSqlite from '../../packages/gatekeeper/src/db/sqlite.ts';
import type { GatekeeperDb } from '../../packages/gatekeeper/src/types.ts';
import type { GatekeeperEvent } from '../../packages/clients/src/gatekeeper-types.ts';

const HELD = 'did:cid:bagaaieraheld';
const EMPTIED = 'did:cid:bagaaieraemptied';
const ABSENT = 'did:cid:bagaaieraabsent';

function event(did: string, opid: string): GatekeeperEvent {
    return { registry: 'local', time: '2026-01-01T00:00:00Z', did, opid, operation: { type: 'create' } as any };
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gk-candidates-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const backends: [string, () => GatekeeperDb & { start?: () => Promise<void>; stop?: () => Promise<void> }][] = [
    ['json', () => new DbJson('gk', dir)],
    ['json-cache', () => new DbJsonCache('gk', dir)],
    ['json-memory', () => new DbJsonMemory('gk')],
    ['sqlite', () => new DbSqlite('gk', dir)],
];

// The journal is read one DID at a time. Migration gives a DID with no entry its
// accepted events as evidence, and must not do that for a DID whose evidence was
// removed, so the two have to read differently.
describe.each(backends)('%s candidate journal', (_name, create) => {
    it('reads the entries asked for, and tells a missing entry from an empty one', async () => {
        const db = create();
        await db.start?.();
        try {
            await db.setCandidates(HELD, [event(HELD, 'op1'), event(HELD, 'op2')]);
            await db.setCandidates(EMPTIED, []);

            expect(await db.getCandidatesFor([HELD, EMPTIED, ABSENT])).toEqual({
                [HELD]: [event(HELD, 'op1'), event(HELD, 'op2')],
                [EMPTIED]: [],
            });
            expect(await db.getCandidatesFor([ABSENT])).toEqual({});
            expect(await db.getCandidatesFor([])).toEqual({});
            expect((await db.getCandidateDIDs()).sort()).toEqual([EMPTIED, HELD].sort());
            // The same journal, read whole.
            expect(await db.getCandidatesFor(await db.getCandidateDIDs())).toEqual(await db.getCandidates());
        } finally {
            await db.stop?.();
        }
    });
});
