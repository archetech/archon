// Bitcoin Core accepts at most three decimals in a fee_rate and rejects anything
// longer as "Invalid amount". Converting BTC/kvB to sat/vB does not cancel in
// binary floating point -- 0.00003614 becomes 3.6140000000000003 -- so the
// result has to be rounded before it can be sent.
export function toFeeRate(satPerVb: number): number {
    return Math.round(satPerVb * 1000) / 1000;
}
