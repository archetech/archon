import { documentGraph, documentStates } from './document-model.mjs';

export function componentGraph(vector, migrations = false) {
    const registry = migrations ? vector.operations.find(op => op.type === 'create').registration.registry : 'hyperswarm';
    const graph = documentGraph(vector, true, registry, migrations);
    const root = graph.ranks.indexOf(graph.root);
    const create = vector.operations[root];
    const genesisDocument = { '@context': ['https://www.w3.org/ns/did/v1'], id: vector.did,
        verificationMethod: [{ id: '#key-1', controller: vector.did, type: 'EcdsaSecp256k1VerificationKey2019', publicKeyJwk: create.publicJwk }],
        authentication: ['#key-1'], assertionMethod: ['#key-1'], capabilityInvocation: ['#key-1'] };
    return { ...graph, genesisDocument, registration: create.registration,
        fullDocuments: graph.ranks.map((_, rank) => {
            const i = graph.ranks.indexOf(rank);
            return i === root ? genesisDocument : vector.operations[i].doc?.didDocument ?? {};
        }) };
}

// Expected values for shared runtime fixtures; Lean independently executes the
// component fold on the signed operation tables, with opaque JSON values.
export function componentStates(vector, graph) {
    const authorized = documentStates(vector, graph);
    function at(i) {
        if (authorized[i] === null) return null;
        if (graph.ranks[i] === graph.root) return { didDocument: graph.genesisDocument, didDocumentData: {}, didDocumentRegistration: graph.registration };
        const before = at(graph.parents[i]);
        const op = vector.operations[i];
        if (op.type === 'delete') return { ...before, didDocument: { id: vector.did }, didDocumentData: {} };
        return { ...before, ...op.doc };
    }
    return vector.operations.map((_, i) => at(i));
}
