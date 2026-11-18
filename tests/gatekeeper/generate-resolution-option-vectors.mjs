// A signed two-version history and the result of resolving it with each kind of
// version option, for both Gatekeepers and both of their resolution surfaces.
// An option that cannot be used is `invalidOptions`, never the latest version.
//
// Synthetic signing key only. Run from the repository root after building packages.
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import Cipher from '../../packages/cipher/dist/esm/cipher-node.js';
import { CID } from 'multiformats/cid';
import { create } from 'multiformats/hashes/digest';

const cipher = new Cipher();
const key = cipher.generateJwk(new Uint8Array(32).fill(47));
const canonical = operation => CID.createV1(0x0200,
    create(0x12, createHash('sha256').update(cipher.canonicalizeJSON(operation)).digest())).toString();

function sign(operation, verificationMethod, created) {
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

const CREATED = '2026-11-18T11:00:00.000Z';
const UPDATED = '2026-11-18T12:00:00.000Z';
const agent = sign({
    type: 'create', created: CREATED, registration: { version: 1, type: 'agent', registry: 'local' }, publicJwk: key.publicJwk,
}, '#key-1', CREATED);
const did = `did:cid:${canonical(agent)}`;
const update = sign({ type: 'update', did, previd: canonical(agent), doc: { didDocumentData: { version: 2 } } }, `${did}#key-1`, UPDATED);

// `query` is the request's query string. A case gives the error resolution
// reports, or the versionSequence of the document it returns.
const cases = [
    { name: 'no_options', query: '', version: '2' },
    // Creation is never excluded by a time bound, so a time before it is not an
    // error. It selects version 1 here because this history's update is after
    // the bound; a successor dated at or before the bound would be selected.
    { name: 'time_before_creation', query: 'versionTime=2020-01-01T00:00:00Z', version: '1' },
    { name: 'time_of_creation', query: 'versionTime=2026-11-18T11:00:00Z', version: '1' },
    { name: 'time_between_versions', query: 'versionTime=2026-11-18T11:30:00Z', version: '1' },
    { name: 'time_with_fraction', query: 'versionTime=2026-11-18T11:30:00.250Z', version: '1' },
    { name: 'time_with_offset', query: `versionTime=${encodeURIComponent('2026-11-18T12:30:00+01:00')}`, version: '1' },
    { name: 'time_after_update', query: 'versionTime=2026-11-18T13:00:00Z', version: '2' },
    { name: 'sequence_one', query: 'versionSequence=1', version: '1' },
    { name: 'sequence_two', query: 'versionSequence=2', version: '2' },
    { name: 'sequence_with_leading_zeros', query: 'versionSequence=002', version: '2' },
    { name: 'time_not_a_date', query: 'versionTime=garbage', error: 'invalidOptions' },
    { name: 'time_empty', query: 'versionTime=', error: 'invalidOptions' },
    { name: 'time_date_only', query: 'versionTime=2026-11-18', error: 'invalidOptions' },
    { name: 'time_without_zone', query: 'versionTime=2026-11-18T11:30:00', error: 'invalidOptions' },
    { name: 'time_day_that_does_not_exist', query: 'versionTime=2026-02-30T00:00:00Z', error: 'invalidOptions' },
    { name: 'time_as_epoch_number', query: 'versionTime=1795000000', error: 'invalidOptions' },
    { name: 'sequence_zero', query: 'versionSequence=0', error: 'invalidOptions' },
    { name: 'sequence_negative', query: 'versionSequence=-1', error: 'invalidOptions' },
    { name: 'sequence_fraction', query: 'versionSequence=1.5', error: 'invalidOptions' },
    { name: 'sequence_trailing_text', query: 'versionSequence=1abc', error: 'invalidOptions' },
    { name: 'sequence_not_a_number', query: 'versionSequence=latest', error: 'invalidOptions' },
    { name: 'sequence_empty', query: 'versionSequence=', error: 'invalidOptions' },
    { name: 'sequence_beyond_exact_integers', query: 'versionSequence=9007199254740993', error: 'invalidOptions' },
    { name: 'valid_sequence_with_invalid_time', query: 'versionSequence=1&versionTime=garbage', error: 'invalidOptions' },
    { name: 'version_id_with_sequence', query: `versionId=${canonical(agent)}&versionSequence=1`, error: 'invalidOptions' },
    { name: 'version_id_of_creation', query: `versionId=${canonical(agent)}`, version: '1' },
    { name: 'version_id_of_update', query: `versionId=${canonical(update)}`, version: '2' },
    { name: 'version_id_unknown', query: 'versionId=bafkreinosuchoperation', error: 'notFound' },
];

writeFileSync('tests/gatekeeper/resolution-option-v1-vectors.json', `${JSON.stringify({ agent, update, did, cases }, null, 2)}\n`);
