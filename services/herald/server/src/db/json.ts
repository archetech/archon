import fs from 'fs';
import path from 'path';
import { DatabaseInterface, DatabaseStructure } from './interfaces.js';

export class DbJson implements DatabaseInterface {
    private readonly dbPath: string;

    constructor(dbPath: string = 'data/db.json') {
        this.dbPath = dbPath;
    }

    init(): void {
        const dir = path.dirname(this.dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
            console.log(`Created directory: ${dir}`);
        }
    }

    loadDb(): DatabaseStructure {
        if (fs.existsSync(this.dbPath)) {
            try {
                return JSON.parse(fs.readFileSync(this.dbPath, 'utf-8')) as DatabaseStructure;
            } catch (error) {
                console.error(`Error parsing JSON from ${this.dbPath}:`, error);
            }
        }
        return {};
    }

    writeDb(data: DatabaseStructure): void {
        try {
            fs.writeFileSync(this.dbPath, JSON.stringify(data, null, 4));
        } catch (error) {
            console.error(`Error writing JSON to ${this.dbPath}:`, error);
        }
    }
}
