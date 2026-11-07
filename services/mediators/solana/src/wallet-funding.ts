// Reading whether the wallet a chain mediator anchors through can pay for it,
// and reporting the answer as metrics so an alert can see it.
//
// The level that stops anchoring is per-node configuration, so only the mediator
// knows a balance is too low. A wallet service that cannot be reached says
// nothing about the funds, so that case leaves the funds gauge at its last
// reading and is reported separately.
//
// Copied into each mediator package; see tests/mediators/duplicated-helpers.test.ts.

export interface WalletFundingGauges {
    insufficientFunds: { set(value: number): void };
    unreachable: { set(value: number): void };
}

export async function readWalletFunding<Balance>(
    getBalance: () => Promise<Balance>,
    isBelowFloor: (balance: Balance) => boolean,
    gauges: WalletFundingGauges,
): Promise<{ wallet: Balance; belowFloor: boolean }> {
    let wallet: Balance;
    let belowFloor: boolean;

    try {
        wallet = await getBalance();
        belowFloor = isBelowFloor(wallet);
    }
    catch (error) {
        gauges.unreachable.set(1);
        throw error;
    }

    gauges.unreachable.set(0);
    gauges.insufficientFunds.set(belowFloor ? 1 : 0);

    return { wallet, belowFloor };
}
