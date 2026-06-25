import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resetAll, parseDid } from './helpers';

const exec = promisify(execFile);

// DIDComm is reached through the node's Drawbridge gateway (it fronts the relay
// at /didcomm); a bare gatekeeper doesn't serve /didcomm. Override the node URL
// per-command so the rest of the CLI suite (which targets gatekeeper directly)
// is unaffected. Drawbridge proxies the same gatekeeper, so DIDs created/resolved
// here live in the same registry as the other tests.
async function archon(...args: string[]): Promise<string> {
    const { stdout } = await exec('docker', [
        'compose', 'exec',
        '-e', 'ARCHON_GATEKEEPER_URL=http://drawbridge:4222',
        '-T', 'cli', 'node', 'scripts/archon-cli.js', ...args,
    ]);
    return stdout.trim();
}

// Write a DIDComm message JSON into the cli container (base64 to dodge shell quoting).
async function writeMessage(path: string, content: object): Promise<void> {
    const b64 = Buffer.from(JSON.stringify(content)).toString('base64');
    await exec('docker', ['compose', 'exec', '-T', 'cli', 'sh', '-c', `echo ${b64} | base64 -d > ${path}`]);
}

function basicMessage(content: string) {
    return { type: 'https://didcomm.org/basicmessage/2.0/message', body: { content } };
}

// Each test uses a fresh wallet+ID (distinct DID → isolated mailbox), publishes a
// DIDComm endpoint (auto-discovered from Drawbridge), sends to itself through the
// service, then receives from its own mailbox via the local gateway.
async function freshDidCommId(name: string): Promise<string> {
    await archon('new-wallet');
    const did = parseDid(await archon('create-id', '-r', 'local', name));
    expect(await archon('publish-didcomm')).toContain('published');
    return did;
}

beforeAll(() => {
    if (!process.env.CLI_TEST_CLEANUP) {
        throw new Error('didcomm CLI e2e overwrites the wallet — set CLI_TEST_CLEANUP (CI only).');
    }
});

afterAll(async () => {
    await resetAll();
});

describe('didcomm CLI e2e (against docker)', () => {
    test('authcrypt: publish, send-to-self, receive round-trip', async () => {
        const did = await freshDidCommId('qa-dc-auth');
        await writeMessage('/tmp/qa-dc-auth.json', basicMessage('hello-authcrypt'));

        const ids = JSON.parse(await archon('send-didcomm', '/tmp/qa-dc-auth.json', did));
        expect(Array.isArray(ids)).toBe(true);
        expect(ids.length).toBeGreaterThan(0);

        const received = JSON.parse(await archon('receive-didcomm'));
        const msg = received.find((r: any) => r.message?.body?.content === 'hello-authcrypt');
        expect(msg).toBeTruthy();
        expect(msg.metadata.encrypted).toBe(true);
        expect(msg.metadata.authenticated).toBe(true);
        expect(msg.metadata.nonRepudiation).toBe(false);
    });

    test('--sign: received message is non-repudiable', async () => {
        const did = await freshDidCommId('qa-dc-signed');
        await writeMessage('/tmp/qa-dc-signed.json', basicMessage('hello-signed'));

        await archon('send-didcomm', '/tmp/qa-dc-signed.json', did, '--sign');

        const received = JSON.parse(await archon('receive-didcomm'));
        const msg = received.find((r: any) => r.message?.body?.content === 'hello-signed');
        expect(msg).toBeTruthy();
        expect(msg.metadata.nonRepudiation).toBe(true);
    });

    test('--anoncrypt: received message hides the sender', async () => {
        const did = await freshDidCommId('qa-dc-anon');
        await writeMessage('/tmp/qa-dc-anon.json', basicMessage('hello-anon'));

        await archon('send-didcomm', '/tmp/qa-dc-anon.json', did, '--anoncrypt');

        const received = JSON.parse(await archon('receive-didcomm'));
        const msg = received.find((r: any) => r.message?.body?.content === 'hello-anon');
        expect(msg).toBeTruthy();
        expect(msg.metadata.encrypted).toBe(true);
        expect(msg.metadata.authenticated).toBe(false);
    });
});
