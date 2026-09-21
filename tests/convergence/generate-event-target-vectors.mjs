// Synthetic signed histories for the event target admission boundary (#1248).
import { writeFileSync } from 'node:fs';
import Cipher from '../../packages/cipher/dist/esm/cipher-node.js';
import { generateCID } from '../../packages/ipfs/dist/esm/utils.js';

const cipher = new Cipher();
const key = cipher.generateJwk(new Uint8Array(32).fill(191));
const cid = op => generateCID(op, { canonical: true });
const vectors = [];
for (const legacy of [false, true]) {
    for (const prefix of [undefined, 'did:custom']) {
        function sign(payload, method) {
            const config = { type: legacy ? 'EcdsaSecp256k1Signature2019' : 'DataIntegrityProof',
                ...(!legacy ? { cryptosuite: 'archon-ecdsa-secp256k1-jcs-2026' } : {}),
                created: '2026-09-01T00:00:00Z', verificationMethod: method, proofPurpose: 'capabilityInvocation' };
            const hash = legacy ? cipher.hashJSON(payload)
                : cipher.hashMessage(Buffer.from(cipher.hashJSON(config) + cipher.hashJSON(payload), 'hex'));
            return { ...payload, proof: { ...config,
                proofValue: Buffer.from(cipher.signHash(hash, key.privateJwk), 'hex').toString('base64url') } };
        }
        const payload = { type: 'create', created: '2026-09-01T00:00:00Z',
            registration: { version: 1, type: 'agent', registry: 'hyperswarm', ...(prefix ? { prefix } : {}) },
            publicJwk: key.publicJwk };
        const create = sign(payload, '#key-1');
        const did = `${prefix ?? 'did:cid'}:${await cid(create)}`;
        const update = sign({ type: 'update', did, previd: await cid(create),
            doc: { didDocumentData: { '2': 'two', '10': 'ten' } } }, did + '#key-1');
        const deletion = sign({ type: 'delete', did, previd: await cid(update) }, did + '#key-1');
        const other = sign({ ...payload, created: '2026-09-02T00:00:00Z' }, '#key-1');
        const otherDid = `${prefix ?? 'did:cid'}:${await cid(other)}`;
        // Even a signed extraneous creation.did cannot override its content ID.
        const createWithDid = sign({ ...payload, did: otherDid }, '#key-1');
        const operations = [create, update, deletion];
        const aliasDid = `did:alias:${await cid(create)}`;
        const aliasUpdate = sign({ type: 'update', did: aliasDid, previd: await cid(create),
            doc: { didDocumentData: { alias: true } } }, aliasDid + '#key-1');
        vectors.push({ name: `${legacy ? 'legacy' : 'integrity'}/${prefix ?? 'default'}`, did,
            operations, ids: await Promise.all(operations.map(cid)), other, otherDid,
            createWithDid, createWithDidTarget: `${prefix ?? 'did:cid'}:${await cid(createWithDid)}`, aliasDid, aliasUpdate });
    }
}
writeFileSync('tests/convergence/event-target-vectors.json', JSON.stringify(vectors, null, 2) + '\n');
