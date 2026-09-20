import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { generateRegistryFixtures } from './generate-registry-fixtures.mjs';
const vectors = JSON.parse(readFileSync(new URL('../../tests/convergence/migration-vectors.json', import.meta.url), 'utf8'));
test('signed migration evidence instantiates prefix agreement and registry receipt checks', () => {
    const { result, orders, prefixes, receipts, anchors, warm } = generateRegistryFixtures(vectors);
    assert.equal(result, readFileSync(new URL('./RegistryFixtures.lean', import.meta.url), 'utf8'));
    assert.equal(orders, 24);
    assert.equal(prefixes, 144);
    assert.equal(receipts, 66);
    assert.equal(anchors, 168);
    assert.equal(warm, 180);
});
test('paired operation tables and receipt tables preserve the registry proof', () => {
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
                v.expectedEvents = v.expectedEvents.map(i => v.events.length - 1 - i);
            }
        }
        assert.equal(generateRegistryFixtures(input).result, generateRegistryFixtures(vectors).result);
    }
});
test('rejects an incorrect expected-registry summary', () => {
    const input = structuredClone(vectors);
    input[0].expectedRegistry = 'ZEC:testnet';
    assert.throws(() => generateRegistryFixtures(input), /expected registry disagrees/);
});

test('derives final registry from the operation and all matching receipt payloads', () => {
    for (const source of vectors) {
        const vector = structuredClone(source);
        const leaf = vector.operations[vector.expected.at(-1)];
        const copies = vector.events.filter(event => isDeepStrictEqual(event.operation, leaf));
        assert(copies.length > 0);
        const registry = vector.expectedRegistry === 'BTC:signet' ? 'ZEC:testnet' : 'BTC:signet';
        // Structural bridge test: changing signed bytes invalidates the original
        // signature; this is not a newly signed protocol counterexample.
        for (const operation of [leaf, ...copies.map(event => event.operation)]) {
            operation.doc.didDocumentRegistration = { version: 1, type: 'agent', registry };
        }
        assert.equal(vector.expectedRegistry, source.expectedRegistry);
        assert.throws(() => generateRegistryFixtures([vector]), /expected registry disagrees with audit projection/);
    }
});

test('anchor bridge checks the expected stored receipts, not only operation IDs', () => {
    const input = structuredClone(vectors);
    const v = input[0];
    const owner = v.expected[1];
    const wrongChain = v.events.findIndex(e => isDeepStrictEqual(e.operation, v.operations[owner])
        && e.registry === 'hyperswarm');
    assert(wrongChain >= 0);
    v.expectedEvents[1] = wrongChain;
    assert.throws(() => generateRegistryFixtures(input), /expected receipts disagree/);
});

test('changing actual receipt registry cannot retain a nonexistent matching anchor', () => {
    for (const source of vectors) {
        const v = structuredClone(source);
        const genesis = v.operations.find(op => op.type === 'create');
        const anchor = v.events.find(e => isDeepStrictEqual(e.operation, genesis) && e.registry === 'BTC:signet');
        assert(anchor);
        anchor.registry = 'ZEC:testnet';
        assert.throws(() => generateRegistryFixtures([v]), /matching-chain anchor/);
    }
});
