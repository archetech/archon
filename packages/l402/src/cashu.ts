import { CashuMint, CashuWallet, getDecodedToken } from '@cashu/cashu-ts';
import { createHash } from 'crypto';
import type { CashuConfig, CashuPayment, CashuRedemptionResult } from './types.js';

export function isTrustedMint(config: CashuConfig, mintUrl: string): boolean {
    const normalizedUrl = mintUrl.replace(/\/+$/, '');
    return config.trustedMints.some(
        trusted => trusted.replace(/\/+$/, '') === normalizedUrl
    );
}

/**
 * Decodes a Cashu token and verifies its mint is trusted.
 * Does NOT redeem or check if proofs are spent. Use redeemCashuToken() for double-spend prevention.
 */
export async function verifyCashuToken(
    config: CashuConfig,
    tokenStr: string
): Promise<CashuPayment> {
    const decoded = getDecodedToken(tokenStr);

    const mintUrl = decoded.mint;
    if (!isTrustedMint(config, mintUrl)) {
        throw new Error(`Untrusted mint: ${mintUrl}`);
    }

    let totalAmount = 0;
    for (const proof of decoded.proofs) {
        totalAmount += proof.amount;
    }

    return {
        token: tokenStr,
        amount: totalAmount,
        mint: mintUrl,
    };
}

export async function redeemCashuToken(
    config: CashuConfig,
    tokenStr: string
): Promise<CashuRedemptionResult> {
    const decoded = getDecodedToken(tokenStr);

    const mintUrl = decoded.mint;
    if (!isTrustedMint(config, mintUrl)) {
        throw new Error(`Untrusted mint: ${mintUrl}`);
    }

    let totalAmount = 0;
    for (const proof of decoded.proofs) {
        totalAmount += proof.amount;
    }

    const mint = new CashuMint(mintUrl);
    const wallet = new CashuWallet(mint);

    // Receive the proofs (this swaps them at the mint, preventing double-spend)
    await wallet.receive(tokenStr);

    const receiptId = createHash('sha256').update(tokenStr).digest('hex');

    return {
        redeemed: true,
        amount: totalAmount,
        receiptId,
    };
}
