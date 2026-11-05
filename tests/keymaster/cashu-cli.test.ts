import { execFile } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import path from 'path';

// The output and failure contract of the Cashu commands, through the real script
// against a stub Keymaster service. The integration suite in tests/cli covers them
// against a real mint, but has no Lightning to exercise cashu-mint --pay.

type Reply = { status?: number, body: unknown };
type Handler = (body: any) => Reply;

const SCRIPT = path.resolve('scripts/archon-cli.js');
const QUOTE = { quote: 'quote-1', request: 'lnbc-invoice', amount: 21, state: 'UNPAID' };
const MINT = 'https://mint.example';

let server: http.Server;
let url: string;
let cwd: string;
let routes: Record<string, Handler>;
let requests: { path: string, body: any }[];

beforeAll(async () => {
    // Away from the repo, so a developer's .env cannot reach the command.
    cwd = mkdtempSync(path.join(tmpdir(), 'cashu-cli-'));
    server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', chunk => { raw += chunk; });
        req.on('end', () => {
            const route = req.url!.replace('/api/v1', '');
            const body = raw ? JSON.parse(raw) : {};
            let reply: Reply;
            if (route === '/ready') {
                reply = { body: { ready: true } };
            }
            else if (routes[route]) {
                requests.push({ path: route, body });
                reply = routes[route](body);
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
        '/cashu/quote': () => ({ body: QUOTE }),
        '/lightning/pay': () => ({ body: { paymentHash: 'hash' } }),
        '/cashu/claim': () => ({ body: { amount: 21, mint: MINT } }),
        '/cashu/balance': () => ({ body: { spendable: 21, inFlight: 0, outstanding: 0 } }),
        '/cashu/send': () => ({ body: { token: 'cashuBtoken', amount: 21, fee: 1, operationId: 'op-1' } }),
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

const called = () => requests.map(request => request.path);

describe('cashu-mint', () => {
    it('prints the quote without paying it', async () => {
        const { status, stdout } = await run('cashu-mint', '21');

        expect(status).toBe(0);
        expect(JSON.parse(stdout)).toEqual(QUOTE);
        expect(called()).toEqual(['/cashu/quote']);
    });

    it('with --pay pays the invoice, claims the quote and prints the balance', async () => {
        const { status, stdout, stderr } = await run('cashu-mint', '21', 'Alice', '--pay', '-m', MINT);

        expect(status).toBe(0);
        expect(JSON.parse(stdout)).toEqual({ amount: 21, mint: MINT, balance: { spendable: 21, inFlight: 0, outstanding: 0 } });
        expect(stderr).toContain('quote-1');
        expect(called()).toEqual(['/cashu/quote', '/lightning/pay', '/cashu/claim', '/cashu/balance']);
        expect(requests[0].body).toEqual({ amount: 21, mint: MINT, id: 'Alice' });
        expect(requests[1].body).toEqual({ bolt11: 'lnbc-invoice', id: 'Alice' });
        expect(requests[2].body).toEqual({ quote: 'quote-1', mint: MINT, id: 'Alice' });
    });

    it('retries a claim the mint has not yet seen paid', async () => {
        let claims = 0;
        routes['/cashu/claim'] = () => (++claims === 1
            ? { status: 409, body: { error: 'Cashu quote not paid' } }
            : { body: { amount: 21, mint: MINT } });

        const { status } = await run('cashu-mint', '21', '--pay');

        expect(status).toBe(0);
        expect(claims).toBe(2);
    });

    it('does not claim when the payment fails, and leaves the quote named', async () => {
        routes['/lightning/pay'] = () => ({ status: 500, body: { error: 'no route to host' } });

        const { status, stdout, stderr } = await run('cashu-mint', '21', '--pay');

        expect(status).toBe(1);
        expect(stdout).toBe('');
        expect(stderr).toContain('quote-1');
        expect(stderr).toContain('no route to host');
        expect(called()).toEqual(['/cashu/quote', '/lightning/pay']);
    });

    it('does not retry a claim that failed for another reason', async () => {
        let claims = 0;
        routes['/cashu/claim'] = () => {
            claims++;
            return { status: 503, body: { error: 'Cashu mint unavailable' } };
        };

        const { status, stderr } = await run('cashu-mint', '21', '--pay');

        expect(status).toBe(1);
        expect(claims).toBe(1);
        expect(stderr).toContain('quote-1');
    });

    it.each(['0', '1.5', '10abc', '1e3', '99999999999999999999'])('refuses the amount %s before calling the service', async (amount) => {
        const { status, stderr } = await run('cashu-mint', amount);

        expect(status).toBe(1);
        expect(stderr).toContain('positive whole number');
        expect(requests).toEqual([]);
    });
});

describe('cashu-send', () => {
    it('prints only the token on stdout', async () => {
        const { status, stdout, stderr } = await run('cashu-send', '21');

        expect(status).toBe(0);
        expect(stdout).toBe('cashuBtoken');
        expect(stderr).toContain('op-1');
        expect(stderr).toContain('Balance: 21');
    });

    it('still prints the token and succeeds when the balance cannot be read', async () => {
        routes['/cashu/balance'] = () => ({ status: 503, body: { error: 'Cashu mint unavailable' } });

        const { status, stdout, stderr } = await run('cashu-send', '21');

        expect(status).toBe(0);
        expect(stdout).toBe('cashuBtoken');
        expect(stderr).not.toContain('Balance');
    });
});

describe('commands that change ecash state', () => {
    it('still report the result when the balance cannot be read', async () => {
        routes['/cashu/balance'] = () => ({ status: 503, body: { error: 'Cashu mint unavailable' } });

        const { status, stdout } = await run('cashu-claim', 'quote-1');

        expect(status).toBe(0);
        expect(JSON.parse(stdout)).toEqual({ amount: 21, mint: MINT });
    });

    it('report a pending melt without failing', async () => {
        routes['/cashu/melt'] = () => ({ body: { paid: false, pending: true, change: 0 } });

        const { status, stdout } = await run('cashu-melt', 'lnbc-invoice');

        expect(status).toBe(0);
        expect(JSON.parse(stdout)).toMatchObject({ paid: false, pending: true });
    });

    it('send --force only when asked', async () => {
        routes['/cashu'] = () => ({ body: { ok: true } });

        await run('remove-cashu');
        await run('remove-cashu', 'Alice', '--force');

        expect(requests.map(request => request.body)).toEqual([{}, { force: true, id: 'Alice' }]);
    });
});
