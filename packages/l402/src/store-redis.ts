import { Redis } from 'ioredis';
import { randomBytes } from 'crypto';
import type { L402Store, MacaroonRecord, PaymentRecord, PendingInvoiceData, RateLimitResult } from './types.js';

export class L402StoreRedis implements L402Store {
    private redis: InstanceType<typeof Redis>;

    constructor(redisUrl?: string) {
        this.redis = new Redis(redisUrl || process.env.ARCHON_REDIS_URL || 'redis://localhost:6379');
    }

    async saveMacaroon(record: MacaroonRecord): Promise<void> {
        const key = `l402:macaroon:${record.id}`;
        await this.redis.hmset(key, {
            id: record.id,
            did: record.did,
            scope: JSON.stringify(record.scope),
            createdAt: String(record.createdAt),
            expiresAt: String(record.expiresAt),
            maxUses: String(record.maxUses),
            currentUses: String(record.currentUses),
            paymentHash: record.paymentHash,
            revoked: record.revoked ? '1' : '0',
        });

        // Set TTL based on expiry
        const ttl = record.expiresAt - Math.floor(Date.now() / 1000);
        if (ttl > 0) {
            await this.redis.expire(key, ttl + 3600); // Extra hour buffer
        }
    }

    async getMacaroon(id: string): Promise<MacaroonRecord | null> {
        const key = `l402:macaroon:${id}`;
        const data = await this.redis.hgetall(key);

        if (!data || !data.id) {
            return null;
        }

        return {
            id: data.id,
            did: data.did,
            scope: JSON.parse(data.scope),
            createdAt: parseInt(data.createdAt, 10),
            expiresAt: parseInt(data.expiresAt, 10),
            maxUses: parseInt(data.maxUses, 10),
            currentUses: parseInt(data.currentUses, 10),
            paymentHash: data.paymentHash,
            revoked: data.revoked === '1',
        };
    }

    async revokeMacaroon(id: string): Promise<void> {
        const key = `l402:macaroon:${id}`;
        await this.redis.hset(key, 'revoked', '1');
    }

    async incrementUsage(id: string): Promise<number> {
        const key = `l402:macaroon:${id}`;
        return await this.redis.hincrby(key, 'currentUses', 1);
    }

    async savePayment(record: PaymentRecord): Promise<void> {
        const key = `l402:payment:${record.id}`;
        await this.redis.hmset(key, {
            id: record.id,
            did: record.did,
            method: record.method,
            paymentHash: record.paymentHash,
            amountSat: String(record.amountSat),
            createdAt: String(record.createdAt),
            macaroonId: record.macaroonId,
            scope: record.scope ? JSON.stringify(record.scope) : '',
        });

        // Add to DID's payment index
        const didKey = `l402:payments:did:${record.did}`;
        await this.redis.zadd(didKey, record.createdAt, record.id);
    }

    async getPayment(id: string): Promise<PaymentRecord | null> {
        const key = `l402:payment:${id}`;
        const data = await this.redis.hgetall(key);

        if (!data || !data.id) {
            return null;
        }

        return {
            id: data.id,
            did: data.did,
            method: data.method as 'lightning' | 'cashu',
            paymentHash: data.paymentHash,
            amountSat: parseInt(data.amountSat, 10),
            createdAt: parseInt(data.createdAt, 10),
            macaroonId: data.macaroonId,
            scope: data.scope ? JSON.parse(data.scope) : undefined,
        };
    }

    async getPaymentsByDid(did: string): Promise<PaymentRecord[]> {
        const didKey = `l402:payments:did:${did}`;
        const ids = await this.redis.zrange(didKey, 0, -1);

        const payments: PaymentRecord[] = [];
        for (const id of ids) {
            const payment = await this.getPayment(id);
            if (payment) {
                payments.push(payment);
            }
        }

        return payments;
    }

    async checkRateLimit(did: string, maxRequests: number, windowSeconds: number): Promise<RateLimitResult> {
        const key = `l402:ratelimit:${did}`;
        const now = Math.floor(Date.now() / 1000);
        const windowStart = now - windowSeconds;

        // Remove old entries
        await this.redis.zremrangebyscore(key, '-inf', windowStart);

        // Count current entries
        const count = await this.redis.zcard(key);
        const remaining = Math.max(0, maxRequests - count);
        const allowed = count < maxRequests;

        // Get the oldest entry for reset time calculation
        const oldest = await this.redis.zrange(key, 0, 0, 'WITHSCORES');
        const resetAt = oldest.length >= 2 ? parseInt(oldest[1], 10) + windowSeconds : now + windowSeconds;

        return { allowed, remaining, resetAt };
    }

    async recordRequest(did: string, windowSeconds: number): Promise<void> {
        const key = `l402:ratelimit:${did}`;
        const now = Math.floor(Date.now() / 1000);

        await this.redis.zadd(key, now, `${now}-${randomBytes(8).toString('hex')}`);
        await this.redis.expire(key, windowSeconds);
    }

    async savePendingInvoice(data: PendingInvoiceData): Promise<void> {
        const key = `l402:pending:${data.paymentHash}`;
        await this.redis.hmset(key, {
            paymentHash: data.paymentHash,
            macaroonId: data.macaroonId,
            serializedMacaroon: data.serializedMacaroon,
            did: data.did,
            scope: JSON.stringify(data.scope),
            amountSat: String(data.amountSat),
            expiresAt: String(data.expiresAt),
            createdAt: String(data.createdAt),
        });

        // Set TTL
        const ttl = data.expiresAt - Math.floor(Date.now() / 1000);
        if (ttl > 0) {
            await this.redis.expire(key, ttl);
        }
    }

    async getPendingInvoice(paymentHash: string): Promise<PendingInvoiceData | null> {
        const key = `l402:pending:${paymentHash}`;
        const data = await this.redis.hgetall(key);

        if (!data || !data.paymentHash) {
            return null;
        }

        return {
            paymentHash: data.paymentHash,
            macaroonId: data.macaroonId,
            serializedMacaroon: data.serializedMacaroon || '',
            did: data.did,
            scope: JSON.parse(data.scope),
            amountSat: parseInt(data.amountSat, 10),
            expiresAt: parseInt(data.expiresAt, 10),
            createdAt: parseInt(data.createdAt, 10),
        };
    }

    async deletePendingInvoice(paymentHash: string): Promise<void> {
        const key = `l402:pending:${paymentHash}`;
        await this.redis.del(key);
    }

    async disconnect(): Promise<void> {
        await this.redis.quit();
    }
}
