// Signed A3 counterexample: provisional suffix metadata must not choose controller cutoffs.
import { writeFileSync } from 'node:fs';
import Cipher from '../../packages/cipher/dist/esm/cipher-node.js';
import { generateCID } from '../../packages/ipfs/dist/esm/utils.js';
const cipher = new Cipher();
const keys = [151, 152].map(i => cipher.generateJwk(new Uint8Array(32).fill(i)));
const cid = op => generateCID(op, { canonical: true });
const date = n => '2026-09-0' + n + 'T00:00:00Z';
const vectors = [];
for (const legacy of [false, true]) for (const origin of ['hyperswarm', 'wrong-genesis', 'pin']) {
    function sign(payload, key, created, method = '#key-1') {
        const config = { type: legacy ? 'EcdsaSecp256k1Signature2019' : 'DataIntegrityProof',
            ...(!legacy ? { cryptosuite: 'archon-ecdsa-secp256k1-jcs-2026' } : {}),
            created, verificationMethod: method, proofPurpose: 'capabilityInvocation' };
        const hash = legacy ? cipher.hashJSON(payload)
            : cipher.hashMessage(Buffer.from(cipher.hashJSON(config) + cipher.hashJSON(payload), 'hex'));
        return { ...payload, proof: { ...config, proofValue: Buffer.from(cipher.signHash(hash, keys[key].privateJwk), 'hex').toString('base64url') } };
    }
    const genesis = sign({ type: 'create', created: date(1),
        registration: { version: 1, type: 'agent', registry: origin === 'pin' ? 'pin' : 'hyperswarm' }, publicJwk: keys[0].publicJwk }, 0, date(1));
    const did = 'did:cid:' + await cid(genesis);
    const migration = sign({ type: 'update', did, previd: await cid(genesis), doc: {
        didDocument: { id: did, verificationMethod: [{ id: '#key-1', controller: did,
            type: 'EcdsaSecp256k1VerificationKey2019', publicKeyJwk: keys[1].publicJwk }] },
        didDocumentRegistration: { version: 1, type: 'agent', registry: 'ZEC:testnet' },
    } }, 0, date(2));
    const update = sign({ type: 'update', did, previd: await cid(migration), doc: { didDocumentData: { label: 'update' } } }, 1, date(3));
    const asset = sign({ type: 'create', created: date(1), registration: { version: 1, type: 'asset', registry: 'BTC:signet' },
        controller: did, data: { label: 'old-key' } }, 0, date(1), did + '#key-1');
    const assetDid = 'did:cid:' + await cid(asset);
    const hint = operation => ({ operation, registry: 'hyperswarm', time: operation.proof.created, ordinal: [1] });
    const chain = (operation, registry, height, index) => ({ operation, registry, time: height === 99 ? date(4) : date(5),
        ordinal: [height, index, 0], registration: { height, index, txid: 'tx-' + height + '-' + index, batch: 'batch', opidx: 0 } });
    const modes = origin === 'hyperswarm' ? ['wrong-registry-suffix', 'confirmed-suffix', 'missing-registration']
        : origin === 'pin' ? ['confirmed-suffix'] : ['wrong-registry-suffix'];
    for (const mode of modes) {
        const events = [hint(genesis), hint(migration), hint(update), chain(migration, 'BTC:signet', 99, 10),
            chain(update, 'BTC:signet', 99, 20), chain(asset, 'BTC:signet', 100, 1)];
        if (origin === 'wrong-genesis') events[0] = chain(genesis, 'BTC:signet', 99, 0);
        if (origin === 'pin') { events[0].registry = 'pin'; events[1].registry = 'pin'; }
        if (mode !== 'wrong-registry-suffix') {
            const confirming = chain(update, 'ZEC:testnet', 99, 30);
            if (mode === 'missing-registration') delete confirming.registration;
            events.push(confirming);
        }
        const suffix = mode === 'wrong-registry-suffix' ? [] : [6];
        vectors.push({ legacy, mode: origin === 'hyperswarm' ? mode : origin + '-' + mode, did, assetDid, events, controllerIds: await Promise.all([genesis, migration, update].map(cid)),
            confirmedVersions: mode === 'confirmed-suffix' ? '3' : '2', assetAccepted: mode !== 'confirmed-suffix',
            orders: [[0, 1, 2, 3, 4, 5, ...suffix], [2, 1, 0, 3, 4, 5, ...suffix]],
            blocks: ['BTC:signet', 'ZEC:testnet'].flatMap(registry => [99, 100].map(height => ({ registry,
                block: { height, hash: registry + '-block-' + height, time: Date.parse(height === 99 ? date(4) : date(5)) / 1000 } }))) });
    }
}
writeFileSync('tests/convergence/controller-view-vectors.json', JSON.stringify(vectors, null, 2) + '\n');
