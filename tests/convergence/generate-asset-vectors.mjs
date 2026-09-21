import { writeFileSync } from 'node:fs';
import { assetGraph, assetScenario } from './asset-model.mjs';
import Cipher from '../../packages/cipher/dist/esm/cipher-node.js';
import { generateCID } from '../../packages/ipfs/dist/esm/utils.js';
const cipher = new Cipher();
const keys = [201, 202, 203, 204].map(n => cipher.generateJwk(new Uint8Array(32).fill(n)));
const cid = operation => generateCID(operation, { canonical: true });
const date = minute => new Date(Date.UTC(2026, 8, 10, 0, minute)).toISOString();
const vectors = [];
for (const legacy of [false, true]) for (const mode of ['hyperswarm', 'pin', 'chain', 'cross-chain', 'local-controllers']) {
    const chain = ['chain', 'cross-chain'].includes(mode);
    const agentRegistry = chain ? mode === 'chain' ? 'BTC:signet' : 'ZEC:testnet' : mode === 'local-controllers' ? 'local' : mode;
    const assetRegistry = chain ? 'BTC:signet' : mode === 'local-controllers' ? 'hyperswarm' : mode;
    const nextRegistry = chain ? 'ETH:sepolia' : assetRegistry;
    function sign(payload, key, minute, method) {
        const config = { type: legacy ? 'EcdsaSecp256k1Signature2019' : 'DataIntegrityProof',
            ...(!legacy ? { cryptosuite: 'archon-ecdsa-secp256k1-jcs-2026' } : {}),
            created: date(minute), verificationMethod: method, proofPurpose: 'capabilityInvocation' };
        const hash = legacy ? cipher.hashJSON(payload)
            : cipher.hashMessage(Buffer.from(cipher.hashJSON(config) + cipher.hashJSON(payload), 'hex'));
        return { ...payload, proof: { ...config, proofValue: Buffer.from(cipher.signHash(hash, keys[key].privateJwk), 'hex').toString('base64url') } };
    }
    const agent = key => sign({ type: 'create', created: date(1),
        registration: { version: 1, type: 'agent', registry: agentRegistry }, publicJwk: keys[key].publicJwk }, key, 1, '#key-1');
    const a = agent(0), b = agent(2), missing = agent(3);
    const aid = 'did:cid:' + await cid(a), bid = 'did:cid:' + await cid(b);
    const missingDid = 'did:cid:' + await cid(missing);
    const rotate = async (genesis, did, oldKey, newKey, minute) => sign({ type: 'update', did, previd: await cid(genesis), doc: {
        didDocument: { id: did, verificationMethod: [{ id: '#key-1', controller: did,
            type: 'EcdsaSecp256k1VerificationKey2019', publicKeyJwk: keys[newKey].publicJwk }, ...(oldKey === 2 ? [{ id: '#key-2', controller: did, type: 'EcdsaSecp256k1VerificationKey2019', publicKeyJwk: keys[oldKey].publicJwk }] : [])] },
    } }, oldKey, minute, did + '#key-1');
    const ar = await rotate(a, aid, 0, 1, 20), br = await rotate(b, bid, 2, 3, 45);
    const ad = sign({ type: 'delete', did: aid, previd: await cid(ar) }, 1, 25, aid + '#key-1');
    const create = sign({ type: 'create', created: date(12),
        registration: { version: 1, type: 'asset', registry: assetRegistry }, controller: aid,
        data: { phase: 'created', kept: 'only until replacement' } }, 0, 12, aid + '#key-1');
    const did = 'did:cid:' + await cid(create);
    const transferPayload = { type: 'update', did, previd: await cid(create), doc: {
        didDocument: { id: did, controller: bid, service: [{ id: '#svc', type: 'Test', serviceEndpoint: 'https://example.test' }] },
        didDocumentData: { phase: 'transferred' },
        didDocumentRegistration: { version: 1, type: 'asset', registry: nextRegistry, validUntil: '2029-01-01T00:00:00Z' },
    } };
    const oldTransfer = sign(transferPayload, 0, 30, aid + '#key-1');
    const freshTransfer = sign(transferPayload, 1, 30, aid + '#key-1');
    const alternatives = await Promise.all(['left', 'right'].map(async label => sign({ type: 'update', did,
        previd: await cid(freshTransfer), doc: { didDocumentData: { branch: label } } }, 2, 40, bid + '#key-1')));
    const alternativeIds = await Promise.all(alternatives.map(cid));
    const winning = alternativeIds[0] < alternativeIds[1] ? 0 : 1;
    const deletion = key => sign({ type: 'delete', did, previd: alternativeIds[winning] }, key, 50, bid + '#key-1');
    const oldDelete = deletion(2), freshDelete = deletion(3);
    const afterDelete = sign({ type: 'update', did, previd: await cid(freshDelete), doc: { didDocumentData: { forbidden: 'after deletion' } } }, 3, 60, bid + '#key-1');
    const badTransfer = controller => sign({ type: 'update', did, previd: transferPayload.previd,
        doc: { didDocument: { id: did, controller } } }, 1, 30, aid + '#key-1');
    const operations = [create, oldTransfer, freshTransfer, ...alternatives, oldDelete, freshDelete, afterDelete,
        badTransfer(missingDid), badTransfer(did),
        sign({ type: 'delete', did, previd: alternativeIds[winning] }, 2, 50, '#key-2'),
        sign(transferPayload, 1, 30, aid + '#missing-method')];
    const ids = await Promise.all(operations.map(cid));
    const events = [], labels = [];
    function add(label, operation, registry, height, index = 0, clock = height) {
        const event = { operation, registry, time: chain || registry === 'local' ? date(clock) : date(clock + 100), ordinal: [height, index, 0] };
        if (chain) event.registration = { height, index, txid: registry + '-tx-' + height, batch: registry + '-batch-' + height, opidx: 0 };
        labels.push(label); events.push(event); return events.length - 1;
    }
    const ag = add('agent-a-genesis', a, agentRegistry, 1), bg = add('agent-b-genesis', b, agentRegistry, 1, 1);
    const ac = add('asset-genesis', create, assetRegistry, 12);
    const al = chain ? add('agent-a-late-anchor', ar, agentRegistry, 35) : undefined;
    const ae = add('agent-a-early-anchor', ar, agentRegistry, 20, 0, mode === 'chain' ? 35 : 20);
    const be = add('agent-b-rotation', br, agentRegistry, 45);
    const assetEvents = operations.slice(1).map((operation, i) => {
        const index = i + 1;
        const height = new Date(operation.proof.created).getUTCMinutes();
        return add('asset-' + index, operation, operation.previd === ids[0] ? assetRegistry : nextRegistry, height,
            index >= 8 ? index : 0);
    });
    // This future-key operation has a valid later chain receipt but an invalid
    // early one. Neither receipt is allowed to synthesize a proof-time verdict.
    if (chain) add('asset-transfer-before-rotation', freshTransfer, assetRegistry, 15);
    const base = [ag, bg, ac, ...assetEvents, ...(al === undefined ? [] : [al])];
    const all = events.map((_, i) => i);
    const hints = operations.map((operation, index) => {
        labels.push('asset-gossip-' + index);
        events.push({ operation, registry: 'hyperswarm', time: operation.proof.created, ordinal: [100 + index] });
        return events.length - 1;
    });
    const deletedOwner = add('agent-a-deleted', ad, agentRegistry, 25, 0, mode === 'chain' ? 40 : 25);
    const stages = [
        { name: 'before-rotation', evidence: base },
        { name: 'after-owner-rotation', evidence: [...base, ae] },
        { name: 'after-recipient-rotation', evidence: all },
        { name: 'deleted-owner', evidence: [...all, deletedOwner] },
        { name: 'provisional-assets', evidence: [ag, bg, ae, be, ...(al === undefined ? [] : [al]), ...hints] },
        { name: 'missing-recipient', evidence: all.filter(i => i !== bg && i !== be) },
        { name: 'missing-transfer', evidence: all.filter(i => ![ids[1], ids[2]].includes(ids[operations.indexOf(events[i].operation)])) },
    ].map(stage => ({ ...stage, orders: [stage.evidence, [...stage.evidence].reverse(),
        [...stage.evidence.filter(i => ![ag, bg, ac].includes(i)), ...stage.evidence.filter(i => [ag, bg, ac].includes(i)), ...stage.evidence.slice(0, 2)]] }));
    const signatures = source => source.map(operation => {
        const { proof, ...payload } = operation;
        const { proofValue, ...config } = proof;
        const hash = legacy ? cipher.hashJSON(payload)
            : cipher.hashMessage(Buffer.from(cipher.hashJSON(config) + cipher.hashJSON(payload), 'hex'));
        return keys.map(key => cipher.verifySig(hash, Buffer.from(proofValue, 'base64url').toString('hex'), key.publicJwk));
    });
    vectors.push({ legacy, mode, did, operations, ids, keys: keys.map(key => key.publicJwk), signatureValid: signatures(operations),
        controllers: [{ did: aid, operations: [a, ar, ad], ids: await Promise.all([a, ar, ad].map(cid)), signatureValid: signatures([a, ar, ad]) },
            { did: bid, operations: [b, br], ids: await Promise.all([b, br].map(cid)), signatureValid: signatures([b, br]) }], events, labels, stages,
        transitions: ['before-rotation', 'after-owner-rotation', 'after-recipient-rotation'],
        blocks: chain ? [...new Map(events.filter(e => e.registration).map(e => [e.registry + '/' + e.registration.height, { registry: e.registry,
            block: { height: e.registration.height, hash: e.registry + '-block-' + e.registration.height,
                time: Date.parse(e.time) / 1000 } }])).values()] : [] });
}
for (const vector of vectors) {
    const graph = assetGraph(vector);
    vector.stages = vector.stages.map(stage => {
        const { expected, components, deactivated } = assetScenario(vector, graph, stage.evidence);
        return { ...stage, expected, components, deactivated };
    });
}
writeFileSync('tests/convergence/asset-vectors.json', JSON.stringify(vectors, null, 2) + '\n');
