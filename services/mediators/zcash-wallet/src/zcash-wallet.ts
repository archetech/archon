import { ECPair, Transaction, address, bitgo, opcodes, script } from '@bitgo/utxo-lib';
import config from './config.js';
import type { WalletNetwork } from './config.js';
import type { RpcClient } from './zcash-rpc.js';
import {
    deriveAddressRange,
    deriveChildKey,
    deriveTransparentAddress,
    getXpub,
    getZcashNetwork,
} from './derivation.js';

export { getXpub } from './derivation.js';

const ZATS_PER_ZEC = 100_000_000;
const DEFAULT_TX_VERSION = bitgo.ZcashTransaction.VERSION5_BRANCH_NU6_1;
const CHANGE_DUST_ZAT = 1_000;

export interface ZcashUtxo {
    txid: string;
    vout: number;
    address: string;
    scriptPubKey: string;
    amount: number;
    zats: number;
    height: number;
    confirmations: number;
    spendable: boolean;
    solvable: boolean;
}

export interface ZcashTransactionEntry {
    txid: string;
    confirmations: number;
    blockhash?: string;
    blocktime?: number;
    time?: number;
    amount?: number;
    fee?: number;
    details?: Array<{ address?: string; category: string; amount: number; vout: number }>;
}

interface RawAddressUtxo {
    address: string;
    txid: string;
    outputIndex: number;
    script: string;
    satoshis?: number;
    zatoshis?: number;
    valueZat?: number;
    height: number;
}

interface WalletAddress {
    address: string;
    chain: 0 | 1;
    index: number;
}

interface BuildOutput {
    address?: string;
    zats: number;
    script?: Buffer;
}

export function zecToZats(amount: number): number {
    if (!Number.isFinite(amount)) {
        throw new Error('Amount must be a finite number');
    }
    return Math.round(amount * ZATS_PER_ZEC);
}

export function zatsToZec(zats: number): number {
    return zats / ZATS_PER_ZEC;
}

export function validateOpReturnData(data: string): Buffer {
    const bytes = Buffer.from(data, 'utf8');
    if (bytes.length > 80) {
        throw new Error('OP_RETURN data exceeds 80 byte limit');
    }
    return bytes;
}

export async function setupTransparentWallet(
    zecClient: RpcClient,
    mnemonic: string,
    network: WalletNetwork,
): Promise<{ walletName: string; descriptors: string[] }> {
    await assertRequiredRpc(zecClient);
    const external = deriveAddressRange(mnemonic, network, 0, config.gapLimit);
    const internal = deriveAddressRange(mnemonic, network, 1, config.gapLimit);

    return {
        walletName: config.walletName,
        descriptors: [
            `transparent-p2pkh:m/44'/${network === 'mainnet' ? 133 : 1}'/0'/0/0-${config.gapLimit - 1}`,
            `transparent-p2pkh:m/44'/${network === 'mainnet' ? 133 : 1}'/0'/1/0-${config.gapLimit - 1}`,
            `external:${external[0]}..${external[external.length - 1]}`,
            `internal:${internal[0]}..${internal[internal.length - 1]}`,
        ],
    };
}

export async function getBalance(
    zecClient: RpcClient,
    mnemonic: string,
    network: WalletNetwork,
): Promise<{ balance: number; unconfirmed_balance: number }> {
    const addresses = await getTrackedAddresses(mnemonic, network);
    const balance = await getAddressBalance(zecClient, addresses.map(item => item.address));
    return {
        balance: zatsToZec(balance.balance),
        unconfirmed_balance: 0,
    };
}

export async function getReceiveAddress(
    zecClient: RpcClient,
    mnemonic: string,
    network: WalletNetwork,
): Promise<string> {
    for (let index = 0; index < config.gapLimit; index++) {
        const addressValue = deriveTransparentAddress(mnemonic, network, 0, index);
        const txids = await zecClient.command<string[]>('getaddresstxids', [{ addresses: [addressValue] }]);
        if (txids.length === 0) {
            return addressValue;
        }
    }

    return deriveTransparentAddress(mnemonic, network, 0, config.gapLimit - 1);
}

export async function getTransactions(
    zecClient: RpcClient,
    mnemonic: string,
    network: WalletNetwork,
    count: number = 10,
    skip: number = 0,
): Promise<ZcashTransactionEntry[]> {
    const addresses = await getTrackedAddresses(mnemonic, network);
    const txids = await zecClient.command<string[]>('getaddresstxids', [{ addresses: addresses.map(item => item.address) }]);
    const unique = Array.from(new Set(txids)).reverse().slice(skip, skip + count);

    const txs = await Promise.all(unique.map(txid => getTransaction(zecClient, txid).catch(() => undefined)));
    return txs.filter((tx): tx is ZcashTransactionEntry => Boolean(tx));
}

