import { writeFileSync } from 'node:fs';
import Cipher from '../../packages/cipher/dist/esm/cipher-node.js';
import { generateCID } from '../../packages/ipfs/dist/esm/utils.js';
const cipher = new Cipher();
const key = cipher.generateJwk(new Uint8Array(32).fill(113));
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
    const genesis = sign({ type: 'create', created: '2026-09-01T00:00:00Z', registration: { version: 1, type: 'agent', registry: 'BTC:signet' }, publicJwk: key.publicJwk }, '#key-1');
    const did = 'did:cid:' + await cid(genesis);
    const update = (previd, state) => sign({ type: 'update', did, previd, doc: { didDocumentData: { state } } }, did + '#key-1');
    const siblings = [update(await cid(genesis), 'one'), update(await cid(genesis), 'two')];
    const pairs = await Promise.all(siblings.map(async op => [await cid(op), op]));
    pairs.sort(([a], [b]) => a < b ? -1 : 1);
    const [a, b] = pairs.map(([, op]) => op);
    const operations = [genesis, a, b, update(await cid(a), 'a-child'), update(await cid(b), 'b-child')];
    const ids = await Promise.all(operations.map(cid));
    const hint = (operation, index) => ({ operation, registry: 'hyperswarm', time: operation.proof.created, ordinal: [index] });
    const chain = (operation, index) => ({ operation, registry: 'BTC:signet', time: '2026-09-02T00:00:00Z', ordinal: [100, index, 0], registration: { height: 100, txid: 'tx' + index, batch: 'batch', opidx: 0 } });
    for (const mode of ['provisional', 'chain-priority', 'earlier-repeat']) {
        const events = operations.map(hint);
        events.push(chain(genesis, 40));
        if (mode !== 'provisional') events.push(chain(a, 50), chain(b, 30));
        if (mode === 'earlier-repeat') events.push(chain(a, 10));
        const all = events.map((_, i) => i);
        const orders = [all, all.slice().reverse(), [4, 3, 2, 1, 0, ...all.slice(5)],
            [...all.slice(5), 4, 3, 2, 1, 0], [2, 4, 0, 1, 3, ...all.slice(5).reverse()],
            [1, 3, 0, 2, 4, ...all.slice(5)]];
        const expected = mode === 'chain-priority' ? [0, 2, 4] : [0, 1, 3];
        vectors.push({ legacy, mode, did, operations, ids, events, orders, expected,
            block: { height: 100, hash: 'block', time: Date.parse('2026-09-02T00:00:00Z') / 1000 } });
    }
}
writeFileSync('tests/convergence/chain-successor-vectors.json', JSON.stringify(vectors, null, 2) + '\n');
