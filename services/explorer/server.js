import express from 'express';
import path from 'path';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.VITE_EXPLORER_PORT || 4000;

// Must match the `base` the bundle was built with, or the asset URLs baked into
// index.html will not resolve. Normalised to a leading slash and no trailing one
// so it can be used directly as an express mount path.
const base = `/${(process.env.VITE_EXPLORER_BASE || '/explorer/').replace(/^\/+|\/+$/g, '')}`;

let version = 'unknown';
const commit = (process.env.GIT_COMMIT || 'unknown').slice(0, 7);

try {
    const pkg = JSON.parse(await readFile(path.join(__dirname, 'package.json'), 'utf-8'));
    version = pkg.version;
} catch {
    console.warn('Failed to read package.json, using unknown version');
}

function serveVersion(_req, res) {
    res.json({ version, commit });
}

// At the root as well as under the prefix: the container healthcheck hits
// /version directly and should not have to know the prefix.
app.get('/version', serveVersion);
app.get(`${base}/version`, serveVersion);

// The gatekeeper and search URLs the browser should call. These used to be baked
// into the bundle and defaulted to loopback, which meant a publicly served
// explorer sent every visitor to their own machine. Served at runtime instead so
// one image works for both a local node and a public deployment.
app.get(`${base}/config.json`, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
        gatekeeperUrl: process.env.ARCHON_EXPLORER_GATEKEEPER_URL || process.env.VITE_GATEKEEPER_URL || '',
        searchServerUrl: process.env.ARCHON_EXPLORER_SEARCH_URL || process.env.VITE_SEARCH_SERVER || '',
    });
});

// Normalise the no-trailing-slash form. Anything resolving relative URLs from
// the page would otherwise resolve them one level too high.
app.get(base, (_req, res) => {
    res.redirect(`${base}/`);
});

app.use(base, express.static(path.join(__dirname, 'dist')));

// Anything under the prefix is a client-side route.
app.get(`${base}{/*path}`, (req, res) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// Reaching the container directly on :4000 should still land somewhere useful.
app.get('/', (_req, res) => {
    res.redirect(base);
});

app.listen(port, () => {
    console.log(`Explorer v${version} (${commit}) running at http://localhost:${port}${base}`);
});
