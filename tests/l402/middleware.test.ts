import nock from 'nock';
import { createL402Middleware, handlePaymentCompletion, handleRevokeMacaroon, handleL402Status, handleGetPayments } from '../../packages/l402/src/middleware.js';
import { createMacaroon } from '../../packages/l402/src/macaroon.js';
import { L402StoreMemory } from '../../packages/l402/src/store-memory.js';
import {
    TEST_ROOT_SECRET,
    TEST_LOCATION,
    TEST_DID,
    MOCK_CLN_CONFIG,
    generateTestPreimage,
    createTestMiddlewareOptions,
    createMockClnInvoiceResponse,
} from './helper.js';
import type { L402MiddlewareOptions } from '../../packages/l402/src/types.js';

// Mock Express request/response/next
function createMockReq(overrides: any = {}) {
    return {
        path: '/api/v1/did/did:cid:test',
        method: 'GET',
        headers: {},
        body: {},
        params: {},
        query: {},
        ...overrides,
    };
}

function createMockRes() {
    const res: any = {
        statusCode: 200,
        headers: {} as Record<string, string>,
        body: null as any,
        status(code: number) {
            res.statusCode = code;
            return res;
        },
        json(data: any) {
            res.body = data;
            return res;
        },
        setHeader(key: string, value: string) {
            res.headers[key] = value;
            return res;
        },
    };
    return res;
}

