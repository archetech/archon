import { jest } from '@jest/globals';
import { Amount, getEncodedToken, PaymentRequest } from '@cashu/cashu-ts';
import type {
    DrawbridgeStore,
    L402Options,
    PaymentRecord,
} from '../../services/drawbridge/server/src/types.ts';

// The L402 collaborators are mocked as in l402-auth.test.ts; the Cashu checks
// run for real against tokens built with cashu-ts.
const mockCreateMacaroon = jest.fn<any>();
const mockCheckLimit = jest.fn<any>();
const mockCheckAndRecordRequest = jest.fn<any>();
const mockRouteToScope = jest.fn<any>();
const mockGetPriceForOperation = jest.fn<any>();
const mockCreateL402Invoice = jest.fn<any>();
const mockSavePendingL402Invoice = jest.fn<any>();

jest.unstable_mockModule('../../services/drawbridge/server/src/macaroon.ts', () => ({
    createMacaroon: mockCreateMacaroon,
    verifyMacaroon: jest.fn(),
    extractCaveats: jest.fn(),
    getMacaroonId: jest.fn(),
    verifyPreimage: jest.fn(),
}));

jest.unstable_mockModule('../../services/drawbridge/server/src/rate-limiter.ts', () => ({
    checkLimit: mockCheckLimit,
    checkAndRecordRequest: mockCheckAndRecordRequest,
}));

jest.unstable_mockModule('../../services/drawbridge/server/src/pricing.ts', () => ({
    routeToScope: mockRouteToScope,
    getPriceForOperation: mockGetPriceForOperation,
}));

jest.unstable_mockModule('../../services/drawbridge/server/src/lightning-mediator-client.ts', () => ({
    createL402Invoice: mockCreateL402Invoice,
    checkL402Invoice: jest.fn(),
    savePendingL402Invoice: mockSavePendingL402Invoice,
    getPendingL402Invoice: jest.fn(),
    deletePendingL402Invoice: jest.fn(),
}));

const { createL402Middleware } = await import('../../services/drawbridge/server/src/middleware/l402-auth.ts');
const { LightningUnavailableError } = await import('../../services/drawbridge/server/src/errors.ts');
const { CashuPaymentRefusedError, CashuPaymentUnavailableError } =
    await import('../../services/drawbridge/server/src/cashu-payment.ts');

const MINT = 'https://node.example/cashu';
const ALLOWED = { allowed: true, remaining: 100, resetAt: Math.floor(Date.now() / 1000) + 60 };

function token(mint = MINT, amounts = [8, 2]): string {
    return getEncodedToken({
        mint,
        unit: 'sat',
        proofs: amounts.map(amount => ({
            id: '009a1f293253e41e', amount: Amount.from(amount), secret: `secret-${amount}`, C: '02' + '11'.repeat(32),
        })),
    });
}

function response() {
    return {
        statusCode: 200,
        headers: new Map<string, string>(),
        body: undefined as any,
        status(code: number) { this.statusCode = code; return this; },
        json(payload: any) { this.body = payload; return this; },
        setHeader(name: string, value: string) { this.headers.set(name, value); },
        once() {},
    };
}

function store(): DrawbridgeStore & { payments: PaymentRecord[] } {
    const payments: PaymentRecord[] = [];
    return {
        payments,
        saveMacaroon: jest.fn(async () => {}),
        getMacaroon: jest.fn(async () => null),
        revokeMacaroon: jest.fn(async () => {}),
        incrementUsage: jest.fn(async () => 1),
        savePayment: jest.fn(async (record: PaymentRecord) => { payments.push(record); }),
        getPayment: jest.fn(async () => null),
        getPaymentsByDid: jest.fn(async () => []),
        checkRateLimit: jest.fn(async () => ALLOWED),
        recordRequest: jest.fn(async () => {}),
        checkAndRecordRequest: jest.fn(async () => ALLOWED),
        checkAndRecordCost: jest.fn(async () => ALLOWED),
    } as any;
}

function cashu(ready = true) {
    return {
        mintUrl: MINT,
        ready: jest.fn(async () => ready),
        // What the node received, net of spent proofs and the mint's fee.
        redeem: jest.fn<(token: string) => Promise<number>>(async () => 10),
    };
}

