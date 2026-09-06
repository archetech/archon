// Process-level handlers for a long-running service.
//
// Tolerating an uncaught exception suits a service that is already up: one bad
// request should not take it down. Before then it is the wrong trade. A
// service that binds its port and reaches its dependencies afterwards has, on
// a tolerated startup failure, a listening process with nothing behind it --
// one that passes a health check and fails every real request (#1053).
//
// So the handlers are fatal until the caller says startup finished.

export interface ProcessGuardOptions {
    // Seams for tests. Nothing in production passes these.
    exit?: (code: number) => void;
    log?: (message: string, ...detail: unknown[]) => void;
    target?: Pick<NodeJS.EventEmitter, 'on'>;
}

/**
 * Install `uncaughtException` and `unhandledRejection` handlers for `service`,
 * and return the function that marks startup finished.
 *
 * Until that function is called, either condition logs and ends the process
 * with status 1. Afterwards both are logged and the process continues.
 */
export function installProcessGuards(service: string, options: ProcessGuardOptions = {}): () => void {
    const exit = options.exit ?? ((code: number) => process.exit(code));
    const log = options.log ?? ((message: string, ...detail: unknown[]) => console.error(message, ...detail));
    const target = options.target ?? process;

    let started = false;

    function handle(label: string, detail: unknown): void {
        log(`${service}: ${label}`, detail);

        if (!started) {
            log(`${service}: startup did not finish, exiting`);
            exit(1);
        }
    }

    target.on('uncaughtException', (error) => handle('uncaught exception', error));
    target.on('unhandledRejection', (reason) => handle('unhandled rejection', reason));

    return () => {
        started = true;
    };
}
