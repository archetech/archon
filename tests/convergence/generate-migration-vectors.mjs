import { writeFileSync } from 'node:fs';
import Cipher from '../../packages/cipher/dist/esm/cipher-node.js';
import { generateCID } from '../../packages/ipfs/dist/esm/utils.js';
import { migrationProjection } from './migration-model.mjs';
const cipher = new Cipher();
const key = cipher.generateJwk(new Uint8Array(32).fill(131));
const cid = op => generateCID(op, { canonical: true });
const vectors = [];
for (const legacy of [false, true]) {
    function sign(payload, method) {
        const config = { type: legacy ? 'EcdsaSecp256k1Signature2019' : 'DataIntegrityProof',
            ...(!legacy ? { cryptosuite: 'archon-ecdsa-secp256k1-jcs-2026' } : {}),
            created: '2026-09-01T00:00:00Z', verificationMethod: method, proofPurpose: 'capabilityInvocation' };
        const hash = legacy ? cipher.hashJSON(payload) : cipher.hashMessage(Buffer.from(cipher.hashJSON(config) + cipher.hashJSON(payload), 'hex'));
        return { ...payload, proof: { ...config, proofValue: Buffer.from(cipher.signHash(hash, key.privateJwk), 'hex').toString('base64url') } };
    }
    const registration = registry => ({ version: 1, type: 'agent', registry });
    const genesis = sign({ type: 'create', created: '2026-09-01T00:00:00Z', registration: registration('BTC:signet'), publicJwk: key.publicJwk }, '#key-1');
    const did = 'did:cid:' + await cid(genesis);
    const operations = [genesis];
    const update = async (parent, label, registry) => operations.push(sign({ type: 'update', did, previd: await cid(operations[parent]),
        doc: { didDocumentData: { label }, ...(registry ? { didDocumentRegistration: registration(registry) } : {}) } }, did + '#key-1'));
    await update(0, 'migrate-A', 'ZEC:testnet');
    await update(0, 'migrate-B', 'ETH:sepolia');
    await update(1, 'A-child');
    await update(2, 'B-child');
    await update(3, 'return-A', 'BTC:signet');
    await update(5, 'returned-child');
    const ids = await Promise.all(operations.map(cid));
    const chain = (op, registry, index) => ({ operation: operations[op], registry, time: '2026-09-02T00:00:00Z', ordinal: [100, index, 0],
        registration: { height: 100, txid: registry + '-tx' + index, batch: 'batch', opidx: 0 } });
    for (const mode of ['competing-migrations', 'earlier-migration-return']) {
        const events = operations.map((operation, i) => ({ operation, registry: 'hyperswarm', time: operation.proof.created, ordinal: [i] }));
        events.push(chain(0, 'BTC:signet', 0), chain(1, 'BTC:signet', 50), chain(2, 'BTC:signet', 30),
            chain(1, 'ZEC:testnet', 1), chain(3, 'BTC:signet', 1), chain(3, 'ZEC:testnet', 500),
            chain(4, 'ETH:sepolia', 10), chain(5, 'ZEC:testnet', 600), chain(6, 'BTC:signet', 2));
        if (mode === 'earlier-migration-return') events.push(chain(1, 'BTC:signet', 10));
        const all = events.map((_, i) => i);
        const orders = [all, all.slice().reverse(), [...all.slice(7), ...all.slice(0, 7).reverse()],
            [6, 5, 4, 3, 2, 1, 0, ...all.slice(7)], [2, 4, 0, 1, 3, 5, 6, ...all.slice(7).reverse()],
            [1, 3, 5, 6, 0, 2, 4, ...all.slice(7)]];
        const vector = { legacy, mode, did, operations, ids, events, orders,
            blocks: ['BTC:signet', 'ZEC:testnet', 'ETH:sepolia'].map(registry => ({ registry, block: { height: 100, hash: registry + '-block', time: Date.parse('2026-09-02T00:00:00Z') / 1000 } })) };
        const projection = migrationProjection(vector);
        vectors.push({ ...vector, expected: projection.path, expectedEvents: projection.events, expectedRegistry: projection.registry });
    }
}
writeFileSync('tests/convergence/migration-vectors.json', JSON.stringify(vectors, null, 2) + '\n');
