import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';

export type PinStatus = 'queued' | 'pinning' | 'pinned' | 'failed';

export interface PinRecord {
    fingerprint: string;
    cid: string;
    registry?: string;
    provider: string;
    requestid?: string;
    status: PinStatus;
    attempts: number;
    created: string;
    updated: string;
    response?: unknown;
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

    async recordSubmitted(
        fingerprint: string,
        cid: string,
        registry: string | undefined,
        provider: string,
        requestid: string | undefined,
        status: PinStatus,
        response: unknown
    ): Promise<void> {
        const now = new Date().toISOString();
        const existing = this.state.pins[fingerprint];
        this.state.pins[fingerprint] = {
            fingerprint,
            cid,
            registry,
            provider,
            requestid,
            status,
            attempts: (existing?.attempts || 0) + 1,
            created: existing?.created || now,
            updated: now,
            response,
        };
        await this.save();
    }

    async recordStatus(fingerprint: string, status: PinStatus, response: unknown, error?: string): Promise<void> {
        const now = new Date().toISOString();
        const existing = this.state.pins[fingerprint];
        if (!existing) {
            return;
        }

        this.state.pins[fingerprint] = {
            ...existing,
            status,
            updated: now,
            response,
            ...(error ? { lastError: error } : { lastError: undefined }),
        };
        await this.save();
    }

    async recordFailure(
        fingerprint: string,
        cid: string,
        registry: string | undefined,
        provider: string,
        error: string,
        clearRequest = false
    ): Promise<void> {
        const now = new Date().toISOString();
        const existing = this.state.pins[fingerprint];
        this.state.pins[fingerprint] = {
            fingerprint,
            cid,
            registry,
            provider,
            requestid: clearRequest ? undefined : existing?.requestid,
            status: 'failed',
            attempts: (existing?.attempts || 0) + 1,
            created: existing?.created || now,
            updated: now,
            response: existing?.response,
            lastError: error,
        };
        await this.save();
    }

    count(status?: PinStatus): number {
        const records = Object.values(this.state.pins);
        return status ? records.filter(record => record.status === status).length : records.length;
    }

    private async save(): Promise<void> {
        await mkdir(dirname(this.path), { recursive: true });
        await writeFile(this.path, `${JSON.stringify(this.state, null, 2)}\n`);
    }
}
