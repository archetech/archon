// Envelope policy shared by import and recovery. Operations and signed bytes
// remain untouched; queue identity and durable candidate identity are distinct.
import type { GatekeeperEvent } from './types.js';

export const PIN_QUEUE = 'pin';

// Local/Hyperswarm retain the first candidate and preserve their relay envelope.
// Pin shares their unanchored clock/authority, but not their transport/retention.
export function isLocallyStampedRegistry(registry: unknown): boolean {
    return registry === 'local' || registry === 'hyperswarm';
}

// Pin receipts can confirm pin-registry DIDs, but never establish chain order.
export function isUnanchoredRegistry(registry: unknown): boolean {
    return registry === PIN_QUEUE || isLocallyStampedRegistry(registry);
}

export function normalizeEventTime(event: GatekeeperEvent): void {
    // Normalize envelopes at import/recovery, including older mediator and
    // restored events. Resolution consumes the stored event time uniformly.
    if (event.registry === 'local' && event.operation.type === 'create' && event.operation.created) {
        event.time = event.operation.created;
    }
    else if (isUnanchoredRegistry(event.registry) && event.operation.proof) {
        event.time = event.operation.proof.created;
    }
}

export function candidateKey(event: GatekeeperEvent): string {
    // A fresh gossip receipt time is not new authorization evidence.
    if (isLocallyStampedRegistry(event.registry)) return JSON.stringify([event.opid, event.registry]);
    if (!isUnanchoredRegistry(event.registry)) return JSON.stringify([event.opid, event.registry, event.ordinal]);
    return JSON.stringify([event.opid, event.registry, event.time, event.ordinal]);
}

export function preferredCandidates(events: GatekeeperEvent[]): GatekeeperEvent[] {
    const unique = new Map<string, GatekeeperEvent>();
    for (const event of events) {
        const key = candidateKey(event);
        if (!unique.has(key) || !isLocallyStampedRegistry(event.registry)) unique.set(key, event);
    }
    return [...unique.values()];
}

export function relayHints(batch: GatekeeperEvent[]): GatekeeperEvent[] {
    return batch.map(event => {
        if (!event || typeof event !== 'object' || isLocallyStampedRegistry(event.registry)) {
            return event;
        }

        const { registration, ...rest } = event;
        void registration;

        return { ...rest, registry: 'hyperswarm' };
    });
}

export function queueKey(event: GatekeeperEvent, opid: string): string {
    const position = event.registration ? `/${JSON.stringify([event.time, event.ordinal])}` : '';
    return `${event.registry}/${opid}${position}`;
}

function hasValidOrdinalComponents(ordinal: unknown, allowEmpty: boolean): ordinal is number[] {
    if (!Array.isArray(ordinal) || (!allowEmpty && ordinal.length === 0)) return false;
    for (const value of ordinal) {
        if (!Number.isSafeInteger(value) || value < 0) return false;
    }
    return true;
}

export function isValidUnanchoredOrdinal(ordinal: unknown): ordinal is number[] {
    return hasValidOrdinalComponents(ordinal, true);
}

// Chain positions must compare identically in the JavaScript and Rust ports.
function isValidChainOrdinal(ordinal: unknown): ordinal is number[] {
    return hasValidOrdinalComponents(ordinal, false);
}

export function isValidEventOrdinal(registry: unknown, ordinal: unknown): ordinal is number[] | undefined {
    return isUnanchoredRegistry(registry)
        ? ordinal === undefined || isValidUnanchoredOrdinal(ordinal)
        : isValidChainOrdinal(ordinal);
}

// Chain positions are [height, index, ...registryPosition, opidx]. CID batch
// metadata supplies the prefix; Gatekeeper appends the original CID-list index.
export function hasChainMetadata(ordinal: unknown, registration: unknown, batch = false): boolean {
    if (!isValidChainOrdinal(ordinal) || ordinal.length < (batch ? 2 : 3)) return false;
    if (!registration || typeof registration !== 'object' || Array.isArray(registration)) return false;
    const anchor = registration as Record<string, unknown>;
    return anchor.height === ordinal[0] && anchor.index === ordinal[1]
        && typeof anchor.txid === 'string' && anchor.txid.length > 0
        && typeof anchor.batch === 'string' && anchor.batch.length > 0
        && (batch || anchor.opidx === ordinal[ordinal.length - 1]);
}
