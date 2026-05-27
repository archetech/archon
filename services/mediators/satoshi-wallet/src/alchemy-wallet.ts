import axios from 'axios';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { ECPairFactory } from 'ecpair';
import config from './config.js';
import type { WalletNetwork } from './config.js';
import { deriveAccountKey, deriveAddress, getBtcNetwork } from './derivation.js';
import { normalizeHostedUtxos, type NormalizedRawUtxo } from './utxo-normalizer.js';
import type { EstimateSmartFeeResult, ListTransactionsEntry, UnspentOutput } from 'bitcoin-core';
import type BtcClient from 'bitcoin-core';

const ECPair = ECPairFactory(ecc);
bitcoin.initEccLib(ecc);

const SATS_PER_BTC = 100_000_000;
const DUST_SATS = 546;
const DEFAULT_FEE_RATE_SAT_VB = 10;

type Chain = 0 | 1;

export interface AlchemyAddressState {
    address: string;
    chain: Chain;
    index: number;
    path: string;
    used: boolean;
}

export interface AlchemyWalletUtxo extends UnspentOutput {
    valueSats: number;
    chain: Chain;
    index: number;
    path: string;
}

interface AlchemyWalletState {
    externalNext: number;
    internalNext: number;
    addresses: AlchemyAddressState[];
    utxos: AlchemyWalletUtxo[];
    transactions: ListTransactionsEntry[];
    updatedAt?: string;
}

interface FundedPsbt {
    psbt: bitcoin.Psbt;
    selected: AlchemyWalletUtxo[];
    feeSats: number;
}

let cachedRefresh: {
    mnemonic: string;
    network: WalletNetwork;
    refreshedAt: number;
    state: AlchemyWalletState;
} | null = null;

let refreshInFlight: Promise<AlchemyWalletState> | null = null;

function emptyState(): AlchemyWalletState {
    return {
        externalNext: 0,
        internalNext: 0,
        addresses: [],
        utxos: [],
        transactions: [],
    };
}

async function loadState(): Promise<AlchemyWalletState> {
    try {
        const raw = await readFile(config.statePath, 'utf8');
        return { ...emptyState(), ...JSON.parse(raw) };
    } catch (error: any) {
        if (error.code === 'ENOENT') {
            return emptyState();
        }
        throw error;
    }
}

async function saveState(state: AlchemyWalletState): Promise<void> {
    await mkdir(path.dirname(config.statePath), { recursive: true });
    await writeFile(config.statePath, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2));
}

function stateKey(chain: Chain, index: number): string {
    return `${chain}:${index}`;
}

function getKnownAddressMap(state: AlchemyWalletState): Map<string, AlchemyAddressState> {
    return new Map(state.addresses.map(address => [stateKey(address.chain, address.index), address]));
}

function requireUtxoUrl(): string {
    if (!config.utxoUrl) {
        throw new Error('ARCHON_WALLET_UTXO_URL is required for ARCHON_WALLET_BACKEND=alchemy');
    }
    return config.utxoUrl.replace(/\/+$/, '');
}

function maskUrl(url: string): string {
    return url.replace(/\/v2\/[^/]+/, '/v2/<redacted>');
}

function formatAlchemyError(error: any, url: string): Error {
    const status = error.response?.status;
    const detail = typeof error.response?.data === 'string'
        ? error.response.data
        : error.response?.data?.message || error.response?.data?.error || error.message;

    if (status === 401) {
        return new Error(`Alchemy UTXO request unauthorized at ${maskUrl(url)}. Check that the API key is valid and enabled for the Bitcoin UTXO API. ${detail || ''}`.trim());
    }

    if (status) {
        return new Error(`Alchemy UTXO request failed with status ${status} at ${maskUrl(url)}. ${detail || ''}`.trim());
    }

    return new Error(`Alchemy UTXO request failed at ${maskUrl(url)}. ${detail || error.message}`.trim());
}

async function fetchAddressUtxos(address: string): Promise<NormalizedRawUtxo[]> {
    const base = requireUtxoUrl();
    const candidates = [
        `${base}/utxo/${encodeURIComponent(address)}`,
        `${base}/address/${encodeURIComponent(address)}/utxo`,
        `${base}/addresses/${encodeURIComponent(address)}/utxos`,
        `${base}/address/${encodeURIComponent(address)}/utxos`,
        `${base}/utxos?address=${encodeURIComponent(address)}`,
    ];

    let lastError: any;
    for (const url of candidates) {
        try {
            const response = await axios.get(url, { timeout: 30_000 });
            return normalizeHostedUtxos(response.data);
        } catch (error: any) {
            lastError = formatAlchemyError(error, url);
            if (error.response && ![400, 404].includes(error.response.status)) {
                throw lastError;
            }
        }
    }

    throw lastError;
}

