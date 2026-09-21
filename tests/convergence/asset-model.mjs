import { assertChainMetadata } from './chain-metadata.mjs';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { integratedAgentGraph, comparePositions } from './integrated-agent-model.mjs';
export const unanchored = name => ['local', 'hyperswarm', 'pin'].includes(name);
export const assetRegistryNames = vectors => [...new Set(['local', ...vectors.flatMap(v => [
    ...v.events.map(e => e.registry), ...v.operations.flatMap(op => [op.registration?.registry, op.doc?.didDocumentRegistration?.registry].filter(Boolean)),
])])].sort();
export function assetGraph(v, names = assetRegistryNames([v])) {
    const creates = v.operations.flatMap((op, i) => op.type === 'create' ? [i] : []);
    assert.equal(creates.length, 1, 'one creation required');
    const root = creates[0], create = v.operations[root];
    assert.equal(v.did, 'did:cid:' + v.ids[root]);
    assert(create.registration.type === 'asset' && create.registration.version === 1 && typeof create.controller === 'string');
    assert(Object.keys(create).every(k => ['type', 'created', 'registration', 'controller', 'data', 'proof'].includes(k)), 'unsupported genesis shape');
    assert(v.ids.length === v.operations.length && new Set(v.ids).size === v.ids.length, 'distinct operation identities required');
    assert(v.signatureValid.length === v.operations.length && v.signatureValid.every(row => row.length === v.keys.length && row.every(b => typeof b === 'boolean')), 'signature oracle dimensions');
    const sorted = [...v.ids].sort(), ranks = v.ids.map(id => sorted.indexOf(id));
    const parents = v.operations.map((op, i) => {
        if (i === root) return null;
        assert(op.did === v.did && ['update', 'delete'].includes(op.type), 'asset successor shape');
        assert(Object.keys(op).every(k => ['type', 'did', 'previd', 'proof', 'doc'].includes(k)), 'asset successor fields');
        assert(op.type === 'delete' ? !op.doc : op.doc && Object.keys(op.doc).length > 0 && Object.keys(op.doc).every(k => ['didDocument', 'didDocumentData', 'didDocumentRegistration'].includes(k)), 'asset component shape');
        if (op.doc?.didDocument) assert(op.doc.didDocument.id === v.did && typeof op.doc.didDocument.controller === 'string', 'asset owner document');
        if (op.doc?.didDocumentRegistration) assert(op.doc.didDocumentRegistration.version === 1 && op.doc.didDocumentRegistration.type === 'asset', 'immutable asset kind/version');
        const parent = v.ids.indexOf(op.previd); assert(parent >= 0, 'source predecessor missing'); return parent;
    });
    const depth = (i, seen = new Set()) => { assert(!seen.has(i), 'cyclic source'); return parents[i] === null ? 0 : 1 + depth(parents[i], new Set([...seen, i])); };
    const depths = v.operations.map((_, i) => depth(i));
    const genesisDocument = { '@context': ['https://www.w3.org/ns/did/v1'], id: v.did, controller: create.controller };
    const structural = i => {
        if (i === root) return { didDocument: genesisDocument, didDocumentData: create.data ?? {}, didDocumentRegistration: create.registration, deactivated: false };
        const before = structural(parents[i]);
        if (!before || before.deactivated) return null;
        if (v.operations[i].type === 'delete') return { ...before, didDocument: { id: v.did }, didDocumentData: {}, deactivated: true };
        return { ...before, ...v.operations[i].doc };
    };
    const components = v.operations.map((_, i) => structural(i));
    const expected = v.operations.map((_, i) => components[i === root ? i : parents[i]]?.didDocumentRegistration.registry ?? '');
    v.events.forEach(assertChainMetadata);
    const owners = v.events.map(e => {
        const owner = v.operations.findIndex(op => isDeepStrictEqual(op, e.operation));
        if (owner >= 0) assert(e.did === undefined || e.did === v.did, 'receipt DID must match operation target');
        return owner;
    });
    const controllerVectors = v.controllers.map(c => ({ ...c, keys: v.keys, scenarios: [],
        events: v.events.filter(e => c.operations.some(op => isDeepStrictEqual(op, e.operation))) }));
    const controllers = controllerVectors.map(c => integratedAgentGraph(c, names));
    for (const e of v.events) assert(owners[v.events.indexOf(e)] >= 0 || controllerVectors.some(c => c.events.includes(e)), 'unowned receipt');
    const ownerNames = [...new Set([create.controller, ...v.operations.flatMap(op => op.doc?.didDocument ? [op.doc.didDocument.controller] : []), ...v.controllers.map(c => c.did)])].sort();
    const positioned = i => !unanchored(v.events[i].registry);
    const compare = (a, b) => names.indexOf(v.events[a].registry) - names.indexOf(v.events[b].registry)
        || comparePositions(v.events[a].ordinal, v.events[b].ordinal) || ranks[owners[a]] - ranks[owners[b]];
    const anchorEvents = v.events.map((_, i) => i).filter(i => owners[i] >= 0 && positioned(i));
    for (const i of anchorEvents) assert(v.events[i].ordinal?.length && v.events[i].ordinal.every(x => Number.isSafeInteger(x) && x >= 0), 'chain ordinal required');
    const anchors = anchorEvents.slice().sort(compare).filter((i, n, xs) => n === 0 || compare(i, xs[n - 1]) !== 0);
    for (const i of anchorEvents) {
        const same = v.events[anchors.find(j => compare(i, j) === 0)];
        assert.equal(Date.parse(v.events[i].time), Date.parse(same.time), 'authoritative chain clock');
        assert.equal(!!v.events[i].registration, !!same.registration, 'authoritative registration');
    }
    const receiptRanks = v.events.map((_, i) => owners[i] < 0 ? -1 : positioned(i) ? anchors.findIndex(j => compare(i, j) === 0) : anchors.length + ranks[owners[i]]);
    return { root, ranks, parents, depths, components, expected, owners, names, ownerNames, anchors, receiptRanks, controllers, controllerVectors, genesisDocument };
}
export function assetScenario(v, g, evidence) {
    const histories = g.controllers.map((cg, c) => {
        const cv = g.controllerVectors[c];
        const retained = evidence.map(i => cv.events.indexOf(v.events[i])).filter(i => i >= 0);
        const root = cg.ranks.indexOf(cg.root);
        if (!retained.some(i => cg.owners[i] === root)) return [];
        const priority = op => Math.min(cg.anchors.length + cg.ranks[op], ...retained.filter(i => cg.owners[i] === op && cv.events[i].registry === cg.expected[op] && cg.rank[i] < cg.anchors.length).map(i => cg.rank[i]));
        const path = [root];
        for (;;) {
            const next = [...new Set(retained.map(i => cg.owners[i]))].filter(i => cg.parents[i] === path.at(-1) && cg.states[i] !== null).sort((a, b) => priority(a) - priority(b))[0];
            if (next === undefined) break; path.push(next);
        }
        const result = [];
        for (const op of path) {
            const matching = retained.filter(i => cg.owners[i] === op && cv.events[i].registry === cg.expected[op]);
            if (result.length && !matching.length) break;
            const anchor = matching.filter(i => cg.rank[i] < cg.anchors.length).sort((a, b) => cg.rank[a] - cg.rank[b])[0];
            result.push({ op, matching: matching.length > 0, registry: cg.expected[op],
                anchor: anchor === undefined ? null : cv.events[anchor],
                time: Date.parse(anchor === undefined ? cv.operations[op].proof.created : cv.events[anchor].time) });
        }
        return result;
    });
    const select = (owner, e) => {
        const c = v.controllers.findIndex(c => c.did === owner);
        if (c < 0 || !histories[c].length) return null;
        const history = histories[c], cg = g.controllers[c];
        const prefix = chain => {
            let last = history[0];
            for (const item of history.slice(1)) {
                if (!item.matching || !(chain && item.anchor?.registry === e.registry
                    ? comparePositions(item.anchor.ordinal, e.ordinal) < 0
                    : item.time <= Date.parse(chain ? e.time : e.operation.proof.created))) break;
                last = item;
            }
            return cg.components[last.op];
        };
        const bounded = prefix(true);
        const anchored = !unanchored(bounded.didDocumentRegistration.registry)
            && history.some(h => h.matching && h.anchor?.registration)
            && history.every(h => !h.matching || !h.anchor || !!h.anchor.registration);
        return e.registration && anchored ? bounded : prefix(false);
    };
    const active = state => !!state?.didDocument.verificationMethod;
    const authorized = v.events.map((e, eventIndex) => {
        const op = g.owners[eventIndex];
        if (op < 0 || !g.components[op]) return false;
        const before = op === g.root ? g.components[op] : g.components[g.parents[op]];
        if (!before || before.deactivated) return false;
        const owner = before.didDocument.controller;
        const selected = select(owner, e);
        if (!active(selected)) return false;
        const reference = e.operation.proof.verificationMethod;
        const absolute = reference.startsWith('#') ? owner + reference : reference;
        if (op === g.root && reference.split('#')[0] !== owner) return false;
        const method = selected.didDocument.verificationMethod.find(m => (m.id.startsWith('#') ? owner + m.id : m.id) === absolute);
        const key = v.keys.findIndex(k => isDeepStrictEqual(k, method?.publicKeyJwk));
        if (key < 0 || !v.signatureValid[op][key]) return false;
        if (op === g.root && selected.didDocumentRegistration.registry === 'local' && g.expected[op] !== 'local') return false;
        const prospective = e.operation.doc?.didDocument?.controller;
        return !prospective || prospective === owner || active(select(prospective, e));
    });
    const available = evidence.filter(i => g.owners[i] >= 0 && authorized[i]);
    const priority = op => Math.min(g.anchors.length + g.ranks[op], ...available.filter(i => g.owners[i] === op && g.receiptRanks[i] < g.anchors.length && v.events[i].registry === g.expected[op]).map(i => g.receiptRanks[i]));
    const path = available.some(i => g.owners[i] === g.root) ? [g.root] : [];
    while (path.length) {
        const next = [...new Set(available.map(i => g.owners[i]))].filter(i => g.parents[i] === path.at(-1)).sort((a, b) => priority(a) - priority(b))[0];
        if (next === undefined) break; path.push(next);
    }
    const full = path.length ? g.components[path.at(-1)] : null;
    const { deactivated, ...components } = full ?? {};
    return { expected: path, components: full ? components : null, deactivated: !!deactivated, authorized, histories };
}
