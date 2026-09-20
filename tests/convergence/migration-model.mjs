import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

// Audit oracle: select a path from immutable signed ancestry. This does not
// simulate insertion/replay, and is not yet a Lean proof for registry changes.
export function migrationProjection(v) {
    assert.equal(v.ids.length, v.operations.length);
    assert.equal(new Set(v.ids).size, v.ids.length);
    const roots = v.operations.flatMap((op, i) => op.type === 'create' ? [i] : []);
    assert.equal(roots.length, 1);
    const root = roots[0], create = v.operations[root];
    assert.equal(v.did, 'did:cid:' + v.ids[root]);
    assert.deepEqual(create.registration, { version: 1, type: 'agent', registry: 'BTC:signet' });
    const parents = v.operations.map((op, i) => {
        if (i === root) return null;
        assert.equal(op.type, 'update');
        assert.equal(op.did, v.did);
        assert.equal(op.proof.verificationMethod, v.did + '#key-1');
        assert(Object.keys(op.doc).every(k => ['didDocumentData', 'didDocumentRegistration'].includes(k)));
        const parent = v.ids.indexOf(op.previd);
        assert(parent >= 0, 'missing predecessor');
        if (op.doc.didDocumentRegistration) assert.deepEqual(op.doc.didDocumentRegistration,
            { version: 1, type: 'agent', registry: op.doc.didDocumentRegistration.registry });
        return parent;
    });
    const after = (i, seen = new Set()) => {
        assert(!seen.has(i), 'cyclic ancestry');
        if (i === root) return create.registration.registry;
        const previous = after(parents[i], new Set([...seen, i]));
        return v.operations[i].doc.didDocumentRegistration?.registry ?? previous;
    };
    const expectedRegistries = v.operations.map((_, i) => i === root ? after(root) : after(parents[i]));
    assert.equal(new Set(v.orders.map(order => JSON.stringify(order))).size, v.orders.length, 'duplicate delivery orders');
    for (const order of v.orders) {
        assert.equal(order.length, v.events.length, 'complete permutation required');
        assert.equal(new Set(order).size, v.events.length, 'complete permutation required');
        assert(order.every(t => Number.isInteger(t) && v.events[t]), 'unknown event');
    }
    const owners = v.events.map(e => {
        const i = v.operations.findIndex(op => isDeepStrictEqual(e.operation, op));
        assert(i >= 0, 'event does not match signed operation');
        return i;
    });
    const compare = (a, b) => {
        assert.equal(v.events[a].registry, v.events[b].registry, 'cannot compare cross-registry positions');
        const x = v.events[a].ordinal, y = v.events[b].ordinal;
        for (let j = 0; j < Math.max(x.length, y.length); j++) {
            if (j === x.length) return -1;
            if (j === y.length) return 1;
            if (x[j] !== y[j]) return x[j] - y[j];
        }
        return 0;
    };
    const preferred = v.operations.map((_, i) => {
        const anchors = v.events.flatMap((e, t) => owners[t] === i && e.registry === expectedRegistries[i] ? [t] : []);
        assert(anchors.length, 'audit requires a matching-chain anchor for every operation');
        for (const t of anchors) assert(v.events[t].ordinal.length && v.events[t].ordinal.every(x => Number.isSafeInteger(x) && x >= 0));
        anchors.sort(compare);
        for (let j = 1; j < anchors.length; j++) assert(compare(anchors[j - 1], anchors[j]) < 0, 'tied positions outside audit domain');
        return anchors[0];
    });
    const path = [root];
    for (;;) {
        const children = parents.flatMap((p, i) => p === path.at(-1) ? [i] : []);
        if (!children.length) break;
        children.sort((a, b) => compare(preferred[a], preferred[b]));
        for (let j = 1; j < children.length; j++) assert(compare(preferred[children[j - 1]], preferred[children[j]]) < 0, 'tied sibling positions outside audit domain');
        path.push(children[0]);
    }
    return { path, expectedRegistries, events: path.map(i => preferred[i]), registry: after(path.at(-1)) };
}
