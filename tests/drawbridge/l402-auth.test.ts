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

const { createL402Middleware, handlePaymentCompletion } = await import('../../services/drawbridge/server/src/middleware/l402-auth');

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
});
