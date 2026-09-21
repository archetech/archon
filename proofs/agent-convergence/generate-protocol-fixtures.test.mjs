import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { reorderedProtocolVector } from './check-protocol-reordering.mjs';
import { generateProtocolFixtures } from './generate-protocol-fixtures.mjs';
const vectors = JSON.parse(readFileSync(new URL('../../tests/convergence/asset-vectors.json', import.meta.url), 'utf8'));
test('final bridge checks typed family, source admission and actual composed execution', () => {
    const code = generateProtocolFixtures(vectors);
    for (const expression of ['ProtocolAgentDomain', 'ProtocolAssetDomain', 'ProtocolSources',
        'protocol_convergence', 'reconcileProtocol', 'methods_agree', 'sameAgentSourceCheck',
        'incompleteSources', 'incompleteWorld', 'ProtocolReceiptSources']) assert(code.includes(expression));
});
test('final bridge preserves source-table independence', () => {
    const v = reorderedProtocolVector(vectors.find(v => v.mode === 'chain'));
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
