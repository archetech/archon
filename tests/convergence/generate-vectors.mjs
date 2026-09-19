// Synthetic keys only. Run from the repo root after building Cipher and IPFS.
import { writeFileSync } from 'node:fs';
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
for (const registry of ['hyperswarm', 'BTC:signet']) {
    const create = sign({ type: 'create', created: time(0), registration: { version: 1, type: 'agent', registry }, publicJwk: key.publicJwk }, '#key-1', 0);
    const did = 'did:cid:' + await cid(create);
    const update = async (prev, state, second) => sign({ type: 'update', did, previd: await cid(prev), doc: { didDocumentData: { state } } }, did + '#key-1', second);
    const left = await update(create, 'left', 1);
    const right = await update(create, 'right', 2);
    const child = await update(left, 'left-child', 3);
    const operations = [create, left, right, child];
    const ids = await Promise.all(operations.map(cid));
    const graph = operations.map((op, index) => ({ type: op.type, parent: index === 0 ? undefined : ids.indexOf(op.previd) }));
    for (const receipts of registry === 'hyperswarm' ? ['fresh', 'fixed', 'tied'] : ['fixed']) {
        for (const fork of receipts === 'tied' ? [true] : [false, true]) {
            const inputs = fork ? [0, 1, 2, 3] : [0, 1, 3];
            const cases = receipts === 'tied' ? [
                { order: [0, 1, 2, 3], expected: [0, 1, 3] },
                { order: [0, 2, 1, 3], expected: [0, 2] },
                // Equal ordinals: first applicable sibling, not first received.
                { order: [1, 0, 2, 3], expected: [0, 2] },
            ] : permutations(inputs).map(order => ({ order,
                expected: project(graph, receipts === 'fixed' ? inputs : order) }));
            vectors.push({ name: `${registry}/${receipts}/${fork ? 'fork' : 'linear'}`, registry, receipts, did, operations, ids, cases });
        }
    }
}
// Keep permutation rows compact: evidence is readable without a large fixture diff.
const body = JSON.stringify(vectors, null, 2).replace(/\{\n\s+"order": \[([\s\S]*?)\],\n\s+"expected": \[([\s\S]*?)\]\n\s+\}/g,
    (_, order, expected) => JSON.stringify({ order: JSON.parse('[' + order + ']'), expected: JSON.parse('[' + expected + ']') }));
writeFileSync('tests/convergence/vectors.json', body + '\n');
for (const v of vectors) console.log(v.name, v.cases.length, 'orders;', new Set(v.cases.map(c => c.expected.join(','))).size, 'expected outcomes');
