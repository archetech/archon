import DbRedis from '@didcid/gatekeeper/db/redis';
import type { Operation } from '@didcid/gatekeeper/types';

// Clearing part of a long queue used to delete the queue and then fail to push the
// rest back: one RPUSH cannot carry more than a few thousand entries. Everything
// not yet sent was lost (#1644).
//
// Opt-in, like the other live-Redis suites: set ARCHON_TEST_REDIS_URL to a
// throwaway Redis.
const describeLive = process.env.ARCHON_TEST_REDIS_URL ? describe : describe.skip;

const operation = (n: number) => ({ type: 'create', n, proof: { proofValue: `proof-${n}` } }) as unknown as Operation;
const numbers = (queue: Operation[]) => queue.map(entry => (entry as unknown as { n: number }).n);
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => from + index);

describeLive('DbRedis.clearQueue on a long queue', () => {
    const TOTAL = 20_000;
    let db: DbRedis;

    beforeAll(async () => {
        process.env.ARCHON_REDIS_URL = process.env.ARCHON_TEST_REDIS_URL;
        db = new DbRedis(`queue-test-${process.pid}-${Date.now()}`);
        await db.start();
    });

    afterAll(async () => {
        await db.resetDb();
        await db.stop();
    });

    it('keeps everything it was not asked to clear', async () => {
        for (const n of range(0, TOTAL)) await db.queueOperation('hyperswarm', operation(n));
        expect(await db.getQueue('hyperswarm')).toHaveLength(TOTAL);

        // The head of the queue, as a mediator clears it.
        expect(await db.clearQueue('hyperswarm', range(0, 1000).map(operation))).toBe(true);
        expect(numbers(await db.getQueue('hyperswarm'))).toEqual(range(1000, TOTAL));

        // Entries that are not the head, leaving far more than one call can push back.
        const scattered = range(1000, 3000).filter(n => n % 2 === 0);
        expect(await db.clearQueue('hyperswarm', scattered.map(operation))).toBe(true);
        const expected = range(1000, TOTAL).filter(n => n >= 3000 || n % 2 === 1);
        expect(numbers(await db.getQueue('hyperswarm'))).toEqual(expected);

        // Entries that are not queued change nothing.
        expect(await db.clearQueue('hyperswarm', [operation(TOTAL + 5)])).toBe(true);
        expect(await db.getQueue('hyperswarm')).toHaveLength(expected.length);

        expect(await db.clearQueue('hyperswarm', expected.map(operation))).toBe(true);
        expect(await db.getQueue('hyperswarm')).toEqual([]);
    }, 120_000);

    it('removes what was asked for when the head repeats an entry or the order differs', async () => {
        // A repeated entry at the head is not the sequence asked for. Trimming two
        // entries here would remove both copies of 1 and leave 2 queued.
        for (const n of [1, 1, 2, 3]) await db.queueOperation('hyperswarm', operation(n));
        expect(await db.clearQueue('hyperswarm', [1, 2].map(operation))).toBe(true);
        expect(numbers(await db.getQueue('hyperswarm'))).toEqual([3]);

        for (const n of [4, 5]) await db.queueOperation('hyperswarm', operation(n));
        expect(await db.clearQueue('hyperswarm', [4, 3].map(operation))).toBe(true);
        expect(numbers(await db.getQueue('hyperswarm'))).toEqual([5]);
        expect(await db.clearQueue('hyperswarm', [operation(5)])).toBe(true);
        expect(await db.getQueue('hyperswarm')).toEqual([]);
    });
});
