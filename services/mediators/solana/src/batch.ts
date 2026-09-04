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
