// Signed operations whose proofValue or key coordinates carry base64 padding,
// which both Gatekeepers refuse: the specification gives unpadded base64url.
// Each padded value decodes to the same bytes as its unpadded form, so every
// signature here verifies under a decoder that drops the padding.
//
// Synthetic signing key only. Run from the repository root after building packages.
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import Cipher from '../../packages/cipher/dist/esm/cipher-node.js';
import { CID } from 'multiformats/cid';
import { create } from 'multiformats/hashes/digest';

const cipher = new Cipher();
const key = cipher.generateJwk(new Uint8Array(32).fill(43));
const canonical = operation => CID.createV1(0x0200,
    create(0x12, createHash('sha256').update(cipher.canonicalizeJSON(operation)).digest())).toString();

function sign(operation, verificationMethod, created = '2026-11-18T12:00:00.000Z') {
    const proof = {
        type: 'DataIntegrityProof',
        cryptosuite: 'archon-ecdsa-secp256k1-jcs-2026',
        created,
        verificationMethod,
        proofPurpose: 'capabilityInvocation',
    };
    const payload = Buffer.from(cipher.hashJSON(proof) + cipher.hashJSON(operation), 'hex');
    const signature = cipher.signHash(cipher.hashMessage(payload), key.privateJwk);
    return { ...operation, proof: { ...proof, proofValue: Buffer.from(signature, 'hex').toString('base64url') } };
}
const padProof = (operation, padding) => ({ ...operation, proof: { ...operation.proof, proofValue: operation.proof.proofValue + padding } });
const withProofValue = (operation, proofValue) => ({ ...operation, proof: { ...operation.proof, proofValue } });

const registration = { version: 1, type: 'agent', registry: 'hyperswarm' };
const genesis = publicJwk => sign({ type: 'create', created: '2026-11-18T11:00:00.000Z', registration, publicJwk }, '#key-1');
const agent = genesis(key.publicJwk);
const did = `did:cid:${canonical(agent)}`;
const update = (previous, doc, created) => sign({ type: 'update', did, previd: canonical(previous), doc }, `${did}#key-1`, created);

// A document whose only method carries the given key.
const documentWith = publicKeyJwk => ({
    '@context': ['https://www.w3.org/ns/did/v1'],
    id: did,
    verificationMethod: [{ id: '#key-1', controller: did, type: 'EcdsaSecp256k1VerificationKey2019', publicKeyJwk }],
    authentication: ['#key-1'],
    assertionMethod: ['#key-1'],
    capabilityInvocation: ['#key-1'],
});

const plain = update(agent, { didDocumentData: { case: 'proof' } });
const paddedX = { ...key.publicJwk, x: `${key.publicJwk.x}=` };
const paddedY = { ...key.publicJwk, y: `${key.publicJwk.y}=` };
const installsPaddedKey = update(agent, { didDocument: documentWith(paddedX) });
const installsSameKey = update(agent, { didDocument: documentWith(key.publicJwk) });
// 32 bytes each, as a coordinate must be, but no point on the curve: x = 0 has
// no y, and x = 2^256 - 1 is beyond the field.
const zeroX = { ...key.publicJwk, x: Buffer.alloc(32).toString('base64url') };
const fieldX = { ...key.publicJwk, x: Buffer.alloc(32, 0xff).toString('base64url') };
const installsZeroX = update(agent, { didDocument: documentWith(zeroX) });

// `operation` is applied after `agent` and `prior`, when the case has them. A case
// without an agent is a creation. `imported` is what importing the operation
// returns. A proofValue or key that cannot be read is an invalid operation, which
// both ports defer and garbage collection later clears; neither adds it.
const cases = [
    { name: 'unpadded_proof', imported: 'added', agent, operation: plain, accepted: true },
    { name: 'padded_proof', imported: 'deferred', agent, operation: padProof(plain, '=='), accepted: false },
    { name: 'padded_proof_one_sign', imported: 'deferred', agent, operation: padProof(plain, '='), accepted: false },
    { name: 'padded_proof_on_delete', imported: 'deferred', agent, operation: padProof(sign({ type: 'delete', did, previd: canonical(agent) }, `${did}#key-1`), '=='), accepted: false },
    { name: 'proof_not_base64url', imported: 'deferred', agent, operation: withProofValue(plain, `${plain.proof.proofValue.slice(0, -1)}!`), accepted: false },
    // 64 bytes, as a signature must be, but r and s out of range: zero, or beyond the order.
    { name: 'proof_scalars_zero', imported: 'deferred', agent, operation: withProofValue(plain, Buffer.alloc(64).toString('base64url')), accepted: false },
    { name: 'proof_scalars_beyond_order', imported: 'deferred', agent, operation: withProofValue(plain, Buffer.alloc(64, 0xff).toString('base64url')), accepted: false },
    { name: 'proof_too_short', imported: 'deferred', agent, operation: withProofValue(plain, plain.proof.proofValue.slice(0, 40)), accepted: false },
    // No proofValue at all is a malformed proof, which both ports reject outright.
    { name: 'proof_empty', imported: 'rejected', agent, operation: withProofValue(plain, ''), accepted: false },
    { name: 'unpadded_creation_key', imported: 'added', operation: agent, accepted: true },
    { name: 'padded_creation_key_x', imported: 'deferred', operation: genesis(paddedX), accepted: false },
    { name: 'padded_creation_key_y', imported: 'deferred', operation: genesis(paddedY), accepted: false },
    { name: 'creation_key_x_not_on_curve', imported: 'deferred', operation: genesis(zeroX), accepted: false },
    { name: 'creation_key_x_beyond_field', imported: 'deferred', operation: genesis(fieldX), accepted: false },
    { name: 'padded_creation_proof', imported: 'deferred', operation: padProof(genesis(key.publicJwk), '=='), accepted: false },
    {
        name: 'signed_by_replaced_unpadded_key', imported: 'added', agent, prior: installsSameKey, accepted: true,
        operation: update(installsSameKey, { didDocumentData: { case: 'replaced' } }, '2026-11-18T12:00:01.000Z'),
    },
    {
        name: 'signed_by_padded_method_key', imported: 'deferred', agent, prior: installsPaddedKey, accepted: false,
        operation: update(installsPaddedKey, { didDocumentData: { case: 'padded method' } }, '2026-11-18T12:00:01.000Z'),
    },
    {
        name: 'signed_by_method_key_not_on_curve', imported: 'deferred', agent, prior: installsZeroX, accepted: false,
        operation: update(installsZeroX, { didDocumentData: { case: 'key not on curve' } }, '2026-11-18T12:00:01.000Z'),
    },
].map(item => ({ ...item, did: item.agent ? did : `did:cid:${canonical(item.operation)}` }));

writeFileSync('tests/gatekeeper/base64url-v1-vectors.json', `${JSON.stringify({ cases }, null, 2)}\n`);
