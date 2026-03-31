export interface LightningMediatorConfig {
    port: number;
    bindAddress: string;
    redisUrl: string;
    clnRestUrl: string;
    clnRune: string;
    lnbitsUrl: string;
    publicHost: string;
    torProxy: string;
}

export interface ReadinessStatus {
    ready: boolean;
    dependencies: {
        redis: boolean;
        clnConfigured: boolean;
        lnbitsConfigured: boolean;
    };
}

export interface ClnConfig {
    restUrl: string;
    rune: string;
}

export interface LightningInvoice {
    paymentRequest: string;
    paymentHash: string;
    amountSat: number;
    expiry: number;
    label: string;
}

export interface LightningPaymentResult {
    paid: boolean;
    preimage?: string;
    paymentHash: string;
    amountSat?: number;
}

export interface LnbitsWallet {
    walletId: string;
    adminKey: string;
    invoiceKey: string;
}

export interface LnbitsPayment {
    paymentHash: string;
    amount: number;
    fee: number;
    memo: string;
    time: string;
    pending: boolean;
    status: 'success' | 'pending' | 'failed';
    expiry?: number;
}

export interface LightningPaymentRecord {
    id: string;
    did: string;
    method: 'lightning';
    paymentHash: string;
    amountSat: number;
    createdAt: number;
    macaroonId?: string;
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

export interface LightningStore {
    savePayment(record: LightningPaymentRecord): Promise<void>;
    getPayment(id: string): Promise<LightningPaymentRecord | null>;
    getPaymentsByDid(did: string): Promise<LightningPaymentRecord[]>;
    savePendingInvoice(data: PendingInvoiceData): Promise<void>;
    getPendingInvoice(paymentHash: string): Promise<PendingInvoiceData | null>;
    deletePendingInvoice(paymentHash: string): Promise<void>;
    savePublishedLightning(did: string, invoiceKey: string): Promise<void>;
    getPublishedLightning(did: string): Promise<string | null>;
    deletePublishedLightning(did: string): Promise<void>;
    disconnect(): Promise<void>;
}
