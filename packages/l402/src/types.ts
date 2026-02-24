export interface L402CaveatSet {
    did?: string;
    scope?: string[];
    expiry?: number;       // Unix timestamp
    maxUses?: number;
    paymentHash?: string;
}

export interface L402Token {
    id: string;
    macaroon: string;      // base64-encoded serialized macaroon
    invoice?: string;       // bolt11 invoice string
    preimage?: string;
    cashuToken?: string;
}

export interface LightningInvoice {
    paymentRequest: string; // bolt11 string
    paymentHash: string;
    amountSat: number;
    expiry: number;         // seconds until expiry
    label: string;
}

export interface LightningPaymentResult {
    paid: boolean;
    preimage?: string;
    paymentHash: string;
    amountSat?: number;
}

export interface CashuPayment {
    token: string;
    amount: number;         // in sats
    mint: string;
}

export interface CashuRedemptionResult {
    redeemed: boolean;
    amount: number;
    receiptId: string;
}

export interface PaymentVerificationResult {
    method: 'lightning' | 'cashu';
    verified: boolean;
    paymentHash: string;
    amountSat: number;
}

export interface ClnConfig {
    restUrl: string;
    rune: string;           // CLN rune auth token
}

export interface CashuConfig {
    mintUrl: string;
    trustedMints: string[];
}

export interface L402MiddlewareOptions {
    rootSecret: string;
    location: string;
    cln?: ClnConfig;
    cashu?: CashuConfig;
    defaults: {
        amountSat: number;
        expirySeconds: number;
        scopes: string[];
    };
    rateLimitRequests: number;
    rateLimitWindowSeconds: number;
    store: L402Store;
    gatekeeper?: {
        resolveDID: (did: string) => Promise<any>;
    };
    pricing?: OperationPricingConfig;
    hooks?: {
        onChallenge?: (didKnown: boolean) => void;
        onMacaroonVerification?: (result: 'success' | 'failure') => void;
    };
}

export interface L402Store {
    // Macaroon CRUD
    saveMacaroon(record: MacaroonRecord): Promise<void>;
    getMacaroon(id: string): Promise<MacaroonRecord | null>;
    revokeMacaroon(id: string): Promise<void>;
    incrementUsage(id: string): Promise<number>;

    // Payment CRUD
    savePayment(record: PaymentRecord): Promise<void>;
    getPayment(id: string): Promise<PaymentRecord | null>;
    getPaymentsByDid(did: string): Promise<PaymentRecord[]>;

    // Rate limiting
    checkRateLimit(did: string, maxRequests: number, windowSeconds: number): Promise<RateLimitResult>;
    recordRequest(did: string, windowSeconds: number): Promise<void>;
    /** Atomically check rate limit and record the request if allowed */
    checkAndRecordRequest(did: string, maxRequests: number, windowSeconds: number): Promise<RateLimitResult>;

    // Pending invoices
    savePendingInvoice(data: PendingInvoiceData): Promise<void>;
    getPendingInvoice(paymentHash: string): Promise<PendingInvoiceData | null>;
    deletePendingInvoice(paymentHash: string): Promise<void>;
}

export interface MacaroonRecord {
    id: string;
    did: string;
    scope: string[];
    createdAt: number;
    expiresAt: number;
    maxUses: number;
    currentUses: number;
    paymentHash: string;
    revoked: boolean;
}

export interface PaymentRecord {
    id: string;
    did: string;
    method: 'lightning' | 'cashu';
    paymentHash: string;
    amountSat: number;
    createdAt: number;
    macaroonId: string;
    scope?: string[];
}

export interface PendingInvoiceData {
    paymentHash: string;
    macaroonId: string;
    serializedMacaroon: string;
    did: string;
    scope: string[];
    amountSat: number;
    expiresAt: number;
    createdAt: number;
}

export interface RateLimitResult {
    allowed: boolean;
    remaining: number;
    resetAt: number;
}

export interface OperationPrice {
    amountSat: number;
    description: string;
}

export interface OperationPricingConfig {
    operations: Record<string, OperationPrice>;
}

export interface L402AccessCredentialSubject {
    paymentMethod: 'lightning' | 'cashu';
    paymentHash: string;
    amountSat: number;
    scope: string[];
    macaroonId: string;
}

export interface L402MacaroonData {
    id: string;
    caveats: L402CaveatSet;
    valid: boolean;
}

export interface PaymentAnalytics {
    totalPayments: number;
    totalRevenueSat: number;
    byMethod: Record<string, { count: number; revenueSat: number }>;
    byDid: Record<string, { count: number; revenueSat: number }>;
    byScope: Record<string, number>;
}

export interface CaveatContext {
    did?: string;
    scope?: string;
    currentTime?: number;
    currentUses?: number;
    paymentHash?: string;
}
