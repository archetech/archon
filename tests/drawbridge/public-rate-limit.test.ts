import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { publicRateLimit, isMeaningfulSource } from '../../services/drawbridge/server/src/middleware/public-rate-limit.ts';
import type { DrawbridgeStore, RateLimitResult } from '../../services/drawbridge/server/src/types.ts';

// A store that actually counts, so the buckets can be driven independently
// rather than stubbed to a fixed verdict.
function countingStore(limits: Record<string, number> = {}) {
    const spent = new Map<string, number>();
    const keys: string[] = [];

    function charge(key: string, cost: number, max: number, windowSeconds: number): RateLimitResult {
        keys.push(key);
        const used = (spent.get(key) ?? 0) + cost;
        spent.set(key, used);
        const ceiling = limits[key] ?? max;
        return {
            allowed: used <= ceiling,
            remaining: Math.max(0, ceiling - used),
            resetAt: Math.floor(Date.now() / 1000) + windowSeconds,
        };
    }

    const store = {
        checkAndRecordRequest: jest.fn(async (key: string, max: number, win: number) => charge(key, 1, max, win)),
        checkAndRecordCost: jest.fn(async (key: string, cost: number, max: number, win: number) => charge(key, cost, max, win)),
    } as unknown as DrawbridgeStore;

    return { store, keys, spent };
}

const BASE = {
    name: 'didcomm',
    readPerSourceMax: 2,
    readGlobalMax: 100,
    depositPerSourceBytes: 1000,
    depositGlobalBytes: 5000,
    windowSeconds: 60,
};

function mount(store: DrawbridgeStore, overrides: Record<string, unknown> = {}) {
    const app = express();
    app.use(express.json());
    app.use('/didcomm', publicRateLimit({ store, ...BASE, ...overrides } as any), (req, res) => {
        res.json({ proxied: true });
    });
    return app;
}

describe('isMeaningfulSource', () => {
    // `trust proxy` is not configured, so a request through the bundled Tor
    // container or any reverse proxy arrives from a private address. Keying a
    // per-source bucket on that would throttle every such client together.
    it.each(['127.0.0.1', '::1', '10.1.2.3', '172.16.0.9', '192.168.1.5', '169.254.1.1', '100.64.0.1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', 'unknown', ''])(
        'treats %s as not identifying a client', (ip) => {
            expect(isMeaningfulSource(ip)).toBe(false);
        });

    it.each(['8.8.8.8', '203.0.113.9', '2001:db8::1', '::ffff:8.8.8.8'])(
        'treats %s as a real source', (ip) => {
            expect(isMeaningfulSource(ip)).toBe(true);
        });
});

