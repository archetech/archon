// Waiting for the wallet service a chain mediator anchors through.
//
// Copied into each mediator package; see tests/mediators/duplicated-helpers.test.ts.

export interface WalletBalance {
    balance: number;
}

export async function waitForWallet(
    getBalance: () => Promise<WalletBalance>,
    getAddress: () => Promise<string>,
    onWait: () => void,
    sleep: (ms: number) => Promise<void>,
    intervalMs: number = 5000,
): Promise<{ balance: number; address: string }> {
    for (;;) {
        try {
            // Both, because the balance route answers from the chain node
            // while the address route refuses until the wallet's own setup has
            // succeeded. A wallet that answers one and not the other is not
            // ready, and the mediator calls the address route immediately.
            const { balance } = await getBalance();
            const address = await getAddress();

            return { balance, address };
        }
        catch {
            onWait();
            await sleep(intervalMs);
        }
    }
}
