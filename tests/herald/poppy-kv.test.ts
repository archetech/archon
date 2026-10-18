import { MemoryKV, RedisKV, type PoppyKV } from '../../services/herald/server/src/poppy/kv.ts';

// The atomic operations Poppy's state transitions rely on, checked against
// both stores so memory mode cannot pass on behaviour Redis does not have.
// The Redis run is opt-in, like the other live-Redis suites: set
// ARCHON_REDIS_URL to a disposable Redis 7 or later (EXPIRE GT/NX).

function contract(name: string, make: () => PoppyKV, close: (kv: PoppyKV) => Promise<void> = async () => {}) {
    describe(name, () => {
        let kv: PoppyKV;
        let prefix: string;

        beforeAll(() => {
            kv = make();
        });

        afterAll(async () => {
            await close(kv);
        });

        beforeEach(() => {
            prefix = `t${Math.random().toString(36).slice(2)}`;
        });

        it('claims a key once', async () => {
            expect(await kv.setIfAbsent(`${prefix}:a`, '1', 60)).toBe(true);
            expect(await kv.setIfAbsent(`${prefix}:a`, '2', 60)).toBe(false);
            expect(await kv.get(`${prefix}:a`)).toBe('1');
        });

        it('replaces only a key that still exists', async () => {
            expect(await kv.setIfPresent(`${prefix}:b`, '1', 60)).toBe(false);
            expect(await kv.get(`${prefix}:b`)).toBeNull();
            await kv.set(`${prefix}:b`, '1', 60);
            expect(await kv.setIfPresent(`${prefix}:b`, '2', 60)).toBe(true);
            expect(await kv.get(`${prefix}:b`)).toBe('2');
        });

        it('hands a taken value to exactly one caller', async () => {
            await kv.set(`${prefix}:c`, 'v', 60);
            const results = await Promise.all([kv.take(`${prefix}:c`), kv.take(`${prefix}:c`), kv.take(`${prefix}:c`)]);
            expect(results.filter(value => value === 'v')).toHaveLength(1);
        });

        it('deletes only while the key holds the expected value', async () => {
            await kv.set(`${prefix}:d`, 'b', 60);
            expect(await kv.deleteIfEquals(`${prefix}:d`, 'a')).toBe(false);
            expect(await kv.get(`${prefix}:d`)).toBe('b');
            expect(await kv.deleteIfEquals(`${prefix}:d`, 'b')).toBe(true);
            expect(await kv.get(`${prefix}:d`)).toBeNull();
        });

        it('expires a set after its lifetime, keeping the longer of two', async () => {
            await kv.addToSet(`${prefix}:e`, 'x', 3);
            await kv.addToSet(`${prefix}:e`, 'y', 1);
            await new Promise(resolve => setTimeout(resolve, 1500));
            expect((await kv.members(`${prefix}:e`)).sort()).toEqual(['x', 'y']);
        });

        it('keeps set members, removes them, and deletes the set like any key', async () => {
            await kv.addToSet(`${prefix}:s`, 'x', 60);
            await kv.addToSet(`${prefix}:s`, 'y', 60);
            await kv.removeFromSet(`${prefix}:s`, 'x');
            expect(await kv.members(`${prefix}:s`)).toEqual(['y']);
            await kv.del(`${prefix}:s`);
            expect(await kv.members(`${prefix}:s`)).toEqual([]);
        });
    });
}

contract('MemoryKV', () => new MemoryKV());

const redisUrl = process.env.ARCHON_REDIS_URL;
if (redisUrl) {
    contract('RedisKV (live redis)', () => new RedisKV(redisUrl, `poppy-test-${Date.now()}`), kv => kv.close!());
} else {
    describe.skip('RedisKV (live redis)', () => {
        it('needs ARCHON_REDIS_URL', () => {});
    });
}

describe('MemoryKV expiry', () => {
    it('expires a set with its lifetime, extended by later adds', async () => {
        let now = 1_000_000;
        const kv = new MemoryKV(() => now);
        await kv.addToSet('s', 'a', 60);
        now += 30_000;
        await kv.addToSet('s', 'b', 60);
        now += 45_000;
        expect((await kv.members('s')).sort()).toEqual(['a', 'b']);
        now += 20_000;
        expect(await kv.members('s')).toEqual([]);
    });
});
