import { jest } from '@jest/globals';
import DbRedis from '@didcid/gatekeeper/db/redis';

// Listing DIDs must not use KEYS, which blocks Redis while it walks every key
// in the database, block checkpoints included (#1407).

function fakeRedis(keys: string[], pageSize: number) {
    // SCAN pages through the keyspace and may return a key more than once.
    const scan = jest.fn(async (cursor: string, ...args: unknown[]) => {
        const pattern = String(args[args.indexOf('MATCH') + 1]);
        const prefix = pattern.replace(/\*$/, '');
        const start = Number(cursor);
        const page = keys.slice(start, start + pageSize).filter(key => key.startsWith(prefix));
        const next = start + pageSize >= keys.length ? '0' : String(start + pageSize);
        return [next, start > 0 && page.length ? [page[0], ...page] : page];
    });
    const forbidden = jest.fn(async () => { throw new Error('KEYS must not be used'); });
    return { scan, keys: forbidden };
}

describe('DbRedis.getAllKeys', () => {
    it('collects every DID with SCAN, once each, among other keys', async () => {
        const keys = [
            ...Array.from({ length: 30 }, (_, i) => `archon/registry/SOL:mainnet-beta/blocks/hash-${i}`),
            'archon/dids/aaa',
            'archon/ops/op1',
            'archon/dids/bbb',
            ...Array.from({ length: 30 }, (_, i) => `archon/registry/ZEC:mainnet/blocks/hash-${i}`),
            'archon/dids/ccc',
        ];
        const redis = fakeRedis(keys, 7);
        const db = new DbRedis('archon');
        (db as any).redis = redis;

        expect((await db.getAllKeys()).sort()).toEqual(['aaa', 'bbb', 'ccc']);
        expect(redis.keys).not.toHaveBeenCalled();
        expect(redis.scan.mock.calls.length).toBeGreaterThan(1);
        expect(redis.scan.mock.calls[0]).toEqual(['0', 'MATCH', 'archon/dids/*', 'COUNT', 10_000]);
    });

    it('returns no DIDs from an empty database', async () => {
        const redis = fakeRedis([], 10);
        const db = new DbRedis('archon');
        (db as any).redis = redis;

        expect(await db.getAllKeys()).toEqual([]);
    });
});

// Opt-in, like the other live-Redis suites: set ARCHON_TEST_REDIS_URL to a
// disposable Redis. The suite flushes the namespace it uses.
const describeLive = process.env.ARCHON_TEST_REDIS_URL ? describe : describe.skip;

describeLive('DbRedis.getAllKeys (live redis)', () => {
    const name = `scan-test-${Date.now()}`;
    let db: DbRedis;
    const previous = process.env.ARCHON_REDIS_URL;

    beforeAll(async () => {
        process.env.ARCHON_REDIS_URL = process.env.ARCHON_TEST_REDIS_URL;
        db = new DbRedis(name);
        await db.start();
    });

    afterAll(async () => {
        await db.resetDb();
        await db.stop();
        if (previous === undefined) delete process.env.ARCHON_REDIS_URL;
        else process.env.ARCHON_REDIS_URL = previous;
    });

    it('lists DIDs without KEYS among thousands of block keys', async () => {
        const redis = (db as any).redis;
        const pipeline = redis.pipeline();
        for (let i = 0; i < 25_000; i++) {
            pipeline.set(`${name}/registry/SOL:mainnet-beta/blocks/hash-${i}`, '{}');
        }
        await pipeline.exec();
        await db.addEvent('did:cid:alpha', { registry: 'local', time: '2026-01-01T00:00:00Z', ordinal: [0] } as any);
        await db.addEvent('did:cid:beta', { registry: 'local', time: '2026-01-01T00:00:00Z', ordinal: [0] } as any);

        await redis.config('RESETSTAT');
        expect((await db.getAllKeys()).sort()).toEqual(['alpha', 'beta']);
        const stats: string = await redis.info('commandstats');
        expect(stats).not.toContain('cmdstat_keys:');
        expect(stats).toContain('cmdstat_scan:');
    });
});
