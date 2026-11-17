// The mediator's outbound pass: take what the Gatekeeper has queued for the
// registry, remove it from the queue, send it to the peers, and merge it locally.

// A part is cleared from the Gatekeeper in one request and sent to a peer in one
// write. A Gatekeeper refuses a request body over its upload limit, 10 MB unless
// set lower, and the wire limit for a write is 8 MB, so parts stay well under both.
export const MAX_PART_OPERATIONS = 1000;
export const MAX_PART_BYTES = 1024 * 1024;

export interface ExportDeps<Op> {
    getQueue(): Promise<Op[]>;
    // Removes these operations from the Gatekeeper's queue. A Gatekeeper answers
    // false, without failing the request, when its store could not do it.
    clearQueue(operations: Op[]): Promise<boolean | void>;
    // Sends one `queue` message carrying these operations to every peer.
    relay(operations: Op[]): Promise<void>;
    // Imports the operations into this node's own Gatekeeper.
    merge(operations: Op[]): Promise<void>;
}

/**
 * Splits a queue into parts of bounded size, keeping its order. An operation
 * larger than the byte limit travels alone.
 */
export function exportParts<Op>(queue: Op[], maxOperations = MAX_PART_OPERATIONS, maxBytes = MAX_PART_BYTES): Op[][] {
    const parts: Op[][] = [];
    let part: Op[] = [];
    let bytes = 0;
    for (const operation of queue) {
        const size = Buffer.byteLength(JSON.stringify(operation));
        if (part.length && (part.length >= maxOperations || bytes + size > maxBytes)) {
            parts.push(part);
            part = [];
            bytes = 0;
        }
        part.push(operation);
        bytes += size;
    }
    if (part.length) parts.push(part);
    return parts;
}

/**
 * Runs one outbound pass and returns how many operations it sent.
 *
 * The queue used to be cleared and sent whole. Once it outgrew one request the
 * Gatekeeper refused the clear, so nothing was removed, the next pass fetched a
 * longer queue, and the mediator held and logged all of it on every pass until it
 * ran out of memory, having sent none of it (#1644).
 *
 * A part that cannot be cleared, whether the request fails or the Gatekeeper
 * answers false, stops the pass: that part and those after it stay queued for
 * the next one. Every part cleared before it has been sent, and
 * is merged before the failure is reported.
 */
export async function flushQueue<Op>(deps: ExportDeps<Op>): Promise<number> {
    const queue = await deps.getQueue();
    const sent: Op[] = [];
    try {
        for (const part of exportParts(queue)) {
            if (await deps.clearQueue(part) === false) throw new Error('the Gatekeeper could not clear its queue');
            await deps.relay(part);
            sent.push(...part);
        }
    }
    finally {
        if (sent.length) await deps.merge(sent);
    }
    return sent.length;
}
