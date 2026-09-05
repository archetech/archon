import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * Run an archon CLI command via docker compose (no TTY).
 * Returns trimmed stdout.
 */
export async function archon(...args: string[]): Promise<string> {
    const { stdout } = await exec(
        'docker', ['compose', 'exec', '-T', 'cli', 'node', 'scripts/archon-cli.js', ...args],
    );
    return stdout.trim();
}

/**
 * Run an admin CLI command via docker compose (no TTY).
 * Returns trimmed stdout.
 */
export async function admin(...args: string[]): Promise<string> {
    const { stdout } = await exec(
        'docker', ['compose', 'exec', '-T', 'cli', 'node', 'scripts/admin-cli.js', ...args],
    );
    return stdout.trim();
}

/**
 * Reset the DB and optionally flush Redis.
 * Only runs when CLI_TEST_CLEANUP is set (CI sets this automatically).
 * Skipped in dev environments to avoid wiping real data.
 */
export async function resetAll(): Promise<void> {
    if (!process.env.CLI_TEST_CLEANUP) {
        return;
    }
    await admin('reset-db');
    if (process.env.CLI_TEST_CLEANUP === 'redis') {
        await exec('docker', ['compose', 'exec', '-T', 'redis', 'redis-cli', 'flushall']);
    }
}

/**
 * Extract a DID from CLI output.
 */
export function parseDid(output: string): string {
    const match = output.match(/did:cid:[a-zA-Z0-9]+/);
    if (!match) throw new Error(`No DID found in output: ${output}`);
    return match[0];
}

/**
 * Create a fresh wallet and ID. Optionally add an alias.
 * WARNING: This overwrites the current wallet. Only safe in CI
 * (where CLI_TEST_CLEANUP is set) or with a disposable wallet.
 */
export async function freshWalletWithId(
    idName: string,
    alias?: string,
): Promise<string> {
    if (!process.env.CLI_TEST_CLEANUP) {
        throw new Error(
            'freshWalletWithId would overwrite your wallet. ' +
            'Set CLI_TEST_CLEANUP=yes to confirm this is a disposable environment.'
        );
    }
    await archon('new-wallet');
    const output = await archon('create-id', '-r', 'local', idName);
    const did = parseDid(output);
    if (alias) {
        await archon('add-alias', alias, did);
    }
    return did;
}

/**
 * Run a docker compose exec command directly.
 */
export async function dockerExec(...args: string[]): Promise<string> {
    const { stdout } = await exec('docker', ['compose', 'exec', '-T', ...args]);
    return stdout.trim();
}
