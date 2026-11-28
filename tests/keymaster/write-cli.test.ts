import { execFile } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import path from 'path';

// What a write command does with the node's answer, through the real script
// against a stub Keymaster service: OK and status 0 for a write the node took,
// the refusal on standard error and a failing status for one it did not. A
// script goes by the status, so `revoke-did <id> && next` must stop at a refusal.
// python/keymaster/tests/test_cli_exit_status.py has the same for the Python CLI.

type Reply = { status?: number, body: unknown };

const SCRIPT = path.resolve('scripts/archon-cli.js');

let server: http.Server;
let url: string;
let cwd: string;
let answer: boolean;
let requests: string[];
let bodies: unknown[];
let refusal: string | undefined;

// [command line, the request it makes, what it prints when taken, when refused]
const WRITES: [string[], string, string, string][] = [
    [['revoke-did', 'did:cid:asset'], 'DELETE /did/did:cid:asset', 'OK', 'Update failed'],
    [['rotate-keys'], 'POST /keys/rotate', 'OK', 'Update failed'],
    [['change-registry', 'did:cid:asset', 'hyperswarm'], 'POST /ids/did:cid:asset/change-registry', 'OK', 'Update failed'],
    [['accept-credential', 'did:cid:credential'], 'POST /credentials/held', 'OK', 'Update failed'],
    [['unpublish-didcomm'], 'DELETE /didcomm/publish', 'unpublished', 'failed'],
];

beforeAll(async () => {
    // Away from the repo, so a developer's .env cannot reach the command.
    cwd = mkdtempSync(path.join(tmpdir(), 'write-cli-'));
    server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', chunk => { raw += chunk; });
        req.on('end', () => {
            const route = `${req.method} ${req.url!.replace('/api/v1', '')}`;
            let reply: Reply;
            if (route === 'GET /ready') {
                reply = { body: { ready: true } };
            }
            else if (route === 'POST /didcomm/credential/accept' || WRITES.some(([, request]) => request === route)) {
                requests.push(route);
                bodies.push(raw ? JSON.parse(raw) : undefined);
                reply = refusal ? { status: 400, body: { error: refusal } } : { body: { ok: answer } };
            }
            else {
                reply = { status: 404, body: { error: `no route ${route}` } };
            }
            res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(reply.body));
        });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    rmSync(cwd, { recursive: true, force: true });
});

beforeEach(() => {
    requests = [];
    bodies = [];
    refusal = undefined;
});

function run(...args: string[]): Promise<{ status: number, stdout: string, stderr: string }> {
    return new Promise((resolve) => {
        execFile(process.execPath, [SCRIPT, ...args], {
            cwd,
            env: { PATH: process.env.PATH, ARCHON_KEYMASTER_URL: url },
        }, (error, stdout, stderr) => {
            resolve({ status: error ? Number(error.code) : 0, stdout: stdout.trim(), stderr: stderr.trim() });
        });
    });
}

describe.each(WRITES)('%j', (args, request, taken, refused) => {
    it('prints its success and exits 0 when the node takes the write', async () => {
        answer = true;

        const { status, stdout, stderr } = await run(...args);

        expect(requests).toEqual([request]);
        expect({ status, stdout, stderr }).toEqual({ status: 0, stdout: taken, stderr: '' });
    });

    it('prints the refusal on standard error and exits 1 when the node refuses it', async () => {
        answer = false;

        const { status, stdout, stderr } = await run(...args);

        expect(requests).toEqual([request]);
        expect({ status, stdout, stderr }).toEqual({ status: 1, stdout: '', stderr: refused });
    });
});

it('prints the answer to a credential over DIDComm either way, and fails when it was not accepted', async () => {
    const file = path.join(cwd, 'message.json');
    writeFileSync(file, '{}');

    answer = true;
    const taken = await run('accept-credential-didcomm', file);
    answer = false;
    const refused = await run('accept-credential-didcomm', file);

    expect(requests).toEqual(['POST /didcomm/credential/accept', 'POST /didcomm/credential/accept']);
    expect({ ...taken, stdout: JSON.parse(taken.stdout) }).toEqual({ status: 0, stdout: { ok: true }, stderr: '' });
    expect({ ...refused, stdout: JSON.parse(refused.stdout) }).toEqual({ status: 1, stdout: { ok: false }, stderr: 'Credential not accepted' });
});

it('stops a chain of commands at the write the node refused', async () => {
    answer = false;

    const chained = await new Promise<{ status: number, stdout: string }>((resolve) => {
        execFile('/bin/sh', ['-c', `"${process.execPath}" "${SCRIPT}" revoke-did did:cid:asset && echo carried-on`], {
            cwd,
            env: { PATH: process.env.PATH, ARCHON_KEYMASTER_URL: url },
        }, (error, stdout) => resolve({ status: error ? Number(error.code) : 0, stdout: stdout.trim() }));
    });

    expect(chained).toEqual({ status: 1, stdout: '' });
});

describe('accept-credential --alias', () => {
    it('sends the alias with the credential, so that it is checked before the credential is accepted', async () => {
        answer = true;

        const { status, stdout } = await run('accept-credential', 'did:cid:credential', '--alias', 'license');

        expect(bodies).toEqual([{ did: 'did:cid:credential', options: { alias: 'license' } }]);
        expect(requests).toEqual(['POST /credentials/held']);
        expect({ status, stdout }).toEqual({ status: 0, stdout: 'OK' });
    });

    it('sends an empty alias as given, and fails when the node refuses it', async () => {
        refusal = 'Invalid parameter: alias must be a non-empty string';

        const { status, stdout, stderr } = await run('accept-credential', 'did:cid:credential', '--alias', '');

        expect(bodies).toEqual([{ did: 'did:cid:credential', options: { alias: '' } }]);
        expect(requests).toEqual(['POST /credentials/held']);
        expect({ status, stdout, stderr }).toEqual({ status: 1, stdout: '', stderr: refusal });
    });

    it('sends a taken alias, and fails with the node\'s refusal of it', async () => {
        refusal = 'Invalid parameter: alias already used';

        const { status, stdout, stderr } = await run('accept-credential', 'did:cid:credential', '--alias', 'Alice');

        expect(bodies).toEqual([{ did: 'did:cid:credential', options: { alias: 'Alice' } }]);
        expect(requests).toEqual(['POST /credentials/held']);
        expect({ status, stdout, stderr }).toEqual({ status: 1, stdout: '', stderr: refusal });
    });
});
