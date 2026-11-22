import { execFile } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import path from 'path';

// The grant commands, through the real script against a stub Keymaster
// service: what each sends, prints and exits with. What Keymaster makes of a
// request is tests/keymaster/grant.test.ts.
// python/keymaster/tests/test_cli_grant.py is this file for the Python CLI.

type Reply = { status?: number, body: unknown };

const SCRIPT = path.resolve('scripts/archon-cli.js');
const REQUEST = 'archon://grant?request=did:cid:request';
const GRANTS = [{ did: 'did:cid:grant', status: 'pending', grant: { v: 1, client: 'did:cid:client' }, registry: 'BTC:mainnet', created: true }];

let server: http.Server;
let url: string;
let cwd: string;
let routes: Record<string, () => Reply>;
let requests: { route: string, body: any }[];

beforeAll(async () => {
    // Away from the repo, so a developer's .env cannot reach the command.
    cwd = mkdtempSync(path.join(tmpdir(), 'grant-cli-'));
    server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', chunk => { raw += chunk; });
        req.on('end', () => {
            const route = `${req.method} ${req.url!.replace('/api/v1', '')}`;
            let reply: Reply;
            if (route === 'GET /ready') {
                reply = { body: { ready: true } };
            }
            else if (routes[route]) {
                requests.push({ route, body: raw ? JSON.parse(raw) : undefined });
                reply = routes[route]();
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
    routes = {
        'POST /grants': () => ({ body: { did: 'did:cid:grant' } }),
        'GET /grants': () => ({ body: { grants: GRANTS } }),
        'GET /did/did:cid:grant': () => ({ body: { docs: { didDocumentRegistration: { registry: 'BTC:mainnet' } } } }),
        'PUT /grants/did%3Acid%3Agrant': () => ({ body: { ok: true } }),
        'DELETE /grants/did%3Acid%3Agrant': () => ({ body: { ok: true } }),
        'DELETE /grants/clients%2Fexample': () => ({ body: { ok: true } }),
    };
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

describe('create-grant', () => {
    it('sends the request as it was named, prints the DID alone, and says which registry was used', async () => {
        const { status, stdout, stderr } = await run('create-grant', REQUEST);

        expect(status).toBe(0);
        expect(stdout).toBe('did:cid:grant');
        expect(stderr).toBe('Created on BTC:mainnet');
        expect(requests).toEqual([
            { route: 'POST /grants', body: { request: REQUEST, options: {} } },
            { route: 'GET /did/did:cid:grant', body: undefined },
        ]);
    });

    it('succeeds when the grant is made and the node cannot then say where', async () => {
        routes['GET /did/did:cid:grant'] = () => ({ status: 500, body: { error: 'unreachable' } });

        const { status, stdout, stderr } = await run('create-grant', REQUEST);

        expect(status).toBe(0);
        expect(stdout).toBe('did:cid:grant');
        expect(stderr).toBe('Created on an unknown registry');
    });

    it('sends its options', async () => {
        const { status } = await run('create-grant', REQUEST, '-r', 'ETH:mainnet', '-a', 'example-grant',
            '--actions', 'example:post, example:tag,', '--expires', '2028-01-01T00:00:00Z');

        expect(status).toBe(0);
        expect(requests[0].body).toEqual({
            request: REQUEST,
            options: {
                alias: 'example-grant',
                registry: 'ETH:mainnet',
                actions: ['example:post', 'example:tag'],
                expiresAt: '2028-01-01T00:00:00Z',
            },
        });
    });

    it('with --no-expiry sends a null expiry', async () => {
        const { status } = await run('create-grant', REQUEST, '--no-expiry');

        expect(status).toBe(0);
        expect(requests[0].body).toEqual({ request: REQUEST, options: { expiresAt: null } });
    });

    it('sends an empty list of actions for Keymaster to refuse', async () => {
        await run('create-grant', REQUEST, '--actions', '');

        expect(requests[0].body).toEqual({ request: REQUEST, options: { actions: [] } });
    });

    it('fails with the refusal Keymaster gives', async () => {
        routes['POST /grants'] = () => ({ status: 400, body: { error: 'Error: Invalid parameter: request: not found' } });

        const { status, stdout, stderr } = await run('create-grant', 'did:cid:nothing');

        expect(status).toBe(1);
        expect(stdout).toBe('');
        expect(stderr).toContain('Invalid parameter: request: not found');
    });

    it('refuses --expires with --no-expiry before calling Keymaster', async () => {
        const { status, stderr } = await run('create-grant', REQUEST, '--expires', '2028-01-01T00:00:00Z', '--no-expiry');

        expect(status).toBe(1);
        expect(stderr).toContain('--expires and --no-expiry cannot be used together');
        expect(requests).toEqual([]);
    });
});

describe('list-grants', () => {
    it('prints the grants', async () => {
        const { status, stdout } = await run('list-grants');

        expect(status).toBe(0);
        expect(JSON.parse(stdout)).toEqual(GRANTS);
        expect(requests).toEqual([{ route: 'GET /grants', body: undefined }]);
    });
});

describe('update-grant', () => {
    it.each([
        [['--actions', 'example:tag'], { actions: ['example:tag'] }],
        [['--all-actions'], { actions: null }],
        [['--expires', '2028-01-01T00:00:00Z'], { expiresAt: '2028-01-01T00:00:00Z' }],
        [['--no-expiry'], { expiresAt: null }],
        [['--all-actions', '--no-expiry'], { actions: null, expiresAt: null }],
        [['--actions', 'example:tag,example:rate', '--expires', '2028-01-01T00:00:00Z'], { actions: ['example:tag', 'example:rate'], expiresAt: '2028-01-01T00:00:00Z' }],
        [[], {}],
    ])('with %j sends the changes asked for', async (options, changes) => {
        const { status, stdout } = await run('update-grant', 'did:cid:grant', ...options);

        expect(status).toBe(0);
        expect(stdout).toBe('OK');
        expect(requests).toEqual([{ route: 'PUT /grants/did%3Acid%3Agrant', body: { changes } }]);
    });

    it.each([
        [['--actions', 'example:tag', '--all-actions'], '--actions and --all-actions cannot be used together'],
        [['--expires', '2028-01-01T00:00:00Z', '--no-expiry'], '--expires and --no-expiry cannot be used together'],
    ])('refuses %j before calling Keymaster', async (options, message) => {
        const { status, stderr } = await run('update-grant', 'did:cid:grant', ...options);

        expect(status).toBe(1);
        expect(stderr).toContain(message);
        expect(requests).toEqual([]);
    });

    it('says when the node did not accept the change', async () => {
        routes['PUT /grants/did%3Acid%3Agrant'] = () => ({ body: { ok: false } });

        const { status, stdout } = await run('update-grant', 'did:cid:grant', '--no-expiry');

        expect(status).toBe(0);
        expect(stdout).toBe('Update failed');
    });
});

describe('revoke-grant', () => {
    it('revokes and prints OK', async () => {
        const { status, stdout } = await run('revoke-grant', 'did:cid:grant');

        expect(status).toBe(0);
        expect(stdout).toBe('OK');
        expect(requests).toEqual([{ route: 'DELETE /grants/did%3Acid%3Agrant', body: undefined }]);
    });

    it('names an alias with a slash as one path segment', async () => {
        const { status } = await run('revoke-grant', 'clients/example');

        expect(status).toBe(0);
        expect(requests).toEqual([{ route: 'DELETE /grants/clients%2Fexample', body: undefined }]);
    });

    it('fails with the refusal Keymaster gives', async () => {
        routes['DELETE /grants/did%3Acid%3Agrant'] = () => ({ status: 400, body: { error: 'Error: Invalid parameter: id: not a grant' } });

        const { status, stderr } = await run('revoke-grant', 'did:cid:grant');

        expect(status).toBe(1);
        expect(stderr).toContain('Invalid parameter: id: not a grant');
    });
});
