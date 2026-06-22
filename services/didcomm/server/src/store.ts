// Mailbox storage for the DIDComm relay. Encrypted envelopes are stored
// addressed by recipient DID (parsed from the JWE recipient kids) until the
// key-holder fetches them. Async interface so it can be backed by an in-memory
// map (default) or redis (native TTL); mongo can be added the same way.
import { Redis } from 'ioredis';

export interface StoredMessage {
    id: string;
    recipient: string;
    envelope: string;
    received: string;
}

export interface MailboxStore {
    add(recipient: string, envelope: string, id: string): Promise<StoredMessage>;
    list(recipient: string): Promise<StoredMessage[]>;
    remove(recipient: string, ids: string[]): Promise<number>;
    issueChallenge(challenge: string): Promise<void>;
    consumeChallenge(challenge: string): Promise<boolean>;
}

export class MemoryMailboxStore implements MailboxStore {
    private messages = new Map<string, StoredMessage[]>();
    private challenges = new Map<string, number>();

    constructor(
        private readonly messageTtlMs = 7 * 24 * 60 * 60 * 1000,
        private readonly challengeTtlMs = 5 * 60 * 1000,
        private readonly now: () => number = () => Date.now(),
    ) {}

    private prune(recipient: string): void {
        const cutoff = this.now() - this.messageTtlMs;
        const list = (this.messages.get(recipient) || []).filter(m => Date.parse(m.received) >= cutoff);
        if (list.length > 0) {
            this.messages.set(recipient, list);
        }
        else {
            this.messages.delete(recipient);
        }
    }

    async add(recipient: string, envelope: string, id: string): Promise<StoredMessage> {
        const message: StoredMessage = { id, recipient, envelope, received: new Date(this.now()).toISOString() };
        const list = this.messages.get(recipient) || [];
        list.push(message);
        this.messages.set(recipient, list);
        return message;
    }

    async list(recipient: string): Promise<StoredMessage[]> {
        this.prune(recipient);
        return [...(this.messages.get(recipient) || [])];
    }

    async remove(recipient: string, ids: string[]): Promise<number> {
        const list = this.messages.get(recipient) || [];
        const idSet = new Set(ids);
        const kept = list.filter(m => !idSet.has(m.id));
        const removed = list.length - kept.length;
        if (kept.length > 0) {
            this.messages.set(recipient, kept);
        }
        else {
            this.messages.delete(recipient);
        }
        return removed;
    }

    async issueChallenge(challenge: string): Promise<void> {
        this.challenges.set(challenge, this.now() + this.challengeTtlMs);
    }

    // Single-use: true only if known and unexpired; removes it to prevent replay.
    async consumeChallenge(challenge: string): Promise<boolean> {
        const expires = this.challenges.get(challenge);
        if (expires === undefined) {
            return false;
        }
        this.challenges.delete(challenge);
        return this.now() <= expires;
    }
}

// Redis-backed store. Messages and challenges use native key expiry (EX), so a
// recipient's inbox is a SET of ids whose message bodies expire on their own;
// list() lazily prunes ids whose bodies have expired.
export class RedisMailboxStore implements MailboxStore {
    private redis: Redis | null = null;

    constructor(
        private readonly url = process.env.ARCHON_REDIS_URL || 'redis://localhost:6379',
        private readonly prefix = 'didcomm',
        private readonly messageTtlMs = 7 * 24 * 60 * 60 * 1000,
        private readonly challengeTtlMs = 5 * 60 * 1000,
    ) {}

    static async create(url?: string): Promise<RedisMailboxStore> {
        const store = new RedisMailboxStore(url);
        await store.connect();
        return store;
    }

    async connect(): Promise<void> {
        this.redis = new Redis(this.url);
    }

    async disconnect(): Promise<void> {
        if (this.redis) {
            await this.redis.quit();
            this.redis = null;
        }
    }

    private client(): Redis {
        if (!this.redis) {
            throw new Error('Redis is not connected. Call connect() or RedisMailboxStore.create() first.');
        }
        return this.redis;
    }

    private inboxKey = (recipient: string) => `${this.prefix}:inbox:${recipient}`;
    private msgKey = (recipient: string, id: string) => `${this.prefix}:msg:${recipient}:${id}`;
    private challengeKey = (challenge: string) => `${this.prefix}:challenge:${challenge}`;

    async add(recipient: string, envelope: string, id: string): Promise<StoredMessage> {
        const message: StoredMessage = { id, recipient, envelope, received: new Date().toISOString() };
        const ttl = Math.ceil(this.messageTtlMs / 1000);
        await this.client()
            .multi()
            .set(this.msgKey(recipient, id), JSON.stringify(message), 'EX', ttl)
            .sadd(this.inboxKey(recipient), id)
            .expire(this.inboxKey(recipient), ttl)
            .exec();
        return message;
    }

    async list(recipient: string): Promise<StoredMessage[]> {
        const redis = this.client();
        const ids = await redis.smembers(this.inboxKey(recipient));
        if (ids.length === 0) {
            return [];
        }
        const values = await redis.mget(ids.map(id => this.msgKey(recipient, id)));
        const messages: StoredMessage[] = [];
        const expired: string[] = [];
        ids.forEach((id, i) => {
            const value = values[i];
            if (value) {
                messages.push(JSON.parse(value));
            }
            else {
                expired.push(id);
            }
        });
        if (expired.length > 0) {
            await redis.srem(this.inboxKey(recipient), ...expired);
        }
        return messages;
    }

    async remove(recipient: string, ids: string[]): Promise<number> {
        if (ids.length === 0) {
            return 0;
        }
        const redis = this.client();
        const removed = await redis.del(...ids.map(id => this.msgKey(recipient, id)));
        await redis.srem(this.inboxKey(recipient), ...ids);
        return removed;
    }

    async issueChallenge(challenge: string): Promise<void> {
        await this.client().set(this.challengeKey(challenge), '1', 'PX', this.challengeTtlMs);
    }

    async consumeChallenge(challenge: string): Promise<boolean> {
        const value = await this.client().getdel(this.challengeKey(challenge));
        return value !== null;
    }
}
