import * as satoshi from '../../services/mediators/satoshi/src/reorg.ts';
import * as zcash from '../../services/mediators/zcash/src/reorg.ts';
import type { ChainReader, StoredPosition } from '../../services/mediators/zcash/src/reorg.ts';

// A reorg near the tip must not restart the scan from the configured start
// block. A rewind that follows the orphaned chain gives up on the first block
// the node no longer holds, which on a mainnet node discarded 135,000 blocks
// of progress under the same log line a two-block rewind prints (#1063).

const IMPLEMENTATIONS = [['satoshi', satoshi], ['zcash', zcash]] as const;

const START = 3_339_200;
const TIP = 3_474_266;

const notFound = Object.assign(new Error('Block not found'), { code: -5 });
const unreachable = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8232'), { code: 'ECONNREFUSED' });

// Every height answers with a hash naming it, so a chain read is checkable
// without standing up a node.
function chainOf(overrides: Partial<ChainReader> = {}): ChainReader {
    return {
        header: async (hash) => ({ confirmations: 1, time: 1_700_000_000, hash } as never),
        hashAt: async (height) => `hash-${height}`,
        txCount: async () => 2,
        ...overrides,
    };
}

function positionAt(height: number, hash: string | undefined = `hash-${height}`): StoredPosition {
    return { height, hash, txnsScanned: 1_000 };
}

