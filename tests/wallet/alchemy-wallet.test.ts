import { normalizeHostedUtxos } from '../../services/mediators/satoshi-wallet/src/utxo-normalizer';

describe('Alchemy wallet backend', () => {
    it('normalizes common UTXO response shapes', () => {
        expect(normalizeHostedUtxos({
            utxos: [
                {
                    txid: 'tx-a',
                    vout: 0,
                    value: 12_345,
                    confirmations: 3,
                },
                {
                    transactionHash: 'tx-b',
                    outputIndex: 1,
                    satoshis: '2500',
                    numConfirmations: '0',
                },
                {
                    tx_hash: 'tx-c',
                    index: 2,
                    amount: '0.00010000',
                    confirmedConfirmations: 7,
                },
            ],
        })).toEqual([
            { txid: 'tx-a', vout: 0, valueSats: 12_345, confirmations: 3 },
            { txid: 'tx-b', vout: 1, valueSats: 2_500, confirmations: 0 },
            { txid: 'tx-c', vout: 2, valueSats: 10_000, confirmations: 7 },
        ]);
    });

    it('normalizes alternate hosted API wrapper shapes', () => {
        expect(normalizeHostedUtxos({
            data: [
                { hash: 'data-tx', n: 3, valueSats: 4000, confirmations: 2.9 },
            ],
        })).toEqual([
            { txid: 'data-tx', vout: 3, valueSats: 4000, confirmations: 2 },
        ]);

        expect(normalizeHostedUtxos({
            result: {
                utxos: [
                    { txId: 'result-utxos-tx', outputIndex: 4, value_sat: 5000n, confirmations: -1 },
                ],
            },
        })).toEqual([
            { txid: 'result-utxos-tx', vout: 4, valueSats: 5000, confirmations: 0 },
        ]);

        expect(normalizeHostedUtxos({
            outputs: [
                { txid: 'outputs-tx', vout: 5, amount: 0.00006 },
            ],
        })).toEqual([
            { txid: 'outputs-tx', vout: 5, valueSats: 6000, confirmations: 0 },
        ]);
    });

    it('normalizes a bare result array', () => {
        expect(normalizeHostedUtxos({
            result: [
                { transactionHash: 'result-array-tx', index: 6, value: '7000', confirmations: 1 },
            ],
        })).toEqual([
            { txid: 'result-array-tx', vout: 6, valueSats: 7000, confirmations: 1 },
        ]);
    });

    it('ignores incomplete or zero-value UTXOs', () => {
        expect(normalizeHostedUtxos([
            { txid: 'missing-vout', value: 1000 },
            { txid: 'zero-value', vout: 0, value: 0 },
            { txid: 'valid', vout: 1, value: '0x64' },
        ])).toEqual([
            { txid: 'valid', vout: 1, valueSats: 100, confirmations: 0 },
        ]);
    });

    it('normalizes mempool.space Esplora UTXOs', () => {
        expect(normalizeHostedUtxos([
            {
                txid: 'mempool-tx',
                vout: 2,
                value: 5000,
                status: {
                    confirmed: true,
                    block_height: 123,
                },
            },
        ])).toEqual([
            { txid: 'mempool-tx', vout: 2, valueSats: 5000, confirmations: 1 },
        ]);
    });

    it('defaults non-numeric confirmations to zero', () => {
        expect(normalizeHostedUtxos([
            {
                txid: 'bad-confirmations',
                vout: 0,
                value: 5000,
                confirmations: 'not-a-number',
            },
        ])).toEqual([
            { txid: 'bad-confirmations', vout: 0, valueSats: 5000, confirmations: 0 },
        ]);
    });
});
