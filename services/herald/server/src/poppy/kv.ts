import { Redis } from 'ioredis';

// The small key-value surface the Personal Agent Protocol state needs: values
// with expiry, an atomic first-writer claim for replay caches, an atomic
// read-and-delete for single-use codes, and sets for per-account indexes.
// Values are JSON strings; TTLs are seconds.
export interface PoppyKV {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, ttlSeconds?: number): Promise<void>;
    setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean>;
    take(key: string): Promise<string | null>;
    del(key: string): Promise<void>;
    addToSet(key: string, member: string): Promise<void>;
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
    private readonly sets = new Map<string, Set<string>>();

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

    async take(key: string): Promise<string | null> {
        const entry = this.live(key);
        this.values.delete(key);
        return entry?.value ?? null;
    }

    async del(key: string): Promise<void> {
        this.values.delete(key);
    }

    async addToSet(key: string, member: string): Promise<void> {
        let set = this.sets.get(key);
        if (!set) {
            set = new Set();
            this.sets.set(key, set);
        }
        set.add(member);
    }

    async removeFromSet(key: string, member: string): Promise<void> {
        this.sets.get(key)?.delete(member);
    }

    async members(key: string): Promise<string[]> {
        return [...(this.sets.get(key) ?? [])];
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

    async take(key: string): Promise<string | null> {
        return this.redis.getdel(this.k(key));
    }

    async del(key: string): Promise<void> {
        await this.redis.del(this.k(key));
    }

    async addToSet(key: string, member: string): Promise<void> {
        await this.redis.sadd(this.k(key), member);
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
