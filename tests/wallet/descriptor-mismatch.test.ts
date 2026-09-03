import { jest } from '@jest/globals';
import { setupWatchOnlyWallet, descriptorKey } from '../../services/mediators/satoshi-wallet/src/btc-wallet.ts';
import { buildDescriptors } from '../../services/mediators/satoshi-wallet/src/derivation.ts';

// bitcoind holds no private keys for the watch-only wallet, so signing derives
// them from the mnemonic at PSBT time. Descriptors from a different seed watch
// addresses this node cannot spend from, while still serving them for funding:
// one node took 4,000 sats into such a wallet before anyone noticed (#1033).

const SEED_A = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const SEED_B = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const NETWORK = 'mainnet';

// bitcoind reports descriptors with a checksum appended and a range already
// applied, so the stub mirrors that rather than echoing what we build.
function asImported(descriptor: string) {
    return { desc: `${descriptor}#abcdefgh`, timestamp: 0, active: true, range: [0, 1000], next: 0 };
}

function clientWith(descriptors: string[]) {
    return {
        command: jest.fn<any>().mockResolvedValue(undefined),
        listDescriptors: jest.fn<any>().mockResolvedValue({ wallet_name: 'w', descriptors: descriptors.map(asImported) }),
        getDescriptorInfo: jest.fn<any>(),
        importDescriptors: jest.fn<any>(),
    } as any;
}

describe('setupWatchOnlyWallet descriptor validation', () => {
    it('accepts a wallet whose descriptors derive from the current mnemonic', async () => {
        const mine = buildDescriptors(SEED_A, NETWORK);
        const result = await setupWatchOnlyWallet(clientWith([mine.external, mine.internal]), SEED_A, NETWORK);

        expect(result.descriptors).toHaveLength(2);
    });

    it('refuses a wallet built on a different seed', async () => {
        const theirs = buildDescriptors(SEED_B, NETWORK);

        await expect(setupWatchOnlyWallet(clientWith([theirs.external, theirs.internal]), SEED_A, NETWORK))
            .rejects.toThrow(/different seed/);
    });

    it('refuses a descriptor with no key origin rather than skipping it', async () => {
        // Valid, satisfies the /0/* and /1/* checks, and says nothing about the seed.
        const anonymous = 'wpkh(xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKrhko4egpiMZbpiaQL2jkwSB1icqYh2cfDfVxdx4df189oLKnC5fSwqPfgyP3hooxujYzAu3fDVmz/0/*)';

        await expect(setupWatchOnlyWallet(clientWith([anonymous]), SEED_A, NETWORK))
            .rejects.toThrow(/no key origin/);
    });
});

describe('descriptorKey', () => {
    it('ignores the change branch and bitcoind checksum', () => {
        const { external, internal } = buildDescriptors(SEED_A, NETWORK);

        expect(descriptorKey(external)).toBe(descriptorKey(internal));
        expect(descriptorKey(`${external}#abcdefgh`)).toBe(descriptorKey(external));
    });

    it('distinguishes seeds by more than the 32-bit fingerprint', () => {
        const a = descriptorKey(buildDescriptors(SEED_A, NETWORK).external)!;
        const b = descriptorKey(buildDescriptors(SEED_B, NETWORK).external)!;

        expect(a).not.toBe(b);
        // The account xpub is compared too, so a fingerprint collision cannot pass.
        expect(a.split(']')[1]).not.toBe(b.split(']')[1]);
    });

    it('returns undefined when there is no origin to check', () => {
        expect(descriptorKey('wpkh(xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKrhko4egpiMZbpiaQL2jkw/0/*)')).toBeUndefined();
    });
});
