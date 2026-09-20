// Signed counterexample: A < parent < B by CID, with equal Solana-style positions.
// Reversing genesis/parent gossip changes which sibling first becomes applicable.
import { writeFileSync } from 'node:fs';
import Cipher from '../../packages/cipher/dist/esm/cipher-node.js';
import { generateCID } from '../../packages/ipfs/dist/esm/utils.js';
const cipher = new Cipher();
const key = cipher.generateJwk(new Uint8Array(32).fill(141));
const cid = op => generateCID(op, { canonical: true });
const vectors = [];
for (const legacy of [false, true]) {
    function sign(payload) {
        const config = { type: legacy ? 'EcdsaSecp256k1Signature2019' : 'DataIntegrityProof',
            ...(!legacy ? { cryptosuite: 'archon-ecdsa-secp256k1-jcs-2026' } : {}),
            created: '2026-09-01T00:00:00Z', verificationMethod: '#key-1', proofPurpose: 'capabilityInvocation' };
        const hash = legacy ? cipher.hashJSON(payload)
            : cipher.hashMessage(Buffer.from(cipher.hashJSON(config) + cipher.hashJSON(payload), 'hex'));
        return { ...payload, proof: { ...config, proofValue: Buffer.from(cipher.signHash(hash, key.privateJwk), 'hex').toString('base64url') } };
    }
    const genesis = sign({ type: 'create', created: '2026-09-01T00:00:00Z',
        registration: { version: 1, type: 'agent', registry: 'SOL:devnet' }, publicJwk: key.publicJwk });
    const did = 'did:cid:' + await cid(genesis);
    const parent = sign({ type: 'update', did, previd: await cid(genesis), doc: { didDocumentData: { label: 'parent' } } });
    const parentId = await cid(parent);
    let before, after;
    for (let i = 0; (!before || !after) && i < 1000; i++) {
        const operation = sign({ type: 'update', did, previd: parentId, doc: { didDocumentData: { label: 'child-' + i } } });
        const id = await cid(operation);
        if (id < parentId) before = operation;
        else if (id > parentId) after = operation;
    }
    if (!before || !after) throw new Error('Could not bracket parent CID');
    const operations = [genesis, parent, before, after];
    const ids = await Promise.all(operations.map(cid));
    const hint = operation => ({ operation, registry: 'hyperswarm', time: operation.proof.created, ordinal: [1] });
    const chain = (operation, txid) => ({ operation, registry: 'SOL:devnet', time: '2026-09-02T00:00:00Z',
        ordinal: [100, 0, 0], registration: { height: 100, index: 0, txid, batch: 'batch-' + txid, opidx: 0 } });
    const events = [hint(genesis), hint(parent), chain(before, 'tx-a'), chain(parent, 'tx-p'), chain(after, 'tx-b')];
    vectors.push({ legacy, mode: 'tied-anchored-ordinals', did, operations, ids, events,
        expected: [0, 1, 2], expectedEvents: [0, 3, 2], expectedRegistry: 'SOL:devnet',
        blocks: [{ registry: 'SOL:devnet', block: { height: 100, hash: 'block', time: Date.parse('2026-09-02T00:00:00Z') / 1000 } }],
        orders: [[0, 1, 2, 3, 4], [1, 0, 2, 3, 4], [4, 3, 2, 1, 0], [1, 2, 4, 3, 0]] });
    const earlier = structuredClone(vectors.at(-1));
    earlier.mode = 'ordinal-before-cid';
    earlier.events[2].ordinal = [100, 1, 0];
    earlier.events[2].registration.index = 1;
    earlier.expected = [0, 1, 3];
    earlier.expectedEvents = [0, 3, 4];
    vectors.push(earlier);
}
writeFileSync('tests/convergence/tied-anchor-vectors.json', JSON.stringify(vectors, null, 2) + '\n');
