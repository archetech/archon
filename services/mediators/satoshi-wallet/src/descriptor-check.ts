import { buildDescriptors } from './derivation.js';
import type { WalletNetwork } from './config.js';

// Deterministic: retrying cannot resolve a seed mismatch, so the caller treats
// this as fatal rather than one of the transient setup failures.
export class DescriptorMismatchError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DescriptorMismatchError';
    }
}

// The origin and account key of a descriptor, ignoring the change branch and
// the checksum bitcoind appends. Returns undefined when the descriptor carries
// no key origin, which is what makes it uncheckable.
export function descriptorKey(descriptor: string): string | undefined {
    const match = descriptor.match(/\[([0-9a-fA-F]{8}(?:\/[0-9]+h?'?)*)\]([a-zA-Z0-9]+)/);

    return match ? `[${match[1].toLowerCase()}]${match[2]}` : undefined;
}

// bitcoind holds no private keys for a watch-only wallet, so signing derives
// them from the mnemonic at PSBT time. Descriptors built from a different seed
// therefore watch addresses this node can never spend from, while still handing
// them out for funding.
//
// A 32-bit fingerprint is not a seed identity, so the comparison is on the
// origin path and account xpub together. A descriptor carrying neither is
// rejected rather than skipped: it cannot be shown to belong to this seed.
export function assertDescriptorsMatch(
    existingDescriptors: string[],
    mnemonic: string,
    network: WalletNetwork,
    walletName: string,
): void {
    const expected = buildDescriptors(mnemonic, network);
    const expectedKeys = new Set([expected.external, expected.internal].map(descriptorKey));

    for (const descriptor of existingDescriptors) {
        // A descriptor whose spending policy needs a key this node does not hold
        // -- a multisig naming ours as one cosigner, say -- would otherwise pass
        // on its first key alone. Nothing here builds those, so this rejects a
        // shape rather than repairing it.
        if (!/^wpkh\(\[/.test(descriptor)) {
            throw new DescriptorMismatchError(
                `Wallet "${walletName}" holds a descriptor this node did not build ` +
                `(${descriptor}). Only single-key wpkh descriptors with a key origin can ` +
                `be checked. Remove or rename the wallet so it can be rebuilt.`
            );
        }

        const key = descriptorKey(descriptor);

        if (!key) {
            throw new DescriptorMismatchError(
                `Wallet "${walletName}" holds a descriptor with no key origin (${descriptor}). ` +
                `It cannot be checked against the current mnemonic. Remove or rename the wallet ` +
                `so it can be rebuilt.`
            );
        }

        if (!expectedKeys.has(key)) {
            throw new DescriptorMismatchError(
                `Wallet "${walletName}" holds a descriptor for a different seed (${key}); the ` +
                `current mnemonic derives ${[...expectedKeys].join(' and ')}. Addresses from this ` +
                `wallet cannot be spent by this node. Recover any funds with the original seed, ` +
                `then remove or rename the wallet so it can be rebuilt.`
            );
        }
    }
}
