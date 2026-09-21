// Pure interpretation of an accepted predecessor-ordered history. Callers
// retain their own cutoff, verification, metadata and locking boundaries.
import type { DidCidDocument, GatekeeperEvent, Operation } from './types.js';
import { hasChainMetadata, isUnanchoredRegistry } from './event-policy.js';

function registryAfter(registry: string | undefined, operation: Operation): string | undefined {
    return operation.type === 'update'
        ? operation.doc?.didDocumentRegistration?.registry ?? registry : registry;
}

// The old registry confirms a migration; its replacement governs successors.
export function expectedRegistryForIndex(events: GatekeeperEvent[], index: number): string | undefined {
    let registry = events[0]?.operation.registration?.registry;
    for (let i = 1; i < index && i < events.length; i++) {
        registry = registryAfter(registry, events[i].operation);
    }
    return registry;
}

export function* historyEntries(events: GatekeeperEvent[]) {
    let expectedRegistry = events[0]?.operation.registration?.registry;
    let confirmed = true; // Public genesis confirmation is unconditional.
    for (const [index, event] of events.entries()) {
        if (index > 0) confirmed = confirmed && event.registry === expectedRegistry;
        yield { event, expectedRegistry, confirmed };
        expectedRegistry = registryAfter(expectedRegistry, event.operation);
    }
}

// Always scan the whole confirmed prefix, independently of a resolver cutoff.
// A publicly confirmed genesis supplies chain evidence only on its expected registry.
export function hasAnchoredPrefix(events: GatekeeperEvent[]): boolean {
    let anchored = false;
    for (const { event, expectedRegistry, confirmed } of historyEntries(events)) {
        if (!confirmed) break;
        if (event.registry === expectedRegistry && !isUnanchoredRegistry(event.registry)) {
            if (!hasChainMetadata(event.ordinal, event.registration)) return false;
            anchored = true;
        }
    }
    return anchored;
}

export function applyComponents(doc: DidCidDocument, operation: Operation, did: string): void {
    if (operation.type === 'update') {
        const next = operation.doc || {};
        // Replace whole supplied components; preserve omitted components.
        if (next.didDocument !== undefined) doc.didDocument = next.didDocument;
        if (next.didDocumentData !== undefined) doc.didDocumentData = next.didDocumentData;
        if (next.didDocumentRegistration !== undefined) doc.didDocumentRegistration = next.didDocumentRegistration;
    }
    else if (operation.type === 'delete') {
        doc.didDocument = { id: did };
        doc.didDocumentData = {};
    }
}
