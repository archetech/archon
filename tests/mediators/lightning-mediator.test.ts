import { jest } from '@jest/globals';
import request from 'supertest';
import { createApp, socksEgress, type AppDeps } from '../../services/mediators/lightning/src/lightning-mediator.ts';
import { LightningPaymentError } from '../../services/mediators/lightning/src/errors.ts';
import type {
    LightningMediatorConfig,
    LightningPaymentRecord,
    LightningStore,
    PendingInvoiceData,
} from '../../services/mediators/lightning/src/types.ts';

// The mediator moves money, and until #909 none of its 17 routes had a test:
// main() built the app, the store and the listener in one function and exported
// nothing. The SSRF guards in #908 could only be verified by reading them.
//
// These drive the routes through createApp with fakes for everything outside:
// no Redis, no LNBits, no gatekeeper, no network.

const ADMIN_KEY = 'test-admin-key';

class FakeStore implements LightningStore {
    payments = new Map<string, LightningPaymentRecord>();
    pending = new Map<string, PendingInvoiceData>();
    published = new Map<string, string>();
    failWith?: Error;

    private check() {
        if (this.failWith) {
            throw this.failWith;
        }
    }

    async savePayment(record: LightningPaymentRecord) {
        this.check();
        this.payments.set(record.id, record);
    }

    async getPayment(id: string) {
        this.check();
        return this.payments.get(id) ?? null;
    }

    async getPaymentsByDid(did: string) {
        this.check();
        return [...this.payments.values()].filter(p => p.did === did);
    }

    async savePendingInvoice(data: PendingInvoiceData) {
        this.check();
        this.pending.set(data.paymentHash, data);
    }

    async getPendingInvoice(paymentHash: string) {
        this.check();
        return this.pending.get(paymentHash) ?? null;
    }

    async deletePendingInvoice(paymentHash: string) {
        this.check();
        this.pending.delete(paymentHash);
    }

    async savePublishedLightning(did: string, invoiceKey: string) {
        this.check();
        this.published.set(did, invoiceKey);
    }

    async getPublishedLightning(did: string) {
        this.check();
        return this.published.get(did) ?? null;
    }

    async deletePublishedLightning(did: string) {
        this.check();
        this.published.delete(did);
    }

    async disconnect() {}
}

function baseConfig(overrides: Partial<LightningMediatorConfig> = {}): LightningMediatorConfig {
    return {
        port: 4235,
        bindAddress: '127.0.0.1',
        adminApiKey: ADMIN_KEY,
        redisUrl: 'redis://localhost:6379',
        gatekeeperUrl: 'http://gatekeeper:4224',
        clnRestUrl: 'https://cln:3001',
        clnRune: 'test-rune',
        lnbitsUrl: 'http://lnbits:5000',
        publicHost: '',
        drawbridgePublicHost: '',
        drawbridgePort: 4222,
        torProxy: '',
        ...overrides,
    };
}

function fakeLnbits() {
    return {
        createWallet: jest.fn<any>().mockResolvedValue({ id: 'wallet-1', adminkey: 'admin', inkey: 'invoice' }),
        getBalance: jest.fn<any>().mockResolvedValue(4200),
        createInvoice: jest.fn<any>().mockResolvedValue({ paymentRequest: 'lnbc1invoice', paymentHash: 'hash-1' }),
        payInvoice: jest.fn<any>().mockResolvedValue({ paid: true, paymentHash: 'hash-1' }),
        getPayments: jest.fn<any>().mockResolvedValue([{ paymentHash: 'hash-1' }]),
        checkPayment: jest.fn<any>().mockResolvedValue({ paid: true }),
    };
}

function fakeCln() {
    return {
        createInvoice: jest.fn<any>().mockResolvedValue({ bolt11: 'lnbc1l402', paymentHash: 'hash-l402' }),
        checkInvoice: jest.fn<any>().mockResolvedValue({ paid: false }),
    };
}

function build(overrides: Partial<AppDeps> = {}) {
    const store = (overrides.store as FakeStore) ?? new FakeStore();
    const lnbits = (overrides.lnbits as ReturnType<typeof fakeLnbits>) ?? fakeLnbits();
    const cln = (overrides.cln as ReturnType<typeof fakeCln>) ?? fakeCln();
    const resolveDID = jest.fn<any>().mockResolvedValue({ didDocument: {} });

    const deps: AppDeps = {
        config: baseConfig(),
        store,
        getResolver: async () => ({ resolveDID }),
        lnbits,
        cln,
        readiness: async () => ({
            ready: true,
            dependencies: { redis: true, clnConfigured: true, lnbitsConfigured: true },
        }),
        version: { version: '9.9.9', commit: 'abc1234' },
        readTorHostname: async () => {
            throw new Error('no tor hostname');
        },
        ...overrides,
    };

    return { app: createApp(deps), store, lnbits, cln, resolveDID, deps };
}

