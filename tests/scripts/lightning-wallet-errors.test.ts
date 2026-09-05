import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);

// lightning-export and lightning-import read an existing wallet to find the
// current identity. A missing wallet and an unreadable one are different
// problems with different remedies, and during a key export the wrong advice
// -- "create a wallet" to someone whose passphrase is merely wrong -- is the
// worst available. Both scripts have to keep them apart.
// lightning-import reads its payload from stdin before it opens the wallet, so
// it has to be fed something well-formed to reach the path under test; export
// ignores stdin. Ending stdin either way keeps a script that waits on it from
// hanging the suite.
const STDIN_PAYLOAD = JSON.stringify({ 'https://lnbits.example': { walletId: 'w', adminKey: 'a', invoiceKey: 'i' } });

async function run(script: string, walletPath: string) {
    try {
        // A script that fails to exit on a wallet error is itself a defect
        // (the shell is left hanging), so bound the run and let that surface as
        // a failure rather than a stuck suite.
        const child = exec('node', [join('scripts', script), walletPath], {
            env: { ...process.env, ARCHON_PASSPHRASE: 'passphrase' },
            timeout: 15000,
        });
        child.child.stdin!.end(STDIN_PAYLOAD);
        const { stdout, stderr } = await child;
        return { code: 0, stdout, stderr };
    }
    catch (error: any) {
        return { code: error.code as number, stdout: error.stdout as string, stderr: error.stderr as string };
    }
}

describe.each(['lightning-export.js', 'lightning-import.js'])('%s', (script) => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'archon-lightning-'));
    });

    it('reports a missing wallet and how to get one', async () => {
        const result = await run(script, join(dir, 'missing.json'));

        expect(result.code).toBe(1);
        expect(result.stderr).toContain('no wallet at');
        expect(result.stderr).toContain('keymaster create-wallet');
    });

    it('reports an unreadable wallet as what it is, not as missing', async () => {
        const corrupt = join(dir, 'corrupt.json');
        writeFileSync(corrupt, 'not json{');

        const result = await run(script, corrupt);

        expect(result.code).not.toBe(0);
        expect(result.stderr).not.toContain('no wallet at');
        expect(result.stderr).toMatch(/not valid JSON|Unexpected token/);
    });
});
