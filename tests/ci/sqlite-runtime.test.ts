import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';

// The sqlite adapters run on node:sqlite, so the SQLite engine now ships with
// Node instead of being pinned in a lockfile. That is the trade this replaced
// the sqlite3 and better-sqlite3 native modules for, and it moves one property
// out of the lockfile: nothing records which engine a build got.
//
// What keeps that reviewable is that every image and every CI job pins one
// exact Node version, so the engine can only change through a visible bump.
// These guards hold that arrangement in place.

const SQLITE_FLOOR = [3, 49, 0];
const NODE_SQLITE_FLOOR = '>=22.5.0';

function trackedFiles(pattern: string): string[] {
    return execSync(`git ls-files '${pattern}'`, { encoding: 'utf-8' }).split('\n').filter(Boolean);
}

function pinnedNodeVersions(): Map<string, Set<string>> {
    const pins = new Map<string, Set<string>>([['dockerfile', new Set()], ['workflow', new Set()]]);

    for (const file of trackedFiles('*Dockerfile*')) {
        for (const [, version] of readFileSync(file, 'utf-8').matchAll(/^FROM node:(\d+\.\d+\.\d+)/gm)) {
            pins.get('dockerfile')!.add(version);
        }
    }

    for (const file of trackedFiles('.github/workflows/*')) {
        for (const [, version] of readFileSync(file, 'utf-8').matchAll(/node-version:\s*['"]?(\d+\.\d+\.\d+)/g)) {
            pins.get('workflow')!.add(version);
        }
    }

    return pins;
}

describe('node:sqlite runtime', () => {
    it('provides a working database', () => {
        // Guard the guard: everything below is vacuous if the module is absent
        // or the build of Node running the suite lacks SQLite support.
        const db = new DatabaseSync(':memory:');
        db.exec('CREATE TABLE t (v TEXT)');
        db.prepare('INSERT INTO t VALUES (?)').run('ok');
        expect(db.prepare('SELECT v FROM t').get()).toMatchObject({ v: 'ok' });
        db.close();
    });

    it('bundles a SQLite no older than the one the adapters were written against', () => {
        // A newer Node is fine; silently going backwards is not, since these
        // are the adapters' storage guarantees and nothing else pins them.
        const db = new DatabaseSync(':memory:');
        const row = db.prepare('SELECT sqlite_version() AS v').get() as { v: string };
        db.close();

        const actual = row.v.split('.').map(Number);
        const atLeastFloor =
            actual[0] > SQLITE_FLOOR[0] ||
            (actual[0] === SQLITE_FLOOR[0] && actual[1] > SQLITE_FLOOR[1]) ||
            (actual[0] === SQLITE_FLOOR[0] && actual[1] === SQLITE_FLOOR[1] && actual[2] >= SQLITE_FLOOR[2]);

        expect(`${row.v} >= ${SQLITE_FLOOR.join('.')}: ${atLeastFloor}`).toBe(`${row.v} >= ${SQLITE_FLOOR.join('.')}: true`);
    });

    it('pins one Node version across every image and CI job', () => {
        // The engine follows Node, so a bump is the only way it can change.
        // One pin everywhere keeps that a single reviewable line rather than a
        // drift between what CI tests and what the images ship.
        const pins = pinnedNodeVersions();
        const all = new Set([...pins.get('dockerfile')!, ...pins.get('workflow')!]);

        expect(pins.get('dockerfile')!.size).toBeGreaterThan(0);
        expect(pins.get('workflow')!.size).toBeGreaterThan(0);
        expect([...all]).toHaveLength(1);
    });

    it('declares the Node floor node:sqlite needs on the packages that ship it', () => {
        // Both are published, and their sqlite backends will not load below
        // 22.5 -- without this, a consumer meets that as a module-not-found.
        for (const pkg of ['packages/gatekeeper', 'packages/keymaster']) {
            const manifest = JSON.parse(readFileSync(`${pkg}/package.json`, 'utf-8'));
            expect(`${pkg}: ${manifest.engines?.node}`).toBe(`${pkg}: ${NODE_SQLITE_FLOOR}`);
        }
    });
});
