import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { componentGraph, componentStates } from './component-model.mjs';
import { documentStates } from './document-model.mjs';
export const comparePositions = (a, b) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
    return a.length - b.length;
};
export function integratedAgentGraph(vector, registryNames) {
    const graph = componentGraph(vector, true);
    const rootIndex = graph.ranks.indexOf(graph.root);
    const genesisMethod = graph.documents[graph.root].find(method => method.id === graph.named[rootIndex]);
    assert(vector.operations[rootIndex].proof.verificationMethod === '#key-1'
        && genesisMethod !== undefined && vector.signatureValid[rootIndex][genesisMethod.key],
    'genesis requires its own valid key-1 signature');
    const states = documentStates(vector, graph);
    const components = componentStates(vector, graph);
    const registryAt = i => i === rootIndex ? vector.operations[i].registration.registry
        : vector.operations[i].doc?.didDocumentRegistration?.registry ?? registryAt(graph.parents[i]);
    const expected = vector.operations.map((_, i) => registryAt(i === rootIndex ? i : graph.parents[i]));
    const owners = vector.events.map(event => {
        const i = vector.operations.findIndex(operation => isDeepStrictEqual(operation, event.operation));
        assert(i >= 0, 'receipt must contain a source operation');
        return i;
    });
    const chain = name => !['local', 'hyperswarm', 'pin'].includes(name);
    assert(vector.events.every(event => !chain(event.registry) || (Array.isArray(event.ordinal) && event.ordinal.length > 0 && event.ordinal.every(n => Number.isSafeInteger(n) && n >= 0))), 'chain receipt requires an ordinal');
    const positioned = i => chain(vector.events[i].registry);
    const anchorEvents = vector.events.map((_, i) => i).filter(positioned);
    // Registry-local ordinal/CID keys, quotienting repeated identical ordering keys.
    const derivedNames = [...new Set([...expected, ...vector.events.map(event => event.registry), ...vector.operations.flatMap(op => op.doc?.didDocumentRegistration ? [op.doc.didDocumentRegistration.registry] : [])])].sort();
    const names = registryNames ?? derivedNames;
    assert(new Set(names).size === names.length && derivedNames.every(name => names.includes(name)), 'registry projection must cover every source name');
    const compare = (x, y) => names.indexOf(vector.events[x].registry) - names.indexOf(vector.events[y].registry)
        || comparePositions(vector.events[x].ordinal, vector.events[y].ordinal)
        || graph.ranks[owners[x]] - graph.ranks[owners[y]];
    const anchors = [...anchorEvents].sort(compare).filter((i, n, sorted) => n === 0 || compare(i, sorted[n - 1]) !== 0);
    for (const i of anchorEvents) {
        const header = vector.events[i];
        const canonical = vector.events[anchors.find(j => compare(i, j) === 0)];
        assert.equal(Date.parse(header.time), Date.parse(canonical.time), 'same chain position must use the same authoritative time');
        assert.equal(!!header.registration, !!canonical.registration, 'same chain position must use the same registration status');
    }
    const rank = vector.events.map((_, i) => positioned(i)
        ? anchors.findIndex(j => compare(i, j) === 0) : anchors.length + graph.ranks[owners[i]]);
    const eligible = i => positioned(i) && vector.events[i].registry === expected[owners[i]] && states[owners[i]] !== null;
    const scenarios = vector.scenarios.map(scenario => {
        const retained = [...new Set(scenario.orders[0].map(i => owners[i]))];
        const anchorSet = [...new Set(scenario.orders[0].filter(positioned).map(i => rank[i]))];
        const priority = i => Math.min(anchors.length + graph.ranks[i], ...scenario.orders[0].filter(j => owners[j] === i && eligible(j)).map(j => rank[j]));
        const selected = [rootIndex];
        for (;;) {
            const children = retained.filter(i => graph.parents[i] === selected.at(-1) && states[i] !== null).sort((a, b) => priority(a) - priority(b));
            if (!children.length) break;
            selected.push(children[0]);
        }
        assert.deepEqual(selected, scenario.expected, 'independent expected path disagrees');
        for (const order of scenario.orders) assert.deepEqual([...new Set(order)].sort((a, b) => a - b), [...new Set(scenario.orders[0])].sort((a, b) => a - b));
        const receiptView = [];
        for (const owner of selected) {
            const sources = scenario.orders[0].filter(i => owners[i] === owner);
            const matched = sources.filter(i => vector.events[i].registry === expected[owner]);
            const chainReceipts = matched.filter(eligible).sort((x, y) => rank[x] - rank[y]);
            const matching = matched.length > 0;
            if (receiptView.length && !matching) break;
            const header = vector.events[chainReceipts[0]];
            receiptView.push({ operation: vector.ids[owner], matching,
                cutoff: !matching ? { kind: 'unconfirmed' } : header
                    ? { kind: 'chain', registry: header.registry, ordinal: header.ordinal,
                        time: Date.parse(header.time), registration: !!header.registration }
                    : { kind: 'unanchored', registry: expected[owner], time: Date.parse(vector.operations[owner].proof.created) } });
        }
        return { ...scenario, retained, anchorSet, components: components[selected.at(-1)], receiptView };
    });
    return { ...graph, states, components, owners, names, anchors, rank, expected, scenarios };
}
