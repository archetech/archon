import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { generateAgentFixtures } from './generate-agent-fixtures.mjs';

const fixture = JSON.parse(readFileSync(new URL('../../tests/convergence/agent-vectors.json', import.meta.url), 'utf8'));

test('signed agent traces reproduce committed Lean examples with warnings as errors', () => {
    const result = generateAgentFixtures(fixture);
    assert.equal(result, readFileSync(new URL('./AgentFixtures.lean', import.meta.url), 'utf8'));
    assert.match(result, /set_option warningAsError true/);
});

test('reordered operation tables preserve genesis, model, states, and every trace', () => {
    const input = structuredClone(fixture);
    for (const vector of input) {
        const remap = i => vector.ids.length - 1 - i;
        for (const field of ['ids', 'operations', 'actions', 'states', 'validBy']) vector[field].reverse();
        vector.parents = vector.parents.reverse().map(i => i === null ? null : remap(i));
        for (const scenario of vector.scenarios) {
            scenario.orders = scenario.orders.map(order => order.map(remap));
            scenario.expected = scenario.expected.map(remap);
        }
    }
    assert.equal(generateAgentFixtures(input), generateAgentFixtures(fixture));
});

test('requires exactly one genesis', () => {
    for (const type of ['update', 'create']) {
        const input = structuredClone(fixture);
        input[0].operations[type === 'update' ? 0 : 1].type = type;
        assert.throws(() => generateAgentFixtures(input), /exactly one create/);
    }
});

test('rejects unsupported signed operation shapes', () => {
    const mutations = [
        v => { v.operations[0].registration.type = 'asset'; },
        v => { v.operations[0].publicJwk = {}; },
        v => { v.operations[1].doc = {}; },
        v => { v.operations[1].doc.didDocumentData = {}; },
        v => { v.operations[1].doc.didDocument.verificationMethod.push(v.operations[1].doc.didDocument.verificationMethod[0]); },
        v => { v.operations[1].doc.didDocument.controller = 'did:cid:other'; },
        v => { v.operations[1].doc.didDocument.capabilityInvocation = []; },
        v => { v.operations[1].doc.didDocument.verificationMethod[0].publicKeyJwk = {}; },
        v => { v.operations[1].did = 'did:cid:other'; },
        v => { v.operations[1].type = 'unexpected'; },
        v => { v.operations[8].doc = {}; },
    ];
    for (const mutate of mutations) {
        const input = structuredClone(fixture);
        mutate(input[0]);
        assert.throws(() => generateAgentFixtures(input), /single-key|verification method|Deletion/);
    }
});

test('does not trust precomputed parent/action annotations', () => {
    for (const mutate of [v => { v.parents[1] = 2; }, v => { v.actions[1] = 'keep'; }]) {
        const input = structuredClone(fixture);
        mutate(input[0]);
        assert.throws(() => generateAgentFixtures(input), /graph disagrees/);
    }
});

test('rejects missing predecessors, duplicate IDs, and cyclic graphs', () => {
    const missing = structuredClone(fixture);
    missing[0].operations[1].previd = 'missing';
    assert.throws(() => generateAgentFixtures(missing), /predecessor/);
    const duplicate = structuredClone(fixture);
    duplicate[0].ids[1] = duplicate[0].ids[0];
    assert.throws(() => generateAgentFixtures(duplicate), /distinct canonical CIDs/);
    const cyclic = structuredClone(fixture);
    cyclic[0].operations[1].previd = cyclic[0].ids[1];
    cyclic[0].parents[1] = 1;
    assert.throws(() => generateAgentFixtures(cyclic), /Cyclic fixture/);
});
