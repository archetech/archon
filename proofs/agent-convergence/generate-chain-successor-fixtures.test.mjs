import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { generateChainSuccessorFixtures } from './generate-chain-successor-fixtures.mjs';
const vectors = JSON.parse(readFileSync(new URL('../../tests/convergence/chain-successor-vectors.json', import.meta.url), 'utf8'));
test('36 signed branch traces instantiate the general replay theorem', () => {
    const { count, result } = generateChainSuccessorFixtures(vectors);
    assert.equal(count, 36);
    assert.equal(result, readFileSync(new URL('./ChainSuccessorFixtures.lean', import.meta.url), 'utf8'));
});
test('operation and event table reorderings preserve the complete Lean output', () => {
    for (const mode of ['events', 'operations', 'both']) {
        const input = structuredClone(vectors);
        for (const v of input) {
            if (mode !== 'operations') {
                v.events.reverse();
                v.orders = v.orders.map(order => order.map(i => v.events.length - 1 - i));
            }
            if (mode !== 'events') {
                v.operations.reverse();
                v.ids.reverse();
                v.expected = v.expected.map(i => v.ids.length - 1 - i);
            }
        }
        assert.deepEqual(generateChainSuccessorFixtures(input), generateChainSuccessorFixtures(vectors));
    }
});
test('rejects migrations and key changes outside fixed data-update authorization', () => {
    for (const component of ['didDocumentRegistration', 'didDocument']) {
        const input = structuredClone(vectors);
        const v = input[0];
        for (const op of [...v.operations, ...v.events.map(e => e.operation)]) {
            if (op.previd === v.ids[0]) op.doc[component] = {};
        }
        assert.throws(() => generateChainSuccessorFixtures(input), /only data updates/);
    }
});
test('rejects absent/tied positions and partial scans', () => {
    for (const mutate of [
        v => { delete v.events[5].ordinal; },
        v => { v.events[6].ordinal = v.events[5].ordinal; },
        v => { v.orders[0] = [0]; },
    ]) {
        const input = structuredClone(vectors);
        mutate(input[1]);
        assert.throws(() => generateChainSuccessorFixtures(input));
    }
});

test('rejects a changed signing method in matched table and event operations', () => {
    for (const original of vectors) {
        const v = structuredClone(original);
        for (const op of [...v.operations, ...v.events.map(e => e.operation)]) {
            if (op.type === 'update') op.proof.verificationMethod = v.did + '#key-2';
        }
        assert.throws(() => generateChainSuccessorFixtures([v]), /fixed key required/);
    }
});
test('every scenario supplies six distinct complete delivery permutations', () => {
    for (const v of vectors) {
        assert.equal(v.orders.length, 6);
        assert.equal(new Set(v.orders.map(order => JSON.stringify(order))).size, 6);
        for (const order of v.orders) {
            assert.deepEqual([...order].sort((a, b) => a - b), v.events.map((_, i) => i));
        }
    }
});
