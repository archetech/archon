import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { generateComponentFixtures } from './generate-component-fixtures.mjs';
import { componentGraph, componentStates } from '../../tests/convergence/component-model.mjs';
const vectors = JSON.parse(readFileSync(new URL('../../tests/convergence/component-vectors.json', import.meta.url), 'utf8'));

test('signed component vectors reproduce warnings-as-errors Lean examples', () => {
    assert.equal(generateComponentFixtures(vectors), readFileSync(new URL('./ComponentFixtures.lean', import.meta.url), 'utf8'));
});

test('operation-table reordering preserves graph and complete-component results', () => {
    const input = structuredClone(vectors);
    for (const vector of input) {
        const remap = i => vector.ids.length - 1 - i;
        for (const key of ['ids', 'operations', 'signatureValid', 'states']) vector[key].reverse();
        for (const scenario of vector.scenarios) {
            scenario.orders = scenario.orders.map(order => order.map(remap));
            scenario.expected = scenario.expected.map(remap);
        }
    }
    assert.equal(generateComponentFixtures(input), generateComponentFixtures(vectors));
});

test('replacement removes old members while omitted components carry forward', () => {
    for (const vector of vectors) {
        const states = componentStates(vector, componentGraph(vector));
        assert.deepEqual(states[2].didDocumentData, { retained: 'two' });
        assert.deepEqual(states[2].didDocument, states[1].didDocument);
        assert.deepEqual(states[3].didDocumentData, states[1].didDocumentData);
        assert.equal(states[3].didDocument.alsoKnownAs, undefined);
        assert.deepEqual(states[4].didDocumentData, {});
        assert.deepEqual(states[9], states[2]);
        assert.deepEqual(states[8], { didDocument: { id: vector.did }, didDocumentData: {}, didDocumentRegistration: states[1].didDocumentRegistration });
        assert.equal(states[6], null);
        assert.equal(states[7], null);
    }
});

test('bridge excludes migration, controller changes, unknown components, and missing genesis', () => {
    const mutations = [
        v => { v.operations[1].doc.didDocumentRegistration.registry = 'BTC:signet'; },
        v => { v.operations[1].doc.didDocument.controller = 'did:cid:other'; },
        v => { v.operations[1].doc.extra = {}; },
        v => { v.operations[0].type = 'update'; },
    ];
    for (const mutate of mutations) {
        const input = structuredClone(vectors);
        mutate(input[0]);
        assert.throws(() => generateComponentFixtures(input), /Registry changes|document model|replacement|create/);
    }
});