function toWalletUtxo(raw: NormalizedRawUtxo, address: AlchemyAddressState, network: WalletNetwork): AlchemyWalletUtxo {
    const scriptPubKey = bitcoin.address.toOutputScript(address.address, getBtcNetwork(network)).toString('hex');
    return {
        txid: raw.txid,
        vout: raw.vout,
        address: address.address,
        scriptPubKey,
        amount: raw.valueSats / SATS_PER_BTC,
        confirmations: raw.confirmations,
        spendable: true,
        solvable: true,
        safe: raw.confirmations > 0,
        valueSats: raw.valueSats,
        chain: address.chain,
        index: address.index,
        path: address.path,
    };
}

function toTransactions(utxos: AlchemyWalletUtxo[]): ListTransactionsEntry[] {
    const byOutpoint = new Map<string, AlchemyWalletUtxo>();
    for (const utxo of utxos) {
        byOutpoint.set(`${utxo.txid}:${utxo.vout}`, utxo);
    }

    const now = Math.floor(Date.now() / 1000);
    return Array.from(byOutpoint.values()).map(utxo => ({
        address: utxo.address,
        category: 'receive',
        amount: utxo.amount,
        vout: utxo.vout,
        confirmations: utxo.confirmations,
        txid: utxo.txid,
        time: now,
        timereceived: now,
    }));
}

function advanceNextIndex(addresses: AlchemyAddressState[], chain: Chain): number {
    const used = addresses.filter(address => address.chain === chain && address.used);
    if (used.length === 0) {
        return 0;
    }
    return Math.max(...used.map(address => address.index)) + 1;
}

async function refreshState(mnemonic: string, network: WalletNetwork): Promise<AlchemyWalletState> {
    const state = await loadState();
    const known = getKnownAddressMap(state);
    const scanMaxExternal = Math.max(state.externalNext + config.gapLimit, config.gapLimit);
    const scanMaxInternal = Math.max(state.internalNext + config.gapLimit, config.gapLimit);
    const addresses: AlchemyAddressState[] = [];

    for (const chain of [0, 1] as const) {
        const max = chain === 0 ? scanMaxExternal : scanMaxInternal;
        for (let index = 0; index <= max; index++) {
            const existing = known.get(stateKey(chain, index));
            if (existing) {
                addresses.push(existing);
                continue;
            }
            const derived = deriveAddress(mnemonic, network, chain, index);
            addresses.push({
                address: derived.address,
                chain,
                index,
                path: derived.path,
                used: false,
            });
        }
    }

    const utxos: AlchemyWalletUtxo[] = [];
    for (const address of addresses) {
        const rawUtxos = await fetchAddressUtxos(address.address);
        if (rawUtxos.length > 0) {
            address.used = true;
            utxos.push(...rawUtxos.map(utxo => toWalletUtxo(utxo, address, network)));
        }
    }

    state.addresses = addresses;
    state.utxos = utxos;
    state.transactions = toTransactions(utxos);
    state.externalNext = advanceNextIndex(addresses, 0);
    state.internalNext = advanceNextIndex(addresses, 1);
    await saveState(state);
    cachedRefresh = {
        mnemonic,
        network,
        refreshedAt: Date.now(),
        state,
    };
    return state;
}

async function getFreshState(
    mnemonic?: string,
    network: WalletNetwork = config.network,
    forceRefresh = false,
): Promise<AlchemyWalletState> {
    if (!mnemonic) {
        return loadState();
    }

    if (!forceRefresh
        && cachedRefresh
        && cachedRefresh.mnemonic === mnemonic
        && cachedRefresh.network === network
        && Date.now() - cachedRefresh.refreshedAt <= config.refreshTtlMs) {
        return cachedRefresh.state;
    }

    if (!forceRefresh && refreshInFlight) {
        return refreshInFlight;
    }

    refreshInFlight = refreshState(mnemonic, network);
    try {
        return await refreshInFlight;
    } finally {
        refreshInFlight = null;
    }
}

