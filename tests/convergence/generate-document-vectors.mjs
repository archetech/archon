// Synthetic keys only; version-1 operation authorization, without new permissions.
import { writeFileSync } from 'node:fs';
import Cipher from '../../packages/cipher/dist/esm/cipher-node.js';
import { generateCID } from '../../packages/ipfs/dist/esm/utils.js';
import { permutations } from './model.mjs';
import { documentGraph, documentStates } from './document-model.mjs';
const cipher = new Cipher();
const keys = [91, 92, 93].map(n => cipher.generateJwk(new Uint8Array(32).fill(n)));
const cid = op => generateCID(op, { canonical: true });
const time = n => new Date(Date.UTC(2026, 8, 2, 0, 0, n)).toISOString();
const histories = [];
for (const legacy of [true, false]) {
    function sign(payload, signer, method, second, create = false) {
        const config = { type: legacy ? 'EcdsaSecp256k1Signature2019' : 'DataIntegrityProof',
            ...(!legacy ? { cryptosuite: 'archon-ecdsa-secp256k1-jcs-2026' } : {}),
            created: time(second), verificationMethod: create ? '#key-1' : `${did}#key-${method}`,
            proofPurpose: legacy ? 'authentication' : 'capabilityInvocation' };
        const hash = legacy ? cipher.hashJSON(payload)
            : cipher.hashMessage(Buffer.from(cipher.hashJSON(config) + cipher.hashJSON(payload), 'hex'));
        return { ...payload, proof: { ...config, proofValue: Buffer.from(cipher.signHash(hash, keys[signer].privateJwk), 'hex').toString('base64url') } };
    }
    const create = sign({ type: 'create', created: time(0),
        registration: { version: 1, type: 'agent', registry: 'hyperswarm' }, publicJwk: keys[0].publicJwk }, 0, 1, 0, true);
    const did = 'did:cid:' + await cid(create);
    const method = (id, key, absolute = false) => ({ id: (absolute ? did : '') + `#key-${id}`, controller: did,
        type: 'EcdsaSecp256k1VerificationKey2019', publicKeyJwk: keys[key].publicJwk });
    const doc = methods => ({ didDocument: {
        '@context': ['https://www.w3.org/ns/did/v1'], id: did, verificationMethod: methods,
        // The second method has no relationship permission. Version 1 accepts it.
        authentication: ['#key-1'], assertionMethod: [], capabilityInvocation: [],
    } });
    const both = doc([method(1, 0), method(2, 1, true)]);
    const replacement = doc([method(1, 0), method(2, 2)]);
    const operations = [create];
    const update = async (parent, signer, named, data) => operations.push(sign({
        type: 'update', did, previd: await cid(operations[parent]), doc: data,
    }, signer, named, operations.length));
    const data = label => ({ didDocumentData: { label } });
    await update(0, 0, 1, both); // 1: add a second method
    await update(1, 1, 2, data('second-key')); // 2: not the first key, no relationship membership
    await update(1, 1, 2, doc([method(2, 1)])); // 3: remove first key, signed by second
    await update(3, 0, 1, data('removed-key')); // 4: rejected
    await update(1, 1, 2, replacement); // 5: same method name, new public key
    await update(5, 2, 2, data('replacement-key')); // 6: accepted
    await update(5, 1, 2, data('old-key')); // 7: rejected
    await update(1, 1, 9, data('missing-method')); // 8: valid signature, wrong method name
    operations.push(sign({ type: 'delete', did, previd: await cid(operations[1]) }, 1, 2, 9));
    await update(9, 1, 2, data('deleted-predecessor')); // 10
    await update(0, 1, 2, both); // 11: new method cannot authorize its own introduction
    await update(11, 1, 2, data('invalid-ancestor')); // 12
    const ids = await Promise.all(operations.map(cid));
    const signatureValid = operations.map(op => {
        const { proof, ...payload } = op;
        const { proofValue, ...config } = proof;
        const hash = legacy ? cipher.hashJSON(payload)
            : cipher.hashMessage(Buffer.from(cipher.hashJSON(config) + cipher.hashJSON(payload), 'hex'));
        return keys.map(key => cipher.verifySig(hash, Buffer.from(proofValue, 'base64url').toString('hex'), key.publicJwk));
    });
    const vector = { legacy, did, operations, ids, keys: keys.map(key => key.publicJwk), signatureValid };
    const graph = documentGraph(vector);
    const states = documentStates(vector, graph);
    const scenarios = [
        ['second-key-without-relationship-membership', [0, 1, 2]],
        ['removed-first-key', [0, 1, 3, 4]],
        ['same-method-new-public-key', [0, 1, 5, 6, 7]],
        ['competing-documents', [0, 1, 3, 5, 6]],
        ['missing-method', [0, 1, 8]],
        ['second-key-deletion', [0, 1, 9, 10]],
        ['self-authorized-method', [0, 11, 12]],
    ].map(([name, evidence]) => {
        const expected = [graph.ranks.indexOf(graph.root)];
        for (;;) {
            const children = evidence.filter(i => states[i] !== null && graph.parents[i] === expected.at(-1)).sort((a, b) => graph.ranks[a] - graph.ranks[b]);
            if (!children.length) break;
            expected.push(children[0]);
        }
        return { name, orders: permutations(evidence), expected, finalState: states[expected.at(-1)] };
    });
    const methodDocuments = [...ids].sort().map(id => {
        const op = operations[ids.indexOf(id)];
        return op.type === 'create' ? [method(1, 0)] : op.doc?.didDocument?.verificationMethod ?? [];
    });
    histories.push({ ...vector, states, methodDocuments, scenarios });
}
writeFileSync('tests/convergence/document-vectors.json', JSON.stringify(histories, null, 2).replace(/\[\s+([\d,\s]+)\]/g, (_, values) => '[' + values.replace(/\s+/g, '') + ']') + '\n');
console.log(`${histories.reduce((n, h) => n + h.scenarios.reduce((m, s) => m + s.orders.length, 0), 0)} signed document authorization traces`);
