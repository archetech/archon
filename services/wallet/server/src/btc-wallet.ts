import * as bip39 from 'bip39';
import HDKey from 'hdkey';
import * as ecc from 'tiny-secp256k1';
import { ECPairFactory } from 'ecpair';
import * as bitcoin from 'bitcoinjs-lib';
import BtcClient, {
    type ImportDescriptorRequest,
    type ImportDescriptorResult,
    type DescriptorInfoResult,
    type WalletCreateFundedPsbtResult,
    type UnspentOutput,
    type ListTransactionsEntry,
    type WalletInfo,
    type EstimateSmartFeeResult,
    type ListDescriptorsResult,
} from 'bitcoin-core';
import config from './config.js';
import type { WalletNetwork } from './config.js';
import { buildDescriptors } from './derivation.js';

export { getXpub } from './derivation.js';

const ECPair = ECPairFactory(ecc);
bitcoin.initEccLib(ecc);

function getBtcNetwork(network: WalletNetwork): bitcoin.Network {
    return network === 'mainnet' ? bitcoin.networks.bitcoin : bitcoin.networks.testnet;
}

export function createBtcClient(): BtcClient {
    return new BtcClient({
        username: config.btcUser,
        password: config.btcPass,
        host: `http://${config.btcHost}:${config.btcPort}`,
        wallet: config.walletName,
    });
}

export async function setupWatchOnlyWallet(
    btcClient: BtcClient,
    mnemonic: string,
    network: WalletNetwork,
): Promise<{ walletName: string; descriptors: string[] }> {
    // Create a blank watch-only descriptor wallet
    // createwallet args: name, disable_private_keys, blank, passphrase, avoid_reuse, descriptors
    try {
        await btcClient.command(
            'createwallet',
            config.walletName,
            true,   // disable_private_keys
            true,   // blank
            '',     // passphrase
            false,  // avoid_reuse
            true,   // descriptors
        );
    } catch (err: any) {
        // Wallet may already exist — try to load it
        if (err.message?.includes('already exists')) {
            try {
                await btcClient.command('loadwallet', config.walletName);
            } catch (loadErr: any) {
                // Already loaded is fine
                if (!loadErr.message?.includes('already loaded')) {
                    throw loadErr;
                }
            }
        } else {
            throw err;
        }
    }

    // Check which descriptors are already imported
    const existing: ListDescriptorsResult = await btcClient.listDescriptors(false);
    const existingDescs = existing.descriptors.map(d => d.desc);
    const hasExternal = existingDescs.some(d => d.includes('/0/*'));
    const hasInternal = existingDescs.some(d => d.includes('/1/*'));

    if (hasExternal && hasInternal) {
        return {
            walletName: config.walletName,
            descriptors: existingDescs,
        };
    }

    // Build descriptors with key origin info so PSBTs include full derivation paths
    const descs = buildDescriptors(mnemonic, network);

    const extInfo: DescriptorInfoResult = await btcClient.getDescriptorInfo(descs.external);
    const intInfo: DescriptorInfoResult = await btcClient.getDescriptorInfo(descs.internal);

    // Only import missing descriptors
    const requests: ImportDescriptorRequest[] = [];

    if (!hasExternal) {
        requests.push({
            desc: extInfo.descriptor,
            timestamp: 'now',
            active: true,
            range: [0, config.gapLimit],
            internal: false,
        });
    }

    if (!hasInternal) {
        requests.push({
            desc: intInfo.descriptor,
            timestamp: 'now',
            active: true,
            range: [0, config.gapLimit],
            internal: true,
        });
    }

    const results: ImportDescriptorResult[] = await btcClient.importDescriptors(requests);

    for (const result of results) {
        if (!result.success) {
            throw new Error(`Failed to import descriptor: ${result.error?.message}`);
        }
    }

    return {
        walletName: config.walletName,
        descriptors: [extInfo.descriptor, intInfo.descriptor],
    };
}

export async function getBalance(btcClient: BtcClient): Promise<{
    balance: number;
    unconfirmed_balance: number;
}> {
    const info: WalletInfo = await btcClient.getWalletInfo();
    return {
        balance: info.balance,
        unconfirmed_balance: info.unconfirmed_balance,
    };
}

let cachedReceiveAddress: string | null = null;

export async function getReceiveAddress(btcClient: BtcClient): Promise<string> {
    if (cachedReceiveAddress) {
        const received = await btcClient.command('getreceivedbyaddress', cachedReceiveAddress, 0);
        if (received === 0) {
            return cachedReceiveAddress;
        }
    }

    cachedReceiveAddress = await btcClient.getNewAddress('receive', 'bech32');
    return cachedReceiveAddress;
}

export async function getTransactions(
    btcClient: BtcClient,
    count: number = 10,
    skip: number = 0,
): Promise<ListTransactionsEntry[]> {
    return btcClient.command('listtransactions', '*', count, skip, true);
}

export async function getUtxos(
    btcClient: BtcClient,
    minconf: number = 1,
): Promise<UnspentOutput[]> {
    return btcClient.listUnspent(minconf);
}

export async function estimateFee(
    btcClient: BtcClient,
    blocks?: number,
): Promise<EstimateSmartFeeResult> {
    return btcClient.estimateSmartFee(blocks || config.feeTarget, 'ECONOMICAL');
}

