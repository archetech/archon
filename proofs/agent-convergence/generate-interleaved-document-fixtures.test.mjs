import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { generateInterleavedDocumentFixtures } from './generate-interleaved-document-fixtures.mjs';
const vectors = JSON.parse(readFileSync(new URL('../../tests/convergence/document-vectors.json', import.meta.url), 'utf8'));

test('signed document evidence instantiates interleaved authorization for 612 orders', () => {
    const { result, count } = generateInterleavedDocumentFixtures(vectors);
    assert.equal(result, readFileSync(new URL('./InterleavedDocumentFixtures.lean', import.meta.url), 'utf8'));
    assert.equal(count, 612);
});

test('source-table reordering preserves the document-authorized interleaved proof', () => {
    const input = structuredClone(vectors);
    for (const vector of input) {
        const remap = i => vector.ids.length - 1 - i;
        for (const key of ['ids', 'operations', 'signatureValid', 'states']) vector[key].reverse();
        for (const scenario of vector.scenarios) {
            scenario.orders = scenario.orders.map(order => order.map(remap));
            scenario.expected = scenario.expected.map(remap);
        }
    }
    assert.equal(generateInterleavedDocumentFixtures(input).result, generateInterleavedDocumentFixtures(vectors).result);
});

test('an order with different retained evidence cannot use the permutation theorem', () => {
    const input = structuredClone(vectors);
    input[0].scenarios[0].orders[1] = [];
    assert.throws(() => generateInterleavedDocumentFixtures(input), /scenario evidence differs/);
});
