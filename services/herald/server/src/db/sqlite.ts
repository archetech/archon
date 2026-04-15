import Database from 'better-sqlite3';
import { DatabaseInterface, User, ReplyToken, EmailMapping } from './interfaces.js';

export class DbSqlite implements DatabaseInterface {
    private db: Database.Database;
    private readonly dbPath: string;

    constructor(dbPath: string = 'data/db.sqlite') {
        this.dbPath = dbPath;
        this.db = new Database(this.dbPath);
    }

    async init(): Promise<void> {
        const createUserTable = `
            CREATE TABLE IF NOT EXISTS users (
                did TEXT PRIMARY KEY,
                firstLogin TEXT,
                lastLogin TEXT,
                logins INTEGER,
                role TEXT,
                name TEXT,
                credentialDid TEXT,
                credentialIssuedAt TEXT
            );
        `;
        this.db.exec(createUserTable);
        this.ensureColumn('credentialDid', 'TEXT');
        this.ensureColumn('credentialIssuedAt', 'TEXT');

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS reply_tokens (
                token TEXT PRIMARY KEY,
                originalDmailDid TEXT NOT NULL,
                senderDid TEXT NOT NULL,
                senderName TEXT NOT NULL,
                emailRecipient TEXT NOT NULL,
                createdAt TEXT NOT NULL
            );
        `);

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS email_mappings (
                dmailDid TEXT PRIMARY KEY,
                emailAddress TEXT NOT NULL,
                recipientDid TEXT NOT NULL,
                createdAt TEXT NOT NULL
            );
        `);

        console.log('SQLite database initialised.');
    }

    private ensureColumn(name: string, definition: string): void {
        const columns = this.db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
        if (!columns.some(column => column.name === name)) {
            this.db.exec(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
        }
    }

    async getUser(did: string): Promise<User | null> {
        const stmt = this.db.prepare('SELECT * FROM users WHERE did = ?');
        const row = stmt.get(did) as (User & { did: string }) | undefined;
        if (!row) {
            return null;
        }

        const { did: _did, ...user } = row;
        return user;
    }

    async setUser(did: string, user: User): Promise<void> {
        const insertUserStmt = this.db.prepare(`
            INSERT OR REPLACE INTO users (did, firstLogin, lastLogin, logins, role, name, credentialDid, credentialIssuedAt)
            VALUES (@did, @firstLogin, @lastLogin, @logins, @role, @name, @credentialDid, @credentialIssuedAt)
        `);

        insertUserStmt.run({
            did,
            firstLogin: user.firstLogin || null,
            lastLogin: user.lastLogin || null,
            logins: user.logins || null,
            role: user.role || null,
            name: user.name || null,
            credentialDid: user.credentialDid || null,
            credentialIssuedAt: user.credentialIssuedAt || null,
        });
    }

    async deleteUser(did: string): Promise<boolean> {
        const result = this.db.prepare('DELETE FROM users WHERE did = ?').run(did);
        return result.changes > 0;
    }

    async listUsers(): Promise<Record<string, User>> {
        const stmt = this.db.prepare('SELECT * FROM users');
        const rows = stmt.all();
        const users: Record<string, User> = {};

        for (const row of rows as any[]) {
            const { did, ...mainProps } = row;
            users[row.did] = {
                ...mainProps
            };
        }

        return users;
    }

    async findDidByName(name: string): Promise<string | null> {
        const row = this.db.prepare('SELECT did FROM users WHERE lower(name) = lower(?)').get(name) as { did: string } | undefined;
        return row?.did || null;
    }

    async close(): Promise<void> {
        try {
            this.db.close();
        }
        catch (error) {
            console.error('SQLite close failed:', error);
        }
    }

    async setReplyToken(token: string, data: ReplyToken): Promise<void> {
        this.db.prepare(`
            INSERT OR REPLACE INTO reply_tokens (token, originalDmailDid, senderDid, senderName, emailRecipient, createdAt)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(token, data.originalDmailDid, data.senderDid, data.senderName, data.emailRecipient, data.createdAt);
    }

    async getReplyToken(token: string): Promise<ReplyToken | null> {
        const row = this.db.prepare('SELECT * FROM reply_tokens WHERE token = ?').get(token) as ReplyToken | undefined;
        return row || null;
    }

    async deleteExpiredReplyTokens(maxAgeMs: number): Promise<number> {
        const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
        const result = this.db.prepare('DELETE FROM reply_tokens WHERE createdAt < ?').run(cutoff);
        return result.changes;
    }

    async setEmailMapping(dmailDid: string, mapping: EmailMapping): Promise<void> {
        this.db.prepare(`
            INSERT OR REPLACE INTO email_mappings (dmailDid, emailAddress, recipientDid, createdAt)
            VALUES (?, ?, ?, ?)
        `).run(dmailDid, mapping.emailAddress, mapping.recipientDid, mapping.createdAt);
    }

    async getEmailMapping(dmailDid: string): Promise<EmailMapping | null> {
        const row = this.db.prepare('SELECT * FROM email_mappings WHERE dmailDid = ?').get(dmailDid) as EmailMapping | undefined;
        return row || null;
    }
}
