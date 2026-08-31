import { spawn, ChildProcess } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// The identity page is the artifact people share to introduce themselves, and
// unfurlers never run the bundle, so the metadata has to be in the HTML the
// server returns (#975). Asserted against a real process, since the rewriting
// happens on the way out.

let dir: string;
let server: ChildProcess;
let base: string;

const DOMAIN = 'example.org';
const PUBLIC_URL = 'https://names.example.org';

async function html(path: string): Promise<string> {
    return (await fetch(`${base}${path}`)).text();
}

beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'serve-herald-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8" /><title>Name Service</title></head><body><div id="root"></div></body></html>');
    writeFileSync(join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');

    const port = 8930 + Math.floor(Math.random() * 200);
    base = `http://127.0.0.1:${port}`;
    server = spawn('node', ['scripts/serve-herald.mjs', dir, String(port)], {
        stdio: 'ignore',
        env: { ...process.env, ARCHON_HERALD_DOMAIN: DOMAIN, ARCHON_HERALD_PUBLIC_URL: PUBLIC_URL },
    });

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

describe('serve-herald identity metadata', () => {
    it('names the identity in the title', async () => {
        expect(await html('/id/david')).toContain('<title>david@example.org</title>');
    });

    it('emits Open Graph and Twitter tags for the identity', async () => {
        const page = await html('/id/david');

        expect(page).toContain('<meta property="og:type" content="profile" />');
        expect(page).toContain('<meta property="og:title" content="david@example.org" />');
        expect(page).toContain(`<meta property="og:url" content="${PUBLIC_URL}/id/david" />`);
        expect(page).toContain('<meta name="twitter:card" content="summary" />');
        expect(page).toContain('name="description"');
    });

    it('leaves exactly one title on the page', async () => {
        // Two titles are resolved inconsistently by unfurlers, so the build's
        // placeholder is removed rather than added to.
        expect((await html('/id/david')).match(/<title>/g)).toHaveLength(1);
    });

    it('gives different identities different metadata', async () => {
        // The failure being fixed was every identity sharing one generic title.
        expect(await html('/id/david')).toContain('david@example.org');
        expect(await html('/id/claude')).toContain('claude@example.org');
    });

    it.each([
        ['/', 'the app root'],
        ['/directory', 'a non-identity route'],
        ['/id/', 'a bare /id/'],
        ['/id/ab', 'a name below the 3-character minimum'],
        ['/id/David', 'an uppercase name the server would never register'],
    ])('leaves the shell untouched for %s (%s)', async (path) => {
        // Anything that could not be a registered name gets no card, rather than
        // one advertising an identity that does not exist.
        expect(await html(path)).toContain('<title>Name Service</title>');
    });

    it('escapes what it injects', async () => {
        // The name is bounded by the route pattern, so this asserts the boundary
        // holds rather than trusting the pattern alone.
        const page = await html('/id/' + encodeURIComponent('a"><script>alert(1)</script>'));

        expect(page).not.toContain('<script>alert(1)</script>');
        expect(page).toContain('<title>Name Service</title>');
    });

    it('still serves assets and 404s a missing one', async () => {
        expect((await fetch(`${base}/assets/app-abc123.js`)).status).toBe(200);
        expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);
    });

    it('sends a Content-Length matching the rewritten body', async () => {
        const res = await fetch(`${base}/id/david`);
        const body = await res.text();

        expect(res.headers.get('content-length')).toBe(String(Buffer.byteLength(body)));
    });
});
