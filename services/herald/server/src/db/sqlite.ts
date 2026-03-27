import Database from 'better-sqlite3';
import { DatabaseInterface, DatabaseStructure, User } from './interfaces.js';

export class DbSqlite implements DatabaseInterface {
    private db: Database.Database;
    private readonly dbPath: string;

    constructor(dbPath: string = 'data/db.sqlite') {
        this.dbPath = dbPath;
        this.db = new Database(this.dbPath);
    }

    init(): void {
        const createUserTable = `
            CREATE TABLE IF NOT EXISTS users (
                did TEXT PRIMARY KEY,
                firstLogin TEXT,
                lastLogin TEXT,
                logins INTEGER,
                role TEXT,
                name TEXT
            );
        `;
        this.db.exec(createUserTable);
        console.log('SQLite database initialised.');
    }

    loadDb(): DatabaseStructure {
        const stmt = this.db.prepare('SELECT * FROM users');
        const rows = stmt.all();
        const users: Record<string, User> = {};

        for (const row of rows as any[]) {
            const { ...mainProps } = row;
            users[row.did] = {
                ...mainProps
            };
        }

        return { users };
    }

    writeDb(data: DatabaseStructure): void {
        const insertUserStmt = this.db.prepare(`
            INSERT OR REPLACE INTO users (did, firstLogin, lastLogin, logins, role, name)
            VALUES (@did, @firstLogin, @lastLogin, @logins, @role, @name)
        `);

        const transaction = this.db.transaction((dbData: DatabaseStructure) => {
            if (dbData.users) {
                for (const did in dbData.users) {
                    const user = dbData.users[did];
                    insertUserStmt.run({
                        did, // 'did' is now part of the User object passed or should be the key
                        firstLogin: user.firstLogin || null,
                        lastLogin: user.lastLogin || null,
                        logins: user.logins || null,
                        role: user.role || null,
                        name: user.name || null,
                    });
                }
            }
        });

        try {
            transaction(data);
        } catch (error) {
            console.error('SQLite write transaction failed:', error);
        }
    }
}
