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

let version = 'unknown';
const commit = (process.env.GIT_COMMIT || 'unknown').slice(0, 7);

try {
    const pkg = JSON.parse(await readFile(path.join(__dirname, 'package.json'), 'utf-8'));
    version = pkg.version;
} catch {
    console.warn('Failed to read package.json, using unknown version');
}

app.get('/version', (_req, res) => {
    res.json({ version, commit });
});

app.use(express.static(path.join(__dirname, 'dist')));

app.get('{*path}', (req, res) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(port, () => {
    console.log(`Explorer v${version} (${commit}) running at http://localhost:${port}`);
});
