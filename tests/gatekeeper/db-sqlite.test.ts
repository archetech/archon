import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

import DbSqlite from '../../packages/gatekeeper/src/db/sqlite.ts';
import { InvalidDIDError } from '../../packages/common/src/errors.ts';
import type {
    BlockInfo,
    GatekeeperEvent,
    Operation,
} from '../../packages/clients/src/gatekeeper-types.ts';

const DID = 'did:cid:bagaaieraabc';
const SUFFIX = 'bagaaieraabc';

function operation(proofValue: string): Operation {
    return {
        type: 'create',
        created: '2026-01-01T00:00:00Z',
        proof: { proofValue },
    } as unknown as Operation;
}

function event(opid: string, proofValue = opid): GatekeeperEvent {
    return {
        registry: 'local',
        time: '2026-01-01T00:00:00Z',
        did: DID,
        opid,
        operation: operation(proofValue),
    };
}

function block(height: number, hash: string): BlockInfo {
    return { height, hash, time: 1_700_000_000 + height };
}

// The backend opens a real file, so each test gets its own directory and the
// connection is always closed — an open sqlite handle would keep Jest alive,
// and CI runs without --forceExit.
async function withDb(fn: (db: DbSqlite) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'gk-sqlite-'));
    const db = new DbSqlite('test', dir);
    try {
        await db.start();
        await fn(db);
    } finally {
        await db.stop();
        await rm(dir, { recursive: true, force: true });
    }
}

