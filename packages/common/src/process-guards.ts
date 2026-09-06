// Process-level handlers for a long-running service.
//
// Logging an uncaught exception and carrying on is right for a service that is
// already up: one bad request should not take it down. The same handler
// applied during startup gives something worse than a crash. These services
// bind their port first and reach their dependencies from inside the listen
// callback, so a throw there is a rejection the handler swallows, leaving a
// process that answers /version and /metrics, fails every real route with a
// TypeError, and never exits (#1053).
//
// So the handlers are fatal until the service says it is up.

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
