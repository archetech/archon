// Synthetic signed counterexample: retained hints must not select chain positions.
import { writeFileSync } from 'node:fs';
import Cipher from '../../packages/cipher/dist/esm/cipher-node.js';
import { generateCID } from '../../packages/ipfs/dist/esm/utils.js';
const cipher = new Cipher();
const keys = [111, 112].map(n => cipher.generateJwk(new Uint8Array(32).fill(n)));
const cid = op => generateCID(op, { canonical: true });
const vectors = [];
for (const legacy of [false, true]) {
    function sign(payload, method, key = 0) {
        const config = { type: legacy ? 'EcdsaSecp256k1Signature2019' : 'DataIntegrityProof',
            ...(!legacy ? { cryptosuite: 'archon-ecdsa-secp256k1-jcs-2026' } : {}),
            created: '2026-09-01T00:00:00Z', verificationMethod: method, proofPurpose: 'capabilityInvocation' };
        const hash = legacy ? cipher.hashJSON(payload) : cipher.hashMessage(Buffer.from(cipher.hashJSON(config) + cipher.hashJSON(payload), 'hex'));
        return { ...payload, proof: { ...config, proofValue: Buffer.from(cipher.signHash(hash, keys[key].privateJwk), 'hex').toString('base64url') } };
    }
    const genesis = sign({ type: 'create', created: '2026-09-01T00:00:00Z', registration: { version: 1, type: 'agent', registry: 'BTC:signet' }, publicJwk: keys[0].publicJwk }, '#key-1');
    const did = 'did:cid:' + await cid(genesis);
    const parent = sign({ type: 'update', did, previd: await cid(genesis), doc: { didDocumentData: { parent: true } } }, did + '#key-1');
    const rotation = sign({ type: 'update', did, previd: await cid(parent), doc: { didDocument: {
        '@context': ['https://www.w3.org/ns/did/v1'], id: did,
        verificationMethod: [{ id: '#key-2', controller: did, type: 'EcdsaSecp256k1VerificationKey2019', publicKeyJwk: keys[1].publicJwk }],
        authentication: ['#key-2'], assertionMethod: ['#key-2'], capabilityInvocation: ['#key-2'],
    } } }, did + '#key-1');
    const asset = sign({ type: 'create', created: '2026-09-01T00:00:00Z', registration: { version: 1, type: 'asset', registry: 'BTC:signet' }, controller: did, data: { state: 'created' } }, did + '#key-2', 1);
    const assetDid = 'did:cid:' + await cid(asset);
    const chain = (operation, index) => ({ operation, registry: 'BTC:signet', time: '2026-09-02T00:00:00Z', ordinal: [100, index, 0], registration: { height: 100, txid: 'tx' + index, batch: 'batch', opidx: 0 } });
    const hint = (operation, index) => ({ operation, registry: 'hyperswarm', time: operation.proof.created, ordinal: [index] });
    vectors.push({ legacy, did, assetDid, ids: await Promise.all([genesis, parent, rotation, asset].map(cid)),
        block: { height: 100, hash: 'block', time: Date.parse('2026-09-02T00:00:00Z') / 1000 },
        events: [hint(genesis, 0), hint(parent, 1), chain(rotation, 10), chain(genesis, 30), chain(parent, 40), chain(rotation, 50), chain(asset, 45), chain(asset, 35)],
        // The asset's anchor at 35 is invalid: the predecessor at 40 is beyond
        // the controller cutoff, so the new key is not yet authorizing there.
        orders: [[0, 1, 2, 3, 4, 5, 6, 7], [1, 0, 2, 3, 4, 5, 6, 7], [7, 6, 5, 4, 3, 2, 1, 0],
            [6, 7, 2, 5, 1, 0, 4, 3], [3, 4, 5, 6, 1, 0, 7, 2], [5, 4, 3, 2, 1, 0, 6, 7]] });
}
writeFileSync('tests/convergence/chain-anchor-vectors.json', JSON.stringify(vectors, null, 2) + '\n');
