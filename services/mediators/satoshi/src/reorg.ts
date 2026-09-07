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

// What a reorg at `height` means for the stored position.
//
// Away from the window start there is a block below to fall back on: it
// becomes the checkpoint and reading resumes above it. At the start there is
// not, so the window is re-read from its first block instead of from the one
// after it -- the boundary is where resuming above the target would skip the
// block that replaced ours with nothing left to catch it.
export type Rewind =
    | { rescanWindow: true, from: number }
    | { rescanWindow: false, checkpoint: number, from: number };

export function planRewind(height: number, startBlock: number, depth: number): Rewind {
    const target = rewindTarget(height, startBlock, depth);

    return target === startBlock
        ? { rescanWindow: true, from: startBlock }
        : { rescanWindow: false, checkpoint: target, from: target + 1 };
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

// Everything the decision needs from the chain. The mediators differ in how
// they reach their node -- one over axios, one over a client library with a
// fallback RPC -- so the plan takes the three reads it makes and nothing else.
export interface ChainReader {
    // Throws when the node has no such block, and also when it cannot be
    // asked; isBlockNotFound tells those apart.
    header(hash: string): Promise<{ confirmations?: number, time?: number } | undefined>;
    hashAt(height: number): Promise<string>;
    txCount(hash: string): Promise<number>;
}

export interface StoredPosition {
    height: number;
    // Absent before anything in the window has been read.
    hash?: string;
    txnsScanned: number;
}

export interface ScanWindow {
    startBlock: number;
    reorgDepth: number;
}

// The fields a rewind writes, as absolute values: the plan is handed the
// counters it adjusts, so nothing downstream has to work out what to add.
export interface RewindCommit {
    height: number;
    hash: string;
    time: string;
    blocksScanned: number;
    txnsScanned: number;
    blockCount: number;
    blocksPending: number;
}

// `scan: false` holds the position: the stored hash could not be checked, and
// reading anything now would overwrite it before the next pass could look.
export type ScanDecision =
    | { scan: false, warn: string }
    | { scan: true, from: number }
    | { scan: true, from: number, commit: RewindCommit, log: string };

export async function planScanStart(
    stored: StoredPosition,
    window: ScanWindow,
    chain: ChainReader,
    blockCount: number,
): Promise<ScanDecision> {
    if (!stored.hash) {
        return { scan: true, from: stored.height ? stored.height + 1 : window.startBlock };
    }

    let header: { confirmations?: number, time?: number } | undefined;

    try {
        header = await chain.header(stored.hash);
    } catch (error) {
        if (!isBlockNotFound(error)) {
            return {
                scan: false,
                warn: `Could not read block ${stored.hash} at height ${stored.height}, skipping this pass: ${error}`,
            };
        }
    }

    if ((header?.confirmations ?? 0) > 0) {
        return { scan: true, from: stored.height + 1 };
    }

    const plan = planRewind(stored.height, window.startBlock, window.reorgDepth);

    if (plan.rescanWindow) {
        return {
            scan: true,
            from: plan.from,
            log: `Reorg detected at height ${stored.height}; rescanning the window from ${window.startBlock}`,
            commit: {
                // Just below the window, which is what a scan that has read
                // none of it looks like -- including to the next pass, which
                // reads this back rather than resuming above it.
                height: window.startBlock - 1,
                hash: '',
                time: '',
                blocksScanned: 0,
                txnsScanned: 0,
                blockCount,
                blocksPending: blockCount - window.startBlock,
            },
        };
    }

    let checkpointHash: string;
    let checkpointHeader: { confirmations?: number, time?: number } | undefined;

    try {
        checkpointHash = await chain.hashAt(plan.checkpoint);
        checkpointHeader = await chain.header(checkpointHash);
    } catch (error) {
        // Committing a rewind to a block that cannot be read would store a
        // position no later pass can verify.
        return {
            scan: false,
            warn: `Reorg at height ${stored.height}, but the chain at ${plan.checkpoint} could not be read, skipping this pass: ${error}`,
        };
    }

    let subtract = 0;
    let counted = true;

    try {
        // The blocks about to be read again were counted when they were read
        // the first time.
        for (let height = plan.from; height <= Math.min(stored.height, blockCount); height++) {
            subtract += await chain.txCount(await chain.hashAt(height));
        }
    } catch {
        // A metric, not the position: the rewind still happens. A partial
        // total would subtract less than the rescan adds back, so none of it
        // is applied and the gauge runs high by this range.
        counted = false;
    }

    return {
        scan: true,
        from: plan.from,
        log: `Reorg detected at height ${stored.height}; rewinding ${stored.height - plan.checkpoint} block(s) to ${plan.checkpoint}`
            + (counted ? '' : ', leaving the transaction count as it is'),
        commit: {
            height: plan.checkpoint,
            hash: checkpointHash,
            time: checkpointHeader?.time ? new Date(checkpointHeader.time * 1000).toISOString() : '',
            blocksScanned: Math.max(0, plan.checkpoint - window.startBlock + 1),
            txnsScanned: counted ? Math.max(0, stored.txnsScanned - subtract) : stored.txnsScanned,
            blockCount,
            blocksPending: blockCount - plan.checkpoint,
        },
    };
}
