import { jest } from '@jest/globals';
import express from 'express';
import http from 'http';
import request from 'supertest';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { gzipSync } from 'zlib';

import { cashuProxyHandlers } from '../../services/drawbridge/server/src/cashu-proxy.ts';
import type { DrawbridgeStore, RateLimitResult } from '../../services/drawbridge/server/src/types.ts';

// Drawbridge's /cashu route as deployed: the public rate limit in front of the
// proxy, forwarding to a stand-in mint that records what reaches it.

const ADMIN_KEY = 'test-admin-key';

const INFO = {
    name: 'Archon mint',
    version: 'cdk-mintd/0.18.3',
    nuts: {
        4: { methods: [{ method: 'bolt11', unit: 'sat' }], disabled: false },
        7: { supported: true },
        17: { supported: [{ method: 'bolt11', unit: 'sat', commands: ['bolt11_mint_quote'] }] },
    },
};

let mint: Server;
let mintURL: string;
let received: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[];
let charged: string[];
let allowed: boolean;

function store(): DrawbridgeStore {
    const charge = async (key: string): Promise<RateLimitResult> => {
        charged.push(key);
        return { allowed, remaining: allowed ? 1 : 0, resetAt: Math.floor(Date.now() / 1000) + 60 };
    };
    return {
        checkAndRecordRequest: jest.fn(charge),
        checkAndRecordCost: jest.fn(charge),
    } as unknown as DrawbridgeStore;
}

function drawbridge(cashuMintURL = mintURL) {
    const app = express();
    app.use(express.json());
    const { rateLimit, proxy } = cashuProxyHandlers({
        store: store(),
        config: {
            cashuMintURL,
            cashuPerSource: 10,
            cashuGlobal: 100,
            cashuRateLimitWindow: 60,
            adminApiKey: ADMIN_KEY,
        },
        logger: { warn: jest.fn(), error: jest.fn() },
    });
    app.use('/cashu', rateLimit, proxy);
    return app;
}

beforeAll(async () => {
    mint = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            received.push({ method: req.method!, url: req.url!, headers: req.headers, body });
            res.setHeader('Content-Type', 'application/json');
            if (req.url === '/v1/info') {
                res.end(JSON.stringify(INFO));
                return;
            }
            // As cdk-mintd does for a browser over HTTPS. Node's fetch cannot decode it.
            if (req.url === '/v1/keysets' && /zstd/.test(String(req.headers['accept-encoding']))) {
                res.setHeader('Content-Encoding', 'zstd');
                res.end(Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00]));
                return;
            }
            if (req.url === '/v1/compressed' && /gzip/.test(String(req.headers['accept-encoding']))) {
                res.setHeader('Content-Encoding', 'gzip');
                res.end(gzipSync(JSON.stringify({ ok: true })));
                return;
            }
            res.end(JSON.stringify({ ok: true }));
        });
    });
    mint.listen(0, '127.0.0.1');
    await new Promise(resolve => mint.once('listening', resolve));
    mintURL = `http://127.0.0.1:${(mint.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise(resolve => mint.close(resolve));
});

beforeEach(() => {
    received = [];
    charged = [];
    allowed = true;
});

describe('the /cashu mint proxy', () => {
    it('forwards the mint API with the /cashu prefix removed', async () => {
        const app = drawbridge();

        expect((await request(app).get('/cashu/v1/info')).status).toBe(200);
        const quote = await request(app).post('/cashu/v1/mint/quote/bolt11').send({ amount: 100, unit: 'sat' });

        expect(quote.status).toBe(200);
        expect(received.map(({ method, url }) => `${method} ${url}`))
            .toEqual(['GET /v1/info', 'POST /v1/mint/quote/bolt11']);
        expect(JSON.parse(received[1].body)).toEqual({ amount: 100, unit: 'sat' });
    });

    it.each(['/cashu/', '/cashu/metrics', '/cashu/v1/../admin', '/cashu/v1/%2e%2e/admin', '/cashu//evil.example/v1/info'])(
        'refuses %s, which is not the mint API', async path => {
            const response = await request(drawbridge()).get(path);

            expect(response.status).toBe(400);
            expect(received).toEqual([]);
        });

    it('charges ordinary requests to the cashu budget', async () => {
        await request(drawbridge()).get('/cashu/v1/keysets');

        // Loopback is not a meaningful source, so only the global bucket.
        expect(charged).toEqual(['cashu:read:global']);
    });

    it('refuses a request over the limit before it reaches the mint', async () => {
        allowed = false;
        const response = await request(drawbridge()).get('/cashu/v1/keysets');

        expect(response.status).toBe(429);
        expect(received).toEqual([]);
    });

    it('does not limit the admin key, and does not pass it to the mint', async () => {
        allowed = false;
        const response = await request(drawbridge()).get('/cashu/v1/keysets').set('X-Archon-Admin-Key', ADMIN_KEY);

        expect(response.status).toBe(200);
        expect(charged).toEqual([]);
        expect(received[0].headers['x-archon-admin-key']).toBeUndefined();
    });

    it('limits a request with the wrong admin key', async () => {
        allowed = false;
        const response = await request(drawbridge()).get('/cashu/v1/keysets').set('X-Archon-Admin-Key', 'wrong');

        expect(response.status).toBe(429);
        expect(charged).toEqual(['cashu:read:global']);
    });

    it('passes on a compressed response as the plain body it read, without the encoding header', async () => {
        const response = await request(drawbridge()).get('/cashu/v1/compressed').set('Accept-Encoding', 'gzip');

        expect(response.status).toBe(200);
        expect(response.headers['content-encoding']).toBeUndefined();
        expect(response.body).toEqual({ ok: true });
    });

    it('does not ask the mint for an encoding it could not read', async () => {
        const response = await request(drawbridge()).get('/cashu/v1/keysets').set('Accept-Encoding', 'gzip, deflate, br, zstd');

        expect(response.status).toBe(200);
        expect(received[0].headers['accept-encoding']).not.toMatch(/zstd/);
        expect(response.body).toEqual({ ok: true });
    });

    it.each(['/cashu/v1/info', '/cashu/v1/info?x=1', '/cashu/v1/./info'])(
        'serves the mint info from %s without NUT-17, which it cannot carry', async path => {
            const response = await request(drawbridge()).get(path);

            expect(response.status).toBe(200);
            const { 17: _ws, ...nuts } = INFO.nuts;
            expect(response.body).toEqual({ ...INFO, nuts });
        });

    it('answers 501 when the node runs no mint', async () => {
        const response = await request(drawbridge('')).get('/cashu/v1/info');

        expect(response.status).toBe(501);
        expect(response.body).toEqual({ error: 'Cashu is not enabled on this node' });
    });

    it('answers 502 when the mint is down', async () => {
        const response = await request(drawbridge('http://127.0.0.1:1')).get('/cashu/v1/info');

        expect(response.status).toBe(502);
    });
});
