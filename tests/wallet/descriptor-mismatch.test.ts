import { buildDescriptors, getMasterFingerprint } from '../../services/mediators/satoshi-wallet/src/derivation.ts';

// bitcoind holds no private keys for the watch-only wallet, so signing derives
// them from the mnemonic at PSBT time. Descriptors from a different seed watch
// addresses this node cannot spend from, while still serving them for funding:
// one node took 4,000 sats into such a wallet before anyone noticed (#1033).

const SEED_A = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const SEED_B = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

// The check the wallet setup performs against each imported descriptor.
function originFingerprint(descriptor: string): string | undefined {
    return descriptor.match(/\[([0-9a-fA-F]{8})\//)?.[1].toLowerCase();
}

describe('descriptor fingerprint', () => {
    it('is carried in the descriptor origin', () => {
        const { external, internal } = buildDescriptors(SEED_A, 'mainnet');
        const expected = getMasterFingerprint(SEED_A, 'mainnet').toLowerCase();

        expect(originFingerprint(external)).toBe(expected);
        expect(originFingerprint(internal)).toBe(expected);
    });

    it('differs between seeds, which is what makes the mismatch detectable', () => {
        const a = getMasterFingerprint(SEED_A, 'mainnet').toLowerCase();
        const b = getMasterFingerprint(SEED_B, 'mainnet').toLowerCase();

        expect(a).not.toBe(b);
        expect(originFingerprint(buildDescriptors(SEED_B, 'mainnet').external)).toBe(b);
    });

    it('is unchanged by network, so a mismatch is not a network difference', () => {
        // The origin path encodes the coin type; the master fingerprint does not.
        expect(getMasterFingerprint(SEED_A, 'mainnet')).toBe(getMasterFingerprint(SEED_A, 'signet'));
    });
});
