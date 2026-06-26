import { jest } from '@jest/globals';
import {
    anchorData,
    bumpTransactionFee,
    estimateZip317TransparentFeeZats,
    estimateFee,
    getBalance,
    getReceiveAddress,
    getTransaction,
    getTransactions,
    getUtxos,
    getWalletStatus,
    sendZec,
    setupTransparentWallet,
    validateOpReturnData,
    zecToZats,
} from '../../services/mediators/zcash-wallet/src/zcash-wallet';
import { deriveTransparentAddress } from '../../services/mediators/zcash-wallet/src/derivation';
import type { RpcClient } from '../../services/mediators/zcash-wallet/src/zcash-rpc';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const FIRST_ADDRESS = deriveTransparentAddress(TEST_MNEMONIC, 'mainnet', 0, 0);

function createRpcMock(overrides?: Partial<Record<string, any>>): RpcClient & { command: jest.Mock } {
    const command = jest.fn(async (method: string, params?: any[]) => {
        if (overrides && method in overrides) {
            const override = overrides[method];
            if (override instanceof Error) {
                throw override;
            }
            if (typeof override === 'function') {
                return override(params);
            }
            return override;
        }

        switch (method) {
        case 'getblockcount':
            return 3_339_235;
        case 'getaddressutxos':
            return [];
        case 'getaddresstxids':
            return [];
        case 'getaddressbalance':
            return { balance: 0, received: 0 };
        case 'getnetworkinfo':
            return { relayfee: 0.000001 };
        case 'sendrawtransaction':
            return 'broadcast-txid';
        default:
            throw new Error(`Unexpected RPC method ${method}`);
        }
    });

    return { command } as RpcClient & { command: jest.Mock };
}