export async function getUtxos(
    zecClient: RpcClient,
    mnemonic: string,
    network: WalletNetwork,
    minconf: number = 1,
): Promise<ZcashUtxo[]> {
    const addresses = await getTrackedAddresses(mnemonic, network);
    const height = await zecClient.command<number>('getblockcount');
    const rawUtxos = await zecClient.command<RawAddressUtxo[]>('getaddressutxos', [{ addresses: addresses.map(item => item.address) }]);

    return rawUtxos
        .map(utxo => normalizeUtxo(utxo, height))
        .filter(utxo => utxo.confirmations >= minconf);
}

export async function estimateFee(
    zecClient: RpcClient,
    blocks?: number,
): Promise<{ feerate: number; blocks: number }> {
    const networkInfo = await zecClient.command<{ relayfee?: number }>('getnetworkinfo');
    return {
        feerate: networkInfo.relayfee || zatsToZec(config.defaultFeeRateZatKb),
        blocks: blocks || config.feeTarget,
    };
}

export async function getWalletStatus(
    zecClient: RpcClient,
    mnemonic: string,
    network: WalletNetwork,
): Promise<{
    network: WalletNetwork;
    walletName: string;
    ready: boolean;
    descriptorCount: number;
    xpub: string;
    addressCount: number;
}> {
    try {
        await assertRequiredRpc(zecClient);
        return {
            network,
            walletName: config.walletName,
            ready: true,
            descriptorCount: 2,
            xpub: getXpub(mnemonic, network),
            addressCount: config.gapLimit * 2,
        };
    } catch {
        return {
            network,
            walletName: config.walletName,
            ready: false,
            descriptorCount: 0,
            xpub: getXpub(mnemonic, network),
            addressCount: 0,
        };
    }
}

export async function getTransaction(
    zecClient: RpcClient,
    txid: string,
): Promise<ZcashTransactionEntry> {
    const tx = await zecClient.command<any>('getrawtransaction', [txid, 1]);
    return {
        txid: tx.txid,
        confirmations: tx.confirmations || 0,
        blockhash: tx.blockhash,
        blocktime: tx.blocktime,
        time: tx.time,
        fee: tx.fee,
        details: Array.isArray(tx.vout)
            ? tx.vout.map((output: any) => ({
                address: output.scriptPubKey?.addresses?.[0],
                category: 'receive',
                amount: output.value,
                vout: output.n,
            }))
            : [],
    };
}

export async function anchorData(
    zecClient: RpcClient,
    mnemonic: string,
    network: WalletNetwork,
    data: string,
    feeRate?: number,
): Promise<{ txid: string; fee: number }> {
    const opReturnBytes = validateOpReturnData(data);
    const opReturnScript = script.compile([opcodes.OP_RETURN, opReturnBytes]);
    return buildSignAndBroadcast(zecClient, mnemonic, network, [{ zats: 0, script: opReturnScript }], feeRate);
}

export async function sendZec(
    zecClient: RpcClient,
    mnemonic: string,
    network: WalletNetwork,
    to: string,
    amountZec: number,
    feeRate?: number,
    subtractFee?: boolean,
): Promise<{ txid: string; fee: number }> {
    try {
        address.toOutputScript(to, getZcashNetwork(network));
    } catch {
        throw new Error(`Invalid address for ${network}: ${to}`);
    }

    const amountZats = zecToZats(amountZec);
    if (amountZats <= 0) {
        throw new Error('Amount must be greater than zero');
    }

    return buildSignAndBroadcast(zecClient, mnemonic, network, [{ address: to, zats: amountZats }], feeRate, subtractFee);
}

export async function bumpTransactionFee(): Promise<{ txid: string; fee: number }> {
    throw new Error('Zcash transparent fee bumping is not supported by zcash-wallet v1');
}

async function assertRequiredRpc(zecClient: RpcClient) {
    const probeAddress = 't1awxNksxJqtHYcG3b8uJ5jvvjPpXkHdvSB';
    await zecClient.command('getblockcount');
    await zecClient.command('getaddressutxos', [{ addresses: [probeAddress] }]);
    await zecClient.command('getaddresstxids', [{ addresses: [probeAddress] }]);
    await zecClient.command('getaddressbalance', [{ addresses: [probeAddress] }]);
}

async function getTrackedAddresses(mnemonic: string, network: WalletNetwork): Promise<WalletAddress[]> {
    const external = Array.from({ length: config.gapLimit }, (_, index) => ({
        address: deriveTransparentAddress(mnemonic, network, 0, index),
        chain: 0 as const,
        index,
    }));
    const internal = Array.from({ length: config.gapLimit }, (_, index) => ({
        address: deriveTransparentAddress(mnemonic, network, 1, index),
        chain: 1 as const,
        index,
    }));
    return [...external, ...internal];
}

async function getAddressBalance(zecClient: RpcClient, addresses: string[]): Promise<{ balance: number; received: number }> {
    const balance = await zecClient.command<{ balance: number; received: number }>('getaddressbalance', [{ addresses }]);
    return {
        balance: balance.balance || 0,
        received: balance.received || 0,
    };
}

