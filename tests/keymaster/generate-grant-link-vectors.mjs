// Writes tests/fixtures/memeplex-grant-link-vectors.json: grant links, and what
// decoding each one gives. tests/keymaster/grant.test.ts holds the verifier
// (@didcid/memeplex) and the TypeScript Keymaster to it, and
// python/keymaster/tests/test_grant.py the Python Keymaster.
//
//   node tests/keymaster/generate-grant-link-vectors.mjs
//
// The expectations are stated here, not computed by a decoder. A case marked
// `verifier: 'pending'` states a rule the verifier does not apply, and the test
// does not ask the verifier about it.

import { writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const PREFIX = 'archon://grant?request=';
const CLIENT = 'did:cid:bagaaieraclientclientclientclientclientclientclientclientcli';
const NONCE = 'Qm9vdHN0cmFwIG5vbmNlMTIz';
const EXTENSION = `did:cid:bagaaieraschemaschemaschemaschemaschemaschemaschemaschemasch?versionId=b${'a'.repeat(58)}`;
const request = { v: 1, client: CLIENT, name: 'Memepool', nonce: NONCE };

const encode = bytes => Buffer.from(bytes).toString('base64url');
const linkOf = text => PREFIX + encode(Buffer.from(text, 'utf8'));
const carrying = memeplexGrantRequest => linkOf(JSON.stringify({ memeplexGrantRequest }));

const accepted = (name, link, expected) => ({ name, link, expect: { request: expected } });
const valid = (name, memeplexGrantRequest) => accepted(name, carrying(memeplexGrantRequest), memeplexGrantRequest);
const refused = (name, link, error) => ({ name, link, expect: { error } });
const invalid = (name, memeplexGrantRequest, validity) =>
    ({ name, link: carrying(memeplexGrantRequest), expect: { error: 'invalid-request', validity } });

const pending = vector => ({ ...vector, verifier: 'pending' });

const long = carrying(request);
const text = JSON.stringify({ memeplexGrantRequest: request });

const cases = [
    valid('every core kind', request),
    valid('some actions and an expiry', { ...request, actions: ['memeplex:post', 'memeplex:tag'], expiresAt: '2028-02-29T23:59:59.5Z' }),
    valid('an extension kind', { ...request, actions: ['memeplex:rate', EXTENSION] }),
    valid('a name outside ASCII', { ...request, name: 'Mémépool 模因池 🌊' }),
    valid('a name of 100 code points outside the basic plane', { ...request, name: '🌊'.repeat(100) }),
    valid('a field the schema does not name', { ...request, label: 'phone' }),
    valid('the registries the client can publish on', { ...request, registries: ['ETH:mainnet', 'BTC:mainnet'] }),
    valid('every permitted registry', { ...request, registries: ['BTC:mainnet', 'ZEC:mainnet', 'ETH:mainnet', 'SOL:mainnet-beta'] }),
    accepted('v written as 1.0', linkOf(text.replace('"v":1', '"v":1.0')), request),
    accepted('white space around the JSON', linkOf(` \n\t${text}\r\n `), request),
    accepted('a byte order mark before the JSON', PREFIX + encode([0xef, 0xbb, 0xbf, ...Buffer.from(text, 'utf8')]), request),
    accepted('a member given twice, of which the last counts',
        linkOf(text.replace('"name":"Memepool"', '"name":"First","name":"Memepool"')), request),

    refused('another archon link', 'archon://auth?challenge=did:cid:abc', 'not-a-grant-link'),
    refused('a web link', 'https://example.com/?request=abc', 'not-a-grant-link'),
    refused('nothing', '', 'not-a-grant-link'),
    refused('a link after a space', ` ${long}`, 'not-a-grant-link'),
    refused('a prefix in another case', long.replace('archon://', 'Archon://'), 'not-a-grant-link'),

    refused('a link one character over the limit', long + 'A'.repeat(2049 - long.length), 'too-long'),
    refused('a link over the limit only in UTF-16 code units', PREFIX + '🌊'.repeat(1100), 'too-long'),

    refused('a link at the limit that does not decode', long + 'A'.repeat(2048 - long.length), 'undecodable'),
    refused('a link within the limit that is not ASCII', PREFIX + 'é'.repeat(1000), 'undecodable'),
    refused('no request', PREFIX, 'undecodable'),
    refused('a request that is not base64url', `${PREFIX}not base64!`, 'undecodable'),
    refused('a request in the base64 alphabet', PREFIX + Buffer.from('{"a":"???>>>"}', 'utf8').toString('base64').replace(/=+$/, ''), 'undecodable'),
    refused('a padded request', linkOf(text + ' ') + '=', 'undecodable'),
    refused('a request of a length base64 cannot have', `${long}A`.slice(0, PREFIX.length + 4 * Math.floor((long.length - PREFIX.length) / 4) + 1), 'undecodable'),
    refused('a request followed by a line feed', `${long}\n`, 'undecodable'),
    refused('a request that is not JSON', linkOf('{"memeplexGrantRequest":'), 'undecodable'),
    refused('bytes that are not UTF-8', PREFIX + encode([0xff, 0xfe, 0xfd]), 'undecodable'),
    refused('a surrogate encoded as UTF-8', PREFIX + encode([0x22, 0xed, 0xa0, 0x80, 0x22]), 'undecodable'),
    refused('NaN, which is not JSON', linkOf('{"memeplexGrantRequest":NaN}'), 'undecodable'),
    refused('Infinity, which is not JSON', linkOf('{"memeplexGrantRequest":{"v":Infinity}}'), 'undecodable'),
    refused('a single-quoted string', linkOf('{\'memeplexGrantRequest\':1}'), 'undecodable'),
    refused('a trailing comma', linkOf(text.replace(/}}$/, ',}}')), 'undecodable'),

    { name: 'a request with no memeplexGrantRequest', link: linkOf(JSON.stringify(request)), expect: { error: 'invalid-request', validity: 'schema' } },
    { name: 'a JSON value that is not an object', link: linkOf('[1]'), expect: { error: 'invalid-request', validity: 'schema' } },
    { name: 'null', link: linkOf('null'), expect: { error: 'invalid-request', validity: 'schema' } },
    invalid('a request that is an array', [request], 'schema'),
    invalid('a request that is null', null, 'schema'),
    invalid('a later v', { ...request, v: 2 }, 'unsupported'),
    invalid('v as a string', { ...request, v: '1' }, 'version'),
    invalid('v as a boolean', { ...request, v: true }, 'version'),
    invalid('v with a fraction', { ...request, v: 1.5 }, 'version'),
    { name: 'v too large to be a number', link: linkOf(text.replace('"v":1', '"v":1e400')), expect: { error: 'invalid-request', validity: 'version' } },
    invalid('no v', { client: CLIENT, name: 'Memepool', nonce: NONCE }, 'version'),
    invalid('no client', { v: 1, name: 'Memepool', nonce: NONCE }, 'schema'),
    invalid('no name', { v: 1, client: CLIENT, nonce: NONCE }, 'schema'),
    invalid('no nonce', { v: 1, client: CLIENT, name: 'Memepool' }, 'schema'),
    invalid('a null nonce', { ...request, nonce: null }, 'schema'),
    invalid('an empty name', { ...request, name: '' }, 'schema'),
    invalid('a name of 101 code points outside the basic plane', { ...request, name: '🌊'.repeat(101) }, 'schema'),
    invalid('a name that is not a string', { ...request, name: 7 }, 'schema'),
    invalid('a client that is not a DID', { ...request, client: 'memepool' }, 'schema'),
    invalid('a client followed by a line feed', { ...request, client: `${CLIENT}\n` }, 'schema'),
    invalid('a nonce of fewer than 128 bits', { ...request, nonce: 'BQUFBQUFBQUFBQUFBQUFB' }, 'schema'),
    invalid('a nonce that is not base64url', { ...request, nonce: 'BQUFBQUFBQUFBQUFBQUFBQU+' }, 'schema'),
    invalid('a nonce followed by a line feed', { ...request, nonce: `${NONCE}\n` }, 'schema'),
    invalid('no actions listed', { ...request, actions: [] }, 'schema'),
    invalid('actions that are not a list', { ...request, actions: 'memeplex:post' }, 'schema'),
    invalid('an action twice', { ...request, actions: ['memeplex:tag', 'memeplex:tag'] }, 'schema'),
    invalid('an unknown action', { ...request, actions: ['memeplex:delete'] }, 'schema'),
    invalid('an action that is not a string', { ...request, actions: [1] }, 'schema'),
    invalid('an extension kind that is not pinned', { ...request, actions: [EXTENSION.split('?')[0]] }, 'schema'),
    invalid('an extension kind followed by a line feed', { ...request, actions: [`${EXTENSION}\n`] }, 'schema'),
    pending(invalid('no registries listed', { ...request, registries: [] }, 'schema')),
    pending(invalid('a registry twice', { ...request, registries: ['BTC:mainnet', 'BTC:mainnet'] }, 'schema')),
    pending(invalid('a registry a grant may not be created on', { ...request, registries: ['BTC:mainnet', 'hyperswarm'] }, 'schema')),
    pending(invalid('a testnet registry', { ...request, registries: ['BTC:signet'] }, 'schema')),
    pending(invalid('registries that are not a list', { ...request, registries: 'BTC:mainnet' }, 'schema')),
    pending(invalid('a registry that is not a string', { ...request, registries: [1] }, 'schema')),
    invalid('an expiry with an offset', { ...request, expiresAt: '2026-12-31T00:00:00+00:00' }, 'schema'),
    invalid('an expiry without a time', { ...request, expiresAt: '2026-12-31' }, 'schema'),
    invalid('an expiry followed by a line feed', { ...request, expiresAt: '2026-12-31T00:00:00Z\n' }, 'schema'),
    invalid('an expiry in digits outside ASCII', { ...request, expiresAt: '٢٠٢٦-12-31T00:00:00Z' }, 'schema'),
    invalid('an expiry that is not a string', { ...request, expiresAt: 1798675200 }, 'schema'),
    invalid('an expiry on a day that does not exist', { ...request, expiresAt: '2027-02-30T00:00:00Z' }, 'expiry-instant'),
    invalid('an expiry on a leap day a century year lacks', { ...request, expiresAt: '2100-02-29T00:00:00Z' }, 'expiry-instant'),
    invalid('an expiry in a month that does not exist', { ...request, expiresAt: '2026-13-01T00:00:00Z' }, 'expiry-instant'),
    invalid('an expiry at an hour that does not exist', { ...request, expiresAt: '2026-12-31T24:00:00Z' }, 'expiry-instant'),
    invalid('an expiry at a second that does not exist', { ...request, expiresAt: '2026-12-31T23:59:60Z' }, 'expiry-instant'),
];

const vectors = {
    description: 'Memeplex grant links and what decoding each gives: the request it carries, or the refusal. Written by tests/keymaster/generate-grant-link-vectors.mjs; see tests/keymaster/grant.test.ts.',
    cases,
};
const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'memeplex-grant-link-vectors.json');

writeFileSync(file, `${JSON.stringify(vectors, null, 4)}\n`);
console.log(`${cases.length} cases written to ${file}`);
