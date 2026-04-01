import { Redis } from 'ioredis';
import { randomBytes } from 'crypto';

import type { LightningPaymentRecord, LightningStore, PendingInvoiceData } from './types.js';

function safeJsonParse<T>(value: string | undefined, fallback: T): T {
    if (!value) return fallback;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

const PREFIX = 'lightning-mediator';

export class RedisStore implements LightningStore {
    private redis: InstanceType<typeof Redis>;

    constructor(redisUrl?: string) {
        this.redis = new Redis(redisUrl || process.env.ARCHON_LIGHTNING_MEDIATOR_REDIS_URL || process.env.ARCHON_REDIS_URL || 'redis://localhost:6379');
    }

    createPaymentId(): string {
        return randomBytes(16).toString('hex');
    }

    async savePayment(record: LightningPaymentRecord): Promise<void> {
        const key = `${PREFIX}:payment:${record.id}`;
        await this.redis.hmset(key, {
            id: record.id,
            did: record.did,
            method: record.method,
            paymentHash: record.paymentHash,
            amountSat: String(record.amountSat),
            createdAt: String(record.createdAt),
            macaroonId: record.macaroonId || '',
            scope: record.scope ? JSON.stringify(record.scope) : '',
        });

        const didKey = `${PREFIX}:payments:did:${record.did}`;
        await this.redis.zadd(didKey, record.createdAt, record.id);
    }

    async getPayment(id: string): Promise<LightningPaymentRecord | null> {
        const key = `${PREFIX}:payment:${id}`;
        const data = await this.redis.hgetall(key);

        if (!data || !data.id) {
            return null;
        }

        return {
            id: data.id,
            did: data.did,
            method: 'lightning',
            paymentHash: data.paymentHash,
            amountSat: parseInt(data.amountSat, 10),
            createdAt: parseInt(data.createdAt, 10),
            macaroonId: data.macaroonId || undefined,
            scope: data.scope ? safeJsonParse<string[] | undefined>(data.scope, undefined) : undefined,
        };
    }

    async getPaymentsByDid(did: string): Promise<LightningPaymentRecord[]> {
        const didKey = `${PREFIX}:payments:did:${did}`;
        const ids = await this.redis.zrange(didKey, 0, -1);

        const payments: LightningPaymentRecord[] = [];
        for (const id of ids) {
            const payment = await this.getPayment(id);
            if (payment) {
                payments.push(payment);
            }
        }

        return payments;
    }

    async savePendingInvoice(data: PendingInvoiceData): Promise<void> {
        const key = `${PREFIX}:pending:${data.paymentHash}`;
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

        const ttl = data.expiresAt - Math.floor(Date.now() / 1000);
        if (ttl > 0) {
            await this.redis.expire(key, ttl);
        }
    }

    async getPendingInvoice(paymentHash: string): Promise<PendingInvoiceData | null> {
        const key = `${PREFIX}:pending:${paymentHash}`;
        const data = await this.redis.hgetall(key);

        if (!data || !data.paymentHash) {
            return null;
        }

        return {
            paymentHash: data.paymentHash,
            macaroonId: data.macaroonId,
            serializedMacaroon: data.serializedMacaroon || '',
            did: data.did,
            scope: safeJsonParse<string[]>(data.scope, []),
            amountSat: parseInt(data.amountSat, 10),
            expiresAt: parseInt(data.expiresAt, 10),
            createdAt: parseInt(data.createdAt, 10),
        };
    }

    async deletePendingInvoice(paymentHash: string): Promise<void> {
        const key = `${PREFIX}:pending:${paymentHash}`;
        await this.redis.del(key);
    }

    async savePublishedLightning(did: string, invoiceKey: string): Promise<void> {
        const key = `${PREFIX}:published:${did}`;
        await this.redis.set(key, invoiceKey);
    }

    async getPublishedLightning(did: string): Promise<string | null> {
        const key = `${PREFIX}:published:${did}`;
        return await this.redis.get(key);
    }

    async deletePublishedLightning(did: string): Promise<void> {
        const key = `${PREFIX}:published:${did}`;
        await this.redis.del(key);
    }

    async disconnect(): Promise<void> {
        await this.redis.quit();
    }
}
