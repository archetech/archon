import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { generateDocumentFixtures } from './generate-document-fixtures.mjs';
import { documentGraph } from '../../tests/convergence/document-model.mjs';
const vectors = JSON.parse(readFileSync(new URL('../../tests/convergence/document-vectors.json', import.meta.url), 'utf8'));

test('document traces reproduce warnings-as-errors Lean fixtures', () => {
    const result = generateDocumentFixtures(vectors);
    assert.equal(result, readFileSync(new URL('./DocumentFixtures.lean', import.meta.url), 'utf8'));
    assert.match(result, /set_option warningAsError true/);
    assert.equal(vectors.reduce((n, v) => n + v.scenarios.reduce((m, s) => m + s.orders.length, 0), 0), 612);
});

test('operation-table order does not change the graph, initial document, or results', () => {
    const input = structuredClone(vectors);
    for (const vector of input) {
        const remap = i => vector.ids.length - 1 - i;
        for (const key of ['ids', 'operations', 'signatureValid', 'states']) vector[key].reverse();
        for (const scenario of vector.scenarios) {
            scenario.orders = scenario.orders.map(order => order.map(remap));
            scenario.expected = scenario.expected.map(remap);
        }
    }
    assert.equal(generateDocumentFixtures(input), generateDocumentFixtures(vectors));
});

test('method names normalize independently of public-key identity', () => {
    const vector = vectors[0];
    const graph = documentGraph(vector);
    assert.equal(graph.named[2], graph.named[6]);
    const before = graph.documents[graph.ranks[1]].find(m => m.id === graph.named[2]);
    const after = graph.documents[graph.ranks[5]].find(m => m.id === graph.named[6]);
    assert.notEqual(before.key, after.key);
    const input = structuredClone(vector);
    for (const operation of input.operations) {
        for (const method of operation.doc?.didDocument?.verificationMethod ?? []) {
            method.id = method.id.startsWith('#') ? input.did + method.id : method.id.slice(input.did.length);
        }
    }
    assert.deepEqual(documentGraph(input), graph);
});

test('rejects missing/multiple genesis and shapes outside the document model', () => {
    const mutations = [
        v => { v.operations[0].type = 'update'; },
        v => { v.operations[1].type = 'create'; },
        v => { v.operations[0].registration.type = 'asset'; },
        v => { v.operations[1].doc = {}; },
        v => { v.operations[1].doc.didDocumentData = {}; },
        v => { v.operations[1].doc.didDocument.controller = 'did:cid:other'; },
        v => { v.operations[1].doc.didDocument.verificationMethod[0].controller = 'did:cid:other'; },
        v => { v.operations[1].doc.didDocument.verificationMethod[0].publicKeyJwk = {}; },
        v => { v.operations[1].previd = 'missing'; },
        v => { v.operations[1].previd = v.ids[1]; },
        v => { v.ids[1] = v.ids[0]; },
        v => { v.signatureValid[0] = []; },
    ];
    for (const mutate of mutations) {
        const input = structuredClone(vectors);
        mutate(input[0]);
        assert.throws(() => generateDocumentFixtures(input), /create|genesis|replacement|document model|verification method|public key|predecessor|Cyclic|distinct IDs|oracle/);
    }
});
