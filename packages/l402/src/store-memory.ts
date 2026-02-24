import type { L402Store, MacaroonRecord, PaymentRecord, PendingInvoiceData, RateLimitResult } from './types.js';

export class L402StoreMemory implements L402Store {
    private macaroons = new Map<string, MacaroonRecord>();
    private payments = new Map<string, PaymentRecord>();
    private paymentsByDid = new Map<string, string[]>();
    private rateLimits = new Map<string, number[]>();
    private pendingInvoices = new Map<string, PendingInvoiceData>();

    async saveMacaroon(record: MacaroonRecord): Promise<void> {
        this.macaroons.set(record.id, { ...record });
    }

    async getMacaroon(id: string): Promise<MacaroonRecord | null> {
        const record = this.macaroons.get(id);
        return record ? { ...record } : null;
    }

    async revokeMacaroon(id: string): Promise<void> {
        const record = this.macaroons.get(id);
        if (record) {
            record.revoked = true;
        }
    }

    async incrementUsage(id: string): Promise<number> {
        const record = this.macaroons.get(id);
        if (!record) {
            throw new Error(`Macaroon ${id} not found`);
        }
        record.currentUses += 1;
        return record.currentUses;
    }

    async savePayment(record: PaymentRecord): Promise<void> {
        this.payments.set(record.id, { ...record });
        const didPayments = this.paymentsByDid.get(record.did) || [];
        didPayments.push(record.id);
        this.paymentsByDid.set(record.did, didPayments);
    }

    async getPayment(id: string): Promise<PaymentRecord | null> {
        const record = this.payments.get(id);
        return record ? { ...record } : null;
    }

    async getPaymentsByDid(did: string): Promise<PaymentRecord[]> {
        const ids = this.paymentsByDid.get(did) || [];
        return ids
            .map(id => this.payments.get(id))
            .filter((r): r is PaymentRecord => r !== undefined)
            .map(r => ({ ...r }));
    }

    async checkRateLimit(did: string, maxRequests: number, windowSeconds: number): Promise<RateLimitResult> {
        const now = Math.floor(Date.now() / 1000);
        const windowStart = now - windowSeconds;
        const timestamps = (this.rateLimits.get(did) || []).filter(t => t > windowStart);
        this.rateLimits.set(did, timestamps);

        const remaining = Math.max(0, maxRequests - timestamps.length);
        const allowed = timestamps.length < maxRequests;
        const resetAt = timestamps.length > 0 ? timestamps[0] + windowSeconds : now + windowSeconds;

        return { allowed, remaining, resetAt };
    }

    async recordRequest(did: string, windowSeconds: number): Promise<void> {
        const now = Math.floor(Date.now() / 1000);
        const windowStart = now - windowSeconds;
        const timestamps = (this.rateLimits.get(did) || []).filter(t => t > windowStart);
        timestamps.push(now);
        this.rateLimits.set(did, timestamps);
    }

    async savePendingInvoice(data: PendingInvoiceData): Promise<void> {
        this.pendingInvoices.set(data.paymentHash, { ...data });
    }

    async getPendingInvoice(paymentHash: string): Promise<PendingInvoiceData | null> {
        const data = this.pendingInvoices.get(paymentHash);
        return data ? { ...data } : null;
    }

    async deletePendingInvoice(paymentHash: string): Promise<void> {
        this.pendingInvoices.delete(paymentHash);
    }

    // For testing: clear all data
    clear(): void {
        this.macaroons.clear();
        this.payments.clear();
        this.paymentsByDid.clear();
        this.rateLimits.clear();
        this.pendingInvoices.clear();
    }

    // For analytics: get all payments
    async getAllPayments(): Promise<PaymentRecord[]> {
        return Array.from(this.payments.values()).map(r => ({ ...r }));
    }

    // For analytics: get all macaroons
    async getAllMacaroons(): Promise<MacaroonRecord[]> {
        return Array.from(this.macaroons.values()).map(r => ({ ...r }));
    }
}
