import { jest } from '@jest/globals';
import type {
    DrawbridgeStore,
    L402Options,
    MacaroonRecord,
    PaymentRecord,
    PendingInvoiceData,
    RateLimitResult,
} from '../../services/drawbridge/server/src/types';

const mockCreateMacaroon = jest.fn();
const mockVerifyMacaroon = jest.fn();
const mockExtractCaveats = jest.fn();
const mockGetMacaroonId = jest.fn();
const mockVerifyPreimage = jest.fn();
const mockCheckLimit = jest.fn();
const mockCheckAndRecordRequest = jest.fn();
const mockRouteToScope = jest.fn();
const mockGetPriceForOperation = jest.fn();
const mockCreateL402Invoice = jest.fn();
const mockCheckL402Invoice = jest.fn();
const mockSavePendingL402Invoice = jest.fn();
const mockGetPendingL402Invoice = jest.fn();
const mockDeletePendingL402Invoice = jest.fn();

jest.unstable_mockModule('../../services/drawbridge/server/src/macaroon', () => ({
    createMacaroon: mockCreateMacaroon,
    verifyMacaroon: mockVerifyMacaroon,
    extractCaveats: mockExtractCaveats,
    getMacaroonId: mockGetMacaroonId,
    verifyPreimage: mockVerifyPreimage,
}));

jest.unstable_mockModule('../../services/drawbridge/server/src/rate-limiter', () => ({
    checkLimit: mockCheckLimit,
    checkAndRecordRequest: mockCheckAndRecordRequest,
}));

jest.unstable_mockModule('../../services/drawbridge/server/src/pricing', () => ({
    routeToScope: mockRouteToScope,
    getPriceForOperation: mockGetPriceForOperation,
}));

jest.unstable_mockModule('../../services/drawbridge/server/src/lightning-mediator-client', () => ({
    createL402Invoice: mockCreateL402Invoice,
    checkL402Invoice: mockCheckL402Invoice,
    savePendingL402Invoice: mockSavePendingL402Invoice,
    getPendingL402Invoice: mockGetPendingL402Invoice,
    deletePendingL402Invoice: mockDeletePendingL402Invoice,
}));

