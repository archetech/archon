// Coordinates setup only. A failed wallet operation is never replayed here.
export class WalletRecovery<T> {
    ready = false;
    failure: unknown;
    private retry?: ReturnType<typeof setInterval>;
    private pending?: Promise<T>;

    constructor(private readonly options: {
        setup: () => Promise<T>;
        changed: (ready: boolean) => void;
        retryFailed: (error: unknown) => void;
        retryIntervalMs: number;
    }) {}

    get fatal(): boolean {
        const error = this.failure as { name?: string; message?: string } | undefined;
        return error?.name === 'DescriptorMismatchError' || Boolean(error?.message?.includes('sqlite'));
    }

    get descriptorMismatch(): string | undefined {
        const error = this.failure as { name?: string; message?: string } | undefined;
        return error?.name === 'DescriptorMismatchError' ? error.message : undefined;
    }

    setup(): Promise<T> {
        if (this.pending) return this.pending;
        this.pending = Promise.resolve().then(this.options.setup).then(result => {
            this.ready = true;
            this.failure = undefined;
            this.stop();
            this.options.changed(true);
            return result;
        }, error => {
            this.ready = false;
            if (!this.fatal) this.failure = error;
            if (this.fatal) this.stop();
            this.options.changed(false);
            throw error;
        }).finally(() => { this.pending = undefined; });
        return this.pending;
    }

    // Core RPC_WALLET_NOT_FOUND: do not mistake transport, payment, or other
    // RPC errors for an unloaded wallet. Fatal descriptor refusals stay latched
    // until an explicit setup attempt succeeds.
    walletUnloaded(error: unknown): boolean {
        if ((error as { code?: unknown } | null)?.code !== -18) return false;
        this.ready = false;
        this.options.changed(false);
        this.start();
        return true;
    }

    start(): void {
        if (this.ready || this.fatal || this.retry) return;
        this.retry = setInterval(() => {
            if (!this.pending) {
                void this.setup().catch(this.options.retryFailed);
            }
        }, this.options.retryIntervalMs);
        this.retry.unref();
    }

    stop(): void {
        clearInterval(this.retry);
        this.retry = undefined;
    }
}
