// Runs on a machine, beside its node. Asks the node's Gatekeeper, a few times a
// second, for every DID changed since the run began, and writes down when each
// version of each DID was first seen.
//
//   node watch.mjs <run start, RFC 3339> <output file>
//
// One line of JSON per sighting: { did, versionId, seen }, with `seen` in
// milliseconds on this machine's clock. A node under a stream of updates can pass
// through a version between two polls; the reader treats a version that was never
// seen as having arrived by the time its successor was.
import { appendFileSync } from 'node:fs';

const [since, file] = process.argv.slice(2);
const INTERVAL_MS = 250;
const seen = new Set();

async function poll() {
    const response = await fetch('http://localhost:4224/api/v1/dids/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updatedAfter: since, resolve: true }),
    });
    if (!response.ok) return;
    const now = Date.now();
    for (const doc of await response.json()) {
        const did = doc?.didDocument?.id;
        const versionId = doc?.didDocumentMetadata?.versionId;
        if (!did || !versionId || seen.has(`${did}|${versionId}`)) continue;
        seen.add(`${did}|${versionId}`);
        appendFileSync(file, JSON.stringify({ did, versionId, seen: now }) + '\n');
    }
}

for (;;) {
    const started = Date.now();
    await poll().catch(() => { /* the node is restarting; ask again */ });
    await new Promise(resolve => setTimeout(resolve, Math.max(0, INTERVAL_MS - (Date.now() - started))));
}
