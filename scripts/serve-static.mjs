// Serves a built single-page app over plain node:http.
//
// Deliberately dependency-free: it is the whole runtime of the client images,
// so anything imported here would have to be installed into them, and the point
// is that they need no node_modules at all.
//
// Usage: node serve-static.mjs <root> [port]
//
// Also importable: createStaticHandler({ root, transformHtml }) returns the
// request handler, so a wrapper can serve the same files while rewriting the
// HTML shell -- which is how per-page metadata reaches crawlers that never run
// the bundle (#975).

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { stat } from 'node:fs/promises';
import { join, resolve, relative, extname, sep } from 'node:path';


const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.map': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.txt': 'text/plain; charset=utf-8',
};

// Decided from the file actually served, not the path asked for: an
// extension-less request under /assets/ falls back to the shell, and marking
// that immutable would pin a stale app in caches for a year.
//
// Vite fingerprints everything under /assets, so those can be cached
// indefinitely. HTML never is, or a deploy stays invisible until the browser
// decides to look again.
export function createStaticHandler({ root, transformHtml }) {

    function cacheControl(file) {
        const inAssets = relative(root, file).startsWith('assets' + sep);
        const isHtml = extname(file).toLowerCase() === '.html';

        return inAssets && !isHtml ? 'public, max-age=31536000, immutable' : 'no-cache';
    }

    async function resolveFile(pathname) {
    // decodeURIComponent throws on a malformed escape, so a bad URL resolves to
    // no file rather than taking the process down.
        let decoded;
        try {
            decoded = decodeURIComponent(pathname);
        } catch {
            return null;
        }

        // Join then verify the result is still inside root, so `..` segments and
        // encoded separators cannot escape the served directory.
        const candidate = resolve(join(root, decoded));
        if (candidate !== root && !candidate.startsWith(root + sep)) {
            return null;
        }

        try {
            const info = await stat(candidate);
            if (info.isFile()) {
                return candidate;
            }
            if (info.isDirectory()) {
                const index = join(candidate, 'index.html');
                await stat(index);
                return index;
            }
        } catch {
            return null;
        }

        return null;
    }

    return async function handle(req, res) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { 'Allow': 'GET, HEAD' }).end();
            return;
        }

        // Parsed against a fixed base rather than the Host header, which is
        // attacker-controlled: a value like `[` makes the base invalid, and the
        // throw inside this async handler would take the process down. Only the
        // path is wanted, so the authority is irrelevant.
        let pathname;
        try {
            ({ pathname } = new URL(req.url ?? '/', 'http://localhost'));
        } catch {
            res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Bad request');
            return;
        }

        let file = await resolveFile(pathname);

        // Client-side routes have no file behind them, so anything that is not a
        // real asset falls back to the app shell. Requests that look like assets do
        // not, or a missing bundle would arrive as HTML and fail confusingly.
        if (!file && !extname(pathname)) {
            file = await resolveFile('/index.html');
        }

        if (!file) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
            return;
        }

        const isHtml = extname(file).toLowerCase() === '.html';

        // The shell is one small file and is rewritten per request when a wrapper
        // asks for it, so it is read into memory rather than streamed. Everything
        // else streams.
        let body;
        if (isHtml && transformHtml) {
            try {
                body = transformHtml(await readFile(file, 'utf-8'), pathname);
            } catch {
                body = undefined;
            }
        }

        res.writeHead(200, {
            'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
            'Cache-Control': cacheControl(file),
            'X-Content-Type-Options': 'nosniff',
            ...(body === undefined ? {} : { 'Content-Length': Buffer.byteLength(body) }),
        });

        if (req.method === 'HEAD') {
            res.end();
            return;
        }

        if (body !== undefined) {
            res.end(body);
            return;
        }

        createReadStream(file).on('error', () => res.destroy()).pipe(res);
    };

}

// Run directly rather than imported.
if (import.meta.url === `file://${process.argv[1]}`) {
    const root = resolve(process.argv[2] ?? 'dist');
    const port = Number(process.argv[3] ?? process.env.VITE_PORT ?? 8080);
    const host = process.env.HOST ?? '0.0.0.0';

    createServer(createStaticHandler({ root })).listen(port, host, () => {
        console.log(`Serving ${root} on http://${host}:${port}`);
    });
}
