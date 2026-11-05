import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bech32 } from 'bech32';

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
 * Run an archon CLI command that is expected to fail.
 * Returns its exit status and trimmed stderr.
 */
export async function archonFails(...args: string[]): Promise<{ status: number, stderr: string }> {
    try {
        await exec('docker', ['compose', 'exec', '-T', 'cli', 'node', 'scripts/archon-cli.js', ...args]);
    }
    catch (error: any) {
        return { status: error.code, stderr: String(error.stderr ?? '').trim() };
    }

    throw new Error(`expected \`archon ${args.join(' ')}\` to fail`);
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

/**
 * A signed mainnet BOLT11 invoice nobody will settle except a mint's fakewallet
 * backend. Fresh each call, since a mint remembers the hashes it has paid.
 */
export function signedInvoice(sats?: number): string {
    const toWords = (bytes: Uint8Array): number[] => bech32.toWords(bytes);
    const tag = (type: number, words: number[]): number[] => [type, words.length >> 5, words.length & 31, ...words];
    const timestamp = Math.floor(Date.now() / 1000);

    const words = [
        ...Array.from({ length: 7 }, (_, index) => Math.floor(timestamp / 32 ** (6 - index)) % 32),
        tag(1, toWords(randomBytes(32))),   // p: payment hash
        tag(13, toWords(new TextEncoder().encode('cashu test'))),   // d: description
        tag(16, toWords(randomBytes(32))),  // s: payment secret
        // 5: features, as five-bit words from the top: var_onion_optin (9) and payment_secret (15)
        tag(5, [0b00001, 0b00000, 0b10000, 0b00000]),
    ].flat();

    const hrp = sats === undefined ? 'lnbc' : `lnbc${sats * 10}n`;
    const signed = Buffer.concat([Buffer.from(hrp), Buffer.from(bech32.fromWords(padWords(words)))]);
    const recovered = secp256k1.sign(signed, secp256k1.utils.randomSecretKey(), { format: 'recovered' });
    // noble puts the recovery id first; BOLT11 puts it last.
    const signature = Buffer.concat([recovered.subarray(1), recovered.subarray(0, 1)]);

    return bech32.encode(hrp, [...words, ...toWords(signature)], 2000);
}

// BOLT11 signs the data as bytes, padding it with zero bits to a byte boundary.
function padWords(words: number[]): number[] {
    return (words.length * 5) % 8 === 0 ? words : [...words, ...new Array(Math.ceil((8 - ((words.length * 5) % 8)) / 5)).fill(0)];
}