describe('zcash-wallet RPC-backed behavior', () => {
    it('calculates ZIP-317 transparent fees from logical actions', () => {
        expect(estimateZip317TransparentFeeZats([150], [34], undefined, 0)).toBe(10_000);
        expect(estimateZip317TransparentFeeZats([150], [82, 34], undefined, 0)).toBe(20_000);
        expect(estimateZip317TransparentFeeZats([150], [92, 34], undefined, 0)).toBe(20_000);
        expect(estimateZip317TransparentFeeZats([150], [92, 34], 100, 0)).toBe(35_600);
    });

    it('sets up idempotently when Zebra address-index RPCs are available', async () => {
        const rpc = createRpcMock();
        const result = await setupTransparentWallet(rpc, TEST_MNEMONIC, 'mainnet');

        expect(result.walletName).toMatch(/^archon-zec-/);
        expect(result.descriptors[0]).toContain("transparent-p2pkh:m/44'/133'/0'/0/");
        expect(rpc.command).toHaveBeenCalledWith('getaddressutxos', [{ addresses: ['t1awxNksxJqtHYcG3b8uJ5jvvjPpXkHdvSB'] }]);
    });

    it('fails setup clearly when Zebra address-index RPCs are missing', async () => {
        const rpc = createRpcMock({ getaddressutxos: new Error('Method not found') });

        await expect(setupTransparentWallet(rpc, TEST_MNEMONIC, 'mainnet')).rejects.toThrow('Method not found');
    });

    it('returns the first unused receive address', async () => {
        const rpc = createRpcMock();

        await expect(getReceiveAddress(rpc, TEST_MNEMONIC, 'mainnet')).resolves.toBe(FIRST_ADDRESS);
    });

    it('falls back to the last receive address when the gap range is used', async () => {
        const rpc = createRpcMock({
            getaddresstxids: ['used-txid'],
        });

        await expect(getReceiveAddress(rpc, TEST_MNEMONIC, 'mainnet')).resolves.toBe(
            deriveTransparentAddress(TEST_MNEMONIC, 'mainnet', 0, 19)
        );
    });

    it('reports balance in ZEC from address-index zats', async () => {
        const rpc = createRpcMock({
            getaddressbalance: { balance: 123_456_789, received: 123_466_789 },
        });

        await expect(getBalance(rpc, TEST_MNEMONIC, 'mainnet')).resolves.toEqual({
            balance: 1.23456789,
            unconfirmed_balance: 0,
        });
    });

    it('uses a fee-rate fallback when Zebra relay fee is unavailable', async () => {
        const rpc = createRpcMock({
            getnetworkinfo: {},
        });

        await expect(estimateFee(rpc, 3)).resolves.toEqual({
            feerate: 0.0001,
            blocks: 3,
        });
    });

    it('reports wallet status from required Zebra address-index RPCs', async () => {
        const readyRpc = createRpcMock();
        const missingRpc = createRpcMock({ getaddressbalance: new Error('Method not found') });

        await expect(getWalletStatus(readyRpc, TEST_MNEMONIC, 'mainnet')).resolves.toMatchObject({
            network: 'mainnet',
            ready: true,
            descriptorCount: 2,
            addressCount: 40,
        });
        await expect(getWalletStatus(missingRpc, TEST_MNEMONIC, 'mainnet')).resolves.toMatchObject({
            network: 'mainnet',
            ready: false,
            descriptorCount: 0,
            addressCount: 0,
        });
    });

    it('maps raw transactions and filters failed transaction lookups', async () => {
        const rpc = createRpcMock({
            getaddresstxids: ['tx-a', 'tx-b', 'tx-a'],
            getrawtransaction: (params?: any[]) => {
                const txid = params?.[0];
                if (txid === 'tx-b') {
                    throw new Error('missing transaction');
                }
                return {
                    txid,
                    confirmations: 2,
                    blockhash: 'block-hash',
                    blocktime: 1_700_000_000,
                    time: 1_700_000_001,
                    fee: -0.00001,
                    vout: [{
                        n: 0,
                        value: 0.25,
                        scriptPubKey: { addresses: [FIRST_ADDRESS] },
                    }],
                };
            },
        });

        await expect(getTransaction(rpc, 'tx-a')).resolves.toStrictEqual({
            txid: 'tx-a',
            confirmations: 2,
            blockhash: 'block-hash',
            blocktime: 1_700_000_000,
            time: 1_700_000_001,
            fee: -0.00001,
            details: [{
                address: FIRST_ADDRESS,
                category: 'receive',
                amount: 0.25,
                vout: 0,
            }],
        });
        await expect(getTransactions(rpc, TEST_MNEMONIC, 'mainnet', 2, 0)).resolves.toHaveLength(1);
    });

    it('normalizes UTXOs and confirmations', async () => {
        const rpc = createRpcMock({
            getaddressutxos: [{
                address: FIRST_ADDRESS,
                txid: '01'.repeat(32),
                outputIndex: 0,
                script: '76a914000000000000000000000000000000000000000088ac',
                satoshis: 50_000,
                height: 3_339_230,
            }],
        });

        const utxos = await getUtxos(rpc, TEST_MNEMONIC, 'mainnet', 1);

        expect(utxos).toMatchObject([{
            txid: '01'.repeat(32),
            vout: 0,
            address: FIRST_ADDRESS,
            amount: 0.0005,
            confirmations: 6,
        }]);
    });

    it('builds and broadcasts an anchor transaction from confirmed transparent UTXOs', async () => {
        const rpc = createRpcMock({
            getaddressutxos: [{
                address: FIRST_ADDRESS,
                txid: '01'.repeat(32),
                outputIndex: 0,
                script: '76a914000000000000000000000000000000000000000088ac',
                satoshis: 50_000,
                height: 3_339_230,
            }],
            sendrawtransaction: (params?: any[]) => {
                expect(params?.[0]).toMatch(/^0400008085202f89/);
                return 'broadcast-txid';
            },
        });

        await expect(anchorData(rpc, TEST_MNEMONIC, 'mainnet', `did:cid:${'a'.repeat(54)}`)).resolves.toEqual({
            txid: 'broadcast-txid',
            fee: 0.0002,
        });
    });

    it('validates send and anchor request inputs before broadcasting', async () => {
        const rpc = createRpcMock();

        expect(validateOpReturnData('hello')).toStrictEqual(Buffer.from('hello'));
        await expect(anchorData(rpc, TEST_MNEMONIC, 'mainnet', 'x'.repeat(81))).rejects.toThrow('OP_RETURN data exceeds 80 byte limit');
        await expect(sendZec(rpc, TEST_MNEMONIC, 'mainnet', 'not-an-address', 1)).rejects.toThrow('Invalid address for mainnet');
        expect(() => zecToZats(Number.POSITIVE_INFINITY)).toThrow('Amount must be a finite number');
        await expect(bumpTransactionFee()).rejects.toThrow('not supported');
    });
});
