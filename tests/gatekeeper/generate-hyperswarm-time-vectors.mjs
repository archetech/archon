// Synthetic signing keys only. Run from the root after building packages.
import { writeFileSync } from 'node:fs';
import Cipher from '../../packages/cipher/dist/esm/cipher-node.js';
import { generateCID } from '../../packages/ipfs/dist/esm/utils.js';
const cipher = new Cipher();
const keys = [61, 62].map(n => cipher.generateJwk(new Uint8Array(32).fill(n)));
const cid = op => generateCID(JSON.parse(cipher.canonicalizeJSON(op)));
const time = ms => `2026-09-04T00:51:32.${String(ms).padStart(3, '0')}Z`;
function sign(op, method, ms, legacy, key = keys[0]) {
    const config = { type: legacy ? 'EcdsaSecp256k1Signature2019' : 'DataIntegrityProof',
        ...(!legacy ? { cryptosuite: 'archon-ecdsa-secp256k1-jcs-2026' } : {}),
        created: typeof ms === 'string' ? ms : time(ms), verificationMethod: method, proofPurpose: legacy ? 'authentication' : 'capabilityInvocation' };
    const hash = legacy ? cipher.hashJSON(op) : cipher.hashMessage(Buffer.from(cipher.hashJSON(config) + cipher.hashJSON(op), 'hex'));
    return { ...op, proof: { ...config, proofValue: Buffer.from(cipher.signHash(hash, key.privateJwk), 'hex').toString('base64url') } };
}
const vectors = [];
for (const legacy of [true, false]) {
    const agent = sign({ type: 'create', created: time(0), registration: { version: 1, type: 'agent', registry: 'hyperswarm' }, publicJwk: keys[0].publicJwk }, '#key-1', 0, legacy);
    const controller = 'did:cid:' + await cid(agent);
    const assetCreate = sign({ type: 'create', created: time(120), registration: { version: 1, type: 'asset', registry: 'hyperswarm' }, controller, data: { state: 'created' } }, controller + '#key-1', 120, legacy);
    const asset = 'did:cid:' + await cid(assetCreate);
    const assetUpdate = sign({ type: 'update', did: asset, previd: await cid(assetCreate), doc: { didDocumentData: { state: 'updated' } } }, controller + '#key-1', 400, legacy);
    const assetDelete = sign({ type: 'delete', did: asset, previd: await cid(assetUpdate) }, controller + '#key-1', 700, legacy);
    const lateAssetDelete = sign({ type: 'delete', did: asset, previd: await cid(assetUpdate) }, controller + '#key-1', 900, legacy);
    const controllerDelete = sign({ type: 'delete', did: controller, previd: await cid(agent) }, controller + '#key-1', 807, legacy);
    const controllerRotation = sign({ type: 'update', did: controller, previd: await cid(agent), doc: { didDocument: {
        '@context': ['https://www.w3.org/ns/did/v1'], id: controller,
        verificationMethod: [{ id: '#key-2', controller, type: 'EcdsaSecp256k1VerificationKey2019', publicKeyJwk: keys[1].publicJwk }],
        authentication: ['#key-2'], assertionMethod: ['#key-2'], capabilityInvocation: ['#key-2'],
    } } }, controller + '#key-1', 807, legacy);
    const afterRotation = sign({ type: 'update', did: asset, previd: await cid(assetUpdate), doc: { didDocumentData: { state: 'rotated' } } }, controller + '#key-2', 900, legacy, keys[1]);
    // A later predecessor can have an earlier claimed time. Do not sort by it
    // or skip an excluded predecessor when choosing a historical prefix.
    const backdatedSuccessor = sign({ type: 'update', did: controller, previd: await cid(controllerRotation), doc: { didDocumentData: { state: 'backdated' } } }, controller + '#key-2', 500, legacy, keys[1]);
    const { proof: rotationProof, ...rotationPayload } = controllerRotation;
    void rotationProof;
    const leapRotation = sign(rotationPayload, controller + '#key-1', '2026-09-04T00:51:60Z', legacy);
    vectors.push({ leapRotation, legacy, controller, asset, agent, assetCreate, assetUpdate, assetDelete, lateAssetDelete, controllerDelete, controllerRotation, afterRotation, backdatedSuccessor });
}
writeFileSync('tests/gatekeeper/hyperswarm-time-vectors.json', JSON.stringify(vectors, null, 2) + '\n');
