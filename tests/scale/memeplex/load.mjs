// Creates Memeplex objects on a Gatekeeper and measures what that costs.
//
//   node load.mjs --url http://localhost:4224 --objects 100000 --authors 1000 \
//       [--registry hyperswarm] [--concurrency 32] [--seed 1] [--out load.json]
//
// It makes the authors first (a user, a client and a grant each), then the objects in
// the mix of objects.mjs. An object that responds to something aims at an earlier
// object, chosen so that a few objects collect most of the responses. Operations are
// signed here and submitted to POST /api/v1/did, the route a Keymaster uses.
// It needs the @didcid packages, so it runs where they are installed: in the
// repository, or in a node's cli container.
import { writeFileSync } from 'node:fs';
import { RESPONDS, author, object, pickKind, random } from './objects.mjs';

const opts = { url: 'http://localhost:4224', objects: 1000, authors: 50, registry: 'hyperswarm', concurrency: 32, seed: 1, out: '' };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    if (!(key in opts) || argv[i + 1] === undefined) throw new Error(`unknown or incomplete option ${argv[i]}`);
    opts[key] = typeof opts[key] === 'number' ? Number(argv[i + 1]) : argv[i + 1];
}
for (const key of ['objects', 'authors', 'concurrency']) {
    if (!Number.isInteger(opts[key]) || opts[key] < 1) throw new Error(`--${key} takes a whole number above zero`);
}

const next = random(opts.seed);
const headers = { 'Content-Type': 'application/json' };
if (process.env.ARCHON_ADMIN_API_KEY) headers['X-Archon-Admin-Key'] = process.env.ARCHON_ADMIN_API_KEY;

async function submit(operation, expected) {
    const response = await fetch(`${opts.url}/api/v1/did`, { method: 'POST', headers, body: JSON.stringify(operation) });
    const body = await response.text();
    if (!response.ok) throw new Error(`create returned ${response.status}: ${body.slice(0, 200)}`);
    const did = JSON.parse(body);
    if (did !== expected) throw new Error(`the node named the DID ${did}, and ${expected} was computed here`);
}

// Runs make() count times, a few at a time, and returns the seconds it took.
async function many(count, make) {
    const began = performance.now();
    let started = 0;
    await Promise.all(Array.from({ length: Math.min(opts.concurrency, count) }, async () => {
        while (started < count) await make(started++);
    }));
    return (performance.now() - began) / 1000;
}

const result = { options: opts, started: new Date().toISOString() };

const authors = new Array(opts.authors);
result.authorSeconds = await many(opts.authors, async i => {
    const made = await author(opts.registry, next);
    // A grant needs its user to exist, so the three go in order.
    for (const [index, operation] of made.operations.entries()) {
        await submit(operation, [made.user.did, made.client.did, made.grant.did][index]);
    }
    authors[i] = made;
});

// Earlier objects that later ones may aim at. Recent ones are kept, and an index is
// squared so that a few of them collect most of the responses.
const targets = [];
const kinds = {};
const sample = [];
let bytes = 0;
result.objectSeconds = await many(opts.objects, async i => {
    const by = authors[Math.floor(next() * authors.length)];
    let kind = pickKind(next);
    if (RESPONDS.has(kind) && !targets.length) kind = 'post';
    const target = RESPONDS.has(kind) ? targets[Math.floor(next() * next() * targets.length)] : undefined;
    const made = await object(by, kind, target, opts.registry, next);
    const body = JSON.stringify(made.operation);
    bytes += Buffer.byteLength(body);
    await submit(made.operation, made.did);
    kinds[kind] = (kinds[kind] || 0) + 1;
    if (!RESPONDS.has(kind)) {
        if (targets.length < 50_000) targets.unshift({ did: made.did, versionId: made.versionId });
        else targets[Math.floor(next() * targets.length)] = { did: made.did, versionId: made.versionId };
    }
    if (i % Math.max(1, Math.floor(opts.objects / 200)) === 0) sample.push({ did: made.did, author: by.user.did, target: target?.did });
});

Object.assign(result, {
    finished: new Date().toISOString(),
    kinds,
    objectsPerSecond: Math.round(opts.objects / result.objectSeconds),
    meanOperationBytes: Math.round(bytes / opts.objects),
    sample,
});
if (opts.out) writeFileSync(opts.out, JSON.stringify(result, null, 4) + '\n');
console.log(JSON.stringify({ ...result, sample: sample.length }, null, 2));
