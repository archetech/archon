// Writes tests/fixtures/cashu-request-vectors.json: NUT-18 payment requests as
// cashu-ts encodes them, with what payCashuRequest makes of each. Both Keymasters
// run on the file, the Python one with its own decoder.
//
//   node tests/keymaster/generate-cashu-request-vectors.mjs

import { writeFileSync } from 'node:fs';
import { PaymentRequest } from '@cashu/cashu-ts';

const MINT = 'https://mint.example/cashu';
const OTHER = 'https://other.example';

// A field given as null is left out of the request.
function request({ amount = 10, unit = 'sat', mints = [MINT], nut10, preferred, transport } = {}) {
    return new PaymentRequest(transport, 'demo', amount ?? undefined, unit, mints ?? undefined, 'A priced call', true, nut10, preferred);
}

const plain = request();
const creqB = plain.toEncodedCreqB();
// One character of the checksum changed.
const corrupted = creqB.slice(0, -1) + (creqB.endsWith('Q') ? 'P' : 'Q');

const accepted = [
    { name: 'creqA', request: plain.toEncodedCreqA() },
    { name: 'creqA with a lowercase prefix', request: plain.toEncodedCreqA().replace(/^creqA/, 'creqa') },
    { name: 'creqB', request: creqB },
    { name: 'creqB in lowercase', request: creqB.toLowerCase() },
    { name: 'surrounding whitespace', request: ` ${creqB}\n` },
    {
        name: 'the NUT-26 example',
        request: 'CREQB1QYQQWER9D4HNZV3NQGQQSQQQQQQQQQQRAQPSQQGQQSQQZQG9QQVXSAR5WPEN5TE0D45KUAPWV4UXZMTSD3JJUCM0D5RQQRJRDANXVET9YPCXZ7TDV4H8GXHR3TQ',
        amount: 1000,
        mints: ['https://mint.example.com'],
    },
    {
        name: 'several mints, normalized, creqA',
        request: request({ mints: [`${OTHER}/`, 'HTTPS://MINT.EXAMPLE/cashu/'] }).toEncodedCreqA(),
        mints: [OTHER, MINT],
    },
    {
        name: 'several mints, normalized, creqB',
        request: request({ mints: [`${OTHER}/`, 'HTTPS://MINT.EXAMPLE/cashu/'] }).toEncodedCreqB(),
        mints: [OTHER, MINT],
    },
    {
        name: 'an unusable mint beside a usable one',
        request: request({ mints: ['not a url', MINT] }).toEncodedCreqA(),
    },
    { name: 'an advisory mint list', request: request({ preferred: true }).toEncodedCreqB() },
    {
        name: 'a transport',
        request: request({ transport: [{ type: 'post', target: 'https://pay.example/callback' }] }).toEncodedCreqA(),
    },
].map(({ amount = 10, mints = [MINT], ...rest }) => ({ ...rest, amount, mints }));

const lock = { kind: 'P2PK', data: '02'.padEnd(66, 'a'), tags: [] };

const refused = [
    { name: 'not a request', request: 'garbage', error: 'request' },
    { name: 'empty', request: '', error: 'request' },
    { name: 'creqA that is not base64', request: 'creqA!!!', error: 'request' },
    { name: 'creqA that is not CBOR', request: 'creqAgarbage', error: 'request' },
    { name: 'creqB with a wrong checksum', request: corrupted, error: 'request' },
    { name: 'another unit, creqA', request: request({ unit: 'usd' }).toEncodedCreqA(), error: 'request: the unit is not sat' },
    { name: 'another unit, creqB', request: request({ unit: 'usd' }).toEncodedCreqB(), error: 'request: the unit is not sat' },
    { name: 'no amount, creqA', request: request({ amount: null }).toEncodedCreqA(), error: 'request: names no amount' },
    { name: 'no amount, creqB', request: request({ amount: null }).toEncodedCreqB(), error: 'request: names no amount' },
    { name: 'a locked token, creqA', request: request({ nut10: lock }).toEncodedCreqA(), error: 'request: asks for a locked token' },
    { name: 'a locked token, creqB', request: request({ nut10: lock }).toEncodedCreqB(), error: 'request: asks for a locked token' },
    { name: 'no mint list, creqA', request: request({ mints: null }).toEncodedCreqA(), error: 'request: names no mint' },
    { name: 'no mint list, creqB', request: request({ mints: null }).toEncodedCreqB(), error: 'request: names no mint' },
    { name: 'only an unusable mint', request: request({ mints: ['not a url'] }).toEncodedCreqA(), error: 'request: names no mint' },
];

writeFileSync('tests/fixtures/cashu-request-vectors.json', JSON.stringify({ accepted, refused }, null, 4) + '\n');
