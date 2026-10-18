import { Redis } from 'ioredis';

// The small key-value surface the Personal Agent Protocol state needs: values
// with expiry, an atomic first-writer claim for replay caches, an atomic
// read-and-delete for single-use codes, and sets for per-account indexes.
// Values are JSON strings; TTLs are seconds. Every operation that decides a
// race (claims, consumption, conditional replacement) is a single atomic
// store command, so concurrent Herald requests agree on the winner.
export interface PoppyKV {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, ttlSeconds?: number): Promise<void>;
    setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean>;
    // Replaces a value only while the key still exists, so a write racing a
    // deletion cannot bring the key back.
    setIfPresent(key: string, value: string, ttlSeconds: number): Promise<boolean>;
    take(key: string): Promise<string | null>;
    // Deletes the key only while it still holds `value`.
    deleteIfEquals(key: string, value: string): Promise<boolean>;
    del(key: string): Promise<void>;
    // The set's lifetime is extended to at least ttlSeconds on each add.
    addToSet(key: string, member: string, ttlSeconds: number): Promise<void>;
    removeFromSet(key: string, member: string): Promise<void>;
    members(key: string): Promise<string[]>;
    close?(): Promise<void>;
}

interface MemoryEntry {
    value: string;
    expiresAt?: number;
}

// For tests and single-process development. State is lost on restart, which
// signs every agent out.
export class MemoryKV implements PoppyKV {
    private readonly values = new Map<string, MemoryEntry>();
    private readonly sets = new Map<string, { members: Set<string>; expiresAt: number }>();

    constructor(private readonly now: () => number = Date.now) {}

    private live(key: string): MemoryEntry | undefined {
        const entry = this.values.get(key);
        if (entry?.expiresAt !== undefined && entry.expiresAt <= this.now()) {
            this.values.delete(key);
            return undefined;
        }
        return entry;
    }

    async get(key: string): Promise<string | null> {
        return this.live(key)?.value ?? null;
    }

    async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
        this.values.set(key, {
            value,
            expiresAt: ttlSeconds === undefined ? undefined : this.now() + ttlSeconds * 1000,
        });
    }

    async setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
        if (this.live(key)) {
            return false;
        }
        await this.set(key, value, ttlSeconds);
        return true;
    }

    async setIfPresent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
        if (!this.live(key)) {
            return false;
        }
        await this.set(key, value, ttlSeconds);
        return true;
    }

    async take(key: string): Promise<string | null> {
        const entry = this.live(key);
        this.values.delete(key);
        return entry?.value ?? null;
    }

    async deleteIfEquals(key: string, value: string): Promise<boolean> {
        if (this.live(key)?.value !== value) {
            return false;
        }
        this.values.delete(key);
        return true;
    }

    async del(key: string): Promise<void> {
        this.values.delete(key);
    }

    private liveSet(key: string) {
        const set = this.sets.get(key);
        if (set && set.expiresAt <= this.now()) {
            this.sets.delete(key);
            return undefined;
        }
        return set;
    }

    async addToSet(key: string, member: string, ttlSeconds: number): Promise<void> {
        const expiresAt = this.now() + ttlSeconds * 1000;
        const set = this.liveSet(key);
        if (set) {
            set.members.add(member);
            set.expiresAt = Math.max(set.expiresAt, expiresAt);
        } else {
            this.sets.set(key, { members: new Set([member]), expiresAt });
        }
    }

    async removeFromSet(key: string, member: string): Promise<void> {
        this.liveSet(key)?.members.delete(member);
    }

    async members(key: string): Promise<string[]> {
        return [...(this.liveSet(key)?.members ?? [])];
    }
}

export class RedisKV implements PoppyKV {
    private readonly redis: Redis;

    constructor(redisUrl: string, private readonly prefix: string) {
        this.redis = new Redis(redisUrl);
    }

    private k(key: string): string {
        return `${this.prefix}:${key}`;
    }

    async get(key: string): Promise<string | null> {
        return this.redis.get(this.k(key));
    }

    async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
        if (ttlSeconds === undefined) {
            await this.redis.set(this.k(key), value);
        } else {
            await this.redis.set(this.k(key), value, 'EX', Math.max(1, Math.ceil(ttlSeconds)));
        }
    }

    async setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
        const result = await this.redis.set(this.k(key), value, 'EX', Math.max(1, Math.ceil(ttlSeconds)), 'NX');
        return result === 'OK';
    }

    async setIfPresent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
        const result = await this.redis.set(this.k(key), value, 'EX', Math.max(1, Math.ceil(ttlSeconds)), 'XX');
        return result === 'OK';
    }

    async take(key: string): Promise<string | null> {
        return this.redis.getdel(this.k(key));
    }

    async deleteIfEquals(key: string, value: string): Promise<boolean> {
        const deleted = await this.redis.eval(
            "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
            1, this.k(key), value,
        );
        return deleted === 1;
    }

    async del(key: string): Promise<void> {
        await this.redis.del(this.k(key));
    }

    async addToSet(key: string, member: string, ttlSeconds: number): Promise<void> {
        const ttl = Math.max(1, Math.ceil(ttlSeconds));
        await this.redis.multi()
            .sadd(this.k(key), member)
            // GT keeps a longer lifetime already set by another member.
            .expire(this.k(key), ttl, 'GT')
            .expire(this.k(key), ttl, 'NX')
            .exec();
    }

    async removeFromSet(key: string, member: string): Promise<void> {
        await this.redis.srem(this.k(key), member);
    }

    async members(key: string): Promise<string[]> {
        return this.redis.smembers(this.k(key));
    }

    async close(): Promise<void> {
        await this.redis.quit();
    }
}
