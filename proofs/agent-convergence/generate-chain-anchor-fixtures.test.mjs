import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { comparePositions, generateChainAnchorFixtures } from './generate-chain-anchor-fixtures.mjs';

const vectors = JSON.parse(readFileSync(new URL('../../tests/convergence/chain-anchor-vectors.json', import.meta.url), 'utf8'));
test('signed source projections reproduce all 36 operation/order cases', () => {
    const { result, count } = generateChainAnchorFixtures(vectors);
    assert.equal(count, 36);
    assert.equal(result, readFileSync(new URL('./ChainAnchorFixtures.lean', import.meta.url), 'utf8'));
});
test('ordinal comparison uses every component and prefix length', () => {
    assert.equal(comparePositions([100, 2, 9], [100, 10, 0]), -1);
    assert.equal(comparePositions([100, 2], [100, 2, 0]), -1);
    assert.equal(comparePositions([100, 2, 1], [100, 2, 0]), 1);
    assert.equal(comparePositions([100, 2], [100, 2]), 0);
});
test('rejects absent positions, ordinal ties, and migrations outside the theorem', () => {
    for (const change of [
        v => { delete v.events[2].ordinal; },
        v => { v.events[5].ordinal = v.events[2].ordinal; },
        v => {
            for (const op of [...v.operations, ...v.events.map(e => e.operation)]) {
                if (op.previd === v.ids[0]) op.doc.didDocumentRegistration = { registry: 'BTC:mainnet' };
            }
        },
    ]) {
        const input = structuredClone(vectors);
        change(input[0]);
        assert.throws(() => generateChainAnchorFixtures(input));
    }
});
test('rejects partial scans and unknown delivery tokens', () => {
    for (const order of [[0, 1], [...vectors[0].orders[0], 99]]) {
        const input = structuredClone(vectors);
        input[0].orders[0] = order;
        assert.throws(() => generateChainAnchorFixtures(input));
    }
});
test('duplicate deliveries retain the same expected positions', () => {
    const input = structuredClone(vectors);
    input[0].orders[0].push(...input[0].orders[0]);
    const { result, count } = generateChainAnchorFixtures(input);
    assert.equal(count, 36);
    assert.match(result, /\[0, 1, 2, 3, 0, 1, 2, 3\]/);
});

test('event and operation table reorderings preserve the entire generated proof', () => {
    for (const mode of ['events', 'operations', 'both']) {
        const input = structuredClone(vectors);
        for (const v of input) {
            if (mode !== 'operations') {
                const remap = i => v.events.length - 1 - i;
                v.events.reverse();
                v.orders = v.orders.map(order => order.map(remap));
            }
            if (mode !== 'events') {
                v.operations.reverse();
                v.ids.reverse();
            }
        }
        assert.deepEqual(generateChainAnchorFixtures(input), generateChainAnchorFixtures(vectors));
    }
});

test('serialized object key order does not change operation identity', () => {
    const input = structuredClone(vectors);
    for (const v of input) {
        for (const e of v.events) e.operation = Object.fromEntries(Object.entries(e.operation).reverse());
    }
    assert.deepEqual(generateChainAnchorFixtures(input), generateChainAnchorFixtures(vectors));
});

test('rejects a disconnected signed predecessor and mismatched operation records', () => {
    const disconnected = structuredClone(vectors);
    const v = disconnected[0];
    for (const op of [...v.operations, ...v.events.map(e => e.operation)]) {
        if (op.previd === v.ids[0]) op.previd = v.ids[3];
    }
    assert.throws(() => generateChainAnchorFixtures(disconnected), /must link to genesis/);
    const mismatched = structuredClone(vectors);
    mismatched[0].events[2].operation.proof.proofValue = 'different';
    assert.throws(() => generateChainAnchorFixtures(mismatched), /must match one canonical operation/);
});
