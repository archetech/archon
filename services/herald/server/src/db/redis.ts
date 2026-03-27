import { Redis } from 'ioredis';
import { DatabaseInterface, User } from './interfaces.js';

const REDIS_NOT_STARTED_ERROR = 'Redis not started. Call init() first.';

export class DbRedis implements DatabaseInterface {
    private readonly redisUrl: string;
    private readonly namespace: string;
    private redis: Redis | null = null;

    constructor(namespace: string = 'herald', redisUrl?: string) {
        this.namespace = namespace;
        this.redisUrl = redisUrl || process.env.ARCHON_HERALD_REDIS_URL || process.env.ARCHON_REDIS_URL || 'redis://localhost:6379';
    }

    private get usersKey(): string {
        return `${this.namespace}:users`;
    }

    private get namesKey(): string {
        return `${this.namespace}:names`;
    }

    async init(): Promise<void> {
        this.redis = new Redis(this.redisUrl);
    }

    async close(): Promise<void> {
        if (this.redis) {
            await this.redis.quit();
            this.redis = null;
        }
    }

    async getUser(did: string): Promise<User | null> {
        if (!this.redis) {
            throw new Error(REDIS_NOT_STARTED_ERROR);
        }

        const payload = await this.redis.hget(this.usersKey, did);
        return payload ? JSON.parse(payload) as User : null;
    }

    async setUser(did: string, user: User): Promise<void> {
        if (!this.redis) {
            throw new Error(REDIS_NOT_STARTED_ERROR);
        }

        const previousUser = await this.getUser(did);
        const nextName = user.name?.trim().toLowerCase();
        const previousName = previousUser?.name?.trim().toLowerCase();
        const multi = this.redis.multi();

        multi.hset(this.usersKey, did, JSON.stringify(user));

        if (previousName && previousName !== nextName) {
            multi.hdel(this.namesKey, previousName);
        }

        if (nextName) {
            multi.hset(this.namesKey, nextName, did);
        }

        await multi.exec();
    }

    async deleteUser(did: string): Promise<boolean> {
        if (!this.redis) {
            throw new Error(REDIS_NOT_STARTED_ERROR);
        }

        const existingUser = await this.getUser(did);
        if (!existingUser) {
            return false;
        }

        const multi = this.redis.multi().hdel(this.usersKey, did);
        if (existingUser.name) {
            multi.hdel(this.namesKey, existingUser.name.trim().toLowerCase());
        }
        await multi.exec();
        return true;
    }

    async listUsers(): Promise<Record<string, User>> {
        if (!this.redis) {
            throw new Error(REDIS_NOT_STARTED_ERROR);
        }

        const records = await this.redis.hgetall(this.usersKey);
        const users: Record<string, User> = {};

        for (const [did, payload] of Object.entries(records)) {
            users[did] = JSON.parse(payload) as User;
        }

        return users;
    }

    async findDidByName(name: string): Promise<string | null> {
        if (!this.redis) {
            throw new Error(REDIS_NOT_STARTED_ERROR);
        }

        const did = await this.redis.hget(this.namesKey, name.trim().toLowerCase());
        return did || null;
    }
}
