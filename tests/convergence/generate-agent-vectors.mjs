// Synthetic keys only. Generates signed predecessor-key and deletion evidence.
import { writeFileSync } from 'node:fs';
import Cipher from '../../packages/cipher/dist/esm/cipher-node.js';
import { generateCID } from '../../packages/ipfs/dist/esm/utils.js';
import { permutations } from './model.mjs';
const cipher = new Cipher();
const keys = [81, 82, 83].map(n => cipher.generateJwk(new Uint8Array(32).fill(n)));
const cid = op => generateCID(op, { canonical: true });
const time = n => new Date(Date.UTC(2026, 8, 1, 0, 0, n)).toISOString();
const histories = [];
for (const legacy of [true, false]) {
    function sign(payload, signer, second, create = false) {
        const config = { type: legacy ? 'EcdsaSecp256k1Signature2019' : 'DataIntegrityProof',
            ...(!legacy ? { cryptosuite: 'archon-ecdsa-secp256k1-jcs-2026' } : {}),
            created: time(second), verificationMethod: create ? '#key-1' : `${did}#key-${signer + 1}`,
            proofPurpose: legacy ? 'authentication' : 'capabilityInvocation' };
        const hash = legacy ? cipher.hashJSON(payload)
            : cipher.hashMessage(Buffer.from(cipher.hashJSON(config) + cipher.hashJSON(payload), 'hex'));
        return { ...payload, proof: { ...config, proofValue: Buffer.from(cipher.signHash(hash, keys[signer].privateJwk), 'hex').toString('base64url') } };
    }
    const create = sign({ type: 'create', created: time(0),
        registration: { version: 1, type: 'agent', registry: 'hyperswarm' }, publicJwk: keys[0].publicJwk }, 0, 0, true);
    const did = 'did:cid:' + await cid(create);
    const rotationDoc = key => ({ didDocument: {
        '@context': ['https://www.w3.org/ns/did/v1'], id: did,
        verificationMethod: [{ id: `#key-${key + 1}`, controller: did, type: 'EcdsaSecp256k1VerificationKey2019', publicKeyJwk: keys[key].publicJwk }],
        authentication: [`#key-${key + 1}`], assertionMethod: [`#key-${key + 1}`], capabilityInvocation: [`#key-${key + 1}`],
    } });
    const ops = [create];
    const addUpdate = async (parent, signer, doc, second) => {
        ops.push(sign({ type: 'update', did, previd: await cid(ops[parent]), doc }, signer, second));
    };
    const data = state => ({ didDocumentData: { state } });
    await addUpdate(0, 0, rotationDoc(1), 1); // 1: valid rotation A
    await addUpdate(0, 0, rotationDoc(2), 2); // 2: competing valid rotation B
    await addUpdate(1, 1, data('after-A'), 3); // 3
    await addUpdate(2, 2, data('after-B'), 4); // 4
    await addUpdate(1, 0, data('stale-key'), 5); // 5: old key cannot sign after A
    await addUpdate(0, 1, rotationDoc(1), 6); // 6: proposed key cannot authorize itself
    await addUpdate(6, 1, data('invalid-ancestor'), 7); // 7
    // Ensure the data update is preferred over deletion, exercising replacement
    // of an already-deleted branch through its still-live predecessor.
    const preferred = await cid(ops[3]);
    let deletion;
    for (let second = 20; second < 1000; second++) {
        const candidate = sign({ type: 'delete', did, previd: await cid(ops[1]) }, 1, second);
        if (preferred < await cid(candidate)) { deletion = candidate; break; }
    }
    if (!deletion) throw new Error('Could not construct the deletion sibling ordering');
    ops.push(deletion); // 8
    await addUpdate(8, 1, data('after-deletion'), 10); // 9: terminal predecessor
    ops.push(sign({ type: 'delete', did, previd: await cid(ops[1]) }, 0, 11)); // 10: stale-key delete
    await addUpdate(2, 1, data('wrong-branch-key'), 12); // 11
    const ids = await Promise.all(ops.map(cid));
    const parents = ops.map(op => op.previd ? ids.indexOf(op.previd) : null);
    const actions = ops.map(op => op.type === 'delete' ? 'delete' : op.doc?.didDocument
        ? keys.findIndex(key => JSON.stringify(key.publicJwk) === JSON.stringify(op.doc.didDocument.verificationMethod[0].publicKeyJwk)) : 'keep');
    // Oracle includes method selection as well as verification by the public key.
    const validBy = ops.map(op => {
        const { proof, ...payload } = op;
        const { proofValue, ...config } = proof;
        const hash = legacy ? cipher.hashJSON(payload)
            : cipher.hashMessage(Buffer.from(cipher.hashJSON(config) + cipher.hashJSON(payload), 'hex'));
        return keys.map((key, index) => proof.verificationMethod === (op.type === 'create' ? '#key-1' : `${did}#key-${index + 1}`)
            && cipher.verifySig(hash, Buffer.from(proofValue, 'base64url').toString('hex'), key.publicJwk));
    });
    const states = [];
    for (const [i, op] of ops.entries()) {
        if (i === 0) { states.push(0); continue; }
        const before = states[parents[i]];
        states.push(typeof before !== 'number' || !validBy[i][before] ? null
            : op.type === 'delete' ? 'deleted' : actions[i] === 'keep' ? before : actions[i]);
    }
    const scenarios = [
        ['competing-key-branches', [0, 1, 2, 3, 4]],
        ['stale-update-key', [0, 1, 3, 5]],
        ['self-signed-rotation', [0, 6, 7]],
        ['terminal-deletion', [0, 1, 8, 9]],
        ['replace-deleted-branch', [0, 1, 8, 3]],
        ['stale-delete-key', [0, 1, 10]],
        ['wrong-branch-key', [0, 2, 11, 4]],
    ].map(([name, evidence]) => {
        const path = [0];
        for (;;) {
            const children = evidence.filter(i => states[i] !== null && parents[i] === path.at(-1))
                .sort((a, b) => ids[a] < ids[b] ? -1 : 1);
            if (!children.length) break;
            path.push(children[0]);
        }
        return { name, orders: permutations(evidence), expected: path, finalState: states[path.at(-1)] };
    });
    histories.push({ legacy, did, operations: ops, keys: keys.map(key => key.publicJwk), ids, parents, actions, validBy, states, scenarios });
}
writeFileSync('tests/convergence/agent-vectors.json', JSON.stringify(histories, null, 2).replace(/\[\s+([\d,\s]+)\]/g, (_, values) => '[' + values.replace(/\s+/g, '') + ']') + '\n');
console.log(`${histories.reduce((n, h) => n + h.scenarios.reduce((m, s) => m + s.orders.length, 0), 0)} signed agent authorization traces`);
