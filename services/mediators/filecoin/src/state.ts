import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';

export interface PinRecord {
    fingerprint: string;
    cid: string;
    registry?: string;
    status: 'pinned' | 'failed';
    attempts: number;
    created: string;
    updated: string;
    wallet?: unknown;
    lastError?: string;
}

interface StateFile {
    version: 1;
    pins: Record<string, PinRecord>;
}

function emptyState(): StateFile {
    return { version: 1, pins: {} };
}

export class JsonPinStore {
    private state: StateFile = emptyState();
    private loaded = false;

    constructor(private readonly path: string) {}

    async load(): Promise<void> {
        if (this.loaded) {
            return;
        }

        try {
            const raw = await readFile(this.path, 'utf-8');
            const parsed = JSON.parse(raw) as StateFile;
            this.state = parsed.version === 1 && parsed.pins ? parsed : emptyState();
        } catch (error: any) {
            if (error?.code !== 'ENOENT') {
                throw error;
            }
            this.state = emptyState();
        }

        this.loaded = true;
    }

    get(fingerprint: string): PinRecord | undefined {
        return this.state.pins[fingerprint];
    }

    async recordFailure(fingerprint: string, cid: string, registry: string | undefined, error: string): Promise<void> {
        const now = new Date().toISOString();
        const existing = this.state.pins[fingerprint];
        this.state.pins[fingerprint] = {
            fingerprint,
            cid,
            registry,
            status: 'failed',
            attempts: (existing?.attempts || 0) + 1,
            created: existing?.created || now,
            updated: now,
            wallet: existing?.wallet,
            lastError: error,
        };
        await this.save();
    }

    async recordSuccess(fingerprint: string, cid: string, registry: string | undefined, wallet: unknown): Promise<void> {
        const now = new Date().toISOString();
        const existing = this.state.pins[fingerprint];
        this.state.pins[fingerprint] = {
            fingerprint,
            cid,
            registry,
            status: 'pinned',
            attempts: (existing?.attempts || 0) + 1,
            created: existing?.created || now,
            updated: now,
            wallet,
        };
        await this.save();
    }

    count(status?: PinRecord['status']): number {
        const records = Object.values(this.state.pins);
        return status ? records.filter(record => record.status === status).length : records.length;
    }

    private async save(): Promise<void> {
        await mkdir(dirname(this.path), { recursive: true });
        await writeFile(this.path, `${JSON.stringify(this.state, null, 2)}\n`);
    }
}