describe.each(IMPLEMENTATIONS)('%s reorg handling', (_name, reorg) => {
    const { isBlockNotFound, rewindTarget, planRewind, reorgDepth, planScanStart, DEFAULT_REORG_DEPTH: depth } = reorg;
    const window = { startBlock: START, reorgDepth: depth };

    describe('rewindTarget', () => {
        it('rewinds by the configured depth', () => {
            expect(rewindTarget(3_474_237, START, depth)).toBe(3_474_237 - depth);
        });

        it('never rewinds past the start of the scan window', () => {
            expect(rewindTarget(START + 2, START, depth)).toBe(START);
        });

        // A depth of zero would rewind to the reorged height, store the
        // canonical hash there and resume above it, so the block that replaced
        // ours would never be read.
        it('always rewinds at least one block', () => {
            expect(rewindTarget(1_000, 0, 0)).toBeLessThan(1_000);
            expect(rewindTarget(1_000, 0, -5)).toBeLessThan(1_000);
            expect(rewindTarget(1_000, 0, NaN)).toBeLessThan(1_000);
        });
    });

    describe('planRewind', () => {
        it('resumes above the checkpoint when there is room below', () => {
            expect(planRewind(START + 1_000, START, depth)).toStrictEqual({
                rescanWindow: false,
                checkpoint: START + 1_000 - depth,
                from: START + 1_000 - depth + 1,
            });
        });

        // At the window start there is no block below to resume above, so
        // resuming above the checkpoint would skip the block that replaced
        // ours with nothing left to catch it.
        it('re-reads the window from its first block at the boundary', () => {
            expect(planRewind(START + depth, START, depth)).toStrictEqual({ rescanWindow: true, from: START });
            expect(planRewind(START + 1, START, depth)).toStrictEqual({ rescanWindow: true, from: START });
            expect(planRewind(START, START, depth)).toStrictEqual({ rescanWindow: true, from: START });
        });

        it('is one block clear of the boundary just above it', () => {
            expect(planRewind(START + depth + 1, START, depth)).toStrictEqual({
                rescanWindow: false,
                checkpoint: START + 1,
                from: START + 2,
            });
        });
    });

    describe('reorgDepth', () => {
        it('takes a whole number of blocks', () => {
            expect(reorgDepth('12')).toBe(12);
            expect(reorgDepth('1')).toBe(1);
        });

        it('falls back to the default when the setting cannot be a depth', () => {
            for (const setting of [undefined, '', '   ', 'six', '0', '-1', '6.5', 'Infinity']) {
                expect(reorgDepth(setting)).toBe(depth);
            }
        });
    });

    describe('isBlockNotFound', () => {
        it('recognises the RPC code for an unknown block', () => {
            expect(isBlockNotFound({ code: -5, message: 'Block not found' })).toBe(true);
        });

        it('recognises the message when the code did not survive the client', () => {
            // A client that rethrows only the message loses the code with it.
            expect(isBlockNotFound(new Error('Block not found'))).toBe(true);
        });

        it('does not read a refused connection as a reorg', () => {
            expect(isBlockNotFound(unreachable)).toBe(false);
        });

        it('does not read a timeout as a reorg', () => {
            expect(isBlockNotFound(Object.assign(new Error('timeout of 5000ms exceeded'), { code: 'ECONNABORTED' }))).toBe(false);
        });

        it('does not read a node that answered nothing as a reorg', () => {
            expect(isBlockNotFound(undefined)).toBe(false);
            expect(isBlockNotFound(null)).toBe(false);
            expect(isBlockNotFound('')).toBe(false);
        });
    });

    describe('planScanStart', () => {
        it('starts at the window when nothing has been read', async () => {
            const decision = await planScanStart({ height: 0, txnsScanned: 0 }, window, chainOf(), TIP);

            expect(decision).toStrictEqual({ scan: true, from: START });
        });

        // What a window rescan leaves behind, so the pass after a restart
        // re-reads the first block rather than resuming above it.
        it('re-reads the first block after a window rescan was interrupted', async () => {
            const decision = await planScanStart({ height: START - 1, hash: '', txnsScanned: 0 }, window, chainOf(), TIP);

            expect(decision).toStrictEqual({ scan: true, from: START });
        });

        it('carries on when the stored block is still on the chain', async () => {
            const decision = await planScanStart(positionAt(3_400_000), window, chainOf(), TIP);

            expect(decision).toStrictEqual({ scan: true, from: 3_400_001 });
        });

        it('holds the position when the node cannot be asked', async () => {
            // Only the stored block is unanswerable. Everything else reads, so
            // a rewind would succeed here if one were wrongly started.
            const chain = chainOf({
                header: async (hash) => {
                    if (hash === 'hash-3400000') {
                        throw unreachable;
                    }

                    return { confirmations: 1, time: 1_700_000_000 };
                },
            });

            const decision = await planScanStart(positionAt(3_400_000), window, chain, TIP);

            expect(decision.scan).toBe(false);
            expect(decision).toHaveProperty('warn', expect.stringContaining('skipping this pass'));
        });

        it('rewinds when the node no longer has the stored block', async () => {
            const chain = chainOf({
                header: async (hash) => {
                    if (hash === `hash-3400000`) {
                        throw notFound;
                    }

                    return { confirmations: 1, time: 1_700_000_000 };
                },
            });

            const decision = await planScanStart(positionAt(3_400_000), window, chain, TIP);

            expect(decision).toMatchObject({
                scan: true,
                from: 3_400_000 - depth + 1,
                commit: {
                    height: 3_400_000 - depth,
                    hash: `hash-${3_400_000 - depth}`,
                    blocksScanned: 3_400_000 - depth - START + 1,
                    // Six blocks of two transactions each come back off.
                    txnsScanned: 1_000 - depth * 2,
                    blocksPending: TIP - (3_400_000 - depth),
                },
            });
        });

        it('re-reads the whole window when the rewind reaches its start', async () => {
            const chain = chainOf({ header: async () => { throw notFound; } });

            const decision = await planScanStart(positionAt(START + 2), window, chain, TIP);

            expect(decision).toMatchObject({
                scan: true,
                from: START,
                commit: { height: START - 1, hash: '', blocksScanned: 0, txnsScanned: 0 },
            });
        });

        it('holds the position when the rewind target cannot be read', async () => {
            const chain = chainOf({
                header: async () => { throw notFound; },
                hashAt: async () => { throw unreachable; },
            });

            const decision = await planScanStart(positionAt(3_400_000), window, chain, TIP);

            expect(decision.scan).toBe(false);
        });

        it('leaves the transaction count alone when the range cannot be totalled', async () => {
            const chain = chainOf({
                header: async (hash) => {
                    if (hash === 'hash-3400000') {
                        throw notFound;
                    }

                    return { confirmations: 1, time: 1_700_000_000 };
                },
                txCount: async () => { throw unreachable; },
            });

            const decision = await planScanStart(positionAt(3_400_000), window, chain, TIP);

            // A partial total would subtract less than the rescan adds back.
            expect(decision).toMatchObject({ scan: true, commit: { txnsScanned: 1_000 } });
            expect(decision).toHaveProperty('log', expect.stringContaining('leaving the transaction count'));
        });
    });
});