describe('DbSqlite lifecycle', () => {
    it('refuses every operation before start()', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'gk-sqlite-'));
        try {
            const db = new DbSqlite('unstarted', dir);
            const notStarted = /SQLite DB not open/;

            await expect(db.resetDb()).rejects.toThrow(notStarted);
            await expect(db.getEvents(DID)).rejects.toThrow(notStarted);
            await expect(db.deleteEvents(DID)).rejects.toThrow(notStarted);
            await expect(db.queueOperation('local', operation('a'))).rejects.toThrow(notStarted);
            await expect(db.getQueue('local')).rejects.toThrow(notStarted);
            await expect(db.clearQueue('local', [])).rejects.toThrow(notStarted);
            await expect(db.getAllKeys()).rejects.toThrow(notStarted);
            await expect(db.addBlock('local', block(1, 'h1'))).rejects.toThrow(notStarted);
            await expect(db.getBlock('local')).rejects.toThrow(notStarted);
            await expect(db.addOperation('op1', operation('a'))).rejects.toThrow(notStarted);
            await expect(db.getOperation('op1')).rejects.toThrow(notStarted);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('is safe to stop twice', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'gk-sqlite-'));
        try {
            const db = new DbSqlite('twice', dir);
            await db.start();
            await expect(db.stop()).resolves.toBeUndefined();
            await expect(db.stop()).resolves.toBeUndefined();
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('persists across a restart on the same file', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'gk-sqlite-'));
        try {
            const first = new DbSqlite('persist', dir);
            await first.start();
            await first.addEvent(DID, event('op1'));
            await first.stop();

            const second = new DbSqlite('persist', dir);
            await second.start();
            try {
                const events = await second.getEvents(DID);
                expect(events).toHaveLength(1);
                expect(events[0].opid).toBe('op1');
            } finally {
                await second.stop();
            }
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

describe('DbSqlite events', () => {
    it('stores an event and hydrates its operation back on read', async () => {
        await withDb(async db => {
            await expect(db.addEvent(DID, event('op1'))).resolves.toBe(1);

            const events = await db.getEvents(DID);
            expect(events).toHaveLength(1);
            expect(events[0].opid).toBe('op1');
            // The operation is stored once in `operations` and rehydrated by opid.
            expect(events[0].operation).toEqual(operation('op1'));
            await expect(db.getOperation('op1')).resolves.toEqual(operation('op1'));
        });
    });

    it('appends events in order', async () => {
        await withDb(async db => {
            await db.addEvent(DID, event('op1'));
            await expect(db.addEvent(DID, event('op2'))).resolves.toBe(1);

            const events = await db.getEvents(DID);
            expect(events.map(e => e.opid)).toEqual(['op1', 'op2']);
        });
    });

    it('returns an empty list for an unknown DID', async () => {
        await withDb(async db => {
            await expect(db.getEvents('did:cid:nothinghere')).resolves.toEqual([]);
        });
    });

    it('replaces the whole event list with setEvents', async () => {
        await withDb(async db => {
            await db.addEvent(DID, event('op1'));

            await db.setEvents(DID, [event('op9')]);

            const events = await db.getEvents(DID);
            expect(events.map(e => e.opid)).toEqual(['op9']);
        });
    });

    it('leaves an event without an opid untouched', async () => {
        await withDb(async db => {
            const bare = { registry: 'local', time: 't' } as unknown as GatekeeperEvent;
            await db.setEvents(DID, [bare]);

            const events = await db.getEvents(DID);
            expect(events).toEqual([bare]);
        });
    });

    it('drops an inline operation that has no opid to dereference it', async () => {
        await withDb(async db => {
            const inline = {
                registry: 'local',
                time: 't',
                operation: operation('inline'),
            } as GatekeeperEvent;
            await db.setEvents(DID, [inline]);

            // setEventsStrict strips `operation` unconditionally, but only copies it
            // into the operations table when an opid accompanies it. An event carrying
            // an operation with no opid therefore loses it permanently — it is neither
            // stored inline nor rehydratable. Callers are expected to always set opid.
            const events = await db.getEvents(DID);
            expect(events[0].operation).toBeUndefined();
        });
    });

    it('returns the event unhydrated when its operation is missing', async () => {
        await withDb(async db => {
            const orphan = { registry: 'local', time: 't', opid: 'ghost' } as GatekeeperEvent;
            await db.setEvents(DID, [orphan]);

            const events = await db.getEvents(DID);
            expect(events).toHaveLength(1);
            expect(events[0].operation).toBeUndefined();
        });
    });

    it('deletes a DID and reports the row count', async () => {
        await withDb(async db => {
            await db.addEvent(DID, event('op1'));

            await expect(db.deleteEvents(DID)).resolves.toBe(1);
            await expect(db.getEvents(DID)).resolves.toEqual([]);
            await expect(db.deleteEvents(DID)).resolves.toBe(0);
        });
    });

    it('rejects an empty DID', async () => {
        await withDb(async db => {
            await expect(db.addEvent('', event('op1'))).rejects.toThrow(InvalidDIDError);
            await expect(db.setEvents('', [])).rejects.toThrow(InvalidDIDError);
        });
    });

    it('swallows a malformed events row rather than throwing', async () => {
        await withDb(async db => {
            await db.addEvent(DID, event('op1'));
            // Corrupt the stored JSON so it parses to a non-array.
            (db as any).db.prepare('UPDATE dids SET events = ? WHERE id = ?').run('{"not":"array"}', SUFFIX);

            await expect(db.getEvents(DID)).resolves.toEqual([]);
        });
    });

    it('lists every stored DID suffix', async () => {
        await withDb(async db => {
            await expect(db.getAllKeys()).resolves.toEqual([]);

            await db.addEvent(DID, event('op1'));
            await db.addEvent('did:cid:secondsuffix', event('op2'));

            const keys = await db.getAllKeys();
            expect(keys.sort()).toEqual([SUFFIX, 'secondsuffix'].sort());
        });
    });
});

describe('DbSqlite queue', () => {
    it('queues operations and reports the queue depth', async () => {
        await withDb(async db => {
            await expect(db.queueOperation('local', operation('a'))).resolves.toBe(1);
            await expect(db.queueOperation('local', operation('b'))).resolves.toBe(2);

            const queue = await db.getQueue('local');
            expect(queue.map(o => (o as any).proof.proofValue)).toEqual(['a', 'b']);
        });
    });

    it('keeps registries separate', async () => {
        await withDb(async db => {
            await db.queueOperation('local', operation('a'));
            await db.queueOperation('hyperswarm', operation('b'));

            await expect(db.getQueue('local')).resolves.toHaveLength(1);
            await expect(db.getQueue('hyperswarm')).resolves.toHaveLength(1);
            await expect(db.getQueue('unused')).resolves.toEqual([]);
        });
    });

    it('clears exactly the batch it is given, by proof value', async () => {
        await withDb(async db => {
            await db.queueOperation('local', operation('a'));
            await db.queueOperation('local', operation('b'));
            await db.queueOperation('local', operation('c'));

            await expect(db.clearQueue('local', [operation('a'), operation('c')])).resolves.toBe(true);

            const queue = await db.getQueue('local');
            expect(queue.map(o => (o as any).proof.proofValue)).toEqual(['b']);
        });
    });

    it('ignores batch entries with no proof value', async () => {
        await withDb(async db => {
            await db.queueOperation('local', operation('a'));

            const unproven = { type: 'create' } as unknown as Operation;
            await expect(db.clearQueue('local', [unproven])).resolves.toBe(true);
            await expect(db.getQueue('local')).resolves.toHaveLength(1);
        });
    });

    it('swallows a malformed queue row rather than throwing', async () => {
        await withDb(async db => {
            await db.queueOperation('local', operation('a'));
            (db as any).db.prepare('UPDATE queue SET ops = ? WHERE id = ?').run('"not an array"', 'local');

            await expect(db.getQueue('local')).resolves.toEqual([]);
        });
    });
});

describe('DbSqlite blocks', () => {
    it('stores a block and reads it back by height, hash, or latest', async () => {
        await withDb(async db => {
            await expect(db.addBlock('local', block(1, 'h1'))).resolves.toBe(true);
            await db.addBlock('local', block(2, 'h2'));

            await expect(db.getBlock('local')).resolves.toMatchObject({ height: 2, hash: 'h2' });
            await expect(db.getBlock('local', 1)).resolves.toMatchObject({ hash: 'h1' });
            await expect(db.getBlock('local', 'h2')).resolves.toMatchObject({ height: 2 });
        });
    });

    it('returns height and time as numbers, matching the other backends', async () => {
        await withDb(async db => {
            await db.addBlock('local', block(7, 'h7'));

            for (const found of [
                await db.getBlock('local'),
                await db.getBlock('local', 7),
                await db.getBlock('local', 'h7'),
            ]) {
                expect(typeof found!.time).toBe('number');
                expect(typeof found!.height).toBe('number');
                expect(found!.time).toBe(1_700_000_007);
            }
        });
    });

    it('coerces a legacy row stored under the old TEXT affinity', async () => {
        await withDb(async db => {
            // Simulate a database created before the column became INTEGER, where
            // SQLite stored the value as a string.
            (db as any).db.prepare(
                'INSERT INTO blocks (registry, hash, height, time, txns) VALUES (?, ?, ?, ?, 0)'
            ).run('local', 'legacy', '42', '1700000042');

            const found = await db.getBlock('local', 'legacy');
            expect(found).toMatchObject({ hash: 'legacy', height: 42, time: 1700000042 });
            expect(typeof found!.time).toBe('number');
            expect(typeof found!.height).toBe('number');
        });
    });

    it('returns null for an unknown registry, height, or hash', async () => {
        await withDb(async db => {
            await expect(db.getBlock('nothing')).resolves.toBeNull();

            await db.addBlock('local', block(1, 'h1'));
            await expect(db.getBlock('local', 99)).resolves.toBeNull();
            await expect(db.getBlock('local', 'nope')).resolves.toBeNull();
        });
    });

    it('replaces a block reannounced at the same hash', async () => {
        await withDb(async db => {
            await db.addBlock('local', block(1, 'h1'));
            await db.addBlock('local', { height: 1, hash: 'h1', time: 999 });

            await expect(db.getBlock('local', 'h1')).resolves.toMatchObject({ time: 999 });
        });
    });

    it('lets a different hash at the same height take over that height', async () => {
        await withDb(async db => {
            await db.addBlock('local', block(1, 'h1'));

            // INSERT OR REPLACE resolves a clash on idx_registry_height by deleting
            // the conflicting row, so this succeeds and the earlier block is gone:
            // last write wins for a given height, rather than being rejected.
            await expect(db.addBlock('local', block(1, 'other'))).resolves.toBe(true);

            await expect(db.getBlock('local', 'h1')).resolves.toBeNull();
            await expect(db.getBlock('local', 1)).resolves.toMatchObject({ hash: 'other' });
        });
    });
});

describe('DbSqlite operations', () => {
    it('stores and reads an operation by opid', async () => {
        await withDb(async db => {
            await db.addOperation('op1', operation('a'));

            await expect(db.getOperation('op1')).resolves.toEqual(operation('a'));
            await expect(db.getOperation('missing')).resolves.toBeNull();
        });
    });

    it('replaces an operation stored under the same opid', async () => {
        await withDb(async db => {
            await db.addOperation('op1', operation('first'));
            await db.addOperation('op1', operation('second'));

            await expect(db.getOperation('op1')).resolves.toEqual(operation('second'));
        });
    });
});

describe('DbSqlite resetDb', () => {
    it('empties every table', async () => {
        await withDb(async db => {
            await db.addEvent(DID, event('op1'));
            await db.queueOperation('local', operation('a'));
            await db.addBlock('local', block(1, 'h1'));
            await db.addOperation('standalone', operation('b'));

            await db.resetDb();

            await expect(db.getAllKeys()).resolves.toEqual([]);
            await expect(db.getQueue('local')).resolves.toEqual([]);
            await expect(db.getBlock('local')).resolves.toBeNull();
            await expect(db.getOperation('standalone')).resolves.toBeNull();
        });
    });
});

describe('DbSqlite concurrency', () => {
    it('serializes concurrent writes so no append is lost', async () => {
        await withDb(async db => {
            // runExclusive chains these; without it the read-modify-write in
            // addEvent would race and drop appends.
            await Promise.all(
                Array.from({ length: 10 }, (_, i) => db.addEvent(DID, event(`op${i}`))),
            );

            const events = await db.getEvents(DID);
            expect(events).toHaveLength(10);
            expect(new Set(events.map(e => e.opid)).size).toBe(10);
        });
    });

    it('serializes concurrent queue writes', async () => {
        await withDb(async db => {
            await Promise.all(
                Array.from({ length: 10 }, (_, i) => db.queueOperation('local', operation(`p${i}`))),
            );

            await expect(db.getQueue('local')).resolves.toHaveLength(10);
        });
    });
});