function feeRateToSatVb(feeRate?: number): number {
    if (feeRate && Number.isFinite(feeRate) && feeRate > 0) {
        return feeRate;
    }
    return DEFAULT_FEE_RATE_SAT_VB;
}

function estimateVsize(inputs: number, p2wpkhOutputs: number, opReturnBytes: number = 0): number {
    const opReturnOutput = opReturnBytes > 0 ? 9 + opReturnBytes : 0;
    return 10 + (inputs * 68) + (p2wpkhOutputs * 31) + opReturnOutput;
}

function deriveKeyPair(mnemonic: string, network: WalletNetwork, utxo: AlchemyWalletUtxo) {
    const account = deriveAccountKey(mnemonic, network);
    const child = account.deriveChild(utxo.chain).deriveChild(utxo.index);
    if (!child.privateKey) {
        throw new Error(`Could not derive private key at ${utxo.path}`);
    }
    return ECPair.fromPrivateKey(child.privateKey, { network: getBtcNetwork(network) });
}

function sortUtxos(utxos: AlchemyWalletUtxo[]): AlchemyWalletUtxo[] {
    return [...utxos].sort((a, b) => {
        if (b.confirmations !== a.confirmations) {
            return b.confirmations - a.confirmations;
        }
        return b.valueSats - a.valueSats;
    });
}

function getInternalAddress(state: AlchemyWalletState, mnemonic: string, network: WalletNetwork): AlchemyAddressState {
    const existing = state.addresses.find(address => address.chain === 1 && address.index === state.internalNext);
    if (existing) {
        return existing;
    }

    const derived = deriveAddress(mnemonic, network, 1, state.internalNext);
    return {
        address: derived.address,
        chain: 1,
        index: state.internalNext,
        path: derived.path,
        used: false,
    };
}

function addInputs(psbt: bitcoin.Psbt, selected: AlchemyWalletUtxo[]): void {
    for (const utxo of selected) {
        psbt.addInput({
            hash: utxo.txid,
            index: utxo.vout,
            witnessUtxo: {
                script: Buffer.from(utxo.scriptPubKey, 'hex'),
                value: utxo.valueSats,
            },
        });
    }
}

function signInputs(psbt: bitcoin.Psbt, mnemonic: string, network: WalletNetwork, selected: AlchemyWalletUtxo[]): void {
    selected.forEach((utxo, index) => {
        psbt.signInput(index, deriveKeyPair(mnemonic, network, utxo));
    });
    psbt.finalizeAllInputs();
}

function fundAnchor(
    state: AlchemyWalletState,
    mnemonic: string,
    network: WalletNetwork,
    data: Buffer,
    feeRate?: number,
): FundedPsbt {
    const satVb = feeRateToSatVb(feeRate);
    const btcNetwork = getBtcNetwork(network);
    const psbt = new bitcoin.Psbt({ network: btcNetwork });
    const selected: AlchemyWalletUtxo[] = [];
    let selectedSats = 0;
    let feeSats = 0;
    let changeSats = 0;

    for (const utxo of sortUtxos(state.utxos)) {
        selected.push(utxo);
        selectedSats += utxo.valueSats;
        const feeWithChange = Math.ceil(estimateVsize(selected.length, 1, data.length) * satVb);
        const feeNoChange = Math.ceil(estimateVsize(selected.length, 0, data.length) * satVb);
        const candidateChange = selectedSats - feeWithChange;

        if (candidateChange > DUST_SATS) {
            feeSats = feeWithChange;
            changeSats = candidateChange;
            break;
        }
        if (selectedSats >= feeNoChange) {
            feeSats = selectedSats;
            changeSats = 0;
            break;
        }
    }

    if (feeSats === 0) {
        throw new Error('Insufficient funds for anchor transaction fee');
    }

    addInputs(psbt, selected);
    const embed = bitcoin.payments.embed({ data: [data] });
    if (!embed.output) {
        throw new Error('Could not build OP_RETURN output');
    }
    psbt.addOutput({ script: embed.output, value: 0 });

    if (changeSats > DUST_SATS) {
        const change = getInternalAddress(state, mnemonic, network);
        psbt.addOutput({ address: change.address, value: changeSats });
        change.used = true;
        if (!state.addresses.some(address => address.chain === change.chain && address.index === change.index)) {
            state.addresses.push(change);
        }
        state.internalNext = Math.max(state.internalNext, change.index + 1);
    }

    return { psbt, selected, feeSats };
}

