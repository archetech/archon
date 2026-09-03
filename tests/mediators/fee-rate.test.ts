import { toFeeRate } from '../../services/mediators/satoshi/src/fee.ts';

// Bitcoin Core rejects a fee_rate carrying more than three decimals as
// "Invalid amount". Converting bitcoind's BTC/kvB estimate to sat/vB does not
// cancel in binary floating point, so every anchor failed on a node whose local
// estimate beat the oracle -- which on an empty mempool is always (#1033).

describe('toFeeRate', () => {
    it('rounds the conversions that carry floating point error', () => {
        // The values that broke anchoring: (feerate / 1000) * 1e8.
        expect(toFeeRate((0.00003614 / 1000) * 1e8)).toBe(3.614);
        expect(toFeeRate((0.00002829 / 1000) * 1e8)).toBe(2.829);
    });

    it('leaves a rate Bitcoin Core already accepts alone', () => {
        expect(toFeeRate(1)).toBe(1);
        expect(toFeeRate(1.2)).toBe(1.2);
        expect(toFeeRate(5.001)).toBe(5.001);
    });

    it('never returns more than three decimals', () => {
        const rates = [3.6140000000000003, 2.8289999999999997, 1 / 3, 0.0001, 12.34567];

        for (const rate of rates) {
            const decimals = (String(toFeeRate(rate)).split('.')[1] ?? '').length;
            expect(decimals).toBeLessThanOrEqual(3);
        }
    });
});
