// Synthetic keys; unchanged version-1 named-method authorization.
import { writeFileSync } from 'node:fs';
import Cipher from '../../packages/cipher/dist/esm/cipher-node.js';
import { generateCID } from '../../packages/ipfs/dist/esm/utils.js';
import { documentGraph, documentStates } from './document-model.mjs';
const cipher = new Cipher();
const keys = [121, 122, 123].map(n => cipher.generateJwk(new Uint8Array(32).fill(n)));
const cid = op => generateCID(op, { canonical: true });
const vectors = [];
for (const legacy of [false, true]) {
    const hash = (payload, config) => legacy ? cipher.hashJSON(payload)
        : cipher.hashMessage(Buffer.from(cipher.hashJSON(config) + cipher.hashJSON(payload), 'hex'));
    function sign(payload, signer, method) {
        const config = { type: legacy ? 'EcdsaSecp256k1Signature2019' : 'DataIntegrityProof',
            ...(!legacy ? { cryptosuite: 'archon-ecdsa-secp256k1-jcs-2026' } : {}),
            created: '2026-09-01T00:00:00Z', verificationMethod: method, proofPurpose: 'capabilityInvocation' };
        return { ...payload, proof: { ...config, proofValue: Buffer.from(cipher.signHash(hash(payload, config), keys[signer].privateJwk), 'hex').toString('base64url') } };
    }
    const genesis = sign({ type: 'create', created: '2026-09-01T00:00:00Z',
        registration: { version: 1, type: 'agent', registry: 'BTC:signet' }, publicJwk: keys[0].publicJwk }, 0, '#key-1');
    const did = 'did:cid:' + await cid(genesis);
    const document = key => ({ didDocument: { id: did,
        verificationMethod: [{ id: '#key-1', controller: did, type: 'EcdsaSecp256k1VerificationKey2019', publicKeyJwk: keys[key].publicJwk },
            { id: '#key-2', controller: did, type: 'EcdsaSecp256k1VerificationKey2019', publicKeyJwk: keys[key].publicJwk }],
        authentication: ['#key-1'], assertionMethod: [], capabilityInvocation: [] } });
    const operations = [genesis];
    const update = async (parent, signer, named, doc) => operations.push(sign({ type: 'update', did, previd: await cid(operations[parent]), doc }, signer, did + '#key-' + named));
    await update(0, 0, 1, document(1)); // A: rotates method 1 and introduces method 2 with key A
    await update(0, 0, 1, document(2)); // B: same method names, key B
    await update(1, 1, 2, { didDocumentData: { state: 'A' } });
    await update(2, 2, 2, { didDocumentData: { state: 'B' } });
    await update(1, 2, 2, { didDocumentData: { state: 'wrong-branch-key' } });
    await update(5, 1, 2, { didDocumentData: { state: 'invalid-ancestor' } });
    operations.push(sign({ type: 'delete', did, previd: await cid(operations[3]) }, 1, did + '#key-2'));
    await update(7, 1, 2, { didDocumentData: { state: 'after-deletion' } });
    const ids = await Promise.all(operations.map(cid));
    const signatureValid = operations.map(({ proof, ...payload }) => {
        const { proofValue, ...config } = proof;
        return keys.map(key => cipher.verifySig(hash(payload, config), Buffer.from(proofValue, 'base64url').toString('hex'), key.publicJwk));
    });
    const base = { legacy, did, operations, ids, keys: keys.map(k => k.publicJwk), signatureValid };
    const states = documentStates(base, documentGraph(base, false, 'BTC:signet'));
    const hint = (operation, index) => ({ operation, registry: 'hyperswarm', time: operation.proof.created, ordinal: [index] });
    const chain = (operation, index) => ({ operation, registry: 'BTC:signet', time: '2026-09-02T00:00:00Z', ordinal: [100, index, 0], registration: { height: 100, txid: 'tx' + index, batch: 'batch', opidx: 0 } });
    for (const mode of ['chain-priority', 'earlier-repeat']) {
        const events = [...operations.map(hint), chain(genesis, 0), chain(operations[1], 50), chain(operations[2], 30), chain(operations[5], 5)];
        if (mode === 'earlier-repeat') events.push(chain(operations[1], 10));
        const all = events.map((_, i) => i);
        const orders = [all, all.slice().reverse(), [...all.slice(9), ...all.slice(0, 9).reverse()],
            [8, 7, 6, 5, 4, 3, 2, 1, 0, ...all.slice(9)],
            [2, 4, 0, 1, 3, 7, 8, 5, 6, ...all.slice(9).reverse()],
            [1, 3, 7, 0, 2, 4, 5, 6, 8, ...all.slice(9)]];
        const expected = mode === 'chain-priority' ? [0, 2, 4] : [0, 1, 3, 7];
        vectors.push({ ...base, states, mode, events, orders, expected, seed: 9,
            block: { height: 100, hash: 'block', time: Date.parse('2026-09-02T00:00:00Z') / 1000 } });
    }
}
writeFileSync('tests/convergence/chain-document-vectors.json', JSON.stringify(vectors, null, 2) + '\n');
