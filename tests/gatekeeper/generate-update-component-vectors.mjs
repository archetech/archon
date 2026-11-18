// Signed updates that supply each kind of component value, for the rule both
// Gatekeepers apply on submission, import and replay: an update supplies at least
// one of didDocument, didDocumentData and didDocumentRegistration, and none is null.
//
// Synthetic signing key only. Run from the repository root after building packages.
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import Cipher from '../../packages/cipher/dist/esm/cipher-node.js';
import { CID } from 'multiformats/cid';
import { create } from 'multiformats/hashes/digest';

const cipher = new Cipher();
const key = cipher.generateJwk(new Uint8Array(32).fill(41));
const canonical = operation => CID.createV1(0x0200,
    create(0x12, createHash('sha256').update(cipher.canonicalizeJSON(operation)).digest())).toString();

function sign(operation, verificationMethod) {
    const proof = {
        type: 'DataIntegrityProof',
        cryptosuite: 'archon-ecdsa-secp256k1-jcs-2026',
        created: '2026-11-18T12:00:00.000Z',
        verificationMethod,
        proofPurpose: 'capabilityInvocation',
    };
    const payload = Buffer.from(cipher.hashJSON(proof) + cipher.hashJSON(operation), 'hex');
    const signature = cipher.signHash(cipher.hashMessage(payload), key.privateJwk);
    return { ...operation, proof: { ...proof, proofValue: Buffer.from(signature, 'hex').toString('base64url') } };
}

const registration = { version: 1, type: 'agent', registry: 'hyperswarm' };
const agent = sign({ type: 'create', created: '2026-11-18T11:00:00.000Z', registration, publicJwk: key.publicJwk }, '#key-1');
const did = `did:cid:${canonical(agent)}`;

// Each case: the update's `doc`, or the whole member left out, and whether the
// update is accepted. An accepted case here replaces didDocumentData only.
const OMIT = Symbol('omit');
const specs = [
    ['data_object', { didDocumentData: { case: 'object' } }, true],
    ['data_empty_object', { didDocumentData: {} }, true],
    ['data_array', { didDocumentData: [1, 'two'] }, true],
    ['data_empty_array', { didDocumentData: [] }, true],
    ['data_string', { didDocumentData: 'text' }, true],
    ['data_empty_string', { didDocumentData: '' }, true],
    ['data_number', { didDocumentData: 7 }, true],
    ['data_zero', { didDocumentData: 0 }, true],
    ['data_true', { didDocumentData: true }, true],
    ['data_false', { didDocumentData: false }, true],
    ['data_null', { didDocumentData: null }, false],
    ['data_null_with_registration', { didDocumentData: null, didDocumentRegistration: registration }, false],
    ['document_null', { didDocument: null }, false],
    ['document_null_with_data', { didDocument: null, didDocumentData: { case: 'document_null_with_data' } }, false],
    ['document_string', { didDocument: 'text' }, false],
    ['document_array', { didDocument: [] }, false],
    ['registration_null_with_data', { didDocumentRegistration: null, didDocumentData: { case: 'registration_null_with_data' } }, false],
    ['no_components', {}, false],
    ['unknown_component_only', { extension: { case: 'unknown_component_only' } }, false],
    ['doc_null', null, false],
    ['doc_array', [], false],
    ['doc_string', 'text', false],
    ['doc_omitted', OMIT, false],
];

const cases = specs.map(([name, doc, accepted]) => ({
    name,
    accepted,
    expectedData: accepted ? doc.didDocumentData : {},
    operation: sign({ type: 'update', did, previd: canonical(agent), ...(doc === OMIT ? {} : { doc }) }, `${did}#key-1`),
}));

writeFileSync('tests/gatekeeper/update-component-v1-vectors.json', `${JSON.stringify({ agent, did, cases }, null, 2)}\n`);
