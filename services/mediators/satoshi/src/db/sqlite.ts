import { DatabaseSync } from 'node:sqlite';
import { MediatorDb } from '../types.js';
import AbstractDB from "./abstract-db.js";

export default class JsonSQLite extends AbstractDB {
    private readonly fileName: string;
    private db?: DatabaseSync;

    static async create(registry: string, dataFolder = 'data'): Promise<JsonSQLite> {
        const json = new JsonSQLite(registry, dataFolder);
        await json.connect();
        return json;
    }

    constructor(registry: string, dataFolder = 'data') {
        super();
        this.fileName = `${dataFolder}/${registry}-mediator.db`;
    }

    async connect(): Promise<void> {
        this.db = new DatabaseSync(this.fileName);

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS json (
                id INTEGER PRIMARY KEY,
                data TEXT NOT NULL
            )
        `);
    }

    async disconnect(): Promise<void> {
        if (this.db) {
            this.db.close();
            this.db = undefined;
        }
    }

    async saveDb(data: MediatorDb): Promise<boolean> {
        if (!this.db) {
            throw new Error('SQLite database is not connected. Call connect() first.');
        }
        this.db.exec('DELETE FROM json');
        this.db.prepare('INSERT INTO json (data) VALUES (?)').run(JSON.stringify(data));
        return true;
    }

    async loadDb(): Promise<MediatorDb | null> {
        if (!this.db) {
            throw new Error('SQLite database is not connected. Call connect() first.');
        }
        const row = this.db.prepare('SELECT data FROM json LIMIT 1').get();

        if (!row) {
            return null;
        }

        return JSON.parse(String(row.data)) as MediatorDb;
    }
}
