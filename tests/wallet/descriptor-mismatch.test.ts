import { assertDescriptorsMatch, descriptorKey, DescriptorMismatchError } from '../../services/mediators/satoshi-wallet/src/descriptor-check.ts';
import { buildDescriptors } from '../../services/mediators/satoshi-wallet/src/derivation.ts';

// bitcoind holds no private keys for the watch-only wallet, so signing derives
// them from the mnemonic at PSBT time. Descriptors from a different seed watch
// addresses this node cannot spend from, while still serving them for funding:
// one node took 4,000 sats into such a wallet before anyone noticed (#1033).

const SEED_A = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const SEED_B = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const NETWORK = 'mainnet';
const WALLET = 'archon-watch-test';

// bitcoind reports descriptors with a checksum appended.
const withChecksum = (descriptor: string) => `${descriptor}#abcdefgh`;

describe('assertDescriptorsMatch', () => {
    it('accepts descriptors derived from the current mnemonic', () => {
        const mine = buildDescriptors(SEED_A, NETWORK);

        expect(() => assertDescriptorsMatch(
            [mine.external, mine.internal].map(withChecksum), SEED_A, NETWORK, WALLET,
        )).not.toThrow();
    });

    it('rejects descriptors built on a different seed', () => {
        const theirs = buildDescriptors(SEED_B, NETWORK);

        expect(() => assertDescriptorsMatch(
            [theirs.external, theirs.internal].map(withChecksum), SEED_A, NETWORK, WALLET,
        )).toThrow(/different seed/);
    });

    it('rejects a descriptor with no key origin rather than skipping it', () => {
        // Valid, satisfies the /0/* and /1/* checks the setup already made, and
        // says nothing about which seed it belongs to.
        const anonymous = 'wpkh(xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKrhko4egpiMZbpiaQL2jkwSB1icqYh2cfDfVxdx4df189oLKnC5fSwqPfgyP3hooxujYzAu3fDVmz/0/*)';

        expect(() => assertDescriptorsMatch([anonymous], SEED_A, NETWORK, WALLET))
            .toThrow(DescriptorMismatchError);
    });

    it('rejects a policy needing a key this node does not hold', () => {
        // Our key as first cosigner, so a check reading only the first key would
        // accept it -- while the wallet cannot spend without the other signer.
        const mine = buildDescriptors(SEED_A, NETWORK).external.replace(/^wpkh\(|\)$/g, '');
        const theirs = buildDescriptors(SEED_B, NETWORK).external.replace(/^wpkh\(|\)$/g, '');
        const shared = `wsh(sortedmulti(2,${mine},${theirs}))`;

        expect(() => assertDescriptorsMatch([shared], SEED_A, NETWORK, WALLET))
            .toThrow(DescriptorMismatchError);
    });

    it('accepts an empty wallet, which has nothing to contradict the mnemonic', () => {
        expect(() => assertDescriptorsMatch([], SEED_A, NETWORK, WALLET)).not.toThrow();
    });

    it('names the wallet and both keys so the operator can act', () => {
        const theirs = buildDescriptors(SEED_B, NETWORK);

        expect(() => assertDescriptorsMatch([theirs.external], SEED_A, NETWORK, WALLET))
            .toThrow(new RegExp(WALLET));
    });
});

describe('descriptorKey', () => {
    it('ignores the change branch and bitcoind checksum', () => {
        const { external, internal } = buildDescriptors(SEED_A, NETWORK);

        expect(descriptorKey(external)).toBe(descriptorKey(internal));
        expect(descriptorKey(withChecksum(external))).toBe(descriptorKey(external));
    });

    it('distinguishes seeds by more than the 32-bit fingerprint', () => {
        const a = descriptorKey(buildDescriptors(SEED_A, NETWORK).external)!;
        const b = descriptorKey(buildDescriptors(SEED_B, NETWORK).external)!;

        // The account xpub is compared too, so a fingerprint collision cannot pass.
        expect(a.split(']')[1]).not.toBe(b.split(']')[1]);
    });

    it('returns undefined when there is no origin to check', () => {
        expect(descriptorKey('wpkh(xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKrhko4egpiMZbpiaQL2jkw/0/*)')).toBeUndefined();
    });
});