// Every /api/v1 route sits behind the admin key, so the helper carries it.
function post(app: any, path: string, body?: any) {
    return request(app).post(path).set('x-archon-admin-key', ADMIN_KEY).send(body);
}

function get(app: any, path: string) {
    return request(app).get(path).set('x-archon-admin-key', ADMIN_KEY);
}

function del(app: any, path: string) {
    return request(app).delete(path).set('x-archon-admin-key', ADMIN_KEY);
}

function jsonResponse(body: any, init: ResponseInit = {}) {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
        ...init,
    });
}

afterEach(() => {
    jest.restoreAllMocks();
});

describe('ops routes', () => {
    it('reports readiness with the dependency breakdown', async () => {
        const { app } = build();
        const response = await request(app).get('/ready');

        expect(response.status).toBe(200);
        expect(response.body).toStrictEqual({
            ready: true,
            dependencies: { redis: true, clnConfigured: true, lnbitsConfigured: true },
        });
    });

    it('answers 503 when a dependency is down', async () => {
        const { app } = build({
            readiness: async () => ({
                ready: false,
                dependencies: { redis: false, clnConfigured: true, lnbitsConfigured: true },
            }),
        });

        const response = await request(app).get('/ready');

        // The body still describes what is wrong, so an operator does not have
        // to guess which dependency failed.
        expect(response.status).toBe(503);
        expect(response.body.dependencies.redis).toBe(false);
    });

    it('serves version and metrics without an admin key', async () => {
        const { app } = build();

        const version = await request(app).get('/version');
        expect(version.status).toBe(200);
        expect(version.body).toStrictEqual({ version: '9.9.9', commit: 'abc1234' });

        const metrics = await request(app).get('/metrics');
        expect(metrics.status).toBe(200);
        expect(metrics.text).toContain('lightning_mediator_http_requests_total');
    });
});

describe('admin key enforcement', () => {
    it('lets /lightning/supported through without a key', async () => {
        // Declared before the requireAdminKey middleware on purpose: a client
        // asks whether Lightning exists here before it has any credentials.
        const { app } = build();
        const response = await request(app).get('/api/v1/lightning/supported');

        expect(response.status).toBe(200);
        expect(response.body.supported).toBe(true);
        expect(response.body.mediator).toBe('lightning-mediator');
        expect(response.body).toMatchObject({ clnConfigured: true, lnbitsConfigured: true });

        // The flags describe this node's configuration, so an unconfigured
        // backend has to show as false rather than being reported as present.
        const bare = build({ config: baseConfig({ clnRune: '', lnbitsUrl: '' }) });
        const unconfigured = await request(bare.app).get('/api/v1/lightning/supported');
        expect(unconfigured.body).toMatchObject({ supported: true, clnConfigured: false, lnbitsConfigured: false });
    });

    it('rejects a missing, wrong, or differently-sized key', async () => {
        const { app } = build();

        const missing = await request(app).post('/api/v1/lightning/balance').send({});
        expect(missing.status).toBe(401);
        expect(missing.body.error).toBe('Admin API key required');

        const wrong = await request(app)
            .post('/api/v1/lightning/balance')
            .set('x-archon-admin-key', 'wrong-admin-key')  // same length as ADMIN_KEY
            .send({});
        expect(wrong.status).toBe(401);

        // timingSafeEqual throws on a length mismatch, so a short key must be
        // rejected by the length check rather than crashing into a 500.
        const short = await request(app)
            .post('/api/v1/lightning/balance')
            .set('x-archon-admin-key', 'x')
            .send({});
        expect(short.status).toBe(401);
        expect(short.body.error).toBe('Invalid admin API key');
    });

    it('refuses every protected route when no key is configured', async () => {
        // Fail closed: an unset key must not mean "no authentication required".
        const { app } = build({ config: baseConfig({ adminApiKey: '' }) });

        const response = await request(app)
            .post('/api/v1/lightning/balance')
            .set('x-archon-admin-key', 'anything')
            .send({});

        expect(response.status).toBe(403);
        expect(response.body.error).toBe('Admin API key not configured');
    });
});

