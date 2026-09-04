export interface PendingBatch {
    did: string;
    opids: string[];
    txid?: string;
}

// The operations a pending batch certifies, which are the only ones its anchor
// may clear. A batch asset is published before the transaction that anchors it
// can be attempted, so it has to stay authoritative until that succeeds:
// anything queued afterwards belongs to the next batch, not this one.
export function coveredOperations<T>(
    pending: { opids: string[] } | undefined,
    operations: T[],
    cids: string[],
): T[] {
    if (!pending) {
        return operations;
    }

    return operations.filter((_, i) => pending.opids.includes(cids[i]));
}

export type AnchorPlan<T> =
    // Already on the network; only the queue clear is outstanding. Broadcasting
    // again would anchor the same batch twice.
    | { action: 'clear'; did: string; covered: T[] }
    // Published but never anchored, and its operations are still queued.
    | { action: 'reuse'; did: string; covered: T[]; opids: string[]; discarded?: undefined }
    // Nothing usable is pending, so a new batch covers the whole queue. A batch
    // whose operations have all left the queue is discarded here rather than
    // anchored, and names itself so the caller can say so.
    | { action: 'mint'; covered: T[]; opids: string[]; discarded?: string };

// The whole anchor decision, kept apart from the effects that carry it out so
// it can be exercised directly: the mediator modules cannot be imported in a
// test, and this is the part worth testing (#1041).
export function planAnchor<T>(
    pending: PendingBatch | undefined,
    operations: T[],
    cids: string[],
): AnchorPlan<T> {
    const covered = coveredOperations(pending, operations, cids);

    if (pending?.txid) {
        return { action: 'clear', did: pending.did, covered };
    }

    if (pending && covered.length > 0) {
        return { action: 'reuse', did: pending.did, covered, opids: pending.opids };
    }

    return {
        action: 'mint',
        covered: operations,
        opids: cids,
        ...(pending ? { discarded: pending.did } : {}),
    };
}
