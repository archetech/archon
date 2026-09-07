import { ArchonError, WalletNotFoundError } from './errors.js';

// Deciding what an empty wallet store means at startup.
//
// Empty and lost look identical from every backend: an unmounted volume, a
// wiped database and a first run all read back as nothing. Only the operator
// knows which their node is, so the difference is a setting rather than a
// heuristic (#1037, #1051).
//
// Three conditions arrive here and each has its own remedy, so none of the
// messages below may be reached by another's path:
//
//   the store is not reachable yet — retried, then fatal
//   the wallet was read and cannot be used — fatal at once
//   the store is empty — the operator's setting decides

export interface WalletStartupOptions {
    // Named in the messages, so an operator knows which store to look at.
    store: string;
    // An empty store is a fault rather than a first run.
    requireExisting: boolean;
    // Named in the refusal, so an operator knows what to unset.
    requireSetting: string;
    // A store may be starting alongside the service. Reads are retried until
    // one answers, whether or not it answers with a wallet.
    attempts?: number;
    delayMs?: number;
    sleep?: (ms: number) => Promise<void>;
}

export type WalletStartup =
    | { action: 'use' }
    | { action: 'provision', warning: string }
    | { action: 'refuse', fatal: string };

const DEFAULT_ATTEMPTS = 10;
const DEFAULT_DELAY_MS = 3_000;

/**
 * Decide whether to carry on, provision, or stop, given a wallet read.
 *
 * `load` is expected to throw `WalletNotFoundError` for an empty store, any
 * other `ArchonError` for a wallet that was read and cannot be used, and
 * anything else for a store that could not be read at all. That last kind is
 * the only one retried: a wrong passphrase or an unreadable version will not
 * become right by asking again, while a database that is still starting will.
 *
 * Separated from the services so the rule is testable without a store, a
 * gatekeeper or a process.
 */
export async function decideWalletStartup(
    load: () => Promise<unknown>,
    options: WalletStartupOptions,
): Promise<WalletStartup> {
    const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
    const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));

    let unreachable: unknown;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            await load();
            return { action: 'use' };
        }
        catch (error) {
            if (error instanceof WalletNotFoundError) {
                return options.requireExisting
                    ? {
                        action: 'refuse',
                        fatal: `No wallet in ${options.store} and ${options.requireSetting} is set. Refusing to start rather than replace this node's identity: check the store is the one this node has been using. Unset ${options.requireSetting} only to let it create a new identity.`,
                    }
                    : {
                        action: 'provision',
                        warning: `No wallet found in ${options.store} — creating one. If this node has run before, its store is missing and its identity has been replaced.`,
                    };
            }

            if (error instanceof ArchonError) {
                return {
                    action: 'refuse',
                    fatal: `The wallet in ${options.store} could not be opened: ${error.message}`,
                };
            }

            unreachable = error;

            if (attempt < attempts) {
                await sleep(delayMs);
            }
        }
    }

    // Deliberately says nothing about the store being empty, and asks for
    // nothing to be unset: an operator acting on either would replace the
    // identity this path exists to protect.
    return {
        action: 'refuse',
        fatal: `Could not read the wallet store (${options.store}) after ${attempts} attempts over ${Math.round(attempts * delayMs / 1000)}s: ${unreachable}. It may not be running or reachable yet.`,
    };
}