describe('LNBits wallet routes', () => {
    it('answers 503 for every LNBits route when LNBits is not configured', async () => {
        const { app } = build({ config: baseConfig({ lnbitsUrl: '' }) });

        for (const path of ['/api/v1/lightning/wallet', '/api/v1/lightning/balance', '/api/v1/lightning/invoice', '/api/v1/lightning/pay', '/api/v1/lightning/payment', '/api/v1/lightning/payments', '/api/v1/lightning/zap']) {
            const response = await post(app, path, {});
            expect([path, response.status]).toStrictEqual([path, 503]);
        }
    });

    it('creates a wallet, defaulting the name', async () => {
        const { app, lnbits } = build();

        const named = await post(app, '/api/v1/lightning/wallet', { name: 'alice' });
        expect(named.status).toBe(200);
        expect(named.body.id).toBe('wallet-1');

        await post(app, '/api/v1/lightning/wallet', {});

        expect(lnbits.createWallet).toHaveBeenNthCalledWith(1, 'http://lnbits:5000', 'alice');
        expect(lnbits.createWallet).toHaveBeenNthCalledWith(2, 'http://lnbits:5000', 'archon');
    });

    it('returns a balance', async () => {
        const { app, lnbits } = build();
        const response = await post(app, '/api/v1/lightning/balance', { invoiceKey: 'inkey' });

        expect(response.status).toBe(200);
        expect(response.body).toStrictEqual({ balance: 4200 });
        expect(lnbits.getBalance).toHaveBeenCalledWith('http://lnbits:5000', 'inkey');
    });

    it('maps a payment error to 400 and anything else to 502', async () => {
        // The distinction is the contract Drawbridge reads: 400 means the
        // request was wrong, 502 means the upstream wallet failed.
        const lnbits = fakeLnbits();
        lnbits.getBalance.mockRejectedValueOnce(new LightningPaymentError('insufficient funds'));
        const { app } = build({ lnbits });

        const rejected = await post(app, '/api/v1/lightning/balance', { invoiceKey: 'inkey' });
        expect(rejected.status).toBe(400);
        expect(rejected.body.error).toBe('insufficient funds');

        lnbits.getBalance.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
        const upstream = await post(app, '/api/v1/lightning/balance', { invoiceKey: 'inkey' });
        expect(upstream.status).toBe(502);
    });
});

describe('invoice and payment routes', () => {
    it('requires an invoice key and a positive amount', async () => {
        const { app, lnbits } = build();

        for (const body of [{}, { invoiceKey: 'inkey' }, { invoiceKey: 'inkey', amount: 0 }, { invoiceKey: 'inkey', amount: -5 }, { invoiceKey: 'inkey', amount: 1.5 }, { invoiceKey: 'inkey', amount: 'abc' }]) {
            const response = await post(app, '/api/v1/lightning/invoice', body);
            expect([JSON.stringify(body), response.status]).toStrictEqual([JSON.stringify(body), 400]);
        }

        expect(lnbits.createInvoice).not.toHaveBeenCalled();
    });

    it('creates an invoice, coercing a numeric string amount', async () => {
        const { app, lnbits } = build();
        const response = await post(app, '/api/v1/lightning/invoice', { invoiceKey: 'inkey', amount: '100', memo: 'coffee' });

        expect(response.status).toBe(200);
        expect(response.body.paymentRequest).toBe('lnbc1invoice');
        expect(lnbits.createInvoice).toHaveBeenCalledWith('http://lnbits:5000', 'inkey', 100, 'coffee');
    });

    it('requires both credentials before paying', async () => {
        const { app, lnbits } = build();

        expect((await post(app, '/api/v1/lightning/pay', { adminKey: 'k' })).status).toBe(400);
        expect((await post(app, '/api/v1/lightning/pay', { bolt11: 'lnbc1' })).status).toBe(400);
        expect(lnbits.payInvoice).not.toHaveBeenCalled();

        const paid = await post(app, '/api/v1/lightning/pay', { adminKey: 'k', bolt11: 'lnbc1' });
        expect(paid.status).toBe(200);
        expect(lnbits.payInvoice).toHaveBeenCalledWith('http://lnbits:5000', 'k', 'lnbc1');
    });

    it('echoes the payment hash back with the status', async () => {
        const { app } = build();

        expect((await post(app, '/api/v1/lightning/payment', { invoiceKey: 'inkey' })).status).toBe(400);

        const response = await post(app, '/api/v1/lightning/payment', { invoiceKey: 'inkey', paymentHash: 'hash-1' });
        expect(response.status).toBe(200);
        expect(response.body).toStrictEqual({ paid: true, paymentHash: 'hash-1' });
    });

    it('lists payments for an admin key', async () => {
        const { app } = build();

        expect((await post(app, '/api/v1/lightning/payments', {})).status).toBe(400);

        const response = await post(app, '/api/v1/lightning/payments', { adminKey: 'k' });
        expect(response.status).toBe(200);
        expect(response.body.payments).toStrictEqual([{ paymentHash: 'hash-1' }]);
    });
});