function fundSend(
    state: AlchemyWalletState,
    mnemonic: string,
    network: WalletNetwork,
    to: string,
    amountBtc: number,
    feeRate?: number,
    subtractFee?: boolean,
): FundedPsbt {
    const satVb = feeRateToSatVb(feeRate);
    const amountSats = Math.round(amountBtc * SATS_PER_BTC);
    const btcNetwork = getBtcNetwork(network);
    const psbt = new bitcoin.Psbt({ network: btcNetwork });
    const selected: AlchemyWalletUtxo[] = [];
    let selectedSats = 0;
    let feeSats = 0;
    let recipientSats = amountSats;
    let changeSats = 0;

    bitcoin.address.toOutputScript(to, btcNetwork);

    for (const utxo of sortUtxos(state.utxos)) {
        selected.push(utxo);
        selectedSats += utxo.valueSats;
        const feeWithChange = Math.ceil(estimateVsize(selected.length, 2) * satVb);
        const feeNoChange = Math.ceil(estimateVsize(selected.length, 1) * satVb);

        if (subtractFee) {
            const candidateChange = selectedSats - amountSats;
            const candidateFee = candidateChange > DUST_SATS ? feeWithChange : feeNoChange + Math.max(candidateChange, 0);
            const candidateRecipient = amountSats - candidateFee;
            if (selectedSats >= amountSats && candidateRecipient > DUST_SATS) {
                feeSats = candidateFee;
                recipientSats = candidateChange > DUST_SATS ? candidateRecipient : selectedSats - candidateFee;
                changeSats = candidateChange > DUST_SATS ? candidateChange : 0;
                break;
            }
            continue;
        }

        const candidateChange = selectedSats - amountSats - feeWithChange;
        if (candidateChange > DUST_SATS) {
            feeSats = feeWithChange;
            changeSats = candidateChange;
            break;
        }

        const noChangeRemainder = selectedSats - amountSats - feeNoChange;
        if (noChangeRemainder >= 0) {
            feeSats = feeNoChange + noChangeRemainder;
            changeSats = 0;
            break;
        }
    }

    if (feeSats === 0 || recipientSats <= DUST_SATS) {
        throw new Error('Insufficient funds for transaction');
    }

    addInputs(psbt, selected);
    psbt.addOutput({ address: to, value: recipientSats });

    if (changeSats > DUST_SATS) {
        const change = getInternalAddress(state, mnemonic, network);
        psbt.addOutput({ address: change.address, value: changeSats });
        change.used = true;
        if (!state.addresses.some(address => address.chain === change.chain && address.index === change.index)) {
            state.addresses.push(change);
        }
        state.internalNext = Math.max(state.internalNext, change.index + 1);
    }

    return { psbt, selected, feeSats };
}

async function broadcastFunded(
    btcClient: BtcClient,
    state: AlchemyWalletState,
    mnemonic: string,
    network: WalletNetwork,
    funded: FundedPsbt,
): Promise<{ txid: string; fee: number }> {
    signInputs(funded.psbt, mnemonic, network, funded.selected);
    const tx = funded.psbt.extractTransaction();
    const txid = await btcClient.sendRawTransaction(tx.toHex());
    const spent = new Set(funded.selected.map(utxo => `${utxo.txid}:${utxo.vout}`));
    state.utxos = state.utxos.filter(utxo => !spent.has(`${utxo.txid}:${utxo.vout}`));
    await saveState(state);
    return { txid, fee: funded.feeSats / SATS_PER_BTC };
}

export async function setupAlchemyWallet(
    _btcClient: BtcClient,
    mnemonic: string,
    network: WalletNetwork,
): Promise<{ walletName: string; descriptors: string[] }> {
    const state = await getFreshState(mnemonic, network);
    return {
        walletName: config.walletName,
        descriptors: state.addresses.map(address => address.path),
    };
}

export async function getAlchemyBalance(mnemonic?: string): Promise<{ balance: number; unconfirmed_balance: number }> {
    const state = await getFreshState(mnemonic);
    const confirmedSats = state.utxos
        .filter(utxo => utxo.confirmations > 0)
        .reduce((sum, utxo) => sum + utxo.valueSats, 0);
    const unconfirmedSats = state.utxos
        .filter(utxo => utxo.confirmations === 0)
        .reduce((sum, utxo) => sum + utxo.valueSats, 0);

    return {
        balance: confirmedSats / SATS_PER_BTC,
        unconfirmed_balance: unconfirmedSats / SATS_PER_BTC,
    };
}

