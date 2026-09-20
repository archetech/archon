// Synthetic signed cases for the integrated agent proof, not production keys.
import { writeFileSync } from 'node:fs';
import Cipher from '../../packages/cipher/dist/esm/cipher-node.js';
import { generateCID } from '../../packages/ipfs/dist/esm/utils.js';
import { integratedAgentGraph } from './integrated-agent-model.mjs';
const cipher = new Cipher();
const keys = [161, 162, 163].map(n => cipher.generateJwk(new Uint8Array(32).fill(n)));
const cid = operation => generateCID(operation, { canonical: true });
const date = second => new Date(Date.UTC(2026, 8, 5, 0, 0, second)).toISOString();
const vectors = [];
for (const legacy of [false, true]) for (const middle of ['ZEC:testnet', 'hyperswarm', 'pin']) {
    const registration = registry => ({ version: 1, type: 'agent', registry });
    function sign(payload, key, method, second) {
        const config = { type: legacy ? 'EcdsaSecp256k1Signature2019' : 'DataIntegrityProof',
            ...(!legacy ? { cryptosuite: 'archon-ecdsa-secp256k1-jcs-2026' } : {}),
            created: date(second), verificationMethod: method, proofPurpose: 'capabilityInvocation' };
        const hash = legacy ? cipher.hashJSON(payload)
            : cipher.hashMessage(Buffer.from(cipher.hashJSON(config) + cipher.hashJSON(payload), 'hex'));
        return { ...payload, proof: { ...config,
            proofValue: Buffer.from(cipher.signHash(hash, keys[key].privateJwk), 'hex').toString('base64url') } };
    }
    const genesis = sign({ type: 'create', created: date(0), registration: registration('BTC:signet'),
        publicJwk: keys[0].publicJwk }, 0, '#key-1', 0);
    const did = 'did:cid:' + await cid(genesis);
    const document = key => ({ id: did, verificationMethod: [{ id: '#key-' + (key + 1),
        controller: did, type: 'EcdsaSecp256k1VerificationKey2019', publicKeyJwk: keys[key].publicJwk }],
    service: [{ id: '#profile', type: 'Profile', serviceEndpoint: 'https://example.org/' + key }] });
    const operations = [genesis];
    const update = async (parent, signer, doc) => operations.push(sign({ type: 'update', did,
        previd: await cid(operations[parent]), doc }, signer, did + '#key-' + (signer + 1), operations.length));
    await update(0, 0, { didDocument: document(1), didDocumentRegistration: registration(middle),
        didDocumentData: { retained: true, removed: true } }); // 1 combined replacement/migration
    await update(1, 1, { didDocumentData: { retained: false } }); // 2 whole data replacement
    await update(1, 0, { didDocumentData: { invalid: 'retired-key' } }); // 3
    await update(0, 1, { didDocument: document(1), didDocumentRegistration: registration(middle) }); // 4 proposed key
    await update(2, 1, { didDocument: document(2), didDocumentRegistration: registration('BTC:signet') }); // 5 return
    operations.push(sign({ type: 'delete', did, previd: await cid(operations[5]) }, 2, did + '#key-3', 6));
    await update(6, 2, { didDocumentData: { invalid: 'deleted-parent' } }); // 7
    await update(0, 0, { didDocument: document(2), didDocumentRegistration: registration('ETH:sepolia') }); // 8 fork
    await update(8, 2, { didDocumentData: { fork: true } }); // 9
    const ids = await Promise.all(operations.map(cid));
    const signatureValid = operations.map(({ proof, ...payload }) => {
        const { proofValue, ...config } = proof;
        const hash = legacy ? cipher.hashJSON(payload)
            : cipher.hashMessage(Buffer.from(cipher.hashJSON(config) + cipher.hashJSON(payload), 'hex'));
        return keys.map(key => cipher.verifySig(hash, Buffer.from(proofValue, 'base64url').toString('hex'), key.publicJwk));
    });
    const expectedRegistry = ['BTC:signet', 'BTC:signet', middle, middle, 'BTC:signet', middle,
        'BTC:signet', 'BTC:signet', 'BTC:signet', 'ETH:sepolia'];
    const hint = operation => ({ operation, registry: 'hyperswarm', time: operation.proof.created, ordinal: [0] });
    const anchor = (operation, registry, index) => ({ operation, registry, time: date(60), ordinal: [100, index, 0],
        registration: { height: 100, index, txid: 'tx-' + index, batch: 'batch-' + index, opidx: 0 } });
    const events = operations.map(hint);
    operations.forEach((operation, i) => {
        if (expectedRegistry[i] === 'pin') {
            // Pin confirmation envelopes have no chain clock. Repeated receipt
            // times must normalize to the complete operation's proof time.
            events.push({ operation, registry: 'pin', time: date(90), ordinal: [i] });
            events.push({ operation, registry: 'pin', time: date(120), ordinal: [i + 20] });
        } else if (expectedRegistry[i] !== 'hyperswarm') {
            events.push(anchor(operation, expectedRegistry[i], i + 10));
        }
    });
    // Wrong-registry hints and repeated anchors retain distinct evidence identities.
    events.push(anchor(operations[2], 'ETH:sepolia', 1));
    const laterAnchor = anchor(operations[1], 'BTC:signet', 1);
    laterAnchor.ordinal[0] = 101;
    laterAnchor.registration.height = 101;
    laterAnchor.time = date(120);
    events.push(laterAnchor);
    const earlierFork = events.length;
    events.push(anchor(operations[8], 'BTC:signet', 2));
    const tiedFork = events.length;
    events.push(anchor(operations[8], 'BTC:signet', 11));
    const scenarios = [
        ['live-return', [0, 1, 2, 3, 4, 5, 8, 9], [0, 1, 2, 5]],
        ['deletion', operations.map((_, i) => i), [0, 1, 2, 5, 6]],
        ['earlier-anchor', [0, 1, 2, 5, 8, 9], [0, 8, 9]],
        ['tied-anchor', [0, 1, 2, 5, 8, 9], ids[1] < ids[8] ? [0, 1, 2, 5] : [0, 8, 9]],
        ['provisional-only', [0, 1, 2, 5, 8, 9], ids[1] < ids[8] ? [0, 1, 2, 5] : [0, 8, 9]],
        ['unconfirmed-gap', [0, 1, 2, 5], [0, 1, 2, 5]],
        ['missing-predecessor', [0, 2, 3, 4, 5, 6, 7], [0]],
    ].map(([name, retained, expected]) => {
        const evidence = events.flatMap((event, i) => retained.some(index => JSON.stringify(operations[index]) === JSON.stringify(event.operation)) && (i !== earlierFork || name === 'earlier-anchor')
            && (i !== tiedFork || name === 'tied-anchor')
            && (name !== 'provisional-only' || i < operations.length)
            && (name !== 'unconfirmed-gap' || i < operations.length || event.operation !== operations[1]) ? [i] : []);
        return { name, expected, orders: [evidence, [...evidence.slice().reverse(), evidence[0]],
            [...evidence.filter(i => events[i].operation.type !== 'create'),
                ...evidence.filter(i => events[i].operation.type === 'create')]] };
    });
    vectors.push({ legacy, middle, did, operations, ids, keys: keys.map(key => key.publicJwk),
        signatureValid, events, scenarios,
        blocks: ['BTC:signet', 'ZEC:testnet', 'ETH:sepolia'].flatMap(registry => [100, 101].map(height => ({ registry,
            block: { height, hash: registry + '-block-' + height, time: Date.parse(date(height === 100 ? 60 : 120)) / 1000 } }))) });
}
for (const vector of vectors) {
    const graph = integratedAgentGraph(vector);
    vector.scenarios.forEach((scenario, i) => { scenario.components = graph.scenarios[i].components;
        scenario.receiptView = graph.scenarios[i].receiptView;
        scenario.deactivated = vector.operations[scenario.expected.at(-1)].type === 'delete'; });
}
writeFileSync('tests/convergence/integrated-agent-vectors.json', JSON.stringify(vectors, null, 2) + '\n');
