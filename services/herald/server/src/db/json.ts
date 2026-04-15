import fs from 'fs';
import path from 'path';
import { DatabaseInterface, DatabaseStructure, User, ReplyToken, EmailMapping } from './interfaces.js';

export class DbJson implements DatabaseInterface {
    private readonly dbPath: string;

    constructor(dbPath: string = 'data/db.json') {
        this.dbPath = dbPath;
    }

    async init(): Promise<void> {
        const dir = path.dirname(this.dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
            console.log(`Created directory: ${dir}`);
        }
    }

    private loadDb(): DatabaseStructure {
        if (fs.existsSync(this.dbPath)) {
            try {
                return JSON.parse(fs.readFileSync(this.dbPath, 'utf-8')) as DatabaseStructure;
            } catch (error) {
                console.error(`Error parsing JSON from ${this.dbPath}:`, error);
            }
        }
        return {};
    }

    private writeDb(data: DatabaseStructure): void {
        try {
            fs.writeFileSync(this.dbPath, JSON.stringify(data, null, 4));
        } catch (error) {
            console.error(`Error writing JSON to ${this.dbPath}:`, error);
        }
    }

    async getUser(did: string): Promise<User | null> {
        const db = this.loadDb();
        return db.users?.[did] || null;
    }

    async setUser(did: string, user: User): Promise<void> {
        const db = this.loadDb();
        if (!db.users) {
            db.users = {};
        }
        db.users[did] = user;
        this.writeDb(db);
    }

    async deleteUser(did: string): Promise<boolean> {
        const db = this.loadDb();
        if (!db.users?.[did]) {
            return false;
        }
        delete db.users[did];
        this.writeDb(db);
        return true;
    }

    async listUsers(): Promise<Record<string, User>> {
        return this.loadDb().users || {};
    }

    async findDidByName(name: string): Promise<string | null> {
        const users = await this.listUsers();
        const trimmedName = name.trim().toLowerCase();

        for (const [did, user] of Object.entries(users)) {
            if (user.name?.trim().toLowerCase() === trimmedName) {
                return did;
            }
        }

        return null;
    }

    async setReplyToken(token: string, data: ReplyToken): Promise<void> {
        const db = this.loadDb();
        if (!db.replyTokens) {
            db.replyTokens = {};
        }
        db.replyTokens[token] = data;
        this.writeDb(db);
    }

    async getReplyToken(token: string): Promise<ReplyToken | null> {
        const db = this.loadDb();
        return db.replyTokens?.[token] || null;
    }

    async deleteExpiredReplyTokens(maxAgeMs: number): Promise<number> {
        const db = this.loadDb();
        if (!db.replyTokens) return 0;
        const now = Date.now();
        let cleaned = 0;
        for (const [token, data] of Object.entries(db.replyTokens)) {
            if (now - new Date(data.createdAt).getTime() > maxAgeMs) {
                delete db.replyTokens[token];
                cleaned++;
            }
        }
        if (cleaned > 0) this.writeDb(db);
        return cleaned;
    }

    async setEmailMapping(dmailDid: string, mapping: EmailMapping): Promise<void> {
        const db = this.loadDb();
        if (!db.emailMappings) {
            db.emailMappings = {};
        }
        db.emailMappings[dmailDid] = mapping;
        this.writeDb(db);
    }

    async getEmailMapping(dmailDid: string): Promise<EmailMapping | null> {
        const db = this.loadDb();
        return db.emailMappings?.[dmailDid] || null;
    }
}