const {
    createL402Middleware,
    handlePaymentCompletion,
    handleRevokeMacaroon,
    handleL402Status,
    handleGetPayments,
} = await import('../../services/drawbridge/server/src/middleware/l402-auth');
const {
    DrawbridgeError,
    PaymentRequiredError,
    InvalidMacaroonError,
    MacaroonRevokedError,
    PaymentVerificationError,
    RateLimitExceededError,
    InsufficientScopeError,
    LightningUnavailableError,
} = await import('../../services/drawbridge/server/src/errors');

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
    beforeEach(() => {
        jest.clearAllMocks();
        mockCreateMacaroon.mockReturnValue({ id: 'mac-123', macaroon: 'serialized-macaroon' });
        mockVerifyMacaroon.mockReturnValue({ valid: true });
        mockExtractCaveats.mockReturnValue({ paymentHash: 'a'.repeat(64) });
        mockGetMacaroonId.mockReturnValue('mac-123');
        mockVerifyPreimage.mockReturnValue(true);
        mockCheckLimit.mockResolvedValue({
            allowed: true,
            remaining: 100,
            resetAt: Math.floor(Date.now() / 1000) + 60,
        });
        mockCheckAndRecordRequest.mockResolvedValue({
            allowed: true,
            remaining: 100,
            resetAt: Math.floor(Date.now() / 1000) + 60,
        });
        mockRouteToScope.mockReturnValue('resolveDID');
        mockGetPriceForOperation.mockReturnValue(undefined);
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

        mockCreateL402Invoice.mockResolvedValue({
            paymentRequest: 'lnbc1challenge',
            paymentHash: 'a'.repeat(64),
            amountSat: 10,
            expiry: 3600,
            label: 'invoice-1',
        });
        mockSavePendingL402Invoice.mockResolvedValue({
            ok: true,
            paymentHash: 'a'.repeat(64),
        });

        await middleware(req, res as any, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(402);
        expect(res.headers.get('WWW-Authenticate')).toContain('invoice="lnbc1challenge"');
        expect(res.body.paymentHash).toBe('a'.repeat(64));
        expect(mockCreateL402Invoice).toHaveBeenCalledWith(
            'http://lightning-mediator.test',
            10,
            'Drawbridge: resolveDID (10 sats)'
        );
        expect(mockSavePendingL402Invoice).toHaveBeenCalledTimes(1);
        expect(store.saveMacaroon).toHaveBeenCalledTimes(1);
        expect(store.recordRequest).toHaveBeenCalledTimes(1);
    });

    it('skips L402 for unprotected routes', async () => {
        const store = createMockStore();
        const middleware = createL402Middleware(createOptions(store));
        const req = {
            method: 'GET',
            path: '/api/v1/status',
            headers: {},
        } as any;
        const res = createMockResponse();
        const next = jest.fn();

        await middleware(req, res as any, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(mockCreateL402Invoice).not.toHaveBeenCalled();
    });

    it('skips L402 when subscription auth already succeeded', async () => {
        const store = createMockStore();
        const middleware = createL402Middleware(createOptions(store));
        const req = {
            method: 'POST',
            path: '/api/v1/did/resolve',
            headers: {},
            subscriptionAuth: true,
        } as any;
        const res = createMockResponse();
        const next = jest.fn();

        await middleware(req, res as any, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(mockCreateL402Invoice).not.toHaveBeenCalled();
    });

    it('returns 429 when issuing a challenge would exceed rate limits', async () => {
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

        mockCheckLimit.mockResolvedValue({
            allowed: false,
            remaining: 0,
            resetAt: 12345,
        });

        await middleware(req, res as any, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(429);
        expect(res.body).toEqual({
            error: 'Rate limit exceeded',
            resetAt: 12345,
        });
    });

    it('treats malformed auth headers as no auth and issues a challenge', async () => {
        const store = createMockStore();
        const middleware = createL402Middleware(createOptions(store));
        const req = {
            method: 'POST',
            path: '/api/v1/did/resolve',
            headers: {
                authorization: 'Bearer nope',
            },
            ip: '127.0.0.1',
        } as any;
        const res = createMockResponse();

        mockCreateL402Invoice.mockResolvedValueOnce({
            paymentRequest: 'lnbc1challenge',
            paymentHash: 'a'.repeat(64),
            amountSat: 10,
            expiry: 3600,
            label: 'invoice-1',
        });
        mockSavePendingL402Invoice.mockResolvedValueOnce({
            ok: true,
            paymentHash: 'a'.repeat(64),
        });

        await middleware(req, res as any, jest.fn());

        expect(res.statusCode).toBe(402);
        expect(res.body.error).toBe('Payment required');
    });

    it('treats malformed L402 headers without a proof separator as no auth', async () => {
        const store = createMockStore();
        const middleware = createL402Middleware(createOptions(store));
        const req = {
            method: 'POST',
            path: '/api/v1/did/resolve',
            headers: {
                authorization: 'L402 missing-colon',
            },
            ip: '127.0.0.1',
        } as any;
        const res = createMockResponse();

        mockCreateL402Invoice.mockResolvedValueOnce({
            paymentRequest: 'lnbc1challenge',
            paymentHash: 'a'.repeat(64),
            amountSat: 10,
            expiry: 3600,
            label: 'invoice-1',
        });
        mockSavePendingL402Invoice.mockResolvedValueOnce({
            ok: true,
            paymentHash: 'a'.repeat(64),
        });

        await middleware(req, res as any, jest.fn());

        expect(res.statusCode).toBe(402);
        expect(res.body.error).toBe('Payment required');
    });

    it('returns 401 when an L402 macaroon has no stored record', async () => {
        const store = createMockStore();
        const middleware = createL402Middleware(createOptions(store));
        const req = {
            method: 'POST',
            path: '/api/v1/did/resolve',
            headers: {
                authorization: 'L402 serialized-macaroon:proof',
            },
            ip: '127.0.0.1',
        } as any;
        const res = createMockResponse();
        const next = jest.fn();

        await middleware(req, res as any, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({ error: 'Invalid macaroon: No macaroon record found' });
    });

    it('returns 401 when an L402 macaroon is revoked', async () => {
        const store = createMockStore();
        const options = createOptions(store);
        const middleware = createL402Middleware(options);
        const req = {
            method: 'POST',
            path: '/api/v1/did/resolve',
            headers: {
                authorization: 'L402 serialized-macaroon:proof',
            },
            ip: '127.0.0.1',
        } as any;
        const res = createMockResponse();
        const next = jest.fn();

        await store.saveMacaroon({
            id: 'mac-123',
            did: 'did:test:alice',
            scope: ['resolveDID'],
            createdAt: Math.floor(Date.now() / 1000),
            expiresAt: Math.floor(Date.now() / 1000) + 300,
            maxUses: 0,
            currentUses: 0,
            paymentHash: 'a'.repeat(64),
            revoked: true,
        });

        await middleware(req, res as any, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({ error: 'Macaroon revoked' });
    });

    it('returns 401 when an L402 proof is invalid', async () => {
        const store = createMockStore();
        const options = createOptions(store);
        const middleware = createL402Middleware(options);
        const req = {
            method: 'POST',
            path: '/api/v1/did/resolve',
            headers: {
                authorization: 'L402 serialized-macaroon:proof',
            },
            ip: '127.0.0.1',
        } as any;
        const res = createMockResponse();
        const next = jest.fn();

        await store.saveMacaroon({
            id: 'mac-123',
            did: 'did:test:alice',
            scope: ['resolveDID'],
            createdAt: Math.floor(Date.now() / 1000),
            expiresAt: Math.floor(Date.now() / 1000) + 300,
            maxUses: 0,
            currentUses: 0,
            paymentHash: 'a'.repeat(64),
            revoked: false,
        });
        mockVerifyPreimage.mockReturnValueOnce(false);

        await middleware(req, res as any, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: 'Internal Drawbridge error' });
        expect(options.logger?.error).toHaveBeenCalled();
    });

    it('returns 401 when macaroon verification fails', async () => {
        const store = createMockStore();
        const options = createOptions(store);
        const middleware = createL402Middleware(options);
        const req = {
            method: 'POST',
            path: '/api/v1/did/resolve',
            headers: {
                authorization: 'L402 serialized-macaroon:proof',
            },
            ip: '127.0.0.1',
        } as any;
        const res = createMockResponse();
        const next = jest.fn();

        await store.saveMacaroon({
            id: 'mac-123',
            did: 'did:test:alice',
            scope: ['resolveDID'],
            createdAt: Math.floor(Date.now() / 1000),
            expiresAt: Math.floor(Date.now() / 1000) + 300,
            maxUses: 0,
            currentUses: 0,
            paymentHash: 'a'.repeat(64),
            revoked: false,
        });
        mockVerifyMacaroon.mockReturnValueOnce({ valid: false });

        await middleware(req, res as any, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({ error: 'Invalid macaroon: Macaroon verification failed' });
    });

    it('returns 429 when an authenticated request exceeds rate limits', async () => {
        const store = createMockStore();
        const options = createOptions(store);
        const middleware = createL402Middleware(options);
        const req = {
            method: 'POST',
            path: '/api/v1/did/resolve',
            headers: {
                authorization: 'L402 serialized-macaroon:proof',
                'x-did': 'did:test:alice',
            },
            ip: '127.0.0.1',
        } as any;
        const res = createMockResponse();
        const next = jest.fn();

        await store.saveMacaroon({
            id: 'mac-123',
            did: 'did:test:alice',
            scope: ['resolveDID'],
            createdAt: Math.floor(Date.now() / 1000),
            expiresAt: Math.floor(Date.now() / 1000) + 300,
            maxUses: 0,
            currentUses: 0,
            paymentHash: 'a'.repeat(64),
            revoked: false,
        });
        mockCheckAndRecordRequest.mockResolvedValueOnce({
            allowed: false,
            remaining: 0,
            resetAt: 67890,
        });
        mockCheckLimit.mockResolvedValueOnce({
            allowed: false,
            remaining: 0,
            resetAt: 67890,
        });

        await middleware(req, res as any, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(429);
        expect(res.body).toEqual({
            error: 'Rate limit exceeded',
            resetAt: 67890,
        });
    });

    it('passes authenticated requests through and increments usage on successful finish', async () => {
        const store = createMockStore();
        const options = createOptions(store);
        const successHook = jest.fn();
        options.hooks = { onMacaroonVerification: successHook };
        const middleware = createL402Middleware(options);
        let finishHandler: (() => void) | undefined;
        const req = {
            method: 'POST',
            path: '/api/v1/did/resolve',
            headers: {
                authorization: 'L402 serialized-macaroon:proof',
                'x-did': 'did:test:alice',
            },
            ip: '127.0.0.1',
        } as any;
        const res = {
            ...createMockResponse(),
            once: (_event: string, handler: () => void) => {
                finishHandler = handler;
            },
        };
        const next = jest.fn(() => {
            res.statusCode = 200;
        });

        await store.saveMacaroon({
            id: 'mac-123',
            did: 'did:test:alice',
            scope: ['resolveDID'],
            createdAt: Math.floor(Date.now() / 1000),
            expiresAt: Math.floor(Date.now() / 1000) + 300,
            maxUses: 0,
            currentUses: 0,
            paymentHash: 'a'.repeat(64),
            revoked: false,
        });

        await middleware(req, res as any, next);
        finishHandler?.();

        expect(next).toHaveBeenCalledTimes(1);
        expect(store.incrementUsage).toHaveBeenCalledWith('mac-123');
        expect(successHook).toHaveBeenCalledWith('success');
    });

    it('returns 403 when L402 auth raises an insufficient scope error', async () => {
        const store = createMockStore();
        const options = createOptions(store);
        const middleware = createL402Middleware(options);
        const req = {
            method: 'POST',
            path: '/api/v1/did/resolve',
            headers: {
                authorization: 'L402 serialized-macaroon:proof',
                'x-did': 'did:test:alice',
            },
            ip: '127.0.0.1',
        } as any;
        const res = createMockResponse();

        await store.saveMacaroon({
            id: 'mac-123',
            did: 'did:test:alice',
            scope: ['resolveDID'],
            createdAt: Math.floor(Date.now() / 1000),
            expiresAt: Math.floor(Date.now() / 1000) + 300,
            maxUses: 0,
            currentUses: 0,
            paymentHash: 'a'.repeat(64),
            revoked: false,
        });
        mockCheckAndRecordRequest.mockRejectedValueOnce(new InsufficientScopeError('resolveDID'));

        await middleware(req, res as any, jest.fn());

        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({ error: 'Insufficient scope: resolveDID' });
    });

    it('returns 503 when lightning is unavailable during challenge creation', async () => {
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

        mockCreateL402Invoice.mockRejectedValueOnce(new LightningUnavailableError());

        await middleware(req, res as any, jest.fn());

        expect(res.statusCode).toBe(503);
        expect(res.body).toEqual({ error: 'Lightning service unavailable' });
    });

    it('returns 500 on unexpected middleware errors', async () => {
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

        mockCreateL402Invoice.mockRejectedValueOnce(new Error('boom'));

        await middleware(req, res as any, jest.fn());

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: 'Internal Drawbridge error' });
        expect(options.logger?.error).toHaveBeenCalled();
    });

    it('adds pricing headers and challenge hook metadata for priced operations', async () => {
        const store = createMockStore();
        const options = createOptions(store);
        const challengeHook = jest.fn();
        options.hooks = { onChallenge: challengeHook };
        options.pricing = {
            operations: {
                resolveDID: { amountSat: 25 },
            }
        } as any;
        const middleware = createL402Middleware(options);
        const req = {
            method: 'POST',
            path: '/api/v1/did/resolve',
            headers: {
                'x-did': 'did:test:alice',
            },
            ip: '127.0.0.1',
        } as any;
        const res = createMockResponse();

        mockGetPriceForOperation.mockReturnValueOnce({ amountSat: 25 });
        mockCreateL402Invoice.mockResolvedValueOnce({
            paymentRequest: 'lnbc1priced',
            paymentHash: 'b'.repeat(64),
            amountSat: 25,
            expiry: 3600,
            label: 'invoice-2',
        });
        mockSavePendingL402Invoice.mockResolvedValueOnce({
            ok: true,
            paymentHash: 'b'.repeat(64),
        });

        await middleware(req, res as any, jest.fn());

        expect(res.headers.get('X-L402-Price')).toBe('25');
        expect(res.headers.get('X-L402-Operation')).toBe('resolveDID');
        expect(res.body.operation).toBe('resolveDID');
        expect(challengeHook).toHaveBeenCalledWith(true);
    });

    it('completes payment using mediator-backed pending state and invoice status', async () => {
        const store = createMockStore();
        const options = createOptions(store);
        const req = {
            body: {
                paymentHash: 'b'.repeat(64),
            },
        } as any;
        const res = createMockResponse();

        const pendingInvoice: PendingInvoiceData = {
            paymentHash: 'b'.repeat(64),
            macaroonId: 'mac-123',
            serializedMacaroon: 'serialized-macaroon',
            did: 'did:test:alice',
            scope: ['resolveDID'],
            amountSat: 21,
            expiresAt: Math.floor(Date.now() / 1000) + 300,
            createdAt: Math.floor(Date.now() / 1000),
        };

        mockGetPendingL402Invoice.mockResolvedValue(pendingInvoice);
        mockCheckL402Invoice.mockResolvedValue({
            paid: true,
            preimage: '11'.repeat(32),
            paymentHash: pendingInvoice.paymentHash,
            amountSat: pendingInvoice.amountSat,
        });
        mockDeletePendingL402Invoice.mockResolvedValue(undefined);

        await handlePaymentCompletion(options, req, res as any);

        expect(res.statusCode).toBe(200);
        expect(res.body).toMatchObject({
            macaroonId: 'mac-123',
            macaroon: 'serialized-macaroon',
            paymentHash: pendingInvoice.paymentHash,
            amountSat: 21,
            preimage: '11'.repeat(32),
        });
        expect(store.savePayment).toHaveBeenCalledTimes(1);
        expect(mockGetPendingL402Invoice).toHaveBeenCalledWith(
            'http://lightning-mediator.test',
            pendingInvoice.paymentHash
        );
        expect(mockCheckL402Invoice).toHaveBeenCalledWith(
            'http://lightning-mediator.test',
            pendingInvoice.paymentHash
        );
        expect(mockDeletePendingL402Invoice).toHaveBeenCalledWith(
            'http://lightning-mediator.test',
            pendingInvoice.paymentHash
        );
    });

    it('rejects payment completion without a payment hash', async () => {
        const res = createMockResponse();

        await handlePaymentCompletion(createOptions(createMockStore()), { body: {} } as any, res as any);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ error: 'paymentHash is required' });
    });

    it('returns 404 when no pending invoice exists', async () => {
        const res = createMockResponse();
        mockGetPendingL402Invoice.mockResolvedValueOnce(null);

        await handlePaymentCompletion(
            createOptions(createMockStore()),
            { body: { paymentHash: 'c'.repeat(64) } } as any,
            res as any
        );

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: 'No pending invoice found for this payment hash' });
    });

    it('expires stale pending invoices', async () => {
        const res = createMockResponse();
        mockGetPendingL402Invoice.mockResolvedValueOnce({
            paymentHash: 'd'.repeat(64),
            macaroonId: 'mac-123',
            serializedMacaroon: 'serialized-macaroon',
            did: 'did:test:alice',
            scope: ['resolveDID'],
            amountSat: 5,
            expiresAt: Math.floor(Date.now() / 1000) - 1,
            createdAt: Math.floor(Date.now() / 1000) - 100,
        });

        await handlePaymentCompletion(
            createOptions(createMockStore()),
            { body: { paymentHash: 'd'.repeat(64) } } as any,
            res as any
        );

        expect(res.statusCode).toBe(410);
        expect(res.body).toEqual({ error: 'Invoice has expired' });
        expect(mockDeletePendingL402Invoice).toHaveBeenCalledWith(
            'http://lightning-mediator.test',
            'd'.repeat(64)
        );
    });

    it('returns 402 when an invoice has not been paid', async () => {
        const res = createMockResponse();
        mockGetPendingL402Invoice.mockResolvedValueOnce({
            paymentHash: 'e'.repeat(64),
            macaroonId: 'mac-123',
            serializedMacaroon: 'serialized-macaroon',
            did: 'did:test:alice',
            scope: ['resolveDID'],
            amountSat: 5,
            expiresAt: Math.floor(Date.now() / 1000) + 300,
            createdAt: Math.floor(Date.now() / 1000),
        });
        mockCheckL402Invoice.mockResolvedValueOnce({
            paid: false,
            paymentHash: 'e'.repeat(64),
        });

        await handlePaymentCompletion(
            createOptions(createMockStore()),
            { body: { paymentHash: 'e'.repeat(64) } } as any,
            res as any
        );

        expect(res.statusCode).toBe(402);
        expect(res.body).toEqual({ error: 'Invoice has not been paid' });
    });

    it('returns 400 when the paid preimage is invalid', async () => {
        const res = createMockResponse();
        mockGetPendingL402Invoice.mockResolvedValueOnce({
            paymentHash: 'f'.repeat(64),
            macaroonId: 'mac-123',
            serializedMacaroon: 'serialized-macaroon',
            did: 'did:test:alice',
            scope: ['resolveDID'],
            amountSat: 5,
            expiresAt: Math.floor(Date.now() / 1000) + 300,
            createdAt: Math.floor(Date.now() / 1000),
        });
        mockCheckL402Invoice.mockResolvedValueOnce({
            paid: true,
            preimage: '11'.repeat(32),
            paymentHash: 'f'.repeat(64),
            amountSat: 5,
        });
        mockVerifyPreimage.mockReturnValueOnce(false);

        await handlePaymentCompletion(
            createOptions(createMockStore()),
            { body: { paymentHash: 'f'.repeat(64) } } as any,
            res as any
        );

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ error: 'Invalid preimage' });
    });

    it('revokes an existing macaroon', async () => {
        const store = createMockStore();
        const options = createOptions(store);
        const res = createMockResponse();

        await store.saveMacaroon({
            id: 'mac-123',
            did: 'did:test:alice',
            scope: ['resolveDID'],
            createdAt: Math.floor(Date.now() / 1000),
            expiresAt: Math.floor(Date.now() / 1000) + 300,
            maxUses: 0,
            currentUses: 0,
            paymentHash: 'a'.repeat(64),
            revoked: false,
        });

        await handleRevokeMacaroon(options, { body: { macaroonId: 'mac-123' } } as any, res as any);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ revoked: true, macaroonId: 'mac-123' });
    });

    it('validates revoke macaroon requests', async () => {
        const options = createOptions(createMockStore());
        const missingRes = createMockResponse();
        const missingMacaroonRes = createMockResponse();

        await handleRevokeMacaroon(options, { body: {} } as any, missingRes as any);
        await handleRevokeMacaroon(options, { body: { macaroonId: 'missing' } } as any, missingMacaroonRes as any);

        expect(missingRes.statusCode).toBe(400);
        expect(missingRes.body).toEqual({ error: 'macaroonId is required' });
        expect(missingMacaroonRes.statusCode).toBe(404);
        expect(missingMacaroonRes.body).toEqual({ error: 'Macaroon not found' });
    });

    it('returns L402 status details', async () => {
        const res = createMockResponse();
        const options = createOptions(createMockStore());
        options.pricing = {
            operations: {
                resolveDID: { amountSat: 10 },
            }
        } as any;

        await handleL402Status(options, {} as any, res as any);

        expect(res.body).toEqual({
            enabled: true,
            lightning: true,
            pricing: ['resolveDID'],
        });
    });

    it('returns payments for a DID and validates missing DID', async () => {
        const store = createMockStore();
        const options = createOptions(store);
        const missingRes = createMockResponse();
        const okRes = createMockResponse();

        await store.savePayment({
            id: 'payment-1',
            did: 'did:test:alice',
            method: 'lightning',
            paymentHash: 'a'.repeat(64),
            amountSat: 21,
            createdAt: Math.floor(Date.now() / 1000),
            macaroonId: 'mac-123',
            scope: ['resolveDID'],
        });

        await handleGetPayments(options, { params: {} } as any, missingRes as any);
        await handleGetPayments(options, { params: { did: 'did:test:alice' } } as any, okRes as any);

        expect(missingRes.statusCode).toBe(400);
        expect(missingRes.body).toEqual({ error: 'DID parameter is required' });
        expect(okRes.body).toHaveLength(1);
        expect(okRes.body[0].did).toBe('did:test:alice');
    });
});

describe('Drawbridge L402 errors', () => {
    it('sets descriptive names and messages for exported error classes', () => {
        expect(new DrawbridgeError('base')).toMatchObject({ name: 'DrawbridgeError', message: 'base' });
        expect(new PaymentRequiredError('invoice')).toMatchObject({ name: 'PaymentRequiredError', message: 'Payment required: invoice' });
        expect(new InvalidMacaroonError('bad signature')).toMatchObject({ name: 'InvalidMacaroonError', message: 'Invalid macaroon: bad signature' });
        expect(new MacaroonRevokedError()).toMatchObject({ name: 'MacaroonRevokedError', message: 'Macaroon revoked' });
        expect(new PaymentVerificationError('mismatch')).toMatchObject({ name: 'PaymentVerificationError', message: 'Payment verification failed: mismatch' });
        expect(new RateLimitExceededError()).toMatchObject({ name: 'RateLimitExceededError', message: 'Rate limit exceeded' });
        expect(new InsufficientScopeError('resolveDID')).toMatchObject({ name: 'InsufficientScopeError', message: 'Insufficient scope: resolveDID' });
        expect(new LightningUnavailableError()).toMatchObject({ name: 'LightningUnavailableError', message: 'Lightning service unavailable' });
    });
});
