import { consensusBranchIdFor } from '../../services/mediators/zcash-wallet/src/zcash-wallet.ts';

// Zcash signatures commit to the consensus branch id (ZIP-243), so one made
// under a superseded upgrade is rejected as ScriptInvalid at consensus
// validation. The branch was pinned to NU6.1 in source, and anchoring on a
// mainnet node stopped the day NU6.2 activated and stayed broken through
// NU6.3 (#1040). It is read from the node now, so the value is never a
// constant this repository has to chase.

function nodeReporting(consensus: unknown) {
    return { command: async () => ({ consensus }) } as any;
}

describe('consensusBranchIdFor', () => {
    it('reads the branch the next block will use', async () => {
        // What mainnet reported under NU6.3.
        await expect(consensusBranchIdFor(nodeReporting({ chaintip: '37a5165b', nextblock: '37a5165b' })))
            .resolves.toBe(0x37a5165b);
    });

    it('follows the node across an upgrade rather than a pinned constant', async () => {
        // Mid-upgrade the tip and the next block differ; a transaction being
        // mined now belongs to the next block.
        await expect(consensusBranchIdFor(nodeReporting({ chaintip: '5437f330', nextblock: '37a5165b' })))
            .resolves.toBe(0x37a5165b);
    });

    it('refuses to guess when the node reports no branch', async () => {
        // Signing with a wrong branch produces a transaction the network
        // rejects, so failing here is the clearer outcome.
        await expect(consensusBranchIdFor(nodeReporting(undefined)))
            .rejects.toThrow(/consensus.nextblock/);
    });

    it.each([
        ['not-hex'],
        // parseInt would take the valid prefix of these and sign with it.
        ['37a5165bgarbage'],
        ['0x37a5165b'],
        ['1'],
        ['37a5165'],
        [''],
    ])('refuses an unreadable branch: %j', async (nextblock) => {
        await expect(consensusBranchIdFor(nodeReporting({ nextblock })))
            .rejects.toThrow(/unreadable|consensus.nextblock/);
    });
});
