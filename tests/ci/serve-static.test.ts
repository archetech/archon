import { spawn, ChildProcess } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { connect } from 'net';

// scripts/serve-static.mjs is the entire HTTP runtime of the four client
// images, so its response and security contracts are asserted against a real
// process rather than by importing it: the crash below is only observable when
// something is there to crash.

let dir: string;
let server: ChildProcess;
let port: number;
let base: string;

function get(path: string, init?: RequestInit): Promise<Response> {
    // Not encoded by fetch, so traversal sequences reach the server intact.
    return fetch(`${base}${path}`, init);
}

beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'serve-static-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>shell</title>');
    writeFileSync(join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
    writeFileSync(join(dir, 'assets', 'app-abc123.css'), 'body{}');
    writeFileSync(join(dir, 'secret.txt'), 'inside-root');

    port = 8900 + Math.floor(Math.random() * 300);
    base = `http://127.0.0.1:${port}`;
    server = spawn('node', ['scripts/serve-static.mjs', dir, String(port)], { stdio: 'ignore' });

    for (let i = 0; i < 50; i++) {
        try {
            await fetch(base);
            return;
        } catch {
            await new Promise(r => setTimeout(r, 100));
        }
    }
    throw new Error('server did not start');
});

afterAll(() => {
    server?.kill();
    rmSync(dir, { recursive: true, force: true });
});

describe('serve-static', () => {
    it('serves the shell at the root', async () => {
        const res = await get('/');

        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    });

    it('serves fingerprinted assets as immutable', async () => {
        const res = await get('/assets/app-abc123.js');

        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
        expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    });

    it('never marks the shell immutable, even under /assets', async () => {
        // An extension-less path under /assets falls back to index.html. Caching
        // that for a year would pin a stale app in browsers and shared caches.
        for (const path of ['/', '/some/route', '/assets/not-a-real-file']) {
            const res = await get(path);

            expect(`${path}: ${res.headers.get('content-type')}`).toBe(`${path}: text/html; charset=utf-8`);
            expect(`${path}: ${res.headers.get('cache-control')}`).toBe(`${path}: no-cache`);
        }
    });

    it('falls back to the shell for client-side routes', async () => {
        const res = await get('/settings/deep/route');

        expect(res.status).toBe(200);
        expect(await res.text()).toContain('<title>shell</title>');
    });

    it('404s a missing asset rather than answering with HTML', async () => {
        // A bundle that arrives as the shell fails much more confusingly than
        // one that is reported missing.
        const res = await get('/assets/missing.js');

        expect(res.status).toBe(404);
        expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    });

    it('sets nosniff on what it serves', async () => {
        expect((await get('/')).headers.get('x-content-type-options')).toBe('nosniff');
    });

    it('refuses methods other than GET and HEAD', async () => {
        const res = await get('/', { method: 'POST' });

        expect(res.status).toBe(405);
        expect(res.headers.get('allow')).toBe('GET, HEAD');
    });

    it('answers HEAD without a body', async () => {
        const res = await get('/', { method: 'HEAD' });

        expect(res.status).toBe(200);
        expect(await res.text()).toBe('');
    });

    it.each([
        '/../../../../etc/passwd',
        '/assets/../../../../etc/passwd',
        '/..%2f..%2f..%2fetc%2fpasswd',
        '/%2e%2e/%2e%2e/etc/passwd',
        '/../serve-static.mjs',
    ])('does not serve %s from outside the root', async (path) => {
        const res = await fetch(`${base}${path}`);
        const body = await res.text();

        expect(body).not.toContain('root:x:');
        expect(body).not.toContain('createServer');
    });

    it('survives a malformed Host header', async () => {
        // The base URL used to be built from Host, so `[` made it invalid and the
        // throw inside the async handler killed the process -- one unauthenticated
        // request taking the container down.
        await new Promise<void>((resolve, reject) => {
            const socket = connect(port, '127.0.0.1', () => {
                socket.write('GET / HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n');
            });
            socket.on('data', () => {});
            socket.on('end', () => resolve());
            socket.on('error', reject);
            setTimeout(() => { socket.destroy(); resolve(); }, 2000);
        });

        expect((await get('/')).status).toBe(200);
    });

    it('survives a malformed percent-escape', async () => {
        await fetch(`${base}/%ZZ`).catch(() => undefined);

        expect((await get('/')).status).toBe(200);
    });
});
