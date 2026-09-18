// Synthetic key; run from the repo root after building packages.
// Large signed payloads are stored as repetition recipes to keep this fixture small.
import { writeFileSync } from 'node:fs';
import Cipher from '../../packages/cipher/dist/esm/cipher-node.js';
import { generateCID } from '../../packages/ipfs/dist/esm/utils.js';
const cipher = new Cipher();
const key = cipher.generateJwk(new Uint8Array(32).fill(59));
function sign(op, method) {
    const proof = { type: 'DataIntegrityProof', cryptosuite: 'archon-ecdsa-secp256k1-jcs-2026', created: '2026-09-17T12:00:00.000Z', verificationMethod: method, proofPurpose: 'capabilityInvocation' };
    const message = cipher.hashMessage(Buffer.from(cipher.hashJSON(proof) + cipher.hashJSON(op), 'hex'));
    return { ...op, proof: { ...proof, proofValue: Buffer.from(cipher.signHash(message, key.privateJwk), 'hex').toString('base64url') } };
}
const genesis = { type: 'create', created: '2026-09-17T11:00:00.000Z', registration: { version: 1, type: 'agent', registry: 'hyperswarm' }, publicJwk: key.publicJwk };
const agent = sign(genesis, '#key-1');
const previd = await generateCID(JSON.parse(cipher.canonicalizeJSON(agent)));
const did = 'did:cid:' + previd;
const cases = [];
for (const [name, character] of [['ascii', 'a'], ['bmp', 'é'], ['supplementary', '😀'], ['short_escape', '\n'], ['long_escape', '\u0000'], ['quote_backslash', '"\\']]) {
    for (const limit of [65536, 65537]) add(name + '_' + limit, 'update', character, limit);
}
for (const type of ['create', 'delete']) for (const limit of [65536, 65537]) add(type + '_' + limit, type, 'é', limit);
add('legacy_40000_bmp', 'update', 'é', undefined, 40000);
function add(name, type, character, limit, fixedRepeat) {
    const op = type === 'create' ? { ...genesis } : { type, did, previd, ...(type === 'update' ? { doc: { didDocumentData: { test: 'size' } } } : {}) };
    const method = type === 'create' ? '#key-1' : did + '#key-1';
    const base = JSON.stringify(sign({ ...op, sizePadding: '' }, method)).length;
    const perCharacter = JSON.stringify(character).length - 2;
    const repeat = fixedRepeat ?? Math.floor((limit - base) / perCharacter);
    const ascii = fixedRepeat === undefined ? limit - base - repeat * perCharacter : 0;
    const operation = sign({ ...op, sizePadding: character.repeat(repeat) + 'a'.repeat(ascii) }, method);
    const serialized = JSON.stringify(operation);
    cases.push({ name, accepted: serialized.length <= 65536, units: serialized.length, bytes: Buffer.byteLength(serialized), padding: { character, repeat, ascii }, operation: { ...operation, sizePadding: '' } });
}
// Raw JSON covers number spellings that serde_json and ECMAScript serialize differently.
const measurements = ['null', 'true', 'false', '[]', '{}', '{"é":["😀","\\u0000","\\n","\\\"","\\\\"]}', '1.0', '-0.0', '1e-6', '1e-7', '1e20', '1e21', '9007199254740993', '{"n":1.2345678901234567}'].map(json => ({ json, units: JSON.stringify(JSON.parse(json)).length }));
writeFileSync('tests/gatekeeper/operation-size-v1-vectors.json', JSON.stringify({ agent, did, cases, measurements }, null, 2) + '\n');