describe('public rate limit middleware', () => {
    it('passes requests through under the limits', async () => {
        const { store } = countingStore();
        const response = await request(mount(store)).get('/didcomm/api/v1/challenge');

        expect(response.status).toBe(200);
        expect(response.body.proxied).toBe(true);
    });

    // Supertest connects over loopback, so the source is never meaningful here;
    // only the global buckets apply. That is the shared-ingress case itself.
    it('applies only the global bucket when the source does not identify a client', async () => {
        const { store, keys } = countingStore();
        await request(mount(store)).get('/didcomm/api/v1/challenge');

        expect(keys).toContain('didcomm:read:global');
        expect(keys.some(key => key.includes(':src:'))).toBe(false);
    });

    it('refuses reads with 429 and a Retry-After once the global bucket is spent', async () => {
        const { store } = countingStore({ 'didcomm:read:global': 2 });
        const app = mount(store);

        expect((await request(app).get('/didcomm/api/v1/challenge')).status).toBe(200);
        expect((await request(app).get('/didcomm/api/v1/challenge')).status).toBe(200);

        const refused = await request(app).get('/didcomm/api/v1/challenge');
        expect(refused.status).toBe(429);
        expect(refused.body.error).toBe('Rate limit exceeded');
        expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    });

    // The point of the byte budget: a request-count ceiling generous enough for
    // normal traffic still lets a handful of max-size envelopes through, and a
    // handful is all it takes to fill the relay's storage cap.
    it('charges deposits by size, so few large ones exhaust the budget', async () => {
        const { store, spent } = countingStore();
        const app = mount(store, { depositGlobalBytes: 3000 });
        const big = 'x'.repeat(1200);

        expect((await request(app).post('/didcomm/api/v1/messages').send({ message: big })).status).toBe(200);
        expect((await request(app).post('/didcomm/api/v1/messages').send({ message: big })).status).toBe(200);

        const refused = await request(app).post('/didcomm/api/v1/messages').send({ message: big });
        expect(refused.status).toBe(429);

        // Three requests, but the budget was spent in bytes, not in requests.
        expect(spent.get('didcomm:deposit:global')).toBeGreaterThan(3000);
    });

    it('keeps cheap polling on a separate budget from deposits', async () => {
        const { store, keys } = countingStore();
        const app = mount(store);

        await request(app).get('/didcomm/api/v1/challenge');
        await request(app).post('/didcomm/api/v1/messages').send({ message: 'hello' });

        expect(keys).toContain('didcomm:read:global');
        expect(keys).toContain('didcomm:deposit:global');
    });

    it('keys a real public source separately, in addition to the global bucket', async () => {
        const { store, keys } = countingStore();
        const app = express();
        // Stand in for a client whose address actually identifies it.
        app.use((req, _res, nextFn) => { Object.defineProperty(req, 'ip', { value: '203.0.113.9' }); nextFn(); });
        app.use('/didcomm', publicRateLimit({ store, ...BASE } as any), (_req, res) => res.json({ proxied: true }));

        await request(app).get('/didcomm/api/v1/challenge');

        expect(keys).toContain('didcomm:read:src:203.0.113.9');
        expect(keys).toContain('didcomm:read:global');
    });

    // The limiter exists to protect availability. If its own store is down,
    // refusing everything would cause the outage it is meant to prevent.
    it('fails open when the store is unreachable', async () => {
        const store = {
            checkAndRecordRequest: jest.fn<any>().mockRejectedValue(new Error('redis is down')),
            checkAndRecordCost: jest.fn<any>().mockRejectedValue(new Error('redis is down')),
        } as unknown as DrawbridgeStore;
        const warn = jest.fn();

        const app = mount(store, { logger: { warn } });
        const response = await request(app).get('/didcomm/api/v1/challenge');

        expect(response.status).toBe(200);
        expect(warn).toHaveBeenCalled();
    });
});

// parseInt('invalid') is NaN; NaN reaches the limiter's Lua as a nil, the
// comparison there throws, and the middleware's fail-open path then lets
// everything through -- the bound switched off by a typo. A zero or negative
// window expires the counter immediately, which disables it just as quietly.
describe('drawbridge rate limit config validation', () => {
    const numeric = [
        'ARCHON_DRAWBRIDGE_RATE_LIMIT_MAX',
        'ARCHON_DRAWBRIDGE_RATE_LIMIT_WINDOW',
        'ARCHON_DRAWBRIDGE_DIDCOMM_READ_PER_SOURCE',
        'ARCHON_DRAWBRIDGE_DIDCOMM_READ_GLOBAL',
        'ARCHON_DRAWBRIDGE_DIDCOMM_DEPOSIT_PER_SOURCE_BYTES',
        'ARCHON_DRAWBRIDGE_DIDCOMM_DEPOSIT_GLOBAL_BYTES',
        'ARCHON_DRAWBRIDGE_DIDCOMM_RATE_LIMIT_WINDOW',
    ];

    async function loadWith(name: string, value: string) {
        const previous = process.env[name];
        process.env[name] = value;
        try {
            await import(`../../services/drawbridge/server/src/config?bad=${name}${encodeURIComponent(value)}`);
            return null;
        }
        catch (error: any) {
            return error.message as string;
        }
        finally {
            if (previous === undefined) {
                delete process.env[name];
            }
            else {
                process.env[name] = previous;
            }
        }
    }

    it.each(numeric)('rejects a non-numeric %s at startup', async (name) => {
        expect(await loadWith(name, 'invalid')).toContain(name);
    });

    it.each(numeric)('rejects a zero or negative %s at startup', async (name) => {
        expect(await loadWith(name, '0')).toContain(name);
        expect(await loadWith(name, '-5')).toContain(name);
    });
});
