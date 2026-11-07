import promClient from 'prom-client';
import { readWalletFunding } from '../../services/mediators/satoshi/src/wallet-funding.ts';

// A mediator below its funding floor stops anchoring and said so only in its log
// (#1534). These gauges are what the provisioned Grafana alert reads, so a stale
// or wrongly set value is a missed or false alert.

describe('readWalletFunding', () => {
    const registry = new promClient.Registry();
    const insufficientFunds = new promClient.Gauge({ name: 'test_insufficient_funds', help: 'test', registers: [registry] });
    const unreachable = new promClient.Gauge({ name: 'test_unreachable', help: 'test', registers: [registry] });
    const gauges = { insufficientFunds, unreachable };

    const value = async (gauge: promClient.Gauge): Promise<number> => (await gauge.get()).values[0].value;
    const belowFloor = ({ balance }: { balance: number }): boolean => balance < 10;

    beforeEach(() => {
        registry.resetMetrics();
    });

    it('sets the funds gauge when the balance is below the floor', async () => {
        const result = await readWalletFunding(async () => ({ balance: 9 }), belowFloor, gauges);

        expect(result).toStrictEqual({ wallet: { balance: 9 }, belowFloor: true });
        expect(await value(insufficientFunds)).toBe(1);
        expect(await value(unreachable)).toBe(0);
    });

    it('treats a balance exactly at the floor as funded', async () => {
        const result = await readWalletFunding(async () => ({ balance: 10 }), belowFloor, gauges);

        expect(result.belowFloor).toBe(false);
        expect(await value(insufficientFunds)).toBe(0);
    });

    it('clears the funds gauge when the funds return', async () => {
        await readWalletFunding(async () => ({ balance: 1 }), belowFloor, gauges);
        expect(await value(insufficientFunds)).toBe(1);

        await readWalletFunding(async () => ({ balance: 100 }), belowFloor, gauges);
        expect(await value(insufficientFunds)).toBe(0);
    });

    it('does not report low funds when the wallet cannot be reached', async () => {
        const down = async (): Promise<{ balance: number }> => { throw new Error('ECONNREFUSED'); };

        await expect(readWalletFunding(down, belowFloor, gauges)).rejects.toThrow('ECONNREFUSED');

        expect(await value(insufficientFunds)).toBe(0);
        expect(await value(unreachable)).toBe(1);
    });

    it('keeps the last funds reading while the wallet cannot be reached', async () => {
        await readWalletFunding(async () => ({ balance: 1 }), belowFloor, gauges);

        const down = async (): Promise<{ balance: number }> => { throw new Error('ECONNREFUSED'); };
        await expect(readWalletFunding(down, belowFloor, gauges)).rejects.toThrow();

        expect(await value(insufficientFunds)).toBe(1);
        expect(await value(unreachable)).toBe(1);
    });

    it('clears the unreachable gauge once the wallet answers again', async () => {
        const down = async (): Promise<{ balance: number }> => { throw new Error('ECONNREFUSED'); };
        await expect(readWalletFunding(down, belowFloor, gauges)).rejects.toThrow();

        await readWalletFunding(async () => ({ balance: 100 }), belowFloor, gauges);

        expect(await value(unreachable)).toBe(0);
    });

    it('treats an unparseable balance as unreachable rather than low', async () => {
        await expect(readWalletFunding(
            async () => ({ balanceWei: 'garbage' }),
            ({ balanceWei }) => BigInt(balanceWei) < 10n,
            gauges,
        )).rejects.toThrow();

        expect(await value(insufficientFunds)).toBe(0);
        expect(await value(unreachable)).toBe(1);
    });
});
