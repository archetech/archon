import { jest } from '@jest/globals';
import { createHash, randomBytes } from 'crypto';
import express from 'express';
import request from 'supertest';
import type { DrawbridgeStore, L402Options, MacaroonRecord } from '../../services/drawbridge/server/src/types.ts';

// The paywall as Drawbridge runs it: behind the router mounted at /api/v1, with
// the real pricing and macaroon code. Only the Lightning mediator is faked; its
// invoice has a known preimage, so a test can pay it and retry (#1600).
const PREIMAGE = randomBytes(32).toString('hex');
const PAYMENT_HASH = createHash('sha256').update(Buffer.from(PREIMAGE, 'hex')).digest('hex');

jest.unstable_mockModule('../../services/drawbridge/server/src/lightning-mediator-client.ts', () => ({
    createL402Invoice: jest.fn(async (_url: string, amountSat: number) => ({
        paymentRequest: `lnbc${amountSat}`, paymentHash: PAYMENT_HASH, amountSat, expiry: 3600, label: 'l',
    })),
    checkL402Invoice: jest.fn(),
    savePendingL402Invoice: jest.fn(async () => ({ ok: true })),
    getPendingL402Invoice: jest.fn(),
    deletePendingL402Invoice: jest.fn(),
}));

const { createL402Middleware } = await import('../../services/drawbridge/server/src/middleware/l402-auth.ts');

const ALLOWED = { allowed: true, remaining: 100, resetAt: Math.floor(Date.now() / 1000) + 60 };

function store(): DrawbridgeStore {
    const macaroons = new Map<string, MacaroonRecord>();
    return {
        saveMacaroon: jest.fn(async (record: MacaroonRecord) => { macaroons.set(record.id, record); }),
        getMacaroon: jest.fn(async (id: string) => macaroons.get(id) ?? null),
        revokeMacaroon: jest.fn(async () => {}),
        incrementUsage: jest.fn(async (id: string) => {
            const record = macaroons.get(id)!;
            macaroons.set(id, { ...record, currentUses: record.currentUses + 1 });
            return record.currentUses + 1;
        }),
        savePayment: jest.fn(async () => {}),
        getPayment: jest.fn(async () => null),
        getPaymentsByDid: jest.fn(async () => []),
        checkRateLimit: jest.fn(async () => ALLOWED),
        recordRequest: jest.fn(async () => {}),
        checkAndRecordRequest: jest.fn(async () => ALLOWED),
        checkAndRecordCost: jest.fn(async () => ALLOWED),
    } as any;
}

function app(pricing?: L402Options['pricing']) {
    const options: L402Options = {
        rootSecret: '0123456789abcdef0123456789abcdef',
        location: 'http://localhost:4222',
        lightningMediatorUrl: 'http://lightning-mediator.test',
        defaults: { amountSat: 10, expirySeconds: 3600, scopes: ['resolveDID', 'getDIDs', 'listRegistries', 'searchDIDs'] },
        rateLimitRequests: 100,
        rateLimitWindowSeconds: 60,
        store: store(),
        pricing,
    };
    const v1 = express.Router();
    v1.use(createL402Middleware(options));
    v1.post('/did', (_req, res) => { res.json({ served: 'createDID' }); });
    v1.post('/dids', (_req, res) => { res.json({ served: 'getDIDs' }); });
    const server = express();
    server.use('/api/v1', v1);
    return server;
}

async function payAndRetry(server: express.Express, path: string) {
    const challenge = await request(server).post(path).send({});
    expect(challenge.status).toBe(402);
    const retry = await request(server).post(path)
        .set('Authorization', `L402 ${challenge.body.macaroon}:${PREIMAGE}`)
        .send({});
    return { challenge, retry };
}

describe('the paywall behind the /api/v1 mount', () => {
    it("charges a priced operation's own price", async () => {
        const server = app({ operations: { createDID: { amountSat: 500, description: 'Register a new DID' } } });
        const challenge = await request(server).post('/api/v1/did').send({});

        expect(challenge.status).toBe(402);
        expect(challenge.body.amountSat).toBe(500);
        expect(challenge.body.operation).toBe('createDID');
        expect(challenge.headers['x-l402-price']).toBe('500');
    });

    it('serves a priced operation once its invoice is paid, and only once', async () => {
        const server = app({ operations: { createDID: { amountSat: 500, description: 'Register a new DID' } } });
        const { challenge, retry } = await payAndRetry(server, '/api/v1/did');
        expect(retry.status).toBe(200);
        expect(retry.body).toEqual({ served: 'createDID' });

        const again = await request(server).post('/api/v1/did')
            .set('Authorization', `L402 ${challenge.body.macaroon}:${PREIMAGE}`)
            .send({});
        expect(again.status).not.toBe(200);
    });

    it('prices and limits a mixed-case path as the route Express serves it on', async () => {
        const server = app({ operations: { createDID: { amountSat: 500, description: 'Register a new DID' } } });
        const { challenge, retry } = await payAndRetry(server, '/api/v1/DID');
        expect(challenge.body.amountSat).toBe(500);
        expect(challenge.body.operation).toBe('createDID');
        expect(retry.status).toBe(200);

        const again = await request(server).post('/API/V1/Did')
            .set('Authorization', `L402 ${challenge.body.macaroon}:${PREIMAGE}`)
            .send({});
        expect(again.status).not.toBe(200);
    });

    it('serves the request a default-priced pass was bought for', async () => {
        const server = app();
        const { challenge, retry } = await payAndRetry(server, '/api/v1/did');
        expect(challenge.body.amountSat).toBe(10);
        expect(retry.status).toBe(200);
        expect(retry.body).toEqual({ served: 'createDID' });
    });

    it('lets a default-priced pass cover the default scopes', async () => {
        const server = app();
        const { challenge } = await payAndRetry(server, '/api/v1/did');

        const other = await request(server).post('/api/v1/dids')
            .set('Authorization', `L402 ${challenge.body.macaroon}:${PREIMAGE}`)
            .send({});
        expect(other.status).toBe(200);
        expect(other.body).toEqual({ served: 'getDIDs' });
    });
});
