import { checkLimit, recordRequest } from '../../packages/l402/src/rate-limiter.js';
import { L402StoreMemory } from '../../packages/l402/src/store-memory.js';

describe('L402 Rate Limiter', () => {
    let store: L402StoreMemory;

    beforeEach(() => {
        store = new L402StoreMemory();
    });

    describe('checkLimit', () => {
        it('should allow requests under the limit', async () => {
            const result = await checkLimit(store, 'did:cid:test', 10, 3600);
            expect(result.allowed).toBe(true);
            expect(result.remaining).toBe(10);
        });

        it('should deny requests at the limit', async () => {
            // Record 10 requests
            for (let i = 0; i < 10; i++) {
                await recordRequest(store, 'did:cid:test', 3600);
            }

            const result = await checkLimit(store, 'did:cid:test', 10, 3600);
            expect(result.allowed).toBe(false);
            expect(result.remaining).toBe(0);
        });

        it('should track remaining correctly', async () => {
            for (let i = 0; i < 3; i++) {
                await recordRequest(store, 'did:cid:test', 3600);
            }

            const result = await checkLimit(store, 'did:cid:test', 10, 3600);
            expect(result.allowed).toBe(true);
            expect(result.remaining).toBe(7);
        });

        it('should track DIDs independently', async () => {
            for (let i = 0; i < 5; i++) {
                await recordRequest(store, 'did:cid:alice', 3600);
            }

            const aliceResult = await checkLimit(store, 'did:cid:alice', 10, 3600);
            expect(aliceResult.remaining).toBe(5);

            const bobResult = await checkLimit(store, 'did:cid:bob', 10, 3600);
            expect(bobResult.remaining).toBe(10);
        });

        it('should provide a resetAt timestamp', async () => {
            const result = await checkLimit(store, 'did:cid:test', 10, 3600);
            expect(result.resetAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
        });
    });

    describe('recordRequest', () => {
        it('should increment the counter', async () => {
            await recordRequest(store, 'did:cid:test', 3600);

            const result = await checkLimit(store, 'did:cid:test', 10, 3600);
            expect(result.remaining).toBe(9);
        });

        it('should handle multiple requests', async () => {
            for (let i = 0; i < 5; i++) {
                await recordRequest(store, 'did:cid:test', 3600);
            }

            const result = await checkLimit(store, 'did:cid:test', 10, 3600);
            expect(result.remaining).toBe(5);
        });
    });
});