describe('publish routes', () => {
    it('requires a did and an invoice key', async () => {
        const { app, store } = build({ config: baseConfig({ publicHost: 'https://node.example' }) });

        expect((await post(app, '/api/v1/lightning/publish', { did: 'did:cid:alice' })).status).toBe(400);
        expect((await post(app, '/api/v1/lightning/publish', { invoiceKey: 'inkey' })).status).toBe(400);
        expect(store.published.size).toBe(0);
    });

    it('refuses to publish before a public host is known', async () => {
        // Publishing an endpoint nobody can reach is worse than refusing: the
        // DID document would advertise it either way.
        const { app, store } = build();

        const response = await post(app, '/api/v1/lightning/publish', { did: 'did:cid:alice', invoiceKey: 'inkey' });

        expect(response.status).toBe(503);
        expect(store.published.size).toBe(0);
    });

    it('prefers the Drawbridge public host, then its own, then the onion', async () => {
        const drawbridge = build({ config: baseConfig({ drawbridgePublicHost: 'https://drawbridge.example', publicHost: 'https://own.example' }) });
        expect((await post(drawbridge.app, '/api/v1/lightning/publish', { did: 'did:cid:a', invoiceKey: 'k' })).body.publicHost)
            .toBe('https://drawbridge.example');

        const own = build({ config: baseConfig({ publicHost: 'https://own.example' }) });
        expect((await post(own.app, '/api/v1/lightning/publish', { did: 'did:cid:a', invoiceKey: 'k' })).body.publicHost)
            .toBe('https://own.example');

        const onion = build({ readTorHostname: async () => 'abcdef.onion\n' });
        expect((await post(onion.app, '/api/v1/lightning/publish', { did: 'did:cid:a', invoiceKey: 'k' })).body.publicHost)
            .toBe('http://abcdef.onion:4222');
    });

    it('stores and removes the published invoice key', async () => {
        const { app, store } = build({ config: baseConfig({ publicHost: 'https://node.example' }) });

        await post(app, '/api/v1/lightning/publish', { did: 'did:cid:alice', invoiceKey: 'inkey' });
        expect(store.published.get('did:cid:alice')).toBe('inkey');

        const removed = await del(app, `/api/v1/lightning/publish/${encodeURIComponent('did:cid:alice')}`);
        expect(removed.status).toBe(200);
        expect(store.published.size).toBe(0);
    });

    it('answers 500 when the store fails', async () => {
        const store = new FakeStore();
        store.failWith = new Error('redis down');
        const { app } = build({ store, config: baseConfig({ publicHost: 'https://node.example' }) });

        const response = await post(app, '/api/v1/lightning/publish', { did: 'did:cid:alice', invoiceKey: 'inkey' });
        expect(response.status).toBe(500);
        expect(response.body.error).toBe('redis down');
    });
});

