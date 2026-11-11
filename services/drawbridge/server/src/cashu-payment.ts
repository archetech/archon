// Cashu as an HTTP 402 payment method (NUT-24, #1596). A priced request is
// challenged with a NUT-18 payment request in the X-Cashu header; the client
// retries with a cashuB token in the same header, which Drawbridge checks and
// then redeems through the node's own Keymaster, so payments land in the node's
// Cashu wallet and Drawbridge itself holds no funds.

import { getTokenMetadata, PaymentRequest } from '@cashu/cashu-ts';
import { CashuUnavailableError } from '@didcid/common/errors';

export const CASHU_HEADER = 'x-cashu';
export const CASHU_UNIT = 'sat';

/** A token that cannot pay the request: answered with 400, as NUT-24 says. */
export class CashuPaymentRefusedError extends Error {}

/** The node's Keymaster or mint could not redeem the token: answered with 503. */
export class CashuPaymentUnavailableError extends Error {}

export interface CashuPayments {
    /** The node mint's public URL, the one accepted mint. */
    mintUrl: string;
    /** Whether the node's Keymaster can redeem tokens from that mint now. */
    ready(): Promise<boolean>;
    /**
     * Redeems the token into the node's wallet and returns the sats received,
     * net of the mint's fees and of any proofs already spent; or throws one of
     * the errors above.
     */
    redeem(token: string): Promise<number>;
}

// Matches Keymaster's normalizeMintUrl, so both sides name the mint alike.
export function normalizeMintUrl(url: string): string | null {
    try {
        const parsed = new URL(url);
        return `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(/\/+$/, '');
    }
    catch {
        return null;
    }
}

/** The NUT-18 request for one call at `amountSat`, payable only at `mintUrl`. */
export function cashuPaymentRequest(amountSat: number, mintUrl: string): string {
    return new PaymentRequest(undefined, undefined, amountSat, CASHU_UNIT, [mintUrl], undefined, true)
        .toEncodedCreqA();
}

function hasSpendingConditions(secret: string): boolean {
    try {
        return Array.isArray(JSON.parse(secret));
    }
    catch {
        return false;
    }
}

/**
 * Checks, without contacting the mint, that `token` can pay `amountSat` at
 * `mintUrl`: the mint, the unit, the amount, and no spending conditions, which
 * the node's wallet could not redeem.
 */
export function checkCashuToken(token: string, amountSat: number, mintUrl: string): void {
    let metadata;
    try {
        metadata = getTokenMetadata(token);
    }
    catch {
        throw new CashuPaymentRefusedError('X-Cashu does not hold a Cashu token');
    }

    if (normalizeMintUrl(metadata.mint) !== normalizeMintUrl(mintUrl)) {
        throw new CashuPaymentRefusedError(`The token is not from the accepted mint ${mintUrl}`);
    }
    if (metadata.unit !== CASHU_UNIT) {
        throw new CashuPaymentRefusedError(`The token's unit must be ${CASHU_UNIT}`);
    }
    const amount = metadata.amount.toNumber();
    if (amount < amountSat) {
        throw new CashuPaymentRefusedError(`The token holds ${amount} sat; the price is ${amountSat} sat`);
    }
    if (metadata.incompleteProofs.some(proof => hasSpendingConditions(proof.secret))) {
        throw new CashuPaymentRefusedError('The token has spending conditions');
    }
}

/** The part of KeymasterClient this module uses. */
export interface CashuKeymaster {
    listCashuMints(name?: string): Promise<Array<{ url: string; error?: string }>>;
    receiveCashu(token: string, name?: string): Promise<{ amount: number }>;
}

const READY_CACHE_MS = 60_000;

/**
 * Payments redeemed by the node's Keymaster into the identity `nodeId`. Cashu
 * is offered only while that identity holds the node mint, checked at most once
 * a minute because listing mints contacts them.
 */
export function keymasterCashuPayments(
    keymaster: CashuKeymaster,
    nodeId: string,
    mintUrl: string,
    logger?: { warn?: (...args: any[]) => void },
): CashuPayments {
    let checked: { at: number; ready: boolean } | null = null;
    // Concurrent challenges share one lookup rather than each contacting the mints.
    let checking: Promise<boolean> | null = null;
    const accepted = normalizeMintUrl(mintUrl);

    async function check(): Promise<boolean> {
        let ready = false;
        try {
            const mints = await keymaster.listCashuMints(nodeId);
            ready = mints.some(mint => normalizeMintUrl(mint.url) === accepted && !mint.error);
            if (!ready) {
                logger?.warn?.(`Cashu payment is not offered: ${nodeId} on the node's Keymaster has not added the node mint ${mintUrl}`);
            }
        }
        catch (error) {
            logger?.warn?.({ err: error }, 'Cashu payment is not offered: the node\'s Keymaster cannot be reached');
        }
        checked = { at: Date.now(), ready };
        return ready;
    }

    return {
        mintUrl,

        ready() {
            if (checked && Date.now() - checked.at < READY_CACHE_MS) {
                return Promise.resolve(checked.ready);
            }
            checking ??= check().finally(() => {
                checking = null;
            });
            return checking;
        },

        async redeem(token) {
            try {
                const result = await keymaster.receiveCashu(token, nodeId);
                return result.amount;
            }
            catch (error: any) {
                // KeymasterClient rethrows an answered request as its JSON body.
                const reason = typeof error?.error === 'string' ? error.error : null;
                if (reason === null || reason.includes(CashuUnavailableError.type)) {
                    throw new CashuPaymentUnavailableError('The node could not redeem the token');
                }
                throw new CashuPaymentRefusedError(`The token was refused: ${reason}`);
            }
        },
    };
}
