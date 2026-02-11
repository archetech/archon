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
 * Reset the DB and optionally flush Redis (controlled by CLI_TEST_CLEANUP env var).
 */
export async function resetAll(): Promise<void> {
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
 */
export async function freshWalletWithId(
    idName: string,
    alias?: string,
): Promise<string> {
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
