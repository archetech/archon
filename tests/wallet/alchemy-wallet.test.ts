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
