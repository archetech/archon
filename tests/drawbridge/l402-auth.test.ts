import { jest } from '@jest/globals';
import { createHash } from 'crypto';

import { createL402Middleware, handlePaymentCompletion } from '../../services/drawbridge/server/src/middleware/l402-auth';
import type {
    DrawbridgeStore,
    L402Options,
    MacaroonRecord,
    PaymentRecord,
    PendingInvoiceData,
    RateLimitResult,
} from '../../services/drawbridge/server/src/types';

type MockResponse = {
    statusCode: number;
    headers: Map<string, string>;
    body: any;
    status: (code: number) => MockResponse;
    json: (payload: any) => MockResponse;
    setHeader: (name: string, value: string) => void;
    once: (event: string, handler: () => void) => void;
};

function createMockResponse(): MockResponse {
    return {
        statusCode: 200,
        headers: new Map(),
        body: undefined,
        status(code: number) {
            this.statusCode = code;
            return this;
        },
        json(payload: any) {
            this.body = payload;
            return this;
        },
        setHeader(name: string, value: string) {
            this.headers.set(name, value);
        },
        once() {
            // L402 auth only uses this hook on successful authenticated requests.
        },
    };
}

function createMockStore(): DrawbridgeStore {
    const macaroons = new Map<string, MacaroonRecord>();
    const payments: PaymentRecord[] = [];
    const rateLimitResult: RateLimitResult = {
        allowed: true,
        remaining: 100,
        resetAt: Math.floor(Date.now() / 1000) + 60,
    };

    return {
        saveMacaroon: jest.fn(async (record: MacaroonRecord) => {
            macaroons.set(record.id, record);
        }),
        getMacaroon: jest.fn(async (id: string) => macaroons.get(id) || null),
        revokeMacaroon: jest.fn(async (id: string) => {
            const record = macaroons.get(id);
            if (record) {
                macaroons.set(id, { ...record, revoked: true });
            }
        }),
        incrementUsage: jest.fn(async (id: string) => {
            const record = macaroons.get(id);
            const currentUses = (record?.currentUses || 0) + 1;
            if (record) {
                macaroons.set(id, { ...record, currentUses });
            }
            return currentUses;
        }),
        savePayment: jest.fn(async (record: PaymentRecord) => {
            payments.push(record);
        }),
        getPayment: jest.fn(async (id: string) => payments.find(payment => payment.id === id) || null),
        getPaymentsByDid: jest.fn(async (did: string) => payments.filter(payment => payment.did === did)),
        checkRateLimit: jest.fn(async () => rateLimitResult),
        recordRequest: jest.fn(async () => {}),
        checkAndRecordRequest: jest.fn(async () => rateLimitResult),
    };
}

function createOptions(store: DrawbridgeStore): L402Options {
    return {
        rootSecret: '0123456789abcdef0123456789abcdef',
        location: 'http://localhost:4222',
        lightningMediatorUrl: 'http://lightning-mediator.test',
        defaults: {
            amountSat: 10,
            expirySeconds: 3600,
            scopes: ['resolveDID', 'getDIDs'],
        },
        rateLimitRequests: 100,
        rateLimitWindowSeconds: 60,
        store,
        logger: {
            error: jest.fn(),
        },
    };
}

describe('Drawbridge L402 mediator integration', () => {
    let fetchMock: jest.SpiedFunction<typeof fetch>;

    beforeEach(() => {
        fetchMock = jest.spyOn(globalThis, 'fetch');
    });

    afterEach(() => {
        fetchMock.mockRestore();
        jest.clearAllMocks();
    });

    it('issues a challenge and saves pending invoice state through lightning-mediator', async () => {
        const store = createMockStore();
        const options = createOptions(store);
        const middleware = createL402Middleware(options);
        const req = {
            method: 'POST',
            path: '/api/v1/did/resolve',
            headers: {},
            ip: '127.0.0.1',
        } as any;
        const res = createMockResponse();
        const next = jest.fn();

        fetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify({
                paymentRequest: 'lnbc1challenge',
                paymentHash: 'a'.repeat(64),
                amountSat: 10,
                expiry: 3600,
                label: 'invoice-1',
            }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                ok: true,
                paymentHash: 'a'.repeat(64),
            }), { status: 201, headers: { 'Content-Type': 'application/json' } }));

        await middleware(req, res as any, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(402);
        expect(res.headers.get('WWW-Authenticate')).toContain('invoice="lnbc1challenge"');
        expect(res.body.paymentHash).toBe('a'.repeat(64));
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock.mock.calls[0]?.[0].toString()).toBe('http://lightning-mediator.test/api/v1/l402/invoice');
        expect(fetchMock.mock.calls[1]?.[0].toString()).toBe('http://lightning-mediator.test/api/v1/l402/pending');
        expect(store.saveMacaroon).toHaveBeenCalledTimes(1);
        expect(store.recordRequest).toHaveBeenCalledTimes(1);
    });

    it('completes payment using mediator-backed pending state and invoice status', async () => {
        const store = createMockStore();
        const options = createOptions(store);
        const req = {
            body: {},
        } as any;
        const res = createMockResponse();

        const preimage = '11'.repeat(32);
        const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
        req.body.paymentHash = paymentHash;
        const pendingInvoice: PendingInvoiceData = {
            paymentHash,
            macaroonId: 'mac-123',
            serializedMacaroon: 'serialized-macaroon',
            did: 'did:test:alice',
            scope: ['resolveDID'],
            amountSat: 21,
            expiresAt: Math.floor(Date.now() / 1000) + 300,
            createdAt: Math.floor(Date.now() / 1000),
        };

        fetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify(pendingInvoice), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                paid: true,
                preimage,
                paymentHash: pendingInvoice.paymentHash,
                amountSat: pendingInvoice.amountSat,
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                ok: true,
                paymentHash: pendingInvoice.paymentHash,
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }));

        await handlePaymentCompletion(options, req, res as any);

        expect(res.statusCode).toBe(200);
        expect(res.body).toMatchObject({
            macaroonId: 'mac-123',
            macaroon: 'serialized-macaroon',
            paymentHash: pendingInvoice.paymentHash,
            amountSat: 21,
            preimage,
        });
        expect(store.savePayment).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0]?.[0].toString()).toBe(`http://lightning-mediator.test/api/v1/l402/pending/${pendingInvoice.paymentHash}`);
        expect(fetchMock.mock.calls[1]?.[0].toString()).toBe('http://lightning-mediator.test/api/v1/l402/check');
        expect(fetchMock.mock.calls[2]?.[0].toString()).toBe(`http://lightning-mediator.test/api/v1/l402/pending/${pendingInvoice.paymentHash}`);
    });
});
