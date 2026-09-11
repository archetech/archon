import { waitForWallet } from '../../services/mediators/satoshi/src/wallet-wait.ts';

// A wallet whose own setup failed answers the balance route from the chain node
// and refuses the address route with a 503 (#1122). Waiting on the balance
// alone therefore returned while the very next call was still failing, and that
// throw escaped an unawaited main() and exited the mediator -- permanently,
// since nothing restarts it.

describe('waitForWallet', () => {
    const immediately = async (): Promise<void> => { };

    it('returns once both routes answer', async () => {
        const waits: number[] = [];
        const result = await waitForWallet(
            async () => ({ balance: 42 }),
            async () => 'address-1',
            () => waits.push(1),
            immediately,
        );

        expect(result).toStrictEqual({ balance: 42, address: 'address-1' });
        expect(waits).toHaveLength(0);
    });

    it('keeps waiting while the address route refuses', async () => {
        let attempts = 0;
        const waits: number[] = [];

        const result = await waitForWallet(
            async () => ({ balance: 7 }),
            async () => {
                attempts += 1;

                if (attempts < 3) {
                    throw new Error('Watch-only wallet is not set up; refusing to serve an address');
                }

                return 'address-2';
            },
            () => waits.push(1),
            immediately,
        );

        expect(result).toStrictEqual({ balance: 7, address: 'address-2' });
        expect(attempts).toBe(3);
        expect(waits).toHaveLength(2);
    });

    it('keeps waiting while the wallet is unreachable', async () => {
        let attempts = 0;

        const result = await waitForWallet(
            async () => {
                attempts += 1;

                if (attempts < 2) {
                    throw new Error('getaddrinfo ENOTFOUND keymaster');
                }

                return { balance: 0 };
            },
            async () => 'address-3',
            () => { },
            immediately,
        );

        expect(result).toStrictEqual({ balance: 0, address: 'address-3' });
    });

    it('never throws out of the wait', async () => {
        let attempts = 0;

        await expect(waitForWallet(
            async () => ({ balance: 1 }),
            async () => {
                attempts += 1;

                if (attempts < 5) {
                    throw new Error('503');
                }

                return 'address-4';
            },
            () => { },
            immediately,
        )).resolves.toBeDefined();
    });
});