describe('zap to a Lightning Address (LUD-16)', () => {
    const zap = (app: any, body: any) => post(app, '/api/v1/lightning/zap', body);

    it('validates the request before reaching the network', async () => {
        const { app } = build();
        const fetchSpy = jest.spyOn(globalThis, 'fetch');

        expect((await zap(app, { did: 'alice@example.com', amount: 100 })).status).toBe(400);
        expect((await zap(app, { adminKey: 'k', amount: 100 })).status).toBe(400);
        expect((await zap(app, { adminKey: 'k', did: 'alice@example.com', amount: 0 })).status).toBe(400);
        expect((await zap(app, { adminKey: 'k', did: 'alice@example.com' })).status).toBe(400);

        const malformed = await zap(app, { adminKey: 'k', did: '@example.com', amount: 100 });
        expect(malformed.status).toBe(400);
        expect(malformed.body.error).toBe('Invalid Lightning Address format');

        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('resolves the address, follows the callback, and pays the invoice', async () => {
        const { app, lnbits } = build();
        const seen: string[] = [];

        jest.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
            const url = String(input);
            seen.push(url);
            if (url.includes('/.well-known/lnurlp/')) {
                return jsonResponse({ callback: 'https://example.com/lnurlp/callback', minSendable: 1000, maxSendable: 1000000000 });
            }
            return jsonResponse({ pr: 'lnbc1remote' });
        });

        const response = await zap(app, { adminKey: 'k', did: 'alice@example.com', amount: 100, memo: 'thanks' });

        expect(response.status).toBe(200);
        expect(seen[0]).toBe('https://example.com/.well-known/lnurlp/alice');
        // Amount travels in millisats, and the memo becomes the LUD-12 comment.
        expect(seen[1]).toBe('https://example.com/lnurlp/callback?amount=100000&comment=thanks');
        expect(lnbits.payInvoice).toHaveBeenCalledWith('http://lnbits:5000', 'k', 'lnbc1remote');
    });

    it('enforces the sendable bounds the remote service declares', async () => {
        const { app, lnbits } = build();
        jest.spyOn(globalThis, 'fetch').mockImplementation(async () =>
            jsonResponse({ callback: 'https://example.com/cb', minSendable: 10000, maxSendable: 100000 })
        );

        const low = await zap(app, { adminKey: 'k', did: 'alice@example.com', amount: 5 });
        expect(low.status).toBe(400);
        expect(low.body.error).toBe('Amount too low: minimum 10 sats');

        const high = await zap(app, { adminKey: 'k', did: 'alice@example.com', amount: 1000 });
        expect(high.status).toBe(400);
        expect(high.body.error).toBe('Amount too high: maximum 100 sats');

        expect(lnbits.payInvoice).not.toHaveBeenCalled();
    });

    it('refuses a callback URL that is not https', async () => {
        // The callback comes from the remote response, so it is
        // attacker-influenced -- this is the guard #908 kept.
        const { app, lnbits } = build();
        jest.spyOn(globalThis, 'fetch').mockImplementation(async () =>
            jsonResponse({ callback: 'http://redis:6379/', minSendable: 1000, maxSendable: 1000000000 })
        );

        const response = await zap(app, { adminKey: 'k', did: 'alice@example.com', amount: 100 });

        expect(response.status).toBe(400);
        expect(response.body.error).toBe('Invalid callback URL: must use https');
        expect(lnbits.payInvoice).not.toHaveBeenCalled();
    });

    it('re-applies the https rule on every redirect hop', async () => {
        // Checking the scheme once is worthless if a redirect can undo it:
        // fetch follows redirects by default, and 307/308 keep method and body,
        // so an https endpoint answering `307 -> http://redis:6379` would reach
        // the plaintext service the check exists to keep out.
        const { app, lnbits } = build();
        const attempted: string[] = [];

        jest.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
            attempted.push(String(input));
            return new Response(null, { status: 307, headers: { location: 'http://redis:6379/' } });
        });

        const response = await zap(app, { adminKey: 'k', did: 'alice@example.com', amount: 100 });

        expect(response.status).toBe(502);
        expect(response.body.error).toContain('refusing non-https hop to redis:6379');
        // The plaintext hop was never requested.
        expect(attempted).toStrictEqual(['https://example.com/.well-known/lnurlp/alice']);
        expect(lnbits.payInvoice).not.toHaveBeenCalled();
    });

    it('follows an https redirect and resolves a relative location against its hop', async () => {
        const { app } = build();
        const attempted: string[] = [];

        jest.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
            const url = String(input);
            attempted.push(url);
            if (url === 'https://example.com/.well-known/lnurlp/alice') {
                return new Response(null, { status: 301, headers: { location: '/moved/lnurlp' } });
            }
            if (url === 'https://example.com/moved/lnurlp') {
                return jsonResponse({ callback: 'https://example.com/cb' });
            }
            return jsonResponse({ pr: 'lnbc1remote' });
        });

        const response = await zap(app, { adminKey: 'k', did: 'alice@example.com', amount: 100 });

        expect(response.status).toBe(200);
        expect(attempted[1]).toBe('https://example.com/moved/lnurlp');
    });

    it('gives up rather than following redirects forever', async () => {
        const { app } = build();
        let hops = 0;

        jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
            hops += 1;
            return new Response(null, { status: 302, headers: { location: `https://example.com/hop-${hops}` } });
        });

        const response = await zap(app, { adminKey: 'k', did: 'alice@example.com', amount: 100 });

        expect(response.status).toBe(502);
        expect(response.body.error).toContain('too many redirects');
        expect(hops).toBe(6); // the initial request plus MAX_LNURL_REDIRECTS
    });

    it('reports an LNURL error document and a missing callback as 502', async () => {
        const { app } = build();

        jest.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({ status: 'ERROR', reason: 'no such user' }));
        const errored = await zap(app, { adminKey: 'k', did: 'alice@example.com', amount: 100 });
        expect(errored.status).toBe(502);
        expect(errored.body.error).toContain('no such user');

        jest.restoreAllMocks();
        jest.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({ minSendable: 1000 }));
        const noCallback = await zap(app, { adminKey: 'k', did: 'alice@example.com', amount: 100 });
        expect(noCallback.status).toBe(502);
        expect(noCallback.body.error).toBe('No callback URL in Lightning Address response');
    });

    it('reports a missing payment request rather than paying nothing', async () => {
        const { app, lnbits } = build();
        jest.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) =>
            String(input).includes('.well-known')
                ? jsonResponse({ callback: 'https://example.com/cb' })
                : jsonResponse({ notAnInvoice: true })
        );

        const response = await zap(app, { adminKey: 'k', did: 'alice@example.com', amount: 100 });

        expect(response.status).toBe(502);
        expect(response.body.error).toBe('No payment request returned from Lightning Address');
        expect(lnbits.payInvoice).not.toHaveBeenCalled();
    });
});

