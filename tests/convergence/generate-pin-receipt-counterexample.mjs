// Synthetic keys and valid signed operations for the admitted pin-clock audit.
import Cipher from '../../packages/cipher/dist/esm/cipher-node.js';
import { generateCID } from '../../packages/ipfs/dist/esm/utils.js';
import { writeFileSync } from 'node:fs';

const cipher = new Cipher();
const keys = [181, 182].map(i => cipher.generateJwk(new Uint8Array(32).fill(i)));
const date = day => `2026-09-0${day}T00:00:00Z`;
const cid = operation => generateCID(operation, { canonical: true });
function sign(payload, key, day, method) {
    const config = { type: 'DataIntegrityProof', cryptosuite: 'archon-ecdsa-secp256k1-jcs-2026',
        created: date(day), verificationMethod: method, proofPurpose: 'capabilityInvocation' };
    const hash = cipher.hashMessage(Buffer.from(cipher.hashJSON(config) + cipher.hashJSON(payload), 'hex'));
    return { ...payload, proof: { ...config,
        proofValue: Buffer.from(cipher.signHash(hash, keys[key].privateJwk), 'hex').toString('base64url') } };
}
const genesis = sign({ type: 'create', created: date(1),
    registration: { version: 1, type: 'agent', registry: 'pin' }, publicJwk: keys[0].publicJwk }, 0, 1, '#key-1');
const did = 'did:cid:' + await cid(genesis);
const parent = sign({ type: 'update', did, previd: await cid(genesis),
    doc: { didDocumentData: { parent: true } } }, 0, 1, did + '#key-1');
const rotation = sign({ type: 'update', did, previd: await cid(parent), doc: { didDocument: {
    id: did, verificationMethod: [{ id: '#key-1', controller: did,
        type: 'EcdsaSecp256k1VerificationKey2019', publicKeyJwk: keys[1].publicJwk }],
} } }, 0, 2, did + '#key-1');
const asset = sign({ type: 'create', created: date(3),
    registration: { version: 1, type: 'asset', registry: 'hyperswarm' }, controller: did, data: {} }, 0, 3, did + '#key-1');
const hint = operation => ({ registry: 'hyperswarm', time: operation.proof.created, operation });
const events = [hint(genesis), hint(parent),
    { registry: 'pin', ordinal: [1], time: date(2), operation: rotation },
    { registry: 'pin', ordinal: [2], time: date(2), operation: parent },
    { registry: 'pin', ordinal: [3], time: date(4), operation: rotation }];
writeFileSync('tests/convergence/pin-receipt-counterexample.json', JSON.stringify({
    did, assetDid: 'did:cid:' + await cid(asset), asset: hint(asset), events,
    orders: [[0, 1, 2, 3, 4], [1, 0, 2, 3, 4]],
}, null, 2) + '\n');
