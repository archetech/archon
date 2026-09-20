import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { migrationProjection } from './migration-model.mjs';
const vectors = JSON.parse(readFileSync(new URL('./migration-vectors.json', import.meta.url), 'utf8'));
const normalized = v => {
    const p = migrationProjection(v);
    return { path: p.path.map(i => v.ids[i]), events: p.events.map(i => v.events[i]), registry: p.registry,
        expectedRegistries: Object.fromEntries(v.ids.map((id, i) => [id, p.expectedRegistries[i]])) };
};
test('migration uses predecessor registry; successor uses new registry', () => {
    assert.equal(vectors.length, 4);
    for (const v of vectors) {
        const p = migrationProjection(v);
        assert.deepEqual(p.expectedRegistries, ['BTC:signet', 'BTC:signet', 'BTC:signet', 'ZEC:testnet', 'ETH:sepolia', 'ZEC:testnet', 'BTC:signet']);
        const expected = v.mode === 'competing-migrations' ? [0, 2, 4] : [0, 1, 3, 5, 6];
        assert.deepEqual(p.path, expected);
        assert.deepEqual(v.expected, expected);
        assert.deepEqual(v.expectedEvents, p.events);
        assert.equal(p.registry, v.mode === 'competing-migrations' ? 'ETH:sepolia' : 'BTC:signet');
        assert.equal(v.expectedRegistry, p.registry);
        assert.equal(v.orders.length, 6);
        assert.equal(new Set(v.orders.map(order => JSON.stringify(order))).size, 6);
    }
});
test('paired operation tables and event tables may reorder without changing projection', () => {
    for (const v of vectors) {
        const input = structuredClone(v);
        input.operations.reverse(); input.ids.reverse();
        input.events.reverse();
        input.orders = input.orders.map(order => order.map(i => input.events.length - 1 - i));
        assert.deepEqual(normalized(input), normalized(v));
    }
});
test('a copied complete permutation cannot inflate coverage', () => {
    const input = structuredClone(vectors[0]);
    input.orders[1] = [...input.orders[0]];
    assert.throws(() => migrationProjection(input), /duplicate delivery orders/);
});
