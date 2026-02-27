import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.VITE_EXPLORER_PORT || 4000;
const adminApiKey = process.env.ARCHON_ADMIN_API_KEY || '';

// Cache the modified index.html
let indexHtml = null;
function getIndexHtml() {
    if (!indexHtml) {
        const rawHtml = fs.readFileSync(path.join(__dirname, 'dist', 'index.html'), 'utf-8');
        const configScript = `<script>window.__ARCHON_CONFIG__ = { apiKey: "${adminApiKey}" };</script>`;
        indexHtml = rawHtml.replace('<head>', `<head>\n    ${configScript}`);
    }
    return indexHtml;
}

app.use(express.static(path.join(__dirname, 'dist'), {
    index: false // Don't serve index.html automatically
}));

app.get('*', (req, res) => {
    res.type('html').send(getIndexHtml());
});

app.listen(port, () => {
    console.log(`Explorer running at http://localhost:${port}`);
});
