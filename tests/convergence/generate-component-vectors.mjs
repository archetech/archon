// Synthetic keys only; version-1 operation authorization, without new permissions.
import { writeFileSync } from 'node:fs';
import Cipher from '../../packages/cipher/dist/esm/cipher-node.js';
import { generateCID } from '../../packages/ipfs/dist/esm/utils.js';
import { permutations } from './model.mjs';
import { documentStates } from './document-model.mjs';
import { componentGraph, componentStates } from './component-model.mjs';
const cipher = new Cipher();
const keys = [101, 102, 103].map(n => cipher.generateJwk(new Uint8Array(32).fill(n)));
const cid = op => generateCID(op, { canonical: true });
const time = n => new Date(Date.UTC(2026, 8, 3, 0, 0, n)).toISOString();
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
    both.didDocument.service = [{ id: '#profile', type: 'Profile', serviceEndpoint: 'https://example.org/first' }];
    both.didDocument.alsoKnownAs = ['https://example.org/agent'];
    await update(0, 0, 1, { ...both, didDocumentData: { retained: 'one', removed: 'gone' }, didDocumentRegistration: create.registration }); // 1
    await update(1, 1, 2, { didDocumentData: { retained: 'two' } }); // 2: replace data, not field merge
    const serviceOnly = structuredClone(both);
    serviceOnly.didDocument.service = [{ id: '#profile', type: 'Profile', serviceEndpoint: 'https://example.org/next' }];
    delete serviceOnly.didDocument.alsoKnownAs;
    serviceOnly.didDocument.authentication = [];
    await update(1, 1, 2, serviceOnly); // 3: retain data, replace document components
    await update(1, 1, 2, { ...replacement, didDocumentData: {} }); // 4: rotate and clear data
    await update(4, 2, 2, data('new-key')); // 5
    await update(1, 2, 2, { ...replacement, didDocumentData: { invalid: true } }); // 6: proposed key cannot authorize
    await update(6, 2, 2, data('invalid-ancestor')); // 7
    operations.push(sign({ type: 'delete', did, previd: await cid(operations[1]) }, 1, 2, 8));
    await update(2, 1, 2, { didDocumentRegistration: create.registration }); // 9: carry both other components
    await update(1, 1, 2, { ...doc([]), didDocumentData: {} }); // 10: valid terminal empty method list
    await update(10, 1, 2, data('missing-method')); // 11
    const ids = await Promise.all(operations.map(cid));
    const signatureValid = operations.map(op => {
        const { proof, ...payload } = op;
        const { proofValue, ...config } = proof;
        const hash = legacy ? cipher.hashJSON(payload)
            : cipher.hashMessage(Buffer.from(cipher.hashJSON(config) + cipher.hashJSON(payload), 'hex'));
        return keys.map(key => cipher.verifySig(hash, Buffer.from(proofValue, 'base64url').toString('hex'), key.publicJwk));
    });
    const vector = { legacy, did, operations, ids, keys: keys.map(key => key.publicJwk), signatureValid };
    const graph = componentGraph(vector);
    const states = documentStates(vector, graph);
    const fullStates = componentStates(vector, graph);
    const scenarios = [
        ['component-replacement', [0, 1, 2, 9]],
        ['document-only-carries-data', [0, 1, 3]],
        ['combined-rotation-and-data', [0, 1, 4, 5]],
        ['competing-combined-updates', [0, 1, 2, 4, 5]],
        ['reject-proposed-key-and-descendant', [0, 1, 6, 7]],
        ['deletion-clears-components', [0, 1, 8]],
        ['empty-method-list', [0, 1, 10, 11]],
    ].map(([name, evidence]) => {
        const expected = [graph.ranks.indexOf(graph.root)];
        for (;;) {
            const children = evidence.filter(i => states[i] !== null && graph.parents[i] === expected.at(-1)).sort((a, b) => graph.ranks[a] - graph.ranks[b]);
            if (!children.length) break;
            expected.push(children[0]);
        }
        return { name, orders: permutations(evidence), expected, finalState: states[expected.at(-1)], components: fullStates[expected.at(-1)] };
    });
    histories.push({ ...vector, states, scenarios });
}
writeFileSync('tests/convergence/component-vectors.json', JSON.stringify(histories, null, 2).replace(/\[\s+([\d,\s]+)\]/g, (_, values) => '[' + values.replace(/\s+/g, '') + ']') + '\n');
console.log(`${histories.reduce((n, h) => n + h.scenarios.reduce((m, s) => m + s.orders.length, 0), 0)} signed component traces`);