function options(s: DrawbridgeStore, overrides: Partial<L402Options> = {}): L402Options {
    return {
        rootSecret: '0123456789abcdef0123456789abcdef',
        location: 'http://localhost:4222',
        lightningMediatorUrl: 'http://lightning-mediator.test',
        defaults: { amountSat: 10, expirySeconds: 3600, scopes: ['resolveDID'] },
        rateLimitRequests: 100,
        rateLimitWindowSeconds: 60,
        store: s,
        logger: { error: jest.fn<any>() },
        ...overrides,
    };
}

async function call(opts: L402Options, headers: Record<string, string> = {}) {
    const res = response();
    const next = jest.fn();
    await createL402Middleware(opts)(
        { method: 'POST', path: '/api/v1/did', headers, ip: '127.0.0.1' } as any, res as any, next,
    );
    return { res, next };
}

function decodedRequest(encoded: string) {
    const request = PaymentRequest.fromEncodedRequest(encoded);
    return { amount: request.amount?.toNumber(), unit: request.unit, mints: request.mints };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockCreateMacaroon.mockReturnValue({ id: 'mac-1', macaroon: 'serialized-macaroon' });
    mockCheckLimit.mockResolvedValue(ALLOWED);
    mockCheckAndRecordRequest.mockResolvedValue(ALLOWED);
    mockRouteToScope.mockReturnValue('createDID');
    mockGetPriceForOperation.mockReturnValue(undefined);
    mockCreateL402Invoice.mockResolvedValue({
        paymentRequest: 'lnbc1challenge', paymentHash: 'a'.repeat(64), amountSat: 10, expiry: 3600, label: 'l',
    });
    mockSavePendingL402Invoice.mockResolvedValue({ ok: true });
});

describe('the 402 challenge', () => {
    it('offers Lightning and Cashu together when both can be paid', async () => {
        const { res, next } = await call(options(store(), { cashu: cashu() }));

        expect(res.statusCode).toBe(402);
        expect(next).not.toHaveBeenCalled();
        expect(res.headers.get('WWW-Authenticate')).toContain('L402 macaroon="serialized-macaroon"');
        expect(decodedRequest(res.headers.get('X-Cashu')!)).toEqual({ amount: 10, unit: 'sat', mints: [MINT] });
        expect(res.body.acceptedMethods).toEqual(['lightning', 'cashu']);
        expect(res.body.cashu).toBe(res.headers.get('X-Cashu'));
        expect(res.body.macaroon).toBe('serialized-macaroon');
    });

    it("asks a priced operation's price in the Cashu request", async () => {
        mockGetPriceForOperation.mockReturnValue({ amountSat: 50 });
        const { res } = await call(options(store(), { cashu: cashu(), pricing: {} as any }));
        expect(decodedRequest(res.body.cashu).amount).toBe(50);
        expect(res.headers.get('X-L402-Price')).toBe('50');
    });

    it('offers Lightning alone while the node cannot redeem Cashu', async () => {
        const { res } = await call(options(store(), { cashu: cashu(false) }));
        expect(res.statusCode).toBe(402);
        expect(res.headers.has('X-Cashu')).toBe(false);
        expect(res.body.acceptedMethods).toEqual(['lightning']);
    });

    it('offers Cashu alone when Lightning is unavailable', async () => {
        const s = store();
        mockCreateL402Invoice.mockRejectedValue(new LightningUnavailableError('mediator down'));
        const { res } = await call(options(s, { cashu: cashu() }));

        expect(res.statusCode).toBe(402);
        expect(res.headers.has('WWW-Authenticate')).toBe(false);
        expect(res.body.acceptedMethods).toEqual(['cashu']);
        expect(res.body.macaroon).toBeUndefined();
        expect(s.recordRequest).toHaveBeenCalledTimes(1);
    });

    it('offers Cashu alone on a node without a Lightning mediator', async () => {
        const { res } = await call(options(store(), { lightningMediatorUrl: '', cashu: cashu() }));
        expect(res.statusCode).toBe(402);
        expect(mockCreateL402Invoice).not.toHaveBeenCalled();
        expect(res.body.acceptedMethods).toEqual(['cashu']);
    });

    it('answers 503 when no method can be offered', async () => {
        const s = store();
        const { res } = await call(options(s, { lightningMediatorUrl: '', cashu: cashu(false) }));
        expect(res.statusCode).toBe(503);
        expect(s.recordRequest).not.toHaveBeenCalled();
    });
});

