import { isBlockNotFound as satoshi, rewindTarget as satoshiRewind, DEFAULT_REORG_DEPTH as satoshiDepth } from '../../services/mediators/satoshi/src/reorg.ts';
import { isBlockNotFound as zcash, rewindTarget as zcashRewind, DEFAULT_REORG_DEPTH as zcashDepth } from '../../services/mediators/zcash/src/reorg.ts';

// A reorg near the tip used to restart the scan from the configured start
// block, because the rewind followed the orphaned chain and gave up on the
// first block the node no longer held. On a mainnet node that discarded
// 135,000 blocks of progress and reported only "rewinding to a confirmed
// block" (#1063).

const IMPLEMENTATIONS = [
    ['satoshi', satoshi, satoshiRewind, satoshiDepth],
    ['zcash', zcash, zcashRewind, zcashDepth],
] as const;

describe.each(IMPLEMENTATIONS)('%s reorg handling', (_name, isBlockNotFound, rewindTarget, depth) => {
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

        it('does not move forward on a nonsense depth', () => {
            expect(rewindTarget(1_000, 0, -5)).toBe(1_000);
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
