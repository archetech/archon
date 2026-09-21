import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { generateAssetFixtures } from './generate-asset-fixtures.mjs';
import { assetGraph, assetScenario } from '../../tests/convergence/asset-model.mjs';
const vectors = JSON.parse(readFileSync(new URL('../../tests/convergence/asset-vectors.json', import.meta.url), 'utf8'));
test('asset bridge connects source reconstruction, authorization, complete results and the integrated theorem', () => {
    const code = generateAssetFixtures(vectors);
    for (const expression of ['reconciledControllerHistories', 'assetReceiptAuthorized', 'assetResult', 'integrated_asset_convergence', 'AssetCidRanks', 'rootNotDeleted']) assert(code.assets.includes(expression));
    assert(code.controllers.includes('methods_agree'));
});
for (const [name, mutate] of [
    ['deleted root', v => { v.operations[0].type = 'delete'; }],
    ['missing predecessor', v => { v.operations[1].previd = 'unknown'; }],
    ['asset kind', v => { v.operations[0].registration.type = 'agent'; }],
    ['detached event', v => { v.events[0].operation = { type: 'unknown' }; }],
    ['signature dimensions', v => { v.signatureValid.pop(); }],
    ['agent genesis signature', v => { v.controllers[0].signatureValid[0] = v.keys.map(() => false); }],
    ['whole-document owner', v => { delete v.operations[1].doc.didDocument.controller; }],
    ['wrong expected payload', v => { v.stages[0].components.didDocumentData = { wrong: true }; }],
    ['wrong deletion metadata', v => { v.stages[0].deactivated = !v.stages[0].deactivated; }],
    ['different evidence', v => { v.stages[0].orders[1].pop(); }],
]) test(`rejects bridge drift: ${name}`, () => {
    const v = structuredClone(vectors[0]); mutate(v); assert.throws(() => generateAssetFixtures([v]));
});
test('operation and event table order are not protocol assumptions', () => {
    const v = structuredClone(vectors.find(v => v.mode === 'chain'));
    const size = v.operations.length;
    v.operations.reverse(); v.ids.reverse(); v.signatureValid.reverse();
    for (const c of v.controllers) { c.operations.reverse(); c.ids.reverse(); c.signatureValid.reverse(); }
    const events = v.events.length;
    v.events.reverse(); v.labels.reverse();
    for (const stage of v.stages) {
        stage.evidence = stage.evidence.map(i => events - i - 1);
        stage.orders = stage.orders.map(order => order.map(i => events - i - 1));
        stage.expected = stage.expected.map(i => size - i - 1);
    }
    assert.doesNotThrow(() => generateAssetFixtures([v]));
});
test('late history changes revoke and recover retained operations', () => {
    for (const v of vectors.filter(v => v.mode !== 'local-controllers')) {
        const stages = v.transitions.map(name => v.stages.find(stage => stage.name === name));
        assert(stages[0].expected.includes(1));
        assert(!stages[1].expected.includes(1) && stages[1].expected.includes(2));
        assert(!stages[1].deactivated || stages[1].expected.includes(5));
        assert(stages[2].deactivated && !stages[2].expected.includes(5));
        assert(v.stages.find(stage => stage.name === 'missing-recipient').expected.length === 1);
        const d = assetGraph(v);
        assert.deepEqual(assetScenario(v, d, stages[2].orders[1]).expected, stages[2].expected);
    }
});

test('rejects duplicate methods published by an asset', () => {
    const v = structuredClone(vectors[0]);
    const doc = v.operations.find(op => op.doc?.didDocument).doc.didDocument;
    doc.verificationMethod = [{ id: '#key-1' }, { id: doc.id + '#key-1' }];
    assert.throws(() => assetGraph(v), /Duplicate normalized/);
});
