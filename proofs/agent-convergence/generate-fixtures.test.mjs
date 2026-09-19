import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { generateFixtures } from './generate-fixtures.mjs';

const fixture = JSON.parse(readFileSync(new URL('../../tests/convergence/vectors.json', import.meta.url), 'utf8'));

test('current signed traces reproduce the committed Lean examples', () => {
    const { result, count } = generateFixtures(fixture);
    assert.equal(count, 420);
    assert.equal(result, readFileSync(new URL('./Fixtures.lean', import.meta.url), 'utf8'));
});

test('rejects an empty update document rather than treating it as authorized data', () => {
    const input = structuredClone(fixture);
    input.histories[0].operations.find(op => op.type === 'update').doc = {};
    assert.throws(() => generateFixtures(input), /only supports data-only updates/);
});

test('requires exactly one genesis per history', () => {
    for (const mode of ['missing', 'multiple']) {
        const input = structuredClone(fixture);
        const operations = input.histories[0].operations;
        if (mode === 'missing') operations.find(op => op.type === 'create').type = 'update';
        else operations.find(op => op.type === 'update').type = 'create';
        assert.throws(() => generateFixtures(input), /exactly one create operation/);
    }
});

test('reordering the operation table preserves the model, root, and every trace', () => {
    const input = structuredClone(fixture);
    for (const history of input.histories) {
        const remap = index => history.operations.length - 1 - index;
        history.operations.reverse();
        history.ids.reverse();
        for (const scenario of input.scenarios.filter(s => s.registry === history.registry)) {
            for (const row of scenario.cases) {
                row.order = row.order.map(remap);
                row.expected = row.expected.map(remap);
            }
        }
    }
    assert.equal(generateFixtures(input).result, generateFixtures(fixture).result);
});

// Representation cases use complete event payloads and the same signed operation table.
const recordCases = JSON.parse(readFileSync(new URL('../../tests/convergence/record-cases.json', import.meta.url), 'utf8'));
const { generateRecordFixtures } = await import('./generate-record-fixtures.mjs');

test('signed representation cases reproduce the committed full-record examples', () => {
    assert.equal(generateRecordFixtures(fixture, recordCases), readFileSync(new URL('./RecordFixtures.lean', import.meta.url), 'utf8'));
});

test('representation bridge rejects branch changes and broken initial paths', () => {
    const outside = structuredClone(recordCases);
    outside.cases[0].events.at(-1).operation = 2;
    assert.throws(() => generateRecordFixtures(fixture, outside), /only duplicates of the settled path/);
    const broken = structuredClone(recordCases);
    broken.cases[0].events[2].operation = 2;
    assert.throws(() => generateRecordFixtures(fixture, broken), /predecessor linked/);
});
