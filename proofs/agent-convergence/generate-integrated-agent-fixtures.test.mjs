import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { generateIntegratedAgentFixtures } from './generate-integrated-agent-fixtures.mjs';
import { integratedAgentGraph } from '../../tests/convergence/integrated-agent-model.mjs';
const vectors = JSON.parse(readFileSync(new URL('../../tests/convergence/integrated-agent-vectors.json', import.meta.url), 'utf8'));
test('integrated signed source generates the checked Lean bridge', () => {
    assert.equal(generateIntegratedAgentFixtures(vectors), readFileSync(new URL('./IntegratedAgentFixtures.lean', import.meta.url), 'utf8'));
});
test('paired operation-table reordering preserves semantic graphs', () => {
    for (const v of vectors) {
        const before = integratedAgentGraph(v), changed = structuredClone(v), size = v.operations.length;
        changed.operations.reverse(); changed.ids.reverse(); changed.signatureValid.reverse();
        changed.scenarios.forEach(s => { s.expected = s.expected.map(i => size - i - 1); });
        const after = integratedAgentGraph(changed);
        assert.deepEqual(after.documents, before.documents);
        assert.deepEqual(after.scenarios.map(s => s.expected.map(i => after.ranks[i])), before.scenarios.map(s => s.expected.map(i => before.ranks[i])));
        assert.deepEqual(after.scenarios.map(s => s.components), before.scenarios.map(s => s.components));
        assert.doesNotThrow(() => generateIntegratedAgentFixtures([changed]));
    }
});
test('paired receipt-table reordering preserves rank keys and expected state', () => {
    for (const v of vectors) {
        const before = integratedAgentGraph(v), changed = structuredClone(v), size = v.events.length;
        changed.events.reverse();
        changed.scenarios.forEach(s => { s.orders = s.orders.map(order => order.map(i => size - i - 1)); });
        const after = integratedAgentGraph(changed);
        assert.deepEqual(after.rank.slice().reverse(), before.rank);
        assert.deepEqual(after.scenarios.map(s => s.components), before.scenarios.map(s => s.components));
    }
});
test('rejects detached receipt operations and changed signed predecessors', () => {
    const detached = structuredClone(vectors[0]); detached.events[0].operation.created = '2020-01-01T00:00:00Z';
    assert.throws(() => integratedAgentGraph(detached), /source operation/);
    const missing = structuredClone(vectors[0]); missing.operations[1].previd = 'unknown';
    assert.throws(() => integratedAgentGraph(missing), /Missing predecessor/);
});
test('rejects incorrect authorization tables, registration kinds, and unknown methods', () => {
    const unauthorized = structuredClone(vectors[0]); unauthorized.signatureValid[1] = unauthorized.keys.map(() => false);
    assert.throws(() => integratedAgentGraph(unauthorized), /expected path/);
    const kind = structuredClone(vectors[0]); kind.operations[1].doc.didDocumentRegistration.type = 'asset';
    assert.throws(() => integratedAgentGraph(kind), /Registry changes/);
    const method = structuredClone(vectors[0]); method.operations[1].doc.didDocument.verificationMethod[0].publicKeyJwk = {};
    assert.throws(() => integratedAgentGraph(method), /Unknown public key/);
});
test('requires positions for chain receipts but permits unpositioned hints', () => {
    const missing = structuredClone(vectors[0]);
    const index = missing.events.findIndex(e => e.registry === 'BTC:signet' && e.operation.type === 'create');
    for (const ordinal of [undefined, null, [], 7, [null, 1], [-1], [0.5], [Number.MAX_SAFE_INTEGER + 1]]) {
        missing.events[index].ordinal = ordinal;
        assert.throws(() => integratedAgentGraph(missing), /chain receipt requires an ordinal/);
    }
    const hints = structuredClone(vectors[0]);
    for (const event of hints.events) if (event.registry === 'hyperswarm') delete event.ordinal;
    assert.doesNotThrow(() => integratedAgentGraph(hints));
});

test('receipt classes retain authorization facts while allowing irrelevant labels', () => {
    const v = structuredClone(vectors[0]);
    const i = v.events.findIndex(e => e.registry === 'BTC:signet');
    const duplicate = structuredClone(v.events[i]);
    duplicate.registration.txid = 'another-transaction';
    duplicate.registration.batch = 'another-batch';
    v.events.push(duplicate);
    const graph = integratedAgentGraph(v);
    assert.equal(graph.rank[i], graph.rank.at(-1));
    duplicate.time = '2026-09-05T00:02:00.000Z';
    assert.throws(() => integratedAgentGraph(v), /authoritative time/);
});
test('receipt view survives operation and receipt table reorderings', () => {
    for (const v of vectors) {
        const before = integratedAgentGraph(v), changed = structuredClone(v);
        changed.operations.reverse(); changed.ids.reverse(); changed.signatureValid.reverse();
        changed.scenarios.forEach(s => { s.expected = s.expected.map(i => changed.operations.length - i - 1); });
        assert.deepEqual(integratedAgentGraph(changed).scenarios.map(s => s.receiptView), before.scenarios.map(s => s.receiptView));
    }
});

test('requires genesis authorization by its own creation key', () => {
    for (const original of vectors) {
        const v = structuredClone(original);
        const root = v.operations.findIndex(op => op.type === 'create');
        const key = v.keys.findIndex(key => JSON.stringify(key) === JSON.stringify(v.operations[root].publicJwk));
        v.signatureValid[root] = v.keys.map((_, index) => index !== key);
        assert.throws(() => integratedAgentGraph(v), /genesis requires/);
        const method = structuredClone(original);
        method.operations[root].proof.verificationMethod = '#key-2';
        assert.throws(() => integratedAgentGraph(method), /genesis requires/);
    }
});
