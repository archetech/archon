import { StoredWallet } from '../types.js';
import { AbstractBase } from './abstract-base.js';
import { DatabaseSync } from 'node:sqlite';

export default class WalletSQLite extends AbstractBase {
    private readonly walletName: string;
    private db: DatabaseSync | null;

    static async create(walletFileName: string = 'wallet.db', dataFolder: string = 'data'): Promise<WalletSQLite> {
        const wallet = new WalletSQLite(walletFileName, dataFolder);
        await wallet.connect();
        return wallet;
    }

    constructor(walletFileName: string = 'wallet.db', dataFolder: string = 'data') {
        super();
        this.walletName = `${dataFolder}/${walletFileName}`;
        this.db = null
    }

    async connect(): Promise<void> {
        if (this.db) {
            return;
        }

        this.db = new DatabaseSync(this.walletName);

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS wallet (
                id INTEGER PRIMARY KEY,
                data TEXT NOT NULL
            )
        `);
    }

    async disconnect(): Promise<void> {
        if (this.db) {
            this.db.close()
            this.db = null
        }
    }

    async saveWallet(wallet: StoredWallet, overwrite: boolean = false): Promise<boolean> {
        await this.connect();

        if (!this.db) {
            throw new Error('DB failed to connect.')
        }

        const exists = this.db.prepare('SELECT 1 FROM wallet LIMIT 1').get();
        if (exists && !overwrite) {
            return false;
        }

        this.db.exec('DELETE FROM wallet');
        this.db.prepare('INSERT INTO wallet (data) VALUES (?)').run(JSON.stringify(wallet));
        return true;
    }

    async loadWallet(): Promise<StoredWallet | null> {
        await this.connect();

        if (!this.db) {
            throw new Error('DB failed to connect.')
        }

        const row = this.db.prepare('SELECT data FROM wallet LIMIT 1').get();
        if (!row) {
            return null;
        }

        return JSON.parse(String(row.data));
    }
}