function normalizeUtxo(utxo: RawAddressUtxo, currentHeight: number): ZcashUtxo {
    const zats = utxo.valueZat ?? utxo.zatoshis ?? utxo.satoshis ?? 0;
    const confirmations = utxo.height > 0 ? Math.max(0, currentHeight - utxo.height + 1) : 0;

    return {
        txid: utxo.txid,
        vout: utxo.outputIndex,
        address: utxo.address,
        scriptPubKey: utxo.script,
        amount: zatsToZec(zats),
        zats,
        height: utxo.height,
        confirmations,
        spendable: true,
        solvable: true,
    };
}

async function buildSignAndBroadcast(
    zecClient: RpcClient,
    mnemonic: string,
    network: WalletNetwork,
    outputs: BuildOutput[],
    feeRate?: number,
    subtractFee?: boolean,
): Promise<{ txid: string; fee: number }> {
    const walletAddresses = await getTrackedAddresses(mnemonic, network);
    const addressInfo = new Map(walletAddresses.map(item => [item.address, item]));
    const utxos = await getUtxos(zecClient, mnemonic, network, 1);
    if (utxos.length === 0) {
        throw new Error('No confirmed transparent Zcash UTXOs available');
    }

    const spendAmount = outputs.reduce((total, output) => total + output.zats, 0);
    const selected: ZcashUtxo[] = [];
    let inputTotal = 0;
    let feeZats = config.defaultFeeZat;

    for (const utxo of utxos.sort((a, b) => b.zats - a.zats)) {
        selected.push(utxo);
        inputTotal += utxo.zats;
        feeZats = estimateFeeZats(selected.length, outputs.length + 1, feeRate, outputs.some(output => output.script));
        if (inputTotal >= spendAmount + feeZats) {
            break;
        }
    }

    if (subtractFee && outputs.length === 1 && outputs[0].address) {
        outputs[0] = { ...outputs[0], zats: outputs[0].zats - feeZats };
    }

    if (outputs.some(output => output.zats < 0) || inputTotal < outputs.reduce((total, output) => total + output.zats, 0) + feeZats) {
        throw new Error('Insufficient confirmed transparent Zcash funds');
    }

    const currentHeight = await zecClient.command<number>('getblockcount');
    const txb = bitgo.createTransactionBuilderForNetwork(getZcashNetwork(network)) as any;
    txb.setDefaultsForVersion(getZcashNetwork(network), DEFAULT_TX_VERSION);
    txb.setExpiryHeight(currentHeight + 40);

    for (const utxo of selected) {
        txb.addInput(utxo.txid, utxo.vout);
    }

    for (const output of outputs) {
        if (output.script) {
            txb.addOutput(output.script, output.zats);
        } else if (output.address) {
            txb.addOutput(output.address, output.zats);
        }
    }

    const outputTotal = outputs.reduce((total, output) => total + output.zats, 0);
    const change = inputTotal - outputTotal - feeZats;
    if (change >= CHANGE_DUST_ZAT) {
        txb.addOutput(await getChangeAddress(zecClient, mnemonic, network), change);
    } else {
        feeZats += change;
    }

    selected.forEach((utxo, index) => {
        const owner = addressInfo.get(utxo.address);
        if (!owner) {
            throw new Error(`UTXO address ${utxo.address} is not in the tracked wallet range`);
        }

        const child = deriveChildKey(mnemonic, network, owner.chain, owner.index);
        if (!child.privateKey) {
            throw new Error(`Could not derive private key for ${utxo.address}`);
        }

        txb.tx.ins[index].value = utxo.zats;
        txb.sign({
            prevOutScriptType: 'p2pkh',
            vin: index,
            keyPair: ECPair.fromPrivateKey(child.privateKey),
            hashType: Transaction.SIGHASH_ALL,
        });
    });

    const tx = txb.build();
    const txid = await zecClient.command<string>('sendrawtransaction', [tx.toHex()]);
    return { txid, fee: zatsToZec(feeZats) };
}

async function getChangeAddress(zecClient: RpcClient, mnemonic: string, network: WalletNetwork): Promise<string> {
    for (let index = 0; index < config.gapLimit; index++) {
        const change = deriveTransparentAddress(mnemonic, network, 1, index);
        const txids = await zecClient.command<string[]>('getaddresstxids', [{ addresses: [change] }]);
        if (txids.length === 0) {
            return change;
        }
    }

    return deriveTransparentAddress(mnemonic, network, 1, config.gapLimit - 1);
}

function estimateFeeZats(inputCount: number, outputCount: number, feeRate?: number, hasOpReturn?: boolean): number {
    if (!feeRate) {
        return config.defaultFeeZat;
    }

    const estimatedBytes = 80 + (inputCount * 150) + (outputCount * 40) + (hasOpReturn ? 90 : 0);
    return Math.max(config.defaultFeeZat, Math.ceil(estimatedBytes * feeRate));
}
