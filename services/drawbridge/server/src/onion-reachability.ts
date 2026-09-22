import { readFile } from 'node:fs/promises';
import { probeOnion } from '@didcid/common/tor-node';

type State = -1 | 0 | 1;

export class OnionReachability {
    private state: State = -1;
    private hostname: string | null = null;
    private checkedAt = 0;
    private inFlight: Promise<void> | undefined;
    private timer: ReturnType<typeof setInterval> | undefined;

    constructor(private readonly options: {
        hostnameFile: string;
        proxy: string;
        port: number;
        intervalMs?: number;
        readHostname?: () => Promise<string>;
        probe?: typeof probeOnion;
        onState: (state: State) => void;
        onTransition: (state: State, error?: unknown) => void;
    }) {
        options.onState(-1);
    }

    async refresh(): Promise<void> {
        if (this.inFlight) return this.inFlight;
        this.inFlight = this.check().finally(() => { this.inFlight = undefined; });
        return this.inFlight;
    }

    private async check(): Promise<void> {
        let hostname: string | null = null;
        let state: State = -1;
        let failure: unknown;
        try {
            hostname = ((await (this.options.readHostname?.() ?? readFile(this.options.hostnameFile, 'utf8'))).trim() || null);
        } catch {
            // No hostname file means no onion is advertised yet.
        }
        if (hostname) {
            try {
                await (this.options.probe ?? probeOnion)(hostname, this.options.port, this.options.proxy);
                state = 1;
            } catch (error) {
                state = 0;
                failure = error;
            }
        }
        if (state !== this.state || hostname !== this.hostname) {
            this.options.onTransition(state, failure);
        }
        this.state = state;
        this.hostname = hostname;
        this.checkedAt = Date.now();
        this.options.onState(state);
    }

    async verifiedHostname(): Promise<string | null> {
        // Public discovery requests cannot each start an independent Tor circuit.
        if (!this.checkedAt || Date.now() - this.checkedAt >= 30_000) await this.refresh();
        return this.state === 1 ? this.hostname : null;
    }

    start(): void {
        void this.refresh();
        this.timer = setInterval(() => { void this.refresh(); }, this.options.intervalMs ?? 60_000);
        this.timer.unref();
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
    }
}
