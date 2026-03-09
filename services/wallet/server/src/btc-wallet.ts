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

const ECPair = ECPairFactory(ecc);
bitcoin.initEccLib(ecc);

function getBtcNetwork(network: WalletNetwork): bitcoin.Network {
    return network === 'mainnet' ? bitcoin.networks.bitcoin : bitcoin.networks.testnet;
}

function getCoinType(network: WalletNetwork): number {
    return network === 'mainnet' ? 0 : 1;
}

const MAINNET_VERSIONS = { private: 0x0488ADE4, public: 0x0488B21E }; // xprv / xpub
const TESTNET_VERSIONS = { private: 0x04358394, public: 0x043587CF }; // tprv / tpub

function getHDKeyVersions(network: WalletNetwork) {
    return network === 'mainnet' ? MAINNET_VERSIONS : TESTNET_VERSIONS;
}

function deriveAccountKey(mnemonic: string, network: WalletNetwork): HDKey {
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const versions = getHDKeyVersions(network);
    const root = HDKey.fromMasterSeed(seed, versions);
    const coinType = getCoinType(network);
    return root.derive(`m/84'/${coinType}'/0'`);
}

export function getXpub(mnemonic: string, network: WalletNetwork): string {
    const account = deriveAccountKey(mnemonic, network);
    return account.publicExtendedKey;
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
    const xpub = getXpub(mnemonic, network);

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

    // Get checksummed descriptors from bitcoind
    const extDesc = `wpkh(${xpub}/0/*)`;
    const intDesc = `wpkh(${xpub}/1/*)`;

    const extInfo: DescriptorInfoResult = await btcClient.getDescriptorInfo(extDesc);
    const intInfo: DescriptorInfoResult = await btcClient.getDescriptorInfo(intDesc);

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

export async function getReceiveAddress(btcClient: BtcClient): Promise<string> {
    return btcClient.getNewAddress('receive', 'bech32');
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

    // Parse PSBT
    const psbt = bitcoin.Psbt.fromBase64(psbtResult.psbt, { network: btcNetwork });

    // Derive keys and sign each input
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const root = HDKey.fromMasterSeed(seed);

    for (let i = 0; i < psbt.inputCount; i++) {
        const input = psbt.data.inputs[i];

        // Get the BIP-32 derivation path from the PSBT input
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
    const txHex = tx.toHex();

    // Broadcast
    const txid = await btcClient.sendRawTransaction(txHex);

    return { txid, fee: psbtResult.fee };
}
