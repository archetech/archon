// Serves a built single-page app over plain node:http.
//
// Deliberately dependency-free: it is the whole runtime of the client images,
// so anything imported here would have to be installed into them, and the point
// is that they need no node_modules at all.
//
// Usage: node serve-static.mjs <root> [port]

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, resolve, extname, sep } from 'node:path';

const root = resolve(process.argv[2] ?? 'dist');
const port = Number(process.argv[3] ?? process.env.VITE_PORT ?? 8080);
const host = process.env.HOST ?? '0.0.0.0';

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

// Vite fingerprints everything under /assets, so those can be cached
// indefinitely. index.html must not be, or a deploy is invisible until the
// browser decides to look again.
function cacheControl(pathname) {
    return pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
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

const server = createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'Allow': 'GET, HEAD' }).end();
        return;
    }

    const { pathname } = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
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

    res.writeHead(200, {
        'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Cache-Control': cacheControl(pathname),
        'X-Content-Type-Options': 'nosniff',
    });

    if (req.method === 'HEAD') {
        res.end();
        return;
    }

    createReadStream(file).on('error', () => res.destroy()).pipe(res);
});

server.listen(port, host, () => {
    console.log(`Serving ${root} on http://${host}:${port}`);
});
