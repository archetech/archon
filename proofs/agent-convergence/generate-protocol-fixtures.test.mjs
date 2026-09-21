import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { generateProtocolFixtures } from './generate-protocol-fixtures.mjs';
const vectors = JSON.parse(readFileSync(new URL('../../tests/convergence/asset-vectors.json', import.meta.url), 'utf8'));
test('final bridge checks typed family, source admission and actual composed execution', () => {
    const code = generateProtocolFixtures(vectors);
    for (const expression of ['ProtocolAgentDomain', 'ProtocolAssetDomain', 'ProtocolSources',
        'protocol_convergence', 'reconcileProtocol', 'methods_agree', 'sameAgentSourceCheck']) assert(code.includes(expression));
});
test('final bridge preserves source-table independence', () => {
    const v = structuredClone(vectors.find(v => v.mode === 'chain'));
    const count = v.operations.length, events = v.events.length;
    v.operations.reverse(); v.ids.reverse(); v.signatureValid.reverse();
    for (const c of v.controllers) { c.operations.reverse(); c.ids.reverse(); c.signatureValid.reverse(); }
    v.events.reverse(); v.labels.reverse();
    for (const stage of v.stages) {
        stage.evidence = stage.evidence.map(i => events - i - 1);
        stage.orders = stage.orders.map(order => order.map(i => events - i - 1));
        stage.expected = stage.expected.map(i => count - i - 1);
    }
    assert.doesNotThrow(() => generateProtocolFixtures([v]));
});
for (const [name, change] of [
    ['controller signature', v => { v.controllers[0].signatureValid[0] = v.keys.map(() => false); }],
    ['missing ordinal', v => { delete v.events.find(e => e.registry.includes(':')).ordinal; }],
    ['detached payload', v => { v.stages[0].components.didDocumentData = { bad: true }; }],
    ['different retained evidence', v => { v.stages[0].orders[1].pop(); }],
]) test(`final bridge rejects ${name}`, () => {
    const v = structuredClone(vectors.find(v => v.mode === 'chain'));
    change(v);
    assert.throws(() => generateProtocolFixtures([v]));
});
