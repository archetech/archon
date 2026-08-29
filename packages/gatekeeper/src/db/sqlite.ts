import { DatabaseSync } from 'node:sqlite';
import { InvalidDIDError } from '@didcid/common/errors';
import { GatekeeperDb, GatekeeperEvent, Operation, BlockId, BlockInfo } from '../types.js'

interface DidsRow {
    id: string
    events: string
}

interface QueueRow {
    id: string
    ops: string
}

const SQLITE_NOT_STARTED_ERROR = 'SQLite DB not open. Call start() first.';

export default class DbSqlite implements GatekeeperDb {
    private readonly dbName: string;
    private db: DatabaseSync | null;

    constructor(name: string, dataFolder: string = 'data') {
        this.dbName = `${dataFolder}/${name}.db`;
        this.db = null
    }

    private _lock: Promise<void> = Promise.resolve();
    private runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
        const run = async () => await fn();
        const chained = this._lock.then(run, run);
        this._lock = chained.then(() => undefined, () => undefined);
        return chained;
    }

    private async withTx<T>(fn: () => Promise<T>): Promise<T> {
        if (!this.db) {
            throw new Error(SQLITE_NOT_STARTED_ERROR);
        }
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const result = await fn();
            this.db.exec('COMMIT');
            return result;
        } catch (e) {
            try {
                this.db.exec('ROLLBACK');
            } catch {}
            throw e;
        }
    }

    private splitSuffix(did: string): string {
        if (!did) {
            throw new InvalidDIDError();
        }
        const suffix = did.split(':').pop();
        if (!suffix) {
            throw new InvalidDIDError();
        }
        return suffix;
    }

    async start(): Promise<void> {
        this.db = new DatabaseSync(this.dbName);

        this.db.exec(`CREATE TABLE IF NOT EXISTS dids (
            id TEXT PRIMARY KEY,
            events TEXT
        )`);

        this.db.exec(`CREATE TABLE IF NOT EXISTS queue (
            id TEXT PRIMARY KEY,
            ops TEXT
        )`);

        this.db.exec(`CREATE TABLE IF NOT EXISTS blocks (
                registry TEXT NOT NULL,
                hash TEXT NOT NULL,
                height INTEGER NOT NULL,
                time INTEGER NOT NULL,
                txns INTEGER NOT NULL,
                PRIMARY KEY (registry, hash)
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_registry_height ON blocks (registry, height);
        `);

        this.db.exec(`CREATE TABLE IF NOT EXISTS operations (
            opid TEXT PRIMARY KEY,
            operation TEXT
        )`);
    }

    async stop(): Promise<void> {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }


    async resetDb(): Promise<void> {
        if (!this.db) {
            throw new Error(SQLITE_NOT_STARTED_ERROR)
        }
        await this.runExclusive(async () => {
            await this.withTx(async () => {
                this.db!.exec('DELETE FROM dids');
                this.db!.exec('DELETE FROM queue');
                this.db!.exec('DELETE FROM blocks');
                this.db!.exec('DELETE FROM operations');
            });
        });
    }

    async addEvent(did: string, event: GatekeeperEvent): Promise<number> {
        if (!did) {
            throw new InvalidDIDError();
        }

        return this.runExclusive(() =>
            this.withTx(async () => {
                const id = this.splitSuffix(did);
                // Store operation separately if present
                if (event.opid && event.operation) {
                    this.addOperationStrict(event.opid, event.operation);
                }
                const events = this.getEventsStrictRaw(id);
                // Strip operation and store only opid reference
                const { operation, ...strippedEvent } = event;
                events.push(strippedEvent as GatekeeperEvent);
                return this.setEventsStrict(id, events);
            })
        );
    }

    private setEventsStrict(id: string, events: GatekeeperEvent[]): number {
        if (!this.db) {
            throw new Error(SQLITE_NOT_STARTED_ERROR);
        }
        // Update operations in ops table if modified, then strip from events
        const strippedEvents: GatekeeperEvent[] = [];
        for (const event of events) {
            if (event.opid && event.operation) {
                this.addOperationStrict(event.opid, event.operation);
            }
            const { operation, ...stripped } = event;
            strippedEvents.push(stripped as GatekeeperEvent);
        }
        const res = this.db.prepare(
            `INSERT OR REPLACE INTO dids(id, events) VALUES(?, ?)`
        ).run(id, JSON.stringify(strippedEvents));
        return Number(res.changes ?? 0);
    }

    private addOperationStrict(opid: string, op: Operation): void {
        if (!this.db) {
            throw new Error(SQLITE_NOT_STARTED_ERROR);
        }
        this.db.prepare(
            `INSERT OR REPLACE INTO operations(opid, operation) VALUES(?, ?)`
        ).run(opid, JSON.stringify(op));
    }


    async setEvents(did: string, events: GatekeeperEvent[]): Promise<number> {
        const id = this.splitSuffix(did);
        return this.runExclusive(() =>
            this.withTx(async () => this.setEventsStrict(id, events))
        );
    }

    private getEventsStrictRaw(id: string): GatekeeperEvent[] {
        if (!this.db) {
            throw new Error(SQLITE_NOT_STARTED_ERROR);
        }
        const row = this.db.prepare('SELECT events FROM dids WHERE id = ?').get(id) as DidsRow | undefined;
        if (!row) {
            return [];
        }
        const events = JSON.parse(row.events);
        if (!Array.isArray(events)) {
            throw new Error('events is not an array');
        }
        return events as GatekeeperEvent[];
    }

    private hydrateEvents(events: GatekeeperEvent[]): GatekeeperEvent[] {
        const hydrated: GatekeeperEvent[] = [];
        for (const event of events) {
            if (event.operation) {
                hydrated.push(event);
            } else if (event.opid) {
                const operation = this.getOperationStrict(event.opid);
                if (operation) {
                    hydrated.push({ ...event, operation });
                } else {
                    hydrated.push(event);
                }
            } else {
                hydrated.push(event);
            }
        }
        return hydrated;
    }

    async getEvents(did: string): Promise<GatekeeperEvent[]> {
        if (!this.db) {
            throw new Error(SQLITE_NOT_STARTED_ERROR)
        }

        try {
            const id = this.splitSuffix(did);
            const events = this.getEventsStrictRaw(id);
            return this.hydrateEvents(events);
        } catch {
            return [];
        }
    }

    async deleteEvents(did: string): Promise<number> {
        if (!this.db) {
            throw new Error(SQLITE_NOT_STARTED_ERROR)
        }

        return this.runExclusive(() =>
            this.withTx(async () => {
                const id = this.splitSuffix(did);
                const result = this.db!.prepare('DELETE FROM dids WHERE id = ?').run(id);
                return Number(result.changes ?? 0);
            })
        );
    }

    async queueOperation(registry: string, op: Operation): Promise<number> {
        if (!this.db) {
            throw new Error(SQLITE_NOT_STARTED_ERROR)
        }

        return this.runExclusive(async () =>
            this.withTx(async () => {
                const ops = this.getQueueStrict(registry);
                ops.push(op);
                this.db!.prepare(
                    `INSERT OR REPLACE INTO queue(id, ops) VALUES(?, ?)`
                ).run(registry, JSON.stringify(ops));
                return ops.length;
            })
        );
    }

    private getQueueStrict(registry: string): Operation[] {
        if (!this.db) {
            throw new Error(SQLITE_NOT_STARTED_ERROR);
        }

        const row = this.db.prepare('SELECT ops FROM queue WHERE id = ?').get(registry) as QueueRow | undefined;
        if (!row) {
            return [];
        }

        const ops = JSON.parse(row.ops);
        if (!Array.isArray(ops)) {
            throw new Error('queue row malformed: ops is not an array');
        }

        return ops as Operation[];
    }

    async getQueue(registry: string): Promise<Operation[]> {
        if (!this.db) {
            throw new Error(SQLITE_NOT_STARTED_ERROR);
        }

        try {
            return this.getQueueStrict(registry);
        } catch {
            return [];
        }
    }

    async clearQueue(registry: string, batch: Operation[]): Promise<boolean> {
        if (!this.db) {
            throw new Error(SQLITE_NOT_STARTED_ERROR)
        }

        return this.runExclusive(async () =>
            this.withTx(async () => {
                const oldQueue = this.getQueueStrict(registry);

                const batchProofValues = new Set(
                    batch.map(b => b.proof?.proofValue).filter((p): p is string => p !== undefined)
                );
                const newQueue = oldQueue.filter(
                    item => !batchProofValues.has(item.proof?.proofValue || '')
                );
                this.db!.prepare(
                    `INSERT OR REPLACE INTO queue(id, ops) VALUES(?, ?)`
                ).run(registry, JSON.stringify(newQueue));
                return true;
            }).catch(err => {
                console.error(err);
                return false;
            })
        );
    }

    async getAllKeys(): Promise<string[]> {
        if (!this.db) {
            throw new Error(SQLITE_NOT_STARTED_ERROR)
        }

        const rows = this.db.prepare('SELECT id FROM dids').all();
        return rows.map(row => String(row.id));
    }

    async addBlock(registry: string, blockInfo: BlockInfo): Promise<boolean> {
        if (!this.db) {
            throw new Error(SQLITE_NOT_STARTED_ERROR);
        }

        try {
            // Insert or replace the block information
            await this.runExclusive(() =>
                this.db!.prepare(
                    `INSERT OR REPLACE INTO blocks (registry, hash, height, time, txns) VALUES (?, ?, ?, ?, ?)`
                ).run(registry, blockInfo.hash, blockInfo.height, blockInfo.time, 0)
            );

            return true;
        } catch (error) {
            return false;
        }
    }

    async getBlock(registry: string, blockId?: BlockId): Promise<BlockInfo | null> {
        if (!this.db) {
            throw new Error(SQLITE_NOT_STARTED_ERROR);
        }

        try {
            let blockRow: BlockInfo | undefined;

            if (blockId === undefined) {
                // Return block with max height
                blockRow = this.db.prepare(
                    `SELECT * FROM blocks WHERE registry = ? ORDER BY height DESC LIMIT 1`
                ).get(registry) as BlockInfo | undefined;
            } else if (typeof blockId === 'number') {
                blockRow = this.db.prepare(
                    `SELECT * FROM blocks WHERE registry = ? AND height = ?`
                ).get(registry, blockId) as BlockInfo | undefined;
            } else {
                blockRow = this.db.prepare(
                    `SELECT * FROM blocks WHERE registry = ? AND hash = ?`
                ).get(registry, blockId) as BlockInfo | undefined;
            }

            return blockRow ? this.normalizeBlock(blockRow) : null;
        } catch (error) {
            return null;
        }
    }

    // `time` was originally declared TEXT, so SQLite's type affinity stored it as a
    // string and returned one — while BlockInfo.time is typed `number`, and every
    // other backend (json, redis, mongo) round-trips it as a number. The column is
    // now INTEGER, but `CREATE TABLE IF NOT EXISTS` leaves databases created before
    // that on the old affinity, so coerce on read to fix existing files too.
    private normalizeBlock(row: BlockInfo): BlockInfo {
        return {
            ...row,
            height: Number(row.height),
            time: Number(row.time),
        };
    }

    async addOperation(opid: string, op: Operation): Promise<void> {
        if (!this.db) {
            throw new Error(SQLITE_NOT_STARTED_ERROR);
        }

        await this.runExclusive(() =>
            this.withTx(async () => {
                this.db!.prepare(
                    `INSERT OR REPLACE INTO operations(opid, operation) VALUES(?, ?)`
                ).run(opid, JSON.stringify(op));
            })
        );
    }

    private getOperationStrict(opid: string): Operation | null {
        if (!this.db) {
            throw new Error(SQLITE_NOT_STARTED_ERROR);
        }

        const row = this.db.prepare(
            'SELECT operation FROM operations WHERE opid = ?'
        ).get(opid) as { operation: string } | undefined;

        return row ? JSON.parse(row.operation) : null;
    }

    async getOperation(opid: string): Promise<Operation | null> {
        return this.getOperationStrict(opid);
    }
}
