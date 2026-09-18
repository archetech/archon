// Synthetic keys from generate-history-recovery-vectors.mjs; no production data.
import fs from 'node:fs';
import Cipher from '@didcid/cipher/node';
import { generateCID } from '@didcid/ipfs/utils';
const cipher = new Cipher();
const histories = JSON.parse(fs.readFileSync('tests/gatekeeper/history-recovery-vectors.json', 'utf8'));
const vectors = [];
for (const [index, v] of histories.entries()) {
    const key = cipher.generateJwk(new Uint8Array(32).fill(41 + index * 4));
    // Exercise a signed legacy numeric-key predecessor alias in one case.
    if (index === 0) {
        const sign = async event => {
            const { proof, ...operation } = event.operation;
            operation.proof = { ...proof, proofValue: Buffer.from(cipher.signHash(cipher.hashJSON(operation), key.privateJwk), 'hex').toString('base64url') };
            return { ...event, operation, opid: await generateCID(operation, { canonical: true }) };
        };
        v.old.operation.doc.didDocumentData = { '2': 'two', '10': 'ten' };
        v.old = await sign(v.old);
        v.oldNext.operation.previd = await generateCID(JSON.parse(cipher.canonicalizeJSON(v.old.operation)));
        v.oldNext = await sign(v.oldNext);
    }
    const operation = {
        type: 'update', did: v.asset, previd: v.oldNext.opid,
        doc: { didDocumentData: 'recovered-descendant' },
    };
    operation.proof = {
        ...v.oldNext.operation.proof,
        proofValue: Buffer.from(cipher.signHash(cipher.hashJSON(operation), key.privateJwk), 'hex').toString('base64url'),
    };
    const descendant = {
        ...v.oldNext, operation, opid: await generateCID(operation, { canonical: true }),
        time: '2026-01-01T00:08:20.000Z', ordinal: [500, 0],
        registration: { height: 500, index: 0, txid: 'tx500', batch: 'batch500' },
    };
    const earlier = {
        ...v.old, time: '2026-01-01T00:02:20.000Z', ordinal: [140, 0],
        registration: { height: 140, index: 0, txid: 'tx140', batch: 'batch140' },
    };
    const nextKey = cipher.generateJwk(new Uint8Array(32).fill(42 + index * 4));
    const direct = structuredClone(v.fresh);
    direct.operation.proof.created = direct.time;
    direct.opid = await generateCID(direct.operation, { canonical: true });
    const directSuccessor = structuredClone(v.freshNext);
    directSuccessor.operation.previd = direct.opid;
    const { proof: successorProof, ...unsignedSuccessor } = directSuccessor.operation;
    directSuccessor.operation.proof = { ...successorProof, created: directSuccessor.time,
        proofValue: Buffer.from(cipher.signHash(cipher.hashJSON(unsignedSuccessor), nextKey.privateJwk), 'hex').toString('base64url') };
    directSuccessor.opid = await generateCID(directSuccessor.operation, { canonical: true });
    const directRejected = { ...direct, time: '2026-01-01T00:02:30.000Z', ordinal: [150, 0],
        registration: { ...direct.registration, height: 150, batch: 'batch150', txid: 'tx150' } };
    vectors.push({ registry: v.registry, asset: v.asset, controller: v.controller,
        base: v.base, competitor: v.early, rejected: v.old, successor: v.oldNext,
        rotation: v.rotation, descendant, earlier, direct, directSuccessor, directRejected });
}
fs.writeFileSync('tests/gatekeeper/rejected-branch-vectors.json', JSON.stringify(vectors, null, 2) + '\n');
