import { isBlockNotFound as satoshi, rewindTarget as satoshiRewind, reorgDepth as satoshiConfigured, DEFAULT_REORG_DEPTH as satoshiDepth } from '../../services/mediators/satoshi/src/reorg.ts';
import { isBlockNotFound as zcash, rewindTarget as zcashRewind, reorgDepth as zcashConfigured, DEFAULT_REORG_DEPTH as zcashDepth } from '../../services/mediators/zcash/src/reorg.ts';

// A reorg near the tip must not restart the scan from the configured start
// block. A rewind that follows the orphaned chain gives up on the first block
// the node no longer holds, which on a mainnet node discarded 135,000 blocks
// of progress under the same log line a two-block rewind prints (#1063).

const IMPLEMENTATIONS = [
    ['satoshi', satoshi, satoshiRewind, satoshiConfigured, satoshiDepth],
    ['zcash', zcash, zcashRewind, zcashConfigured, zcashDepth],
] as const;

describe.each(IMPLEMENTATIONS)('%s reorg handling', (_name, isBlockNotFound, rewindTarget, reorgDepth, depth) => {
    describe('rewindTarget', () => {
        it('rewinds by the configured depth', () => {
            expect(rewindTarget(3_474_237, 3_339_200, depth)).toBe(3_474_237 - depth);
        });

        it('never rewinds past the start of the scan window', () => {
            expect(rewindTarget(3_339_202, 3_339_200, depth)).toBe(3_339_200);
        });

        it('stays at the start block when the position is already there', () => {
            expect(rewindTarget(3_339_200, 3_339_200, depth)).toBe(3_339_200);
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
            // The zcash client rethrows data.error.message and drops the code.
            expect(isBlockNotFound(new Error('Block not found'))).toBe(true);
        });

        it('does not read a refused connection as a reorg', () => {
            expect(isBlockNotFound(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8232'), { code: 'ECONNREFUSED' }))).toBe(false);
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
});
