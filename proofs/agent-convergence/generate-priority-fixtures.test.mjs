import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { generatePriorityFixtures } from './generate-priority-fixtures.mjs';
const vectors = JSON.parse(readFileSync(new URL('../../tests/convergence/chain-successor-vectors.json', import.meta.url), 'utf8'));
test('shared evidence instantiates projection agreement for 36 delivery orders', () => {
    const { result, count } = generatePriorityFixtures(vectors);
    assert.equal(result, readFileSync(new URL('./PriorityFixtures.lean', import.meta.url), 'utf8'));
    assert.equal(count, 36);
});
test('operation and event table reorderings preserve the Lean projection and agreement cases', () => {
    for (const mode of ['operations', 'events', 'both']) {
        const input = structuredClone(vectors);
        for (const v of input) {
            if (mode !== 'events') {
                v.operations.reverse(); v.ids.reverse();
                v.expected = v.expected.map(i => v.ids.length - 1 - i);
            }
            if (mode !== 'operations') {
                v.events.reverse();
                v.orders = v.orders.map(order => order.map(i => v.events.length - 1 - i));
            }
        }
        assert.equal(generatePriorityFixtures(input).result, generatePriorityFixtures(vectors).result);
    }
});
