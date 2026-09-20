import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { generateRegistryInterleavedFixtures } from './generate-registry-interleaved-fixtures.mjs';
import { migrationProjection } from '../../tests/convergence/migration-model.mjs';
const vectors = JSON.parse(readFileSync(new URL('../../tests/convergence/migration-vectors.json', import.meta.url), 'utf8'));

test('signed migration interleavings instantiate projection, replay, and transition proofs', () => {
    const { lean, cases, transitions, passChecks } = generateRegistryInterleavedFixtures(vectors);
    assert.equal(lean, readFileSync(new URL('./RegistryInterleavedFixtures.lean', import.meta.url), 'utf8'));
    assert.deepEqual(cases, JSON.parse(readFileSync(new URL('../../tests/convergence/registry-interleaved-cases.json', import.meta.url), 'utf8')));
    assert.equal(cases.length, 28);
    assert.equal(transitions, 1225);
    assert.equal(passChecks, 74);
});

test('paired operation and event table reordering preserves proof and decoded traces', () => {
    const expected = generateRegistryInterleavedFixtures(vectors);
    for (const mode of ['operations', 'events', 'both']) {
        const input = structuredClone(vectors);
        for (const v of input) {
            if (mode !== 'events') {
                v.operations.reverse(); v.ids.reverse();
                v.expected = v.expected.map(i => v.operations.length - 1 - i);
            }
            if (mode !== 'operations') {
                v.events.reverse();
                v.orders = v.orders.map(order => order.map(t => v.events.length - 1 - t));
                v.expectedEvents = v.expectedEvents.map(t => v.events.length - 1 - t);
            }
        }
        const actual = generateRegistryInterleavedFixtures(input);
        assert.equal(actual.lean, expected.lean);
        if (mode !== 'operations') for (const c of actual.cases) {
            const restore = t => input[c.vector].events.length - 1 - t;
            c.seed = restore(c.seed); c.order = c.order.map(restore);
            c.passes = c.passes.map(pass => pass.map(path => path.map(restore)));
        }
        assert.deepEqual(actual.cases, expected.cases);
    }
});

test('distinct provisional receipts retain the first full receipt in both arrival directions', () => {
    const { cases } = generateRegistryInterleavedFixtures(vectors);
    const directions = new Set();
    for (const c of cases) {
        const v = vectors[c.vector], projection = migrationProjection(v);
        const owner = t => v.operations.findIndex(op => isDeepStrictEqual(op, v.events[t].operation));
        const provisional = t => v.events[t].registry !== projection.expectedRegistries[owner(t)];
        let before = [c.seed];
        for (const pass of c.passes) for (const [i, after] of pass.entries()) {
            const incoming = c.order[i], current = before.find(t => owner(t) === owner(incoming));
            if (current !== undefined && current !== incoming && provisional(current) && provisional(incoming)) {
                assert(after.includes(current));
                assert(!after.includes(incoming));
                directions.add(v.events[current].registry === 'hyperswarm' ? 'gossip-first' : 'wrong-chain-first');
            }
            before = after;
        }
    }
    assert.deepEqual([...directions].sort(), ['gossip-first', 'wrong-chain-first']);
});
