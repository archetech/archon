import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { generateInterleavedFixtures } from './generate-interleaved-fixtures.mjs';
const vectors = JSON.parse(readFileSync(new URL('../../tests/convergence/chain-successor-vectors.json', import.meta.url), 'utf8'));
test('shared fixtures reproduce 764 checked transitions and 100 passes', () => {
    const { lean, cases } = generateInterleavedFixtures(vectors);
    assert.equal(lean, readFileSync(new URL('./InterleavedFixtures.lean', import.meta.url), 'utf8'));
    assert.deepEqual(cases, JSON.parse(readFileSync(new URL('../../tests/convergence/interleaved-cases.json', import.meta.url), 'utf8')));
    assert.equal(cases.length, 36);
    for (const c of cases) assert(c.passes.length <= c.passBound);
    assert(cases.some(c => c.passes.length === c.passBound), 'exercise the final allowed stopping pass');
    assert.equal(cases.reduce((n, c) => n + c.passes.length, 0), 100);
    assert.equal(cases.reduce((n, c) => n + c.passes.length * c.order.length, 0), 764);
});
test('operation and event table reorderings preserve all Lean transitions', () => {
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
        assert.equal(generateInterleavedFixtures(input).lean, generateInterleavedFixtures(vectors).lean);
    }
});
test('rejects a projection disagreeing with the settled-path result', () => {
    const input = structuredClone(vectors);
    input[0].expected = [0, 2, 4];
    assert.throws(() => generateInterleavedFixtures(input), /disagrees with settled projection/);
});
