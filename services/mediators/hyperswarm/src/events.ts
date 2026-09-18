import type { GatekeeperEvent, Operation } from '@didcid/clients/gatekeeper-types';

// Gossip transports operations, so this mediator supplies their event envelopes.
// Preserve the existing receipt ordinal; proof time is the historical timestamp.
export function createEvents(batch: Operation[]): GatekeeperEvent[] {
    const receipt = Date.now();
    return batch.map((operation, index) => ({
        registry: 'hyperswarm',
        time: operation.proof?.created ?? '',
        ordinal: [receipt, index],
        operation,
    }));
}
