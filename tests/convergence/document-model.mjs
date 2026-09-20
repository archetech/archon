import { isDeepStrictEqual } from 'node:util';

// Structural bridge only: signature validity is independently computed from
// signed bytes, and checked by the ordinary runtime import suites.
export function documentGraph(vector, components = false) {
    const { operations, ids, keys, did, signatureValid } = vector;
    const creates = operations.flatMap((op, i) => op.type === 'create' ? [i] : []);
    if (creates.length !== 1) throw new Error('Expected exactly one create');
    if (ids.length !== operations.length || new Set(ids).size !== ids.length) throw new Error('Expected distinct IDs');
    const sorted = [...ids].sort();
    const ranks = ids.map(id => sorted.indexOf(id));
    const root = creates[0];
    const create = operations[root];
    const keyIndex = key => {
        const index = keys.findIndex(candidate => isDeepStrictEqual(candidate, key));
        if (index < 0) throw new Error('Unknown public key');
        return index;
    };
    if (did !== 'did:cid:' + ids[root] || create.previd !== undefined
        || Object.keys(create).some(k => !['type', 'created', 'registration', 'publicJwk', 'proof'].includes(k))
        || !isDeepStrictEqual(create.registration, { version: 1, type: 'agent', registry: 'hyperswarm' })) {
        throw new Error('Expected self-controlled hyperswarm genesis');
    }
    const absolute = id => {
        if (typeof id !== 'string' || !id.includes('#')) throw new Error('Invalid method reference');
        return id.startsWith('#') ? did + id : id;
    };
    const names = new Set(operations.map(op => absolute(op.proof.verificationMethod)));
    const documents = operations.map((op, i) => {
        if (i === root) return [{ id: did + '#key-1', key: keyIndex(create.publicJwk) }];
        if (op.did !== did || !['update', 'delete'].includes(op.type)
            || Object.keys(op).some(k => !['type', 'did', 'previd', 'proof', 'doc'].includes(k))) throw new Error('Outside document model');
        if (op.type === 'delete') {
            if (Object.hasOwn(op, 'doc')) throw new Error('Deletion with document');
            return [];
        }
        if (!op.doc || Object.keys(op.doc).length === 0
            || Object.keys(op.doc).some(k => !['didDocument', 'didDocumentData', 'didDocumentRegistration'].includes(k))
            || (!components && Object.keys(op.doc).length !== 1)) throw new Error('Expected data-only update or document replacement');
        if (Object.hasOwn(op.doc, 'didDocumentRegistration')
            && (!components || !isDeepStrictEqual(op.doc.didDocumentRegistration, create.registration))) throw new Error('Registry changes are outside component model');
        if (!Object.hasOwn(op.doc, 'didDocument')) return [];
        const doc = op.doc.didDocument;
        if (!doc || doc.id !== did || !Array.isArray(doc.verificationMethod)
            || Object.keys(doc).some(k => ![...['@context', 'id', 'verificationMethod', 'authentication', 'assertionMethod', 'capabilityInvocation'], ...(components ? ['service', 'alsoKnownAs'] : [])].includes(k))) throw new Error('Outside document model');
        return doc.verificationMethod.map(method => {
            if (method.controller !== did || method.type !== 'EcdsaSecp256k1VerificationKey2019'
                || Object.keys(method).some(k => !['id', 'controller', 'type', 'publicKeyJwk'].includes(k))) throw new Error('Unsupported verification method');
            return { id: absolute(method.id), key: keyIndex(method.publicKeyJwk) };
        });
    });
    for (const doc of documents) for (const method of doc) names.add(method.id);
    const methodNames = [...names].sort();
    const parents = operations.map((op, i) => {
        if (i === root) return null;
        const parent = ids.indexOf(op.previd);
        if (parent < 0) throw new Error('Missing predecessor');
        return parent;
    });
    const depth = (i, seen = new Set()) => {
        if (seen.has(i)) throw new Error('Cyclic fixture');
        return parents[i] === null ? 0 : 1 + depth(parents[i], new Set([...seen, i]));
    };
    if (signatureValid.length !== operations.length || signatureValid.some(row => row.length !== keys.length || row.some(b => typeof b !== 'boolean'))) throw new Error('Invalid signature oracle dimensions');
    const byRank = ranks.map((_, rank) => ranks.indexOf(rank));
    return { root: ranks[root], ranks, parents, methodNames, depths: operations.map((_, i) => depth(i)),
        documents: byRank.map(i => documents[i].map(m => ({ id: methodNames.indexOf(m.id), key: m.key }))),
        named: operations.map(op => methodNames.indexOf(absolute(op.proof.verificationMethod))),
        actions: operations.map((op, i) => op.type === 'delete' ? 'delete' : op.doc?.didDocument ? ranks[i] : 'keep') };
}

export function documentStates(vector, graph) {
    const states = new Map();
    function at(i) {
        if (states.has(i)) return states.get(i);
        if (graph.ranks[i] === graph.root) return graph.root;
        const before = at(graph.parents[i]);
        const key = typeof before === 'number' ? graph.documents[before].find(m => m.id === graph.named[i])?.key : undefined;
        const state = key === undefined || !vector.signatureValid[i][key] ? null
            : graph.actions[i] === 'keep' ? before : graph.actions[i] === 'delete' ? 'deleted' : graph.actions[i];
        states.set(i, state);
        return state;
    }
    return vector.operations.map((_, i) => at(i));
}
