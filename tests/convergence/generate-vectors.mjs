// Synthetic keys only. Run from the repo root after building Cipher and IPFS.
import { readFileSync, writeFileSync } from 'node:fs';
import Cipher from '../../packages/cipher/dist/esm/cipher-node.js';
import { generateCID } from '../../packages/ipfs/dist/esm/utils.js';
import { permutations, project } from './model.mjs';
const cipher = new Cipher();
const key = cipher.generateJwk(new Uint8Array(32).fill(73));
const cid = op => generateCID(op, { canonical: true });
const time = second => `2026-09-01T00:00:${String(second).padStart(2, '0')}Z`;
function sign(op, method, second) {
    const config = { type: 'DataIntegrityProof', cryptosuite: 'archon-ecdsa-secp256k1-jcs-2026',
        created: time(second), verificationMethod: method, proofPurpose: 'capabilityInvocation' };
    const hash = cipher.hashMessage(Buffer.from(cipher.hashJSON(config) + cipher.hashJSON(op), 'hex'));
    return { ...op, proof: { ...config, proofValue: Buffer.from(cipher.signHash(hash, key.privateJwk), 'hex').toString('base64url') } };
}
const vectors = [];
for (const registry of ['hyperswarm', 'local', 'pin', 'BTC:signet']) {
    const create = sign({ type: 'create', created: time(0), registration: { version: 1, type: 'agent', registry }, publicJwk: key.publicJwk }, '#key-1', 0);
    const did = 'did:cid:' + await cid(create);
    const update = async (prev, state, second) => sign({ type: 'update', did, previd: await cid(prev), doc: { didDocumentData: { state } } }, did + '#key-1', second);
    const left = await update(create, 'left', 1);
    const right = await update(create, 'right', 2);
    const child = await update(left, 'left-child', 3);
    const operations = [create, left, right, child];
    const ids = await Promise.all(operations.map(cid));
    const graph = operations.map((op, index) => ({ type: op.type, parent: index === 0 ? undefined : ids.indexOf(op.previd) }));
    const transports = registry === 'pin' ? ['pin', 'pin-mixed'] : registry === 'local' ? ['local'] : registry === 'hyperswarm' ? ['hyperswarm', 'mixed', 'foreign-anchor'] : ['BTC:signet', 'hyperswarm', 'mixed'];
    for (const transport of transports) {
        const anchored = transport === 'BTC:signet';
        for (const receipts of anchored ? ['fixed'] : ['fresh', 'tied']) {
            for (const fork of [false, true]) {
                const inputs = fork ? [0, 1, 2, 3] : [0, 1, 3];
                const priority = anchored ? inputs : inputs.slice().sort((a, b) => ids[a] < ids[b] ? -1 : 1);
                const cases = permutations(inputs).map(order => ({ order, expected: project(graph, priority) }));
                vectors.push({ name: `${registry}/${transport}/${receipts}/${fork ? 'fork' : 'linear'}`, registry, transport, receipts, did, operations, ids, cases });
            }
        }
    }
}
// Keep permutation rows compact: evidence is readable without a large fixture diff.
const histories = [...new Set(vectors.map(v => v.registry))].map(registry => {
    const { did, operations, ids } = vectors.find(v => v.registry === registry);
    return { registry, did, operations, ids };
});
const scenarios = vectors.map(({ name, registry, transport, receipts, cases }) => ({ name, registry, transport, receipts, cases }));
const controllerForks = await Promise.all(JSON.parse(readFileSync('tests/gatekeeper/hyperswarm-time-vectors.json', 'utf8')).map(async recovery => {
    const operations = [recovery.agent, recovery.assetCreate, recovery.assetUpdate, recovery.controllerRotation, recovery.controllerDelete, recovery.afterRotation];
    const ids = await Promise.all(operations.map(cid));
    const winner = ids[3] < ids[4] ? 3 : 4;
    return { legacy: recovery.legacy, controller: recovery.controller, asset: recovery.asset, operations, ids,
        orders: [[0, 1, 2, 3, 4, 5], [5, 4, 3, 2, 1, 0], [1, 2, 5, 0, 3, 4], [0, 3, 4, 1, 2, 5],
            [3, 4, 5, 2, 1, 0], [0, 1, 2, winner === 3 ? 4 : 3, 5, winner]],
        controllerPath: [0, winner], assetPath: winner === 3 ? [1, 2, 5] : [1, 2] };
}));
const body = JSON.stringify({ histories, scenarios, controllerForks }, null, 2).replace(/\{\n\s+"order": \[([\s\S]*?)\],\n\s+"expected": \[([\s\S]*?)\]\n\s+\}/g,
    (_, order, expected) => JSON.stringify({ order: JSON.parse('[' + order + ']'), expected: JSON.parse('[' + expected + ']') }));
writeFileSync('tests/convergence/vectors.json', body + '\n');
for (const v of vectors) console.log(v.name, v.cases.length, 'orders;', new Set(v.cases.map(c => c.expected.join(','))).size, 'expected outcomes');
