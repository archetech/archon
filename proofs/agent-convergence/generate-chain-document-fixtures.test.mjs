import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { generateChainDocumentFixtures } from './generate-chain-document-fixtures.mjs';
const vectors = JSON.parse(readFileSync(new URL('../../tests/convergence/chain-document-vectors.json', import.meta.url), 'utf8'));
test('signed chain/document fixtures reproduce 920 transitions and 68 passes', () => {
    const { lean, cases } = generateChainDocumentFixtures(vectors);
    assert.equal(lean, readFileSync(new URL('./ChainDocumentFixtures.lean', import.meta.url), 'utf8'));
    assert.deepEqual(cases, JSON.parse(readFileSync(new URL('../../tests/convergence/chain-document-cases.json', import.meta.url), 'utf8')));
    assert.equal(cases.length, 24);
    assert.equal(cases.reduce((n, c) => n + c.passes.length, 0), 68);
    assert.equal(cases.reduce((n, c) => n + c.passes.length * c.order.length, 0), 920);
    for (const c of cases) assert(c.passes.length <= c.passBound);
});
test('operation and event table reorderings preserve the composed proof', () => {
    for (const mode of ['operations', 'events', 'both']) {
        const input = structuredClone(vectors);
        for (const v of input) {
            if (mode !== 'events') {
                for (const key of ['operations', 'ids', 'states', 'signatureValid']) v[key].reverse();
                v.expected = v.expected.map(i => v.ids.length - 1 - i);
            }
            if (mode !== 'operations') {
                v.events.reverse();
                v.seed = v.events.length - 1 - v.seed;
                v.orders = v.orders.map(order => order.map(i => v.events.length - 1 - i));
            }
        }
        assert.equal(generateChainDocumentFixtures(input).lean, generateChainDocumentFixtures(vectors).lean);
    }
});
test('rejects fixture claims outside the explicit ancestry/position domain', () => {
    for (const mutate of [
        v => { v.states[5] = 0; },
        v => { v.events[10].ordinal = v.events[11].ordinal; },
        v => { v.events[10].registry = 'BTC:other'; },
        v => { v.seed = 1; },
        v => { v.orders[0] = []; },
    ]) {
        const input = structuredClone(vectors);
        mutate(input[0]);
        assert.throws(() => generateChainDocumentFixtures(input), /oracle|ordinal|registry|seed|evidence/);
    }
});

test('each signed scenario has six distinct delivery orders', () => {
    for (const vector of vectors) {
        assert.equal(vector.orders.length, 6);
        assert.equal(new Set(vector.orders.map(order => JSON.stringify(order))).size, 6);
    }
    const input = structuredClone(vectors);
    input[0].orders[1] = [...input[0].orders[0]];
    assert.throws(() => generateChainDocumentFixtures(input), /duplicate delivery orders/);
});