export async function getAlchemyReceiveAddress(mnemonic: string, network: WalletNetwork): Promise<string> {
    const state = await getFreshState(mnemonic, network);
    const existing = state.addresses.find(address => address.chain === 0 && address.index === state.externalNext);
    if (existing) {
        return existing.address;
    }

    const derived = deriveAddress(mnemonic, network, 0, state.externalNext);
    return derived.address;
}

export async function getAlchemyTransactions(count = 10, skip = 0, mnemonic?: string): Promise<ListTransactionsEntry[]> {
    const state = await getFreshState(mnemonic);
    return state.transactions.slice(skip, skip + count);
}

export async function getAlchemyUtxos(minconf = 1, mnemonic?: string): Promise<UnspentOutput[]> {
    const state = await getFreshState(mnemonic);
    return state.utxos.filter(utxo => utxo.confirmations >= minconf);
}

export async function estimateAlchemyFee(btcClient: BtcClient, blocks?: number): Promise<EstimateSmartFeeResult> {
    try {
        return await btcClient.estimateSmartFee(blocks || config.feeTarget, 'ECONOMICAL');
    } catch {
        return {
            feerate: (DEFAULT_FEE_RATE_SAT_VB * 1000) / SATS_PER_BTC,
            blocks: blocks || config.feeTarget,
        };
    }
}

export async function getAlchemyWalletStatus(): Promise<{
    network: WalletNetwork;
    walletName: string;
    ready: boolean;
    descriptorCount: number;
}> {
    const state = await loadState();
    return {
        network: config.network,
        walletName: config.walletName,
        ready: state.addresses.length > 0,
        descriptorCount: state.addresses.length,
    };
}

export async function getAlchemyTransaction(txid: string): Promise<{
    txid: string;
    confirmations: number;
    blockhash?: string;
    fee?: number;
}> {
    const base = requireUtxoUrl();
    const candidates = [
        `${base}/tx/${encodeURIComponent(txid)}`,
        `${base}/transaction/${encodeURIComponent(txid)}`,
    ];

    let lastError: any;
    for (const url of candidates) {
        try {
            const response = await axios.get(url, { timeout: 30_000 });
            const tx = response.data;
            const confirmed = Boolean(tx.status?.confirmed ?? tx.confirmed);
            return {
                txid: tx.txid || tx.hash || txid,
                confirmations: confirmed ? 1 : 0,
                blockhash: tx.status?.block_hash || tx.blockhash,
                fee: typeof tx.fee === 'number' ? tx.fee / SATS_PER_BTC : tx.fee,
            };
        } catch (error: any) {
            lastError = formatAlchemyError(error, url);
            if (error.response && ![400, 404].includes(error.response.status)) {
                throw lastError;
            }
        }
    }

    throw lastError;
}

export async function sendAlchemyBtc(
    btcClient: BtcClient,
    mnemonic: string,
    network: WalletNetwork,
    to: string,
    amountBtc: number,
    feeRate?: number,
    subtractFee?: boolean,
): Promise<{ txid: string; fee: number }> {
    const state = await refreshState(mnemonic, network);
    const funded = fundSend(state, mnemonic, network, to, amountBtc, feeRate, subtractFee);
    return broadcastFunded(btcClient, state, mnemonic, network, funded);
}

export async function anchorAlchemyData(
    btcClient: BtcClient,
    mnemonic: string,
    network: WalletNetwork,
    data: string,
    feeRate?: number,
): Promise<{ txid: string; fee: number }> {
    const bytes = Buffer.from(data, 'utf8');
    if (bytes.length > 80) {
        throw new Error('OP_RETURN data must be 80 bytes or less');
    }

    const state = await refreshState(mnemonic, network);
    const funded = fundAnchor(state, mnemonic, network, bytes, feeRate);
    return broadcastFunded(btcClient, state, mnemonic, network, funded);
}

export async function bumpAlchemyTransactionFee(): Promise<{ txid: string; fee: number }> {
    throw new Error('RBF fee bumping is not supported by ARCHON_WALLET_BACKEND=alchemy');
}
