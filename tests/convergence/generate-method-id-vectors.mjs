// Signed naming-admission cases; IDs normalize against the document, not its owner.
import { writeFileSync } from 'node:fs';
import Cipher from '../../packages/cipher/dist/esm/cipher-node.js';
import { generateCID } from '../../packages/ipfs/dist/esm/utils.js';
const cipher = new Cipher();
const keys = [181, 182].map(i => cipher.generateJwk(new Uint8Array(32).fill(i)));
const cid = op => generateCID(op, { canonical: true });
const vectors = [];
for (const legacy of [false, true]) {
    function sign(payload, method, key = 0) {
        const config = { type: legacy ? 'EcdsaSecp256k1Signature2019' : 'DataIntegrityProof',
            ...(!legacy ? { cryptosuite: 'archon-ecdsa-secp256k1-jcs-2026' } : {}),
            created: '2026-09-01T00:00:00Z', verificationMethod: method, proofPurpose: 'capabilityInvocation' };
        const hash = legacy ? cipher.hashJSON(payload)
            : cipher.hashMessage(Buffer.from(cipher.hashJSON(config) + cipher.hashJSON(payload), 'hex'));
        return { ...payload, proof: { ...config,
            proofValue: Buffer.from(cipher.signHash(hash, keys[key].privateJwk), 'hex').toString('base64url') } };
    }
    const agent = sign({ type: 'create', created: '2026-09-01T00:00:00Z',
        registration: { version: 1, type: 'agent', registry: 'hyperswarm' }, publicJwk: keys[0].publicJwk }, '#key-1');
    const owner = 'did:cid:' + await cid(agent);
    for (const asset of [false, true]) {
        const create = asset ? sign({ type: 'create', created: agent.created,
            registration: { version: 1, type: 'asset', registry: 'hyperswarm' }, controller: owner }, owner + '#key-1') : agent;
        const did = 'did:cid:' + await cid(create);
        const method = (id, key) => ({ id, controller: did, type: 'EcdsaSecp256k1VerificationKey2019', publicKeyJwk: keys[key].publicJwk });
        const cases = [
            ['literal', [method('#key-1', 0), method('#key-1', 1)], false],
            ['normalized', [method('#key-1', 0), method(did + '#key-1', 1)], false],
            ['same-key-duplicate', [method('#key-1', 0), method(did + '#key-1', 0)], false],
            ['second-method', [method('#key-1', 0), method('#key-2', 1)], true, '#key-2', 1],
            ['shared-key', [method('#key-1', 0), method('#key-2', 0)], true, '#key-2', 0],
            ['rotation', [method('#key-1', 1)], true, '#key-1', 1],
        ];
        for (const [name, methods, accepted, named, key] of cases) {
            for (const reverse of accepted ? [false] : [false, true]) {
                const verificationMethod = reverse ? [...methods].reverse() : methods;
                const update = sign({ type: 'update', did, previd: await cid(create),
                    doc: { didDocument: { id: did, ...(asset ? { controller: owner } : {}), verificationMethod } } }, owner + '#key-1');
                const successor = sign({ type: 'update', did, previd: await cid(update),
                    doc: { didDocumentData: { continued: true } } }, asset ? owner + '#key-1' : did + (named ?? '#key-1'), asset ? 0 : (key ?? 0));
                vectors.push({ name: `${legacy ? 'legacy' : 'integrity'}/${asset ? 'asset' : 'agent'}/${name}/${reverse}`,
                    did, setup: asset ? [agent, create] : [create], update, successor, accepted,
                    ids: await Promise.all([create, ...(accepted ? [update, successor] : [])].map(cid)) });
            }
        }
    }
}
writeFileSync('tests/convergence/method-id-vectors.json', JSON.stringify(vectors, null, 2) + '\n');
