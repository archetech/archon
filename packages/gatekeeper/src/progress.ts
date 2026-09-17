// Aggregate progress only: no per-DID identifiers or additional database reads.
export default class ProgressLogger {
    private readonly started = performance.now();
    private lastLog = this.started;

    constructor(private readonly phase: string, private readonly total: number) {
        this.log(0, this.started);
    }

    update(completed: number): void {
        const now = performance.now();
        if (completed === this.total || now - this.lastLog >= 5000) {
            this.log(completed, now);
        }
    }

    private log(completed: number, now: number): void {
        console.log(`Gatekeeper ${this.phase}: ${completed}/${this.total} DIDs (${((now - this.started) / 1000).toFixed(1)}s)`);
        this.lastLog = now;
    }
}
