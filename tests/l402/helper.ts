import { createHash, randomBytes } from 'crypto';
import type { ClnConfig, CashuConfig, L402MiddlewareOptions } from '../../packages/l402/src/types.js';
import { L402StoreMemory } from '../../packages/l402/src/store-memory.js';

export const TEST_ROOT_SECRET = 'test-root-secret-key-for-macaroons-hmac-chain';
export const TEST_LOCATION = 'http://localhost:4224';

export const TEST_DID = 'did:cid:z3v8AuahvBGDMXvCTWedYbxnH6C9ZrsEtEJAvip2XPzcZb8yo6A';

export function generateTestPreimage(): { preimage: string; paymentHash: string } {
    const preimage = randomBytes(32).toString('hex');
    const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
    return { preimage, paymentHash };
}

export const MOCK_CLN_CONFIG: ClnConfig = {
    restUrl: 'http://localhost:3010',
    rune: 'test-rune-token',
};

export const MOCK_CASHU_CONFIG: CashuConfig = {
    mintUrl: 'https://mint.example.com',
    trustedMints: ['https://mint.example.com', 'https://mint2.example.com'],
};

export function createMockClnInvoiceResponse(paymentHash: string) {
    return {
        bolt11: 'lnbc1000n1pjtest...',
        payment_hash: paymentHash,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
    };
}

export function createMockClnListInvoicesResponse(paymentHash: string, paid: boolean, preimage?: string) {
    return {
        invoices: [{
            payment_hash: paymentHash,
            status: paid ? 'paid' : 'unpaid',
            payment_preimage: preimage,
            amount_msat: 100000,
        }],
    };
}

export function createTestMiddlewareOptions(overrides?: Partial<L402MiddlewareOptions>): L402MiddlewareOptions {
    return {
        rootSecret: TEST_ROOT_SECRET,
        location: TEST_LOCATION,
        cln: MOCK_CLN_CONFIG,
        cashu: MOCK_CASHU_CONFIG,
        defaults: {
            amountSat: 100,
            expirySeconds: 3600,
            scopes: ['resolveDID', 'getDIDs'],
        },
        rateLimitRequests: 1000,
        rateLimitWindowSeconds: 3600,
        store: new L402StoreMemory(),
        ...overrides,
    };
}