export async function getWalletStatus(btcClient: BtcClient): Promise<{
    network: WalletNetwork;
    walletName: string;
    ready: boolean;
    descriptorCount: number;
}> {
    try {
        const info: ListDescriptorsResult = await btcClient.listDescriptors(false);
        return {
            network: config.network,
            walletName: config.walletName,
            ready: info.descriptors.length > 0,
            descriptorCount: info.descriptors.length,
        };
    } catch {
        return {
            network: config.network,
            walletName: config.walletName,
            ready: false,
            descriptorCount: 0,
        };
    }
}

export async function anchorData(
    btcClient: BtcClient,
    mnemonic: string,
    network: WalletNetwork,
    data: string,
    feeRate?: number,
): Promise<{ txid: string; fee: number }> {
    const opReturnHex = Buffer.from(data, 'utf8').toString('hex');

    // Create funded PSBT with OP_RETURN output
    const psbtResult: WalletCreateFundedPsbtResult = await btcClient.walletCreateFundedPsbt(
        [],
        [{ data: opReturnHex }],
        0,
        {
            includeWatching: true,
            fee_rate: feeRate || undefined,
            conf_target: feeRate ? undefined : config.feeTarget,
            replaceable: true,
            add_inputs: true,
            changePosition: 1,
        },
        true, // include BIP-32 derivation info
    );

    // Sign and broadcast
    return signAndBroadcast(btcClient, mnemonic, network, psbtResult);
}

export async function bumpTransactionFee(
    btcClient: BtcClient,
    mnemonic: string,
    network: WalletNetwork,
    txid: string,
    feeRate?: number,
): Promise<{ txid: string; fee: number }> {
    // psbtbumpfee returns a PSBT for watch-only wallets
    const bumpResult = await btcClient.command('psbtbumpfee', txid, {
        ...(feeRate ? { fee_rate: feeRate } : {}),
    });

    const btcNetwork = getBtcNetwork(network);
    const psbt = bitcoin.Psbt.fromBase64(bumpResult.psbt, { network: btcNetwork });

    // Sign all inputs
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const root = HDKey.fromMasterSeed(seed);

    for (let i = 0; i < psbt.inputCount; i++) {
        const input = psbt.data.inputs[i];
        const bip32Derivation = input.bip32Derivation;
        if (!bip32Derivation || bip32Derivation.length === 0) {
            throw new Error(`Input ${i}: missing BIP-32 derivation info`);
        }

        const { path } = bip32Derivation[0];
        const child = root.derive(path);

        if (!child.privateKey) {
            throw new Error(`Input ${i}: could not derive private key at ${path}`);
        }

        const keyPair = ECPair.fromPrivateKey(child.privateKey, { network: btcNetwork });
        psbt.signInput(i, keyPair);
    }

    psbt.finalizeAllInputs();
    const tx = psbt.extractTransaction();
    const newTxid = await btcClient.sendRawTransaction(tx.toHex());

    return { txid: newTxid, fee: bumpResult.fee };
}

async function signAndBroadcast(
    btcClient: BtcClient,
    mnemonic: string,
    network: WalletNetwork,
    psbtResult: WalletCreateFundedPsbtResult,
): Promise<{ txid: string; fee: number }> {
    const btcNetwork = getBtcNetwork(network);
    const psbt = bitcoin.Psbt.fromBase64(psbtResult.psbt, { network: btcNetwork });

    // Derive keys and sign each input
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const root = HDKey.fromMasterSeed(seed);

    for (let i = 0; i < psbt.inputCount; i++) {
        const input = psbt.data.inputs[i];
        const bip32Derivation = input.bip32Derivation;
        if (!bip32Derivation || bip32Derivation.length === 0) {
            throw new Error(`Input ${i}: missing BIP-32 derivation info`);
        }

        const { path } = bip32Derivation[0];
        const child = root.derive(path);

        if (!child.privateKey) {
            throw new Error(`Input ${i}: could not derive private key at ${path}`);
        }

        const keyPair = ECPair.fromPrivateKey(child.privateKey, { network: btcNetwork });
        psbt.signInput(i, keyPair);
    }

    // Finalize and extract
    psbt.finalizeAllInputs();
    const tx = psbt.extractTransaction();
    const txid = await btcClient.sendRawTransaction(tx.toHex());

    return { txid, fee: psbtResult.fee };
}

export async function sendBtc(
    btcClient: BtcClient,
    mnemonic: string,
    network: WalletNetwork,
    to: string,
    amountBtc: number,
    feeRate?: number,
    subtractFee?: boolean,
): Promise<{ txid: string; fee: number }> {
    const btcNetwork = getBtcNetwork(network);

    // Validate address
    try {
        bitcoin.address.toOutputScript(to, btcNetwork);
    } catch {
        throw new Error(`Invalid address for ${network}: ${to}`);
    }

    // Create funded PSBT via bitcoind (handles UTXO selection, change)
    const psbtResult: WalletCreateFundedPsbtResult = await btcClient.walletCreateFundedPsbt(
        [],
        [{ [to]: amountBtc }],
        0,
        {
            includeWatching: true,
            fee_rate: feeRate || undefined,
            conf_target: feeRate ? undefined : config.feeTarget,
            replaceable: true,
            subtractFeeFromOutputs: subtractFee ? [0] : [],
            add_inputs: true,
        },
        true, // include BIP-32 derivation info
    );

    // Sign and broadcast
    return signAndBroadcast(btcClient, mnemonic, network, psbtResult);
}
