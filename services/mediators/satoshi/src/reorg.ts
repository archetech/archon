// Reorg handling for a chain the mediator scans block by block.
//
// The local store keeps one {height, hash}, the last block read, so the depth
// of a reorg cannot be measured from it. What can be done is bound the
// response. Re-reading a fixed number of blocks is idempotent -- discovered
// items are keyed by height, index, txid and DID -- and costs that many
// blocks. Following the orphaned chain to find the fork point instead costs
// whatever the node still holds of it, and yields nothing once it holds none
// (#1063).
//
// The exact fork point is recoverable: every scanned block is sent to the
// gatekeeper with its height, so its registry can be compared against the
// chain. That trades a bounded local decision for a walk over two remote
// services, and is not what this does.

// Deep enough to cover a natural reorg on either chain, which is one or two
// blocks, with room to spare.
export const DEFAULT_REORG_DEPTH = 6;

// A depth below one would rewind to the reorged height itself: the handler
// stores the canonical hash there and resumes above it, so the block that
// replaced ours is never read. Anything that is not a whole number of blocks
// says nothing about how far to go.
function blocksToRewind(depth: number): number {
    return Number.isInteger(depth) && depth >= 1 ? depth : DEFAULT_REORG_DEPTH;
}

// The configured depth, or the default when the setting is missing or is not a
// count of blocks.
export function reorgDepth(setting: string | undefined): number {
    return blocksToRewind(Number(setting));
}

// Where to resume after a reorg at `height`, never before the window starts.
export function rewindTarget(height: number, startBlock: number, depth: number): number {
    return Math.max(startBlock, height - blocksToRewind(depth));
}

// Whether an error says the node does not have that block, as opposed to
// saying nothing because it could not be asked.
//
// Only the first is evidence of a reorg. Reading a timeout or a refused
// connection as one rewinds a chain that never forked.
export function isBlockNotFound(error: unknown): boolean {
    // bitcoind and zcashd answer an unknown block with RPC code -5. Whether
    // that code survives the client is not guaranteed, so the message counts
    // too. Transport failures carry a string code such as ECONNREFUSED.
    if ((error as { code?: unknown })?.code === -5) {
        return true;
    }

    const message = (error as { message?: unknown })?.message;

    return typeof message === 'string' && /block not found/i.test(message);
}
