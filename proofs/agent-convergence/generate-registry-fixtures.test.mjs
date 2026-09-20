import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { generateRegistryFixtures } from './generate-registry-fixtures.mjs';
const vectors = JSON.parse(readFileSync(new URL('../../tests/convergence/migration-vectors.json', import.meta.url), 'utf8'));
test('signed migration evidence instantiates prefix agreement and registry receipt checks', () => {
    const { result, orders, prefixes, receipts } = generateRegistryFixtures(vectors);
    assert.equal(result, readFileSync(new URL('./RegistryFixtures.lean', import.meta.url), 'utf8'));
    assert.equal(orders, 24);
    assert.equal(prefixes, 144);
    assert.equal(receipts, 66);
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
test('the fixture cannot claim a registry different from signed ancestry', () => {
    const input = structuredClone(vectors);
    input[0].expectedRegistry = 'ZEC:testnet';
    assert.throws(() => generateRegistryFixtures(input), /expected registry disagrees/);
});