describe('L402 Middleware', () => {
    let store: L402StoreMemory;
    let options: L402MiddlewareOptions;

    beforeEach(() => {
        store = new L402StoreMemory();
        options = createTestMiddlewareOptions({ store });
    });

    afterEach(() => {
        nock.cleanAll();
    });

    describe('Unprotected routes', () => {
        it('should pass through /ready without L402 check', async () => {
            const middleware = createL402Middleware(options);
            const req = createMockReq({ path: '/ready' });
            const res = createMockRes();
            let nextCalled = false;

            await middleware(req as any, res as any, () => { nextCalled = true; });

            expect(nextCalled).toBe(true);
        });

        it('should pass through /version without L402 check', async () => {
            const middleware = createL402Middleware(options);
            const req = createMockReq({ path: '/version' });
            const res = createMockRes();
            let nextCalled = false;

            await middleware(req as any, res as any, () => { nextCalled = true; });

            expect(nextCalled).toBe(true);
        });

        it('should pass through /status without L402 check', async () => {
            const middleware = createL402Middleware(options);
            const req = createMockReq({ path: '/status' });
            const res = createMockRes();
            let nextCalled = false;

            await middleware(req as any, res as any, () => { nextCalled = true; });

            expect(nextCalled).toBe(true);
        });

        it('should pass through /metrics without L402 check', async () => {
            const middleware = createL402Middleware(options);
            const req = createMockReq({ path: '/metrics' });
            const res = createMockRes();
            let nextCalled = false;

            await middleware(req as any, res as any, () => { nextCalled = true; });

            expect(nextCalled).toBe(true);
        });
    });

    describe('Challenge issuance (no L402 header)', () => {
        it('should return 402 with invoice for protected routes', async () => {
            const { paymentHash } = generateTestPreimage();

            nock(MOCK_CLN_CONFIG.restUrl)
                .post('/v1/invoice')
                .reply(200, createMockClnInvoiceResponse(paymentHash));

            const middleware = createL402Middleware(options);
            const req = createMockReq({
                path: '/api/v1/did/did:cid:test',
                headers: { 'x-did': TEST_DID },
            });
            const res = createMockRes();

            await middleware(req as any, res as any, () => {});

            expect(res.statusCode).toBe(402);
            expect(res.body.error).toBe('Payment required');
            expect(res.body.invoice).toBeDefined();
            expect(res.body.macaroon).toBeDefined();
            expect(res.body.paymentHash).toBeDefined();
            expect(res.body.amountSat).toBe(100);
        });

        it('should set WWW-Authenticate header', async () => {
            const { paymentHash } = generateTestPreimage();

            nock(MOCK_CLN_CONFIG.restUrl)
                .post('/v1/invoice')
                .reply(200, createMockClnInvoiceResponse(paymentHash));

            const middleware = createL402Middleware(options);
            const req = createMockReq({
                path: '/api/v1/did/did:cid:test',
                headers: { 'x-did': TEST_DID },
            });
            const res = createMockRes();

            await middleware(req as any, res as any, () => {});

            expect(res.headers['WWW-Authenticate']).toMatch(/^L402 /);
            expect(res.headers['WWW-Authenticate']).toContain('macaroon=');
            expect(res.headers['WWW-Authenticate']).toContain('invoice=');
        });

        it('should save pending invoice to store', async () => {
            const { paymentHash } = generateTestPreimage();

            nock(MOCK_CLN_CONFIG.restUrl)
                .post('/v1/invoice')
                .reply(200, createMockClnInvoiceResponse(paymentHash));

            const middleware = createL402Middleware(options);
            const req = createMockReq({
                path: '/api/v1/did/did:cid:test',
                headers: { 'x-did': TEST_DID },
            });
            const res = createMockRes();

            await middleware(req as any, res as any, () => {});

            const pending = await store.getPendingInvoice(paymentHash);
            expect(pending).not.toBeNull();
            expect(pending!.did).toBe(TEST_DID);
        });

        it('should return 402 without invoice when CLN is not configured', async () => {
            const noClnOptions = createTestMiddlewareOptions({ store, cln: undefined });
            const middleware = createL402Middleware(noClnOptions);
            const req = createMockReq({
                path: '/api/v1/did/did:cid:test',
            });
            const res = createMockRes();

            await middleware(req as any, res as any, () => {});

            expect(res.statusCode).toBe(402);
            expect(res.body.error).toBe('Payment required');
        });
    });

    describe('Rate limiting', () => {
        it('should enforce rate limits', async () => {
            const limitedOptions = createTestMiddlewareOptions({
                store,
                rateLimitRequests: 2,
                rateLimitWindowSeconds: 3600,
            });

            // Fill up the rate limit
            for (let i = 0; i < 2; i++) {
                await store.recordRequest(TEST_DID, 3600);
            }

            const middleware = createL402Middleware(limitedOptions);
            const req = createMockReq({
                path: '/api/v1/did/did:cid:test',
                headers: { 'x-did': TEST_DID },
            });
            const res = createMockRes();

            await middleware(req as any, res as any, () => {});

            expect(res.statusCode).toBe(429);
            expect(res.body.error).toBe('Rate limit exceeded');
        });
    });

    describe('handlePaymentCompletion', () => {
        it('should complete a lightning payment', async () => {
            const { preimage, paymentHash } = generateTestPreimage();

            // Save a pending invoice
            await store.savePendingInvoice({
                paymentHash,
                macaroonId: 'mac-001',
                serializedMacaroon: 'test-serialized-token',
                did: TEST_DID,
                scope: ['resolveDID'],
                amountSat: 100,
                expiresAt: Math.floor(Date.now() / 1000) + 3600,
                createdAt: Math.floor(Date.now() / 1000),
            });

            // Also save the macaroon record
            await store.saveMacaroon({
                id: 'mac-001',
                did: TEST_DID,
                scope: ['resolveDID'],
                createdAt: Math.floor(Date.now() / 1000),
                expiresAt: Math.floor(Date.now() / 1000) + 3600,
                maxUses: 0,
                currentUses: 0,
                paymentHash,
                revoked: false,
            });

            const req = createMockReq({
                body: { paymentHash, preimage },
            });
            const res = createMockRes();

            await handlePaymentCompletion(options, req as any, res as any);

            expect(res.statusCode).toBe(200);
            expect(res.body.paymentHash).toBe(paymentHash);
            expect(res.body.method).toBe('lightning');
            expect(res.body.macaroon).toBe('test-serialized-token');

            // Pending invoice should be cleaned up
            const pending = await store.getPendingInvoice(paymentHash);
            expect(pending).toBeNull();

            // Payment should be saved
            const payments = await store.getPaymentsByDid(TEST_DID);
            expect(payments).toHaveLength(1);
        });

        it('should reject missing paymentHash', async () => {
            const req = createMockReq({ body: {} });
            const res = createMockRes();

            await handlePaymentCompletion(options, req as any, res as any);

            expect(res.statusCode).toBe(400);
        });

        it('should reject invalid preimage', async () => {
            const { paymentHash } = generateTestPreimage();

            await store.savePendingInvoice({
                paymentHash,
                macaroonId: 'mac-001',
                serializedMacaroon: 'test-serialized-token',
                did: TEST_DID,
                scope: ['resolveDID'],
                amountSat: 100,
                expiresAt: Math.floor(Date.now() / 1000) + 3600,
                createdAt: Math.floor(Date.now() / 1000),
            });

            const req = createMockReq({
                body: { paymentHash, preimage: '0'.repeat(64) },
            });
            const res = createMockRes();

            await handlePaymentCompletion(options, req as any, res as any);

            expect(res.statusCode).toBe(400);
            expect(res.body.error).toBe('Invalid preimage');
        });

        it('should return 404 for unknown payment hash', async () => {
            const req = createMockReq({
                body: { paymentHash: 'unknown', preimage: 'abc' },
            });
            const res = createMockRes();

            await handlePaymentCompletion(options, req as any, res as any);

            expect(res.statusCode).toBe(404);
        });
    });

    describe('handleRevokeMacaroon', () => {
        it('should revoke a macaroon', async () => {
            await store.saveMacaroon({
                id: 'mac-001',
                did: TEST_DID,
                scope: ['resolveDID'],
                createdAt: Math.floor(Date.now() / 1000),
                expiresAt: Math.floor(Date.now() / 1000) + 3600,
                maxUses: 0,
                currentUses: 0,
                paymentHash: 'hash',
                revoked: false,
            });

            const req = createMockReq({ body: { macaroonId: 'mac-001' } });
            const res = createMockRes();

            await handleRevokeMacaroon(options, req as any, res as any);

            expect(res.statusCode).toBe(200);
            expect(res.body.revoked).toBe(true);

            const record = await store.getMacaroon('mac-001');
            expect(record!.revoked).toBe(true);
        });

        it('should reject missing macaroonId', async () => {
            const req = createMockReq({ body: {} });
            const res = createMockRes();

            await handleRevokeMacaroon(options, req as any, res as any);

            expect(res.statusCode).toBe(400);
        });
    });

    describe('handleL402Status', () => {
        it('should return L402 status', async () => {
            const req = createMockReq();
            const res = createMockRes();

            await handleL402Status(options, req as any, res as any);

            expect(res.statusCode).toBe(200);
            expect(res.body.enabled).toBe(true);
            expect(res.body.lightning).toBe(true);
            expect(res.body.cashu).toBe(true);
        });

        it('should report no lightning when not configured', async () => {
            const noClnOptions = createTestMiddlewareOptions({ store, cln: undefined });
            const req = createMockReq();
            const res = createMockRes();

            await handleL402Status(noClnOptions, req as any, res as any);

            expect(res.body.lightning).toBe(false);
        });
    });

    describe('Macaroon auth flow', () => {
        it('should accept a valid L402 header with lightning preimage', async () => {
            const { preimage, paymentHash } = generateTestPreimage();

            // Create a macaroon with caveats
            const caveatSet = {
                scope: ['resolveDID', 'getDIDs'],
                expiry: Math.floor(Date.now() / 1000) + 3600,
                paymentHash,
            };
            const token = createMacaroon(TEST_ROOT_SECRET, TEST_LOCATION, caveatSet);

            // Save macaroon record to store
            await store.saveMacaroon({
                id: token.id,
                did: 'anonymous',
                scope: ['resolveDID', 'getDIDs'],
                createdAt: Math.floor(Date.now() / 1000),
                expiresAt: Math.floor(Date.now() / 1000) + 3600,
                maxUses: 0,
                currentUses: 0,
                paymentHash,
                revoked: false,
            });

            const middleware = createL402Middleware(options);
            const req = createMockReq({
                path: '/api/v1/did/did:cid:test',
                method: 'GET',
                headers: {
                    authorization: `L402 ${token.macaroon}:${preimage}`,
                },
            });
            const res = createMockRes();
            let nextCalled = false;

            await middleware(req as any, res as any, () => { nextCalled = true; });

            expect(nextCalled).toBe(true);
        });

        it('should reject a revoked macaroon', async () => {
            const { preimage, paymentHash } = generateTestPreimage();

            const caveatSet = {
                scope: ['resolveDID'],
                expiry: Math.floor(Date.now() / 1000) + 3600,
                paymentHash,
            };
            const token = createMacaroon(TEST_ROOT_SECRET, TEST_LOCATION, caveatSet);

            await store.saveMacaroon({
                id: token.id,
                did: 'anonymous',
                scope: ['resolveDID'],
                createdAt: Math.floor(Date.now() / 1000),
                expiresAt: Math.floor(Date.now() / 1000) + 3600,
                maxUses: 0,
                currentUses: 0,
                paymentHash,
                revoked: true,
            });

            const middleware = createL402Middleware(options);
            const req = createMockReq({
                path: '/api/v1/did/did:cid:test',
                method: 'GET',
                headers: {
                    authorization: `L402 ${token.macaroon}:${preimage}`,
                },
            });
            const res = createMockRes();

            await middleware(req as any, res as any, () => {});

            expect(res.statusCode).toBe(401);
        });

        it('should reject an invalid preimage', async () => {
            const { paymentHash } = generateTestPreimage();

            const caveatSet = {
                scope: ['resolveDID'],
                expiry: Math.floor(Date.now() / 1000) + 3600,
                paymentHash,
            };
            const token = createMacaroon(TEST_ROOT_SECRET, TEST_LOCATION, caveatSet);

            await store.saveMacaroon({
                id: token.id,
                did: 'anonymous',
                scope: ['resolveDID'],
                createdAt: Math.floor(Date.now() / 1000),
                expiresAt: Math.floor(Date.now() / 1000) + 3600,
                maxUses: 0,
                currentUses: 0,
                paymentHash,
                revoked: false,
            });

            const middleware = createL402Middleware(options);
            const req = createMockReq({
                path: '/api/v1/did/did:cid:test',
                method: 'GET',
                headers: {
                    authorization: `L402 ${token.macaroon}:${'a'.repeat(64)}`,
                },
            });
            const res = createMockRes();

            await middleware(req as any, res as any, () => {});

            expect(res.statusCode).toBe(500);
        });

        it('should reject an expired macaroon', async () => {
            const { preimage, paymentHash } = generateTestPreimage();

            const caveatSet = {
                scope: ['resolveDID'],
                expiry: Math.floor(Date.now() / 1000) - 100, // already expired
                paymentHash,
            };
            const token = createMacaroon(TEST_ROOT_SECRET, TEST_LOCATION, caveatSet);

            await store.saveMacaroon({
                id: token.id,
                did: 'anonymous',
                scope: ['resolveDID'],
                createdAt: Math.floor(Date.now() / 1000) - 200,
                expiresAt: Math.floor(Date.now() / 1000) - 100,
                maxUses: 0,
                currentUses: 0,
                paymentHash,
                revoked: false,
            });

            const middleware = createL402Middleware(options);
            const req = createMockReq({
                path: '/api/v1/did/did:cid:test',
                method: 'GET',
                headers: {
                    authorization: `L402 ${token.macaroon}:${preimage}`,
                },
            });
            const res = createMockRes();

            await middleware(req as any, res as any, () => {});

            expect(res.statusCode).toBe(401);
        });
    });

    describe('L402 path passthrough', () => {
        it('should pass through /l402/pay without L402 check', async () => {
            const middleware = createL402Middleware(options);
            const req = createMockReq({ path: '/l402/pay', method: 'POST' });
            const res = createMockRes();
            let nextCalled = false;

            await middleware(req as any, res as any, () => { nextCalled = true; });

            expect(nextCalled).toBe(true);
        });

        it('should pass through /l402/status without L402 check', async () => {
            const middleware = createL402Middleware(options);
            const req = createMockReq({ path: '/l402/status', method: 'GET' });
            const res = createMockRes();
            let nextCalled = false;

            await middleware(req as any, res as any, () => { nextCalled = true; });

            expect(nextCalled).toBe(true);
        });
    });

    describe('handleGetPayments', () => {
        it('should return payments for a DID', async () => {
            await store.savePayment({
                id: 'pay-001',
                did: TEST_DID,
                method: 'lightning',
                paymentHash: 'hash1',
                amountSat: 100,
                createdAt: Math.floor(Date.now() / 1000),
                macaroonId: 'mac-001',
            });

            const req = createMockReq({ params: { did: TEST_DID } });
            const res = createMockRes();

            await handleGetPayments(options, req as any, res as any);

            expect(res.statusCode).toBe(200);
            expect(res.body).toHaveLength(1);
            expect(res.body[0].amountSat).toBe(100);
        });

        it('should return empty array for DID with no payments', async () => {
            const req = createMockReq({ params: { did: 'did:cid:nobody' } });
            const res = createMockRes();

            await handleGetPayments(options, req as any, res as any);

            expect(res.statusCode).toBe(200);
            expect(res.body).toHaveLength(0);
        });

        it('should return 400 when DID param is missing', async () => {
            const req = createMockReq({ params: {} });
            const res = createMockRes();

            await handleGetPayments(options, req as any, res as any);

            expect(res.statusCode).toBe(400);
        });
    });

    describe('handleRevokeMacaroon (existence check)', () => {
        it('should return 404 for non-existent macaroon', async () => {
            const req = createMockReq({ body: { macaroonId: 'nonexistent' } });
            const res = createMockRes();

            await handleRevokeMacaroon(options, req as any, res as any);

            expect(res.statusCode).toBe(404);
        });
    });

    describe('Rate limiting without DID', () => {
        it('should rate limit by IP when no x-did header', async () => {
            const limitedOptions = createTestMiddlewareOptions({
                store,
                rateLimitRequests: 2,
                rateLimitWindowSeconds: 3600,
            });

            // Fill up the rate limit for this IP
            await store.recordRequest('ip:127.0.0.1', 3600);
            await store.recordRequest('ip:127.0.0.1', 3600);

            const middleware = createL402Middleware(limitedOptions);
            const req = createMockReq({
                path: '/api/v1/did/did:cid:test',
                ip: '127.0.0.1',
            });
            const res = createMockRes();

            await middleware(req as any, res as any, () => {});

            expect(res.statusCode).toBe(429);
        });
    });

    describe('Rate limiting on authenticated requests', () => {
        it('should enforce rate limits on macaroon-authenticated requests', async () => {
            const { preimage, paymentHash } = generateTestPreimage();

            const limitedOptions = createTestMiddlewareOptions({
                store,
                rateLimitRequests: 1,
                rateLimitWindowSeconds: 3600,
            });

            const caveatSet = {
                scope: ['resolveDID', 'getDIDs'],
                expiry: Math.floor(Date.now() / 1000) + 3600,
                paymentHash,
            };
            const token = createMacaroon(TEST_ROOT_SECRET, TEST_LOCATION, caveatSet);

            await store.saveMacaroon({
                id: token.id,
                did: 'anonymous',
                scope: ['resolveDID', 'getDIDs'],
                createdAt: Math.floor(Date.now() / 1000),
                expiresAt: Math.floor(Date.now() / 1000) + 3600,
                maxUses: 0,
                currentUses: 0,
                paymentHash,
                revoked: false,
            });

            // Pre-fill rate limit
            await store.recordRequest('ip:127.0.0.1', 3600);

            const middleware = createL402Middleware(limitedOptions);
            const req = createMockReq({
                path: '/api/v1/did/did:cid:test',
                method: 'GET',
                ip: '127.0.0.1',
                headers: {
                    authorization: `L402 ${token.macaroon}:${preimage}`,
                },
            });
            const res = createMockRes();

            await middleware(req as any, res as any, () => {});

            expect(res.statusCode).toBe(429);
        });
    });

    describe('handlePaymentCompletion (expiry)', () => {
        it('should reject payment for expired pending invoice', async () => {
            const { preimage, paymentHash } = generateTestPreimage();

            await store.savePendingInvoice({
                paymentHash,
                macaroonId: 'mac-001',
                serializedMacaroon: 'test-serialized-token',
                did: TEST_DID,
                scope: ['resolveDID'],
                amountSat: 100,
                expiresAt: Math.floor(Date.now() / 1000) - 100, // already expired
                createdAt: Math.floor(Date.now() / 1000) - 3700,
            });

            const req = createMockReq({
                body: { paymentHash, preimage },
            });
            const res = createMockRes();

            await handlePaymentCompletion(options, req as any, res as any);

            expect(res.statusCode).toBe(410);
            expect(res.body.error).toBe('Invoice has expired');

            // Pending invoice should be cleaned up
            const pending = await store.getPendingInvoice(paymentHash);
            expect(pending).toBeNull();
        });
    });
});
