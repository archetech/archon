// L402 caveat set — conditions encoded into macaroons
export interface L402CaveatSet {
    did?: string;
    scope?: string[];
    expiry?: number;       // Unix timestamp
    maxUses?: number;
    paymentHash?: string;
}

// Serialized L402 token returned to clients
export interface L402Token {
    id: string;
    macaroon: string;      // base64-encoded serialized macaroon
    invoice?: string;       // bolt11 invoice string
}

// Lightning invoice from CLN
export interface LightningInvoice {
    paymentRequest: string; // bolt11 string
    paymentHash: string;
    amountSat: number;
    expiry: number;         // seconds until expiry
    label: string;
}

// Result of checking an invoice
export interface LightningPaymentResult {
    paid: boolean;
    preimage?: string;
    paymentHash: string;
    amountSat?: number;
}

// CLN REST API configuration
export interface ClnConfig {
    restUrl: string;
    rune: string;
}

// Caveat verification context
export interface CaveatContext {
    did?: string;
    scope?: string;
    currentTime?: number;
    currentUses?: number;
    paymentHash?: string;
}

// Verified macaroon data
export interface L402MacaroonData {
    id: string;
    caveats: L402CaveatSet;
    valid: boolean;
}

// Store interface for macaroons, payments, and rate limiting
export interface DrawbridgeStore {
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
    checkAndRecordRequest(did: string, maxRequests: number, windowSeconds: number): Promise<RateLimitResult>;

    // Pending invoices
    savePendingInvoice(data: PendingInvoiceData): Promise<void>;
    getPendingInvoice(paymentHash: string): Promise<PendingInvoiceData | null>;
    deletePendingInvoice(paymentHash: string): Promise<void>;
}

// Persisted macaroon record
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

// Persisted payment record
export interface PaymentRecord {
    id: string;
    did: string;
    method: 'lightning';
    paymentHash: string;
    amountSat: number;
    createdAt: number;
    macaroonId: string;
    scope?: string[];
}

// Invoice waiting for payment
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

// Rate limit check result
export interface RateLimitResult {
    allowed: boolean;
    remaining: number;
    resetAt: number;
}

// Per-operation pricing
export interface OperationPrice {
    amountSat: number;
    description: string;
}

export interface OperationPricingConfig {
    operations: Record<string, OperationPrice>;
}

// L402 middleware configuration
export interface L402Options {
    rootSecret: string;
    location: string;
    cln: ClnConfig;
    defaults: {
        amountSat: number;
        expirySeconds: number;
        scopes: string[];
    };
    rateLimitRequests: number;
    rateLimitWindowSeconds: number;
    store: DrawbridgeStore;
    pricing?: OperationPricingConfig;
    hooks?: {
        onChallenge?: (didKnown: boolean) => void;
        onMacaroonVerification?: (result: 'success' | 'failure') => void;
    };
    logger?: { error?: (...args: any[]) => void };
}
