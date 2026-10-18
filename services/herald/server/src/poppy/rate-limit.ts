// Fixed-window request counters, per process. Drawbridge already limits
// requests per network address in front of Herald; these add the limits the
// guides ask a Company to keep per client_id, per new client_id, and per
// sign-in attempt, which Drawbridge cannot see.

export class RateLimiter {
    private readonly windows = new Map<string, { start: number; count: number }>();

    constructor(
        private readonly limit: number,
        private readonly windowMs: number,
        private readonly now: () => number = Date.now,
    ) {}

    // Returns 0 when the request is allowed, or the seconds to wait.
    take(key: string): number {
        const now = this.now();
        let window = this.windows.get(key);
        if (!window || now - window.start >= this.windowMs) {
            window = { start: now, count: 0 };
            this.windows.set(key, window);
            if (this.windows.size > 10_000) {
                this.prune(now);
            }
        }
        if (window.count >= this.limit) {
            return Math.max(1, Math.ceil((window.start + this.windowMs - now) / 1000));
        }
        window.count += 1;
        return 0;
    }

    private prune(now: number): void {
        for (const [key, window] of this.windows) {
            if (now - window.start >= this.windowMs) {
                this.windows.delete(key);
            }
        }
    }
}