describe('zap to a DID', () => {
    const zap = (app: any, body: any) => post(app, '/api/v1/lightning/zap', body);

    function withService(serviceEndpoint: any) {
        const resolveDID = jest.fn<any>().mockResolvedValue({
            didDocument: { service: [{ type: 'Lightning', serviceEndpoint }] },
        });
        return { getResolver: async () => ({ resolveDID }), resolveDID };
    }

    it('404s when the DID publishes no Lightning service', async () => {
        const { app } = build({ getResolver: async () => ({ resolveDID: jest.fn<any>().mockResolvedValue({ didDocument: { service: [{ type: 'DIDCommMessaging' }] } }) }) });

        const response = await zap(app, { adminKey: 'k', did: 'did:cid:bob', amount: 100 });

        expect(response.status).toBe(404);
        expect(response.body.error).toBe('Recipient DID has no Lightning service endpoint');
    });

    it('accepts the endpoint as a string or as an object with a uri', async () => {
        jest.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({ paymentRequest: 'lnbc1did' }));

        for (const endpoint of ['https://bob.example/invoice', { uri: 'https://bob.example/invoice' }]) {
            const { getResolver } = withService(endpoint);
            const { app, lnbits } = build({ getResolver });

            const response = await zap(app, { adminKey: 'k', did: 'did:cid:bob', amount: 100 });
            expect(response.status).toBe(200);
            expect(lnbits.payInvoice).toHaveBeenCalledWith('http://lnbits:5000', 'k', 'lnbc1did');
        }
    });

    it('requires https for a clearnet endpoint and http for an onion one', async () => {
        const fetchSpy = jest.spyOn(globalThis, 'fetch');

        const clearnet = build(withService('http://bob.example/invoice'));
        const insecure = await zap(clearnet.app, { adminKey: 'k', did: 'did:cid:bob', amount: 100 });
        expect(insecure.status).toBe(400);
        expect(insecure.body.error).toBe('Invalid service endpoint: must use https');

        // Tor already authenticates and encrypts to the onion address, so https
        // there buys nothing and a self-signed certificate would only break it.
        const onion = build(withService('https://bobxyz.onion/invoice'));
        const wrongOnion = await zap(onion.app, { adminKey: 'k', did: 'did:cid:bob', amount: 100 });
        expect(wrongOnion.status).toBe(400);
        expect(wrongOnion.body.error).toBe('Invalid service endpoint: .onion must use http');

        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('passes the amount and memo as query parameters', async () => {
        const seen: string[] = [];
        jest.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
            seen.push(String(input));
            return jsonResponse({ paymentRequest: 'lnbc1did' });
        });

        const { app } = build(withService('https://bob.example/invoice'));
        await zap(app, { adminKey: 'k', did: 'did:cid:bob', amount: 250, memo: 'for the coffee' });

        const url = new URL(seen[0]);
        expect(url.searchParams.get('amount')).toBe('250');
        expect(url.searchParams.get('memo')).toBe('for the coffee');
    });

    it('short-circuits to the internal route when the recipient is on this stack', async () => {
        // Otherwise the request would leave through our own onion service and
        // come straight back, which is slow and can deadlock a single circuit.
        const seen: string[] = [];
        jest.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
            seen.push(String(input));
            return jsonResponse({ paymentRequest: 'lnbc1did' });
        });
        const socksSpy = jest.spyOn(socksEgress, 'fetch');

        const { app } = build({
            ...withService('http://ourhost.onion/invoice'),
            config: baseConfig({ publicHost: 'http://ourhost.onion:4222', torProxy: '127.0.0.1:9050' }),
        });

        const response = await zap(app, { adminKey: 'k', did: 'did:cid:bob', amount: 100 });

        expect(response.status).toBe(200);
        expect(seen[0]).toBe('http://drawbridge:4222/invoice?amount=100');
        // The loopback shortcut is a clearnet request, so it must not be
        // dispatched through Tor.
        expect(socksSpy).not.toHaveBeenCalled();
    });

    it('sends a genuine onion endpoint through the SOCKS proxy, not the built-in fetch', async () => {
        // socksDispatcher is built on undici >= 7 and Node's own fetch hands it
        // a v6-era handler it rejects in milliseconds -- which reads like an
        // unreachable Tor destination rather than a wiring bug (#916).
        const builtIn = jest.spyOn(globalThis, 'fetch');
        const socksSpy = jest.spyOn(socksEgress, 'fetch').mockImplementation((async () =>
            jsonResponse({ paymentRequest: 'lnbc1onion' })) as any);

        const { app, lnbits } = build({
            ...withService('http://bobxyz.onion/invoice'),
            config: baseConfig({ torProxy: '127.0.0.1:9050' }),
        });

        const response = await zap(app, { adminKey: 'k', did: 'did:cid:bob', amount: 100 });

        expect(response.status).toBe(200);
        expect(socksSpy).toHaveBeenCalled();
        expect(builtIn).not.toHaveBeenCalled();
        expect(lnbits.payInvoice).toHaveBeenCalledWith('http://lnbits:5000', 'k', 'lnbc1onion');
    });

    it('refuses a redirect from the invoice endpoint instead of following it', async () => {
        // Unlike LNURL, there is no single scheme rule to re-apply here -- the
        // endpoint may legitimately be onion-http -- and an invoice endpoint is
        // a machine API with no reason to redirect.
        jest.spyOn(globalThis, 'fetch').mockImplementation(async () =>
            new Response(null, { status: 307, headers: { location: 'http://redis:6379/' } })
        );

        const { app, lnbits } = build(withService('https://bob.example/invoice'));
        const response = await zap(app, { adminKey: 'k', did: 'did:cid:bob', amount: 100 });

        expect(response.status).toBe(502);
        expect(response.body.error).toContain('redirects are not followed');
        expect(lnbits.payInvoice).not.toHaveBeenCalled();
    });

    it('reports a missing payment request rather than paying nothing', async () => {
        jest.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({ nothing: true }));

        const { app, lnbits } = build(withService('https://bob.example/invoice'));
        const response = await zap(app, { adminKey: 'k', did: 'did:cid:bob', amount: 100 });

        expect(response.status).toBe(502);
        expect(response.body.error).toBe('No payment request returned from recipient');
        expect(lnbits.payInvoice).not.toHaveBeenCalled();
    });
});