describe('paying with X-Cashu', () => {
    it('redeems the token, records the payment and serves the request', async () => {
        const s = store();
        const payments = cashu();
        const onCashuPayment = jest.fn();
        const paid = token();
        const { res, next } = await call(
            options(s, { cashu: payments, hooks: { onCashuPayment } }),
            { 'x-cashu': paid, 'x-did': 'did:cid:payer' },
        );

        expect(next).toHaveBeenCalledTimes(1);
        expect(res.statusCode).toBe(200);
        expect(payments.redeem).toHaveBeenCalledWith(paid);
        expect(onCashuPayment).toHaveBeenCalledTimes(1);
        expect(s.payments).toEqual([expect.objectContaining({
            did: 'did:cid:payer', method: 'cashu', amountSat: 10, scope: ['createDID'],
        })]);
        expect(mockCreateL402Invoice).not.toHaveBeenCalled();
    });

    it('refuses a partly spent token that brings in less than the price', async () => {
        const s = store();
        const payments = cashu();
        // 10 sat face value, of which 8 had already been spent elsewhere.
        payments.redeem.mockResolvedValue(2);
        const { res, next } = await call(options(s, { cashu: payments }), { 'x-cashu': token() });

        expect(res.statusCode).toBe(400);
        expect(res.body.error).toContain('brought in 2 sat');
        expect(next).not.toHaveBeenCalled();
        expect(s.payments).toEqual([]);
    });

    it('refuses a token that cannot pay, without redeeming it', async () => {
        const payments = cashu();
        for (const bad of [token('https://other.example/cashu'), token(MINT, [8])]) {
            const { res, next } = await call(options(store(), { cashu: payments }), { 'x-cashu': bad });
            expect(res.statusCode).toBe(400);
            expect(next).not.toHaveBeenCalled();
        }
        expect(payments.redeem).not.toHaveBeenCalled();
    });

    it('answers 400 for a token the node refuses and 503 when it cannot redeem', async () => {
        const refused = cashu();
        refused.redeem.mockRejectedValue(new CashuPaymentRefusedError('The token was refused: already spent'));
        const first = await call(options(store(), { cashu: refused }), { 'x-cashu': token() });
        expect(first.res.statusCode).toBe(400);
        expect(first.res.body.error).toContain('already spent');
        expect(first.next).not.toHaveBeenCalled();

        const down = cashu();
        down.redeem.mockRejectedValue(new CashuPaymentUnavailableError('The node could not redeem the token'));
        const second = await call(options(store(), { cashu: down }), { 'x-cashu': token() });
        expect(second.res.statusCode).toBe(503);
        expect(second.next).not.toHaveBeenCalled();
    });

    it('is rate limited before the token is redeemed', async () => {
        mockCheckAndRecordRequest.mockResolvedValue({ ...ALLOWED, allowed: false });
        const payments = cashu();
        const { res } = await call(options(store(), { cashu: payments }), { 'x-cashu': token() });
        expect(res.statusCode).toBe(429);
        expect(payments.redeem).not.toHaveBeenCalled();
        // The reset time comes from the same bucket that was exhausted.
        expect(mockCheckLimit).toHaveBeenCalledWith(expect.anything(), 'ip:127.0.0.1', 100, 60);
    });

    it('limits by source address, so a changing X-DID gets no fresh budget', async () => {
        const opts = options(store(), { cashu: cashu() });
        await call(opts, { 'x-cashu': token(), 'x-did': 'did:cid:one' });
        await call(opts, { 'x-cashu': token(), 'x-did': 'did:cid:two' });

        const buckets = mockCheckAndRecordRequest.mock.calls.map(call => call[1]);
        expect(buckets).toEqual(['ip:127.0.0.1', 'ip:127.0.0.1']);
    });

    it('ignores X-Cashu on a node that offers no Cashu payment', async () => {
        const { res, next } = await call(options(store()), { 'x-cashu': token() });
        expect(res.statusCode).toBe(402);
        expect(next).not.toHaveBeenCalled();
        expect(res.body.acceptedMethods).toEqual(['lightning']);
    });
});
