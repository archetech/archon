// Synthetic keys and valid signed operations for the same-position chain registration-metadata audit.
import Cipher from '../../packages/cipher/dist/esm/cipher-node.js';
import { generateCID } from '../../packages/ipfs/dist/esm/utils.js';
import { writeFileSync } from 'node:fs';

const cipher = new Cipher();
const keys = [181, 182].map(i => cipher.generateJwk(new Uint8Array(32).fill(i)));
const date = day => `2026-09-0${day}T00:00:00Z`;
const cid = operation => generateCID(operation, { canonical: true });
const vectors = [];
for (const legacy of [false, true]) {
    function sign(payload, key, day, method) {
        const config = { type: legacy ? 'EcdsaSecp256k1Signature2019' : 'DataIntegrityProof',
            ...(!legacy ? { cryptosuite: 'archon-ecdsa-secp256k1-jcs-2026' } : {}),
            created: date(day), verificationMethod: method, proofPurpose: 'capabilityInvocation' };
        const hash = legacy ? cipher.hashJSON(payload)
            : cipher.hashMessage(Buffer.from(cipher.hashJSON(config) + cipher.hashJSON(payload), 'hex'));
        return { ...payload, proof: { ...config,
            proofValue: Buffer.from(cipher.signHash(hash, keys[key].privateJwk), 'hex').toString('base64url') } };
    }
    const genesis = sign({ type: 'create', created: date(1),
        registration: { version: 1, type: 'agent', registry: 'BTC:signet' }, publicJwk: keys[0].publicJwk }, 0, 1, '#key-1');
    const did = 'did:cid:' + await cid(genesis);
    const parent = sign({ type: 'update', did, previd: await cid(genesis),
        doc: { didDocumentData: { parent: true } } }, 0, 1, did + '#key-1');
    const rotation = sign({ type: 'update', did, previd: await cid(parent), doc: { didDocument: {
        id: did, verificationMethod: [{ id: '#key-1', controller: did,
            type: 'EcdsaSecp256k1VerificationKey2019', publicKeyJwk: keys[1].publicJwk }],
    } } }, 0, 2, did + '#key-1');
    const asset = sign({ type: 'create', created: date(1),
        registration: { version: 1, type: 'asset', registry: 'BTC:signet' }, controller: did, data: {} }, 0, 3, did + '#key-1');
    const chain = (operation, height) => ({ registry: 'BTC:signet', time: date(height), ordinal: [height, 0, 0], registration: { height, txid: 'audit', batch: 'audit', opidx: 0 }, operation });
    const lateAsset = sign({ type: 'create', created: date(1),
        registration: { version: 1, type: 'asset', registry: 'BTC:signet' }, controller: did, data: {} }, 0, 1, did + '#key-1');
    const lateComplete = chain(lateAsset, 3);
    const lateIncomplete = { ...lateComplete };
    delete lateIncomplete.registration;
    const plain = chain(genesis, 1);
    delete plain.registration;
    const registered = chain(genesis, 1);
    vectors.push({ legacy, did, assetDid: 'did:cid:' + await cid(asset),
        lateAssetDid: 'did:cid:' + await cid(lateAsset), lateReceipts: [lateIncomplete, lateComplete],
        events: [chain(parent, 1), chain(rotation, 2)], genesis: [plain, registered],
        asset: { ...chain(asset, 1), ordinal: [1, 1, 0] } });

}
writeFileSync('tests/convergence/chain-registration-counterexample.json', JSON.stringify(vectors, null, 2) + '\n');
