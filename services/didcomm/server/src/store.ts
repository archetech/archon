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

// Thrown by add() when a cap would be exceeded. The route maps this to 429 so a
// sender learns delivery failed rather than losing the message silently.
export class MailboxFullError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'MailboxFullError';
    }
}

export interface MailboxCaps {
    // Byte-based rather than count-based: with a 5mb upload limit, "N messages"
    // is anywhere from a few KB to several GB, so counts do not bound the
    // resource that actually runs out.
    maxRecipientBytes?: number;
    maxTotalBytes?: number;
    // Hard ceiling on live challenges. Sweeping expired ones bounds retention
    // only: GET /challenge is unauthenticated, so within the TTL an anonymous
    // caller can hold arbitrarily many entries that are all still valid.
    maxChallenges?: number;
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
    private lastSweep = 0;
    private writesSinceSweep = 0;

    // Sweep is triggered by writes rather than a timer. Growth only happens on a
    // write, so an idle store needs no sweeping -- and no timer means no handle
    // to leak into the Jest run (this suite runs --runInBand without
    // --forceExit, where a stray interval hangs the whole workflow).
    private static readonly SWEEP_EVERY_WRITES = 128;
    private static readonly SWEEP_EVERY_MS = 60 * 1000;

    constructor(
        private readonly messageTtlMs = 7 * 24 * 60 * 60 * 1000,
        private readonly challengeTtlMs = 5 * 60 * 1000,
        private readonly now: () => number = () => Date.now(),
        private readonly caps: MailboxCaps = {},
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

    // Shed everything expired, in every mailbox, plus dead challenges. Read
    // paths only ever pruned the mailbox being read, so anything never polled
    // was retained forever -- and unconsumed challenges were retained always.
    sweep(): void {
        for (const recipient of [...this.messages.keys()]) {
            this.prune(recipient);
        }

        const now = this.now();
        for (const [challenge, expires] of this.challenges) {
            if (now > expires) {
                this.challenges.delete(challenge);
            }
        }

        this.lastSweep = now;
        this.writesSinceSweep = 0;
    }

    private maybeSweep(): void {
        this.writesSinceSweep += 1;
        const due = this.writesSinceSweep >= MemoryMailboxStore.SWEEP_EVERY_WRITES
            || this.now() - this.lastSweep >= MemoryMailboxStore.SWEEP_EVERY_MS;
        if (due) {
            this.sweep();
        }
    }

    private bytesFor(list: StoredMessage[]): number {
        return list.reduce((total, m) => total + Buffer.byteLength(m.envelope, 'utf-8'), 0);
    }

    private totalBytes(): number {
        let total = 0;
        for (const list of this.messages.values()) {
            total += this.bytesFor(list);
        }
        return total;
    }

    // Which cap, if any, the store is over. Expired messages still occupying the
    // maps would count, so callers re-check after a sweep before rejecting.
    private overCap(recipient: string, size: number): string | null {
        const { maxRecipientBytes, maxTotalBytes } = this.caps;

        if (maxRecipientBytes !== undefined
            && this.bytesFor(this.messages.get(recipient) || []) + size > maxRecipientBytes) {
            return `recipient mailbox is full (limit ${maxRecipientBytes} bytes)`;
        }

        if (maxTotalBytes !== undefined && this.totalBytes() + size > maxTotalBytes) {
            return `mailbox storage is full (limit ${maxTotalBytes} bytes)`;
        }

        return null;
    }

    async add(recipient: string, envelope: string, id: string): Promise<StoredMessage> {
        this.maybeSweep();

        const size = Buffer.byteLength(envelope, 'utf-8');
        let full = this.overCap(recipient, size);

        if (full) {
            // maybeSweep() is throttled, so the measurement above can include
            // messages that have already expired. Never reject on stale
            // accounting: sweep for real, then decide.
            this.sweep();
            full = this.overCap(recipient, size);
        }

        if (full) {
            throw new MailboxFullError(full);
        }

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
        // GET /challenge is unauthenticated by design, so this is the map an
        // anonymous caller can grow; sweep on the same path that grows it.
        this.maybeSweep();

        const { maxChallenges } = this.caps;

        if (maxChallenges !== undefined && this.challenges.size >= maxChallenges) {
            // As in add(): never refuse on stale accounting.
            this.sweep();

            if (this.challenges.size >= maxChallenges) {
                throw new MailboxFullError(`too many outstanding challenges (limit ${maxChallenges})`);
            }
        }

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

// Redis-backed store. Messages and challenges use native key expiry (EX/PX), so
// retention is enforced by redis itself rather than by sweeping; a recipient's
// inbox is a SET of ids whose message bodies expire on their own.
//
// maxRecipientBytes is enforced here, but approximately: the measurement and the
// write are separate round trips, so concurrent deliveries (or several relay
// instances sharing one redis) can both measure under the cap and both commit.
// Overshoot is bounded by concurrency x message size. The cap is a safety bound
// rather than an accounting invariant; making it exact needs a Lua script that
// prunes, measures and inserts in one step.
//
// maxChallenges is NOT enforced here, for the same reason as maxTotalBytes:
// counting live challenges means scanning the keyspace on every issue.
//
// maxTotalBytes is NOT enforced either: a running total
// would drift permanently, because keys that expire via TTL never decrement it,
// and recomputing it would mean scanning the keyspace on every write. Bounding
// total storage on redis is therefore a deployment concern -- a dedicated redis
// instance or database with `maxmemory` set. Do not set an eviction policy on a
// redis shared with gatekeeper, drawbridge and the mediators; it would evict
// their keys too. See docs/services/didcomm/README.md.
export class RedisMailboxStore implements MailboxStore {
    private redis: Redis | null = null;

    constructor(
        private readonly url = process.env.ARCHON_REDIS_URL || 'redis://localhost:6379',
        private readonly prefix = 'didcomm',
        private readonly messageTtlMs = 7 * 24 * 60 * 60 * 1000,
        private readonly challengeTtlMs = 5 * 60 * 1000,
        private readonly caps: MailboxCaps = {},
    ) {}

    static async create(url?: string, caps: MailboxCaps = {}): Promise<RedisMailboxStore> {
        const store = new RedisMailboxStore(url, undefined, undefined, undefined, caps);
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

    // Reads the recipient's own inbox to measure it, and drops ids whose bodies
    // have already expired while it is there. That pruning matters on its own:
    // add() refreshes the inbox set's TTL on every insert, so under sustained
    // delivery the set never expires and would otherwise accumulate dead ids.
    private async measureAndPrune(recipient: string): Promise<number> {
        const redis = this.client();
        const ids = await redis.smembers(this.inboxKey(recipient));
        if (ids.length === 0) {
            return 0;
        }

        const values = await redis.mget(ids.map(id => this.msgKey(recipient, id)));
        const expired: string[] = [];
        let bytes = 0;

        ids.forEach((id, i) => {
            const value = values[i];
            if (value) {
                bytes += Buffer.byteLength(JSON.parse(value).envelope, 'utf-8');
            }
            else {
                expired.push(id);
            }
        });

        if (expired.length > 0) {
            await redis.srem(this.inboxKey(recipient), ...expired);
        }

        return bytes;
    }

    async add(recipient: string, envelope: string, id: string): Promise<StoredMessage> {
        const { maxRecipientBytes } = this.caps;

        if (maxRecipientBytes !== undefined) {
            const size = Buffer.byteLength(envelope, 'utf-8');
            if (await this.measureAndPrune(recipient) + size > maxRecipientBytes) {
                throw new MailboxFullError(`recipient mailbox is full (limit ${maxRecipientBytes} bytes)`);
            }
        }

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