describe('L402 invoice routes', () => {
    it('requires a positive amount and maps CLN failure to 502', async () => {
        const cln = fakeCln();
        const { app } = build({ cln });

        expect((await post(app, '/api/v1/l402/invoice', { amountSat: 0 })).status).toBe(400);
        expect(cln.createInvoice).not.toHaveBeenCalled();

        const created = await post(app, '/api/v1/l402/invoice', { amountSat: 21, memo: 'access' });
        expect(created.status).toBe(200);
        expect(created.body.bolt11).toBe('lnbc1l402');
        expect(cln.createInvoice).toHaveBeenCalledWith({ restUrl: 'https://cln:3001', rune: 'test-rune' }, 21, 'access');

        cln.createInvoice.mockRejectedValueOnce(new Error('cln unreachable'));
        const failed = await post(app, '/api/v1/l402/invoice', { amountSat: 21 });
        expect(failed.status).toBe(502);
    });

    it('checks an invoice by payment hash', async () => {
        const cln = fakeCln();
        const { app } = build({ cln });

        expect((await post(app, '/api/v1/l402/check', {})).status).toBe(400);

        const checked = await post(app, '/api/v1/l402/check', { paymentHash: 'hash-l402' });
        expect(checked.status).toBe(200);
        expect(checked.body).toStrictEqual({ paid: false });

        cln.checkInvoice.mockRejectedValueOnce(new Error('cln unreachable'));
        expect((await post(app, '/api/v1/l402/check', { paymentHash: 'hash-l402' })).status).toBe(502);
    });
});

