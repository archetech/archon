// Measures a Gatekeeper that holds Memeplex objects: how many DIDs it reports, how
// long it takes to resolve one, and how long the design's two main queries take.
//
//   node measure.mjs --url http://localhost:4224 --samples a.json,b.json
//
// The samples are the files load.mjs wrote; each lists objects with their author
// and, where they have one, their target.
import { readFileSync } from 'node:fs';

const opts = { url: 'http://localhost:4224', samples: '', resolves: 300, queries: 40 };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    if (!(key in opts) || argv[i + 1] === undefined) throw new Error(`unknown or incomplete option ${argv[i]}`);
    opts[key] = typeof opts[key] === 'number' ? Number(argv[i + 1]) : argv[i + 1];
}
const headers = { 'Content-Type': 'application/json' };
if (process.env.ARCHON_ADMIN_API_KEY) headers['X-Archon-Admin-Key'] = process.env.ARCHON_ADMIN_API_KEY;

const sample = opts.samples.split(',').filter(Boolean).flatMap(file => JSON.parse(readFileSync(file, 'utf8')).sample);
if (!sample.length) throw new Error('--samples names no objects');
// Spread over the whole sample, oldest files included.
const spread = count => Array.from({ length: Math.min(count, sample.length) }, (_, i) => sample[Math.floor(i * sample.length / Math.min(count, sample.length))]);

async function timed(request) {
    const began = performance.now();
    const response = await request();
    const body = await response.json();
    if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body).slice(0, 200)}`);
    return { ms: performance.now() - began, body };
}
const summary = list => {
    const sorted = list.slice().sort((a, b) => a - b);
    const at = p => Number(sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)].toFixed(2));
    return { count: sorted.length, p50: at(0.5), p95: at(0.95), max: at(1) };
};
const query = where => timed(() => fetch(`${opts.url}/api/v1/query`, { method: 'POST', headers, body: JSON.stringify({ where }) }));

const status = (await timed(() => fetch(`${opts.url}/api/v1/status`, { headers }))).body;
const resolves = [];
for (const item of spread(opts.resolves)) {
    resolves.push((await timed(() => fetch(`${opts.url}/api/v1/did/${encodeURIComponent(item.did)}`, { headers }))).ms);
}
const byAuthor = [], byTarget = [], authorHits = [], targetHits = [];
for (const item of spread(opts.queries)) {
    const found = await query({ 'memeplex.author': { $in: [item.author] } });
    byAuthor.push(found.ms);
    authorHits.push(found.body.length);
}
for (const item of spread(opts.queries * 4).filter(entry => entry.target).slice(0, opts.queries)) {
    const found = await query({ 'memeplex.target': { $in: [item.target] } });
    byTarget.push(found.ms);
    targetHits.push(found.body.length);
}
console.log(JSON.stringify({
    dids: status.dids?.total,
    gatekeeperRss: status.memoryUsage?.rss,
    resolveMs: summary(resolves),
    queryAuthorMs: summary(byAuthor),
    queryAuthorHits: summary(authorHits),
    queryTargetMs: byTarget.length ? summary(byTarget) : null,
    queryTargetHits: targetHits.length ? summary(targetHits) : null,
}));
