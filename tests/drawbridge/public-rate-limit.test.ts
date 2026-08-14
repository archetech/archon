import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { publicRateLimit } from '../../services/drawbridge/server/src/middleware/public-rate-limit';
import type { DrawbridgeStore, RateLimitResult } from '../../services/drawbridge/server/src/types';

// A store that counts per key, so the two buckets can be driven independently
// rather than stubbed to a fixed verdict.
function countingStore(limits: Record<string, number> = {}) {
    const counts = new Map<string, number>();
    const keys: string[] = [];

    const store = {
        checkAndRecordRequest: jest.fn(async (key: string, max: number, windowSeconds: number): Promise<RateLimitResult> => {
            keys.push(key);
            const used = (counts.get(key) ?? 0) + 1;
            counts.set(key, used);
            const ceiling = limits[key] ?? max;
            return {
                allowed: used <= ceiling,
                remaining: Math.max(0, ceiling - used),
                resetAt: Math.floor(Date.now() / 1000) + windowSeconds,
            };
        }),
    } as unknown as DrawbridgeStore;

    return { store, keys, counts };
}

function mount(store: DrawbridgeStore, overrides: Record<string, number> = {}) {
    const app = express();
    app.use('/didcomm', publicRateLimit({
        store,
        name: 'didcomm',
        perSourceMax: 2,
        globalMax: 100,
        windowSeconds: 60,
        ...overrides,
    }), (req, res) => {
        res.json({ proxied: true });
    });
    return app;
}

describe('public rate limit middleware', () => {
    it('passes requests through under the limits', async () => {
        const { store } = countingStore();
        const response = await request(mount(store)).get('/didcomm/api/v1/challenge');

        expect(response.status).toBe(200);
        expect(response.body.proxied).toBe(true);
    });

    it('refuses with 429 and a Retry-After once a source exceeds its bucket', async () => {
        const { store } = countingStore();
        const app = mount(store);

        expect((await request(app).get('/didcomm/api/v1/challenge')).status).toBe(200);
        expect((await request(app).get('/didcomm/api/v1/challenge')).status).toBe(200);

        const refused = await request(app).get('/didcomm/api/v1/challenge');
        expect(refused.status).toBe(429);
        expect(refused.body.error).toBe('Rate limit exceeded');
        expect(refused.body.resetAt).toEqual(expect.any(Number));
        expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    });

    // Over Tor every request shares a source, so the per-source bucket cannot
    // see the flood at all. The global bucket is what still holds.
    it('refuses on the global bucket even when every request shares a source', async () => {
        const { store } = countingStore({ 'didcomm:global': 2 });
        const app = mount(store, { perSourceMax: 1_000_000 });

        expect((await request(app).get('/didcomm/api/v1/messages')).status).toBe(200);
        expect((await request(app).get('/didcomm/api/v1/messages')).status).toBe(200);
        expect((await request(app).get('/didcomm/api/v1/messages')).status).toBe(429);
    });

    it('keys the two buckets separately, and namespaces them by surface', async () => {
        const { store, keys } = countingStore();
        await request(mount(store)).get('/didcomm/api/v1/challenge');

        expect(keys.some(key => key.startsWith('didcomm:src:'))).toBe(true);
        expect(keys).toContain('didcomm:global');
    });

    // The limiter exists to protect availability. If its own store is down,
    // refusing everything would cause the outage it is meant to prevent -- and
    // the relay's storage caps still bound growth underneath.
    it('fails open when the store is unreachable', async () => {
        const store = {
            checkAndRecordRequest: jest.fn<any>().mockRejectedValue(new Error('redis is down')),
        } as unknown as DrawbridgeStore;
        const warn = jest.fn();

        const app = express();
        app.use('/didcomm', publicRateLimit({
            store,
            name: 'didcomm',
            perSourceMax: 1,
            globalMax: 1,
            windowSeconds: 60,
            logger: { warn } as any,
        }), (req, res) => {
            res.json({ proxied: true });
        });

        const response = await request(app).get('/didcomm/api/v1/challenge');

        expect(response.status).toBe(200);
        expect(warn).toHaveBeenCalled();
    });
});
