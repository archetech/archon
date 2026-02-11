import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { archon, resetAll, parseDid } from './helpers';

const exec = promisify(execFile);

let credentialDid: string;
let tempDir: string;

beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'archon-cli-test-'));

    // Create wallet and identity
    await archon('new-wallet');
    await archon('create-id', '-r', 'local', 'qa-issue-creds');

    // Create schema with alias
    await archon('create-schema', '-a', 'nickname-template', 'share/schema/social-media.json');

    // Bind credential and capture JSON
    const bound = await archon('bind-credential', 'nickname-template', 'qa-issue-creds');
    const credential = JSON.parse(bound);
    credential.credential = { nickname: 'qa' };

    // Write modified credential to temp file and copy into container
    const tempFile = join(tempDir, 'qa-credential-final.json');
    writeFileSync(tempFile, JSON.stringify(credential));
    await exec('docker', ['compose', 'cp', tempFile, 'cli:/app/share/qa-credential-final.json']);

    // Issue and accept
    const issueOutput = await archon('issue-credential', 'share/qa-credential-final.json');
    credentialDid = parseDid(issueOutput);

    const acceptOutput = await archon('accept-credential', credentialDid, 'nicknames');
    expect(acceptOutput).toContain('OK');
}, 60000);

afterAll(async () => {
    // Clean up temp files
    try {
        unlinkSync(join(tempDir, 'qa-credential-final.json'));
    } catch { /* ignore */ }

    // Clean up container file
    try {
        await exec('docker', ['compose', 'exec', '-T', 'cli', 'rm', '-f', '/app/share/qa-credential-final.json']);
    } catch { /* ignore */ }

    await resetAll();
});

describe('credential lifecycle', () => {
    test('issue-credential returns a DID', () => {
        expect(credentialDid).toMatch(/^did:cid:[a-zA-Z0-9]+$/);
    });

    test('list-credentials includes the credential', async () => {
        const output = await archon('list-credentials');
        expect(output).toMatch(/did:cid:[a-zA-Z0-9]+/);
    });

    test('get-credential returns credential JSON', async () => {
        const output = await archon('get-credential', credentialDid);
        const cred = JSON.parse(output);

        expect(cred).toHaveProperty('@context');
        expect(cred).toHaveProperty('type');
        expect(cred).toHaveProperty('issuer');
        expect(cred).toHaveProperty('validFrom');
        expect(cred).toHaveProperty('credentialSubject');
        expect(cred).toHaveProperty('credential');
        expect(cred).toHaveProperty('proof');
    });

    test('publish-credential returns manifest JSON', async () => {
        const output = await archon('publish-credential', credentialDid);
        const manifest = JSON.parse(output);

        expect(manifest).toHaveProperty('@context');
        expect(manifest).toHaveProperty('type');
        expect(manifest).toHaveProperty('issuer');
        expect(manifest).toHaveProperty('validFrom');
        expect(manifest).toHaveProperty('credentialSubject');
        expect(manifest).toHaveProperty('proof');
    });

    test('reveal-credential returns credential JSON', async () => {
        const output = await archon('reveal-credential', credentialDid);
        const revealed = JSON.parse(output);

        expect(revealed).toHaveProperty('type');
        expect(revealed).toHaveProperty('issuer');
        expect(revealed).toHaveProperty('validFrom');
        expect(revealed).toHaveProperty('credentialSubject');
        expect(revealed).toHaveProperty('proof');
    });

    test('revoke-credential returns OK', async () => {
        const output = await archon('revoke-credential', credentialDid);
        expect(output).toContain('OK');
    });
});
