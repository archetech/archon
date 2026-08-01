import { jest } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import DbJson from '../../packages/gatekeeper/src/db/json.ts';
import DbJsonCache from '../../packages/gatekeeper/src/db/json-cache.ts';
import type { GatekeeperEvent } from '../../packages/clients/src/gatekeeper-types.ts';

const DID = 'did:cid:bagaaieraabc';

function event(opid: string): GatekeeperEvent {
    return {
        registry: 'local',
        time: '2026-01-01T00:00:00Z',
        did: DID,
        opid,
        operation: { type: 'create' } as any,
    };
}

let dir: string;
let logSpy: any;
let errorSpy: any;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gk-json-'));
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    logSpy.mockRestore();
    errorSpy.mockRestore();
});

describe('DbJson', () => {
    it('creates an empty database file when none exists', async () => {
        const db = new DbJson('gk', dir);

        await expect(db.getEvents(DID)).resolves.toEqual([]);

        const file = join(dir, 'gk.json');
        expect(existsSync(file)).toBe(true);
        expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ dids: {} });
    });

    it('creates the data folder on demand', async () => {
        const nested = join(dir, 'deeply', 'nested');
        const db = new DbJson('gk', nested);

        await db.addEvent(DID, event('op1'));

        expect(existsSync(join(nested, 'gk.json'))).toBe(true);
    });

    it('persists events to disk and reads them back in a fresh instance', async () => {
        const db = new DbJson('gk', dir);
        await db.addEvent(DID, event('op1'));

        const reopened = new DbJson('gk', dir);
        const events = await reopened.getEvents(DID);
        expect(events.map(e => e.opid)).toEqual(['op1']);
    });

    it('recovers from a corrupt file by starting empty', async () => {
        const file = join(dir, 'gk.json');
        writeFileSync(file, '{ not valid json');

        const db = new DbJson('gk', dir);

        await expect(db.getEvents(DID)).resolves.toEqual([]);
        // The unreadable file is replaced rather than left in place.
        expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ dids: {} });
    });

    it('deletes the database file on reset', async () => {
        const db = new DbJson('gk', dir);
        await db.addEvent(DID, event('op1'));
        const file = join(dir, 'gk.json');
        expect(existsSync(file)).toBe(true);

        await db.resetDb();

        expect(existsSync(file)).toBe(false);
        await expect(db.getEvents(DID)).resolves.toEqual([]);
    });

    it('is a no-op to reset when no file exists', async () => {
        const db = new DbJson('never-written', dir);

        await expect(db.resetDb()).resolves.toBeUndefined();
    });
});

describe('DbJsonCache', () => {
    // start() schedules a repeating save; every test must stop() it or the timer
    // keeps Jest alive, and CI runs without --forceExit.
    async function withCache(fn: (db: DbJsonCache) => Promise<void>): Promise<void> {
        const db = new DbJsonCache('gk', dir);
        try {
            await fn(db);
        } finally {
            await db.stop();
        }
    }

    it('buffers writes in memory and flushes them on stop', async () => {
        await withCache(async db => {
            // The constructor already wrote an empty file: loadDb() falls into its
            // catch for a missing file and saves the empty database immediately.
            const file = join(dir, 'gk.json');
            expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ dids: {} });

            await db.addEvent(DID, event('op1'));

            // writeDb only updates the cache, so the file is still the empty one.
            expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ dids: {} });

            await db.stop();

            const written = JSON.parse(readFileSync(file, 'utf-8'));
            expect(Object.keys(written.dids)).toHaveLength(1);
        });
    });

    it('loads an existing file into the cache', async () => {
        const seeded = { dids: { bagaaieraabc: [event('seeded')] } };
        writeFileSync(join(dir, 'gk.json'), JSON.stringify(seeded));

        await withCache(async db => {
            const events = await db.getEvents(DID);
            expect(events.map(e => e.opid)).toEqual(['seeded']);
        });
    });

    it('starts empty when the file is corrupt or has no dids key', async () => {
        writeFileSync(join(dir, 'gk.json'), '{ not valid json');
        await withCache(async db => {
            await expect(db.getEvents(DID)).resolves.toEqual([]);
        });

        // A structurally valid file missing `dids` is treated the same way.
        writeFileSync(join(dir, 'other.json'), JSON.stringify({ somethingElse: true }));
        const db = new DbJsonCache('other', dir);
        try {
            await expect(db.getEvents(DID)).resolves.toEqual([]);
        } finally {
            await db.stop();
        }
    });

    it('schedules a repeating save that stop() cancels', async () => {
        const db = new DbJsonCache('gk', dir);
        await db.start();

        expect(existsSync(join(dir, 'gk.json'))).toBe(true);
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('DID db saved'));

        // Without this the 20s timer would keep the process alive.
        await db.stop();
    });

    it('fails fast when the data folder cannot be created', async () => {
        // Point the data folder through a file, so mkdir cannot succeed.
        const blocker = join(dir, 'a-file');
        writeFileSync(blocker, 'x');

        // The constructor calls loadDb(), which saves on the missing-file path — so
        // an unwritable folder surfaces at construction rather than being swallowed
        // later by saveLoop's catch.
        expect(() => new DbJsonCache('gk', join(blocker, 'sub'))).toThrow(/ENOTDIR|ENOENT/);
    });

    it('logs a save failure from the loop instead of throwing', async () => {
        const db = new DbJsonCache('gk', dir);
        try {
            // Make the next save fail by replacing the target with a directory.
            rmSync(join(dir, 'gk.json'));
            mkdirSync(join(dir, 'gk.json'));

            await expect(db.start()).resolves.toBeUndefined();
            expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Error in saveLoop'));
        } finally {
            // stop() rethrows the failed save, but must still cancel the timer —
            // otherwise the armed timeout keeps the process alive forever.
            await expect(db.stop()).rejects.toThrow();
        }
    });

    it('cancels the scheduled save even when the final save fails', async () => {
        const db = new DbJsonCache('gk', dir);
        await db.start();

        // Make the final save fail by replacing the target file with a directory.
        rmSync(join(dir, 'gk.json'));
        mkdirSync(join(dir, 'gk.json'));

        await expect(db.stop()).rejects.toThrow();

        // The timer is cleared regardless, so a second stop is a quiet no-op path.
        expect((db as any).saveLoopTimeoutId).toBeNull();
    });

    it('clears the cache and the file on reset', async () => {
        await withCache(async db => {
            await db.addEvent(DID, event('op1'));
            await db.stop(); // flush to disk
            expect(existsSync(join(dir, 'gk.json'))).toBe(true);

            const fresh = await db.resetDb();

            expect(fresh).toEqual({ dids: {} });
            await expect(db.getEvents(DID)).resolves.toEqual([]);
        });
    });
});