describe('L402 pending invoice lifecycle', () => {
    const pending = {
        paymentHash: 'hash-1',
        macaroonId: 'mac-1',
        serializedMacaroon: 'AgEE...',
        did: 'did:cid:alice',
        scope: ['read'],
        amountSat: 21,
        expiresAt: 1_800_000_000,
        createdAt: 1_700_000_000,
    };

    it('saves, reads back, and deletes', async () => {
        const { app, store } = build();

        const saved = await post(app, '/api/v1/l402/pending', pending);
        expect(saved.status).toBe(201);
        expect(saved.body).toStrictEqual({ ok: true, paymentHash: 'hash-1' });

        const read = await get(app, '/api/v1/l402/pending/hash-1');
        expect(read.status).toBe(200);
        expect(read.body).toStrictEqual(pending);

        const removed = await del(app, '/api/v1/l402/pending/hash-1');
        expect(removed.status).toBe(200);
        expect(store.pending.size).toBe(0);

        expect((await get(app, '/api/v1/l402/pending/hash-1')).status).toBe(404);
    });

    it('rejects a payload missing any required field', async () => {
        // This record gates paid access, so a partial one must not be stored
        // and later read back as if it were complete.
        const { app, store } = build();

        for (const field of Object.keys(pending)) {
            const partial: any = { ...pending };
            delete partial[field];

            const response = await post(app, '/api/v1/l402/pending', partial);
            expect([field, response.status]).toStrictEqual([field, 400]);
        }

        // Non-positive numerics are rejected on the same path.
        for (const bad of [{ amountSat: 0 }, { expiresAt: -1 }, { createdAt: 'soon' }, { scope: 'read' }]) {
            const response = await post(app, '/api/v1/l402/pending', { ...pending, ...bad });
            expect([JSON.stringify(bad), response.status]).toStrictEqual([JSON.stringify(bad), 400]);
        }

        expect(store.pending.size).toBe(0);
    });

    it('coerces the scope entries to strings', async () => {
        const { app, store } = build();

        await post(app, '/api/v1/l402/pending', { ...pending, scope: ['read', 7] });

        expect(store.pending.get('hash-1')?.scope).toStrictEqual(['read', '7']);
    });

    it('answers 500 when the store fails', async () => {
        const store = new FakeStore();
        store.failWith = new Error('redis down');
        const { app } = build({ store });

        expect((await post(app, '/api/v1/l402/pending', pending)).status).toBe(500);
        expect((await get(app, '/api/v1/l402/pending/hash-1')).status).toBe(500);
        expect((await del(app, '/api/v1/l402/pending/hash-1')).status).toBe(500);
    });
});

describe('public invoice endpoint', () => {
    it('needs no admin key -- it is what a payer fetches', async () => {
        const { app, store } = build();
        await store.savePublishedLightning('did:cid:alice', 'inkey');

        const response = await request(app).get(`/invoice/${encodeURIComponent('did:cid:alice')}?amount=100&memo=tip`);

        expect(response.status).toBe(200);
        expect(response.body.paymentRequest).toBe('lnbc1invoice');
    });

    it('requires a positive amount and a published DID', async () => {
        const { app, store } = build();

        const noAmount = await request(app).get(`/invoice/${encodeURIComponent('did:cid:alice')}`);
        expect(noAmount.status).toBe(400);

        const unpublished = await request(app).get(`/invoice/${encodeURIComponent('did:cid:alice')}?amount=100`);
        expect(unpublished.status).toBe(404);
        expect(unpublished.body.error).toBe('DID has not published Lightning');

        await store.savePublishedLightning('did:cid:alice', 'inkey');
        expect((await request(app).get(`/invoice/${encodeURIComponent('did:cid:alice')}?amount=-1`)).status).toBe(400);
    });

    it('answers 503 when LNBits is not configured', async () => {
        const { app } = build({ config: baseConfig({ lnbitsUrl: '' }) });
        const response = await request(app).get(`/invoice/${encodeURIComponent('did:cid:alice')}?amount=100`);

        expect(response.status).toBe(503);
    });
});
