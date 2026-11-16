// Runs inside a node's cli container. Creates identities through the node's
// Keymaster at a steady rate and prints one line of JSON for each:
// { name, did, versionId, submitted, returned }, times in milliseconds.
//
//   node generate.mjs <count> <per second> <registry> <name prefix>
import KeymasterClient from '@didcid/clients/keymaster';

const [count, rate, registry, prefix] = process.argv.slice(2);
const keymaster = new KeymasterClient();
await keymaster.connect({
    url: process.env.ARCHON_KEYMASTER_URL || 'http://localhost:4226',
    apiKey: process.env.ARCHON_ADMIN_API_KEY,
    waitUntilReady: true,
    intervalSeconds: 1,
    chatty: false,
});

const gap = 1000 / Number(rate);
const began = Date.now();
for (let i = 0; i < Number(count); i++) {
    // Keep to the rate overall: a slow create does not push the later ones back.
    const due = began + i * gap;
    if (due > Date.now()) await new Promise(resolve => setTimeout(resolve, due - Date.now()));
    const name = `${prefix}-${i}`;
    const submitted = Date.now();
    const did = await keymaster.createId(name, { registry });
    const returned = Date.now();
    const doc = await keymaster.resolveDID(did);
    console.log(JSON.stringify({ name, did, versionId: doc.didDocumentMetadata.versionId, submitted, returned }));
}
