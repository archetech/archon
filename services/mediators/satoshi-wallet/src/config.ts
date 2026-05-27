import dotenv from 'dotenv';

dotenv.config();

export type WalletNetwork = 'mainnet' | 'signet' | 'testnet4';
export type WalletBackend = 'core' | 'alchemy';

export interface AppConfig {
    port: number;
    metricsPort: number;
    keymasterURL: string;
    adminApiKey?: string;
    btcHost: string;
    btcPort: number;
    btcRpcUrl?: string;
    utxoUrl?: string;
    btcUser?: string;
    btcPass?: string;
    walletName: string;
    backend: WalletBackend;
    network: WalletNetwork;
    gapLimit: number;
    feeTarget: number;
    statePath: string;
    refreshTtlMs: number;
}

function toNetwork(name: string | undefined): WalletNetwork {
    switch (name) {
    case 'mainnet':
        return 'mainnet';
    case 'signet':
    case undefined:
        return 'signet';
    case 'testnet4':
        return 'testnet4';
    default:
        throw new Error(`Unsupported network "${name}"`);
    }
}

function toBackend(name: string | undefined): WalletBackend {
    switch (name) {
    case 'core':
    case undefined:
        return 'core';
    case 'alchemy':
        return 'alchemy';
    default:
        throw new Error(`Unsupported wallet backend "${name}"`);
    }
}

function defaultUtxoUrl(rpcUrl?: string): string | undefined {
    if (!rpcUrl) {
        return undefined;
    }

    const url = new URL(rpcUrl);
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}/api/v2`;
}

const network = toNetwork(process.env.ARCHON_WALLET_NETWORK);
const nodeId = (process.env.ARCHON_NODE_ID || 'default').toLowerCase();

const config: AppConfig = {
    port: process.env.ARCHON_WALLET_PORT ? parseInt(process.env.ARCHON_WALLET_PORT) : 4240,
    metricsPort: process.env.ARCHON_WALLET_METRICS_PORT ? parseInt(process.env.ARCHON_WALLET_METRICS_PORT) : 4241,
    keymasterURL: process.env.ARCHON_KEYMASTER_URL || 'http://localhost:4226',
    adminApiKey: process.env.ARCHON_ADMIN_API_KEY,
    btcHost: process.env.ARCHON_WALLET_BTC_HOST || 'localhost',
    btcPort: process.env.ARCHON_WALLET_BTC_PORT ? parseInt(process.env.ARCHON_WALLET_BTC_PORT) : 38332,
    btcRpcUrl: process.env.ARCHON_WALLET_BTC_RPC_URL,
    utxoUrl: process.env.ARCHON_WALLET_UTXO_URL || defaultUtxoUrl(process.env.ARCHON_WALLET_BTC_RPC_URL),
    btcUser: process.env.ARCHON_WALLET_BTC_USER,
    btcPass: process.env.ARCHON_WALLET_BTC_PASS,
    walletName: process.env.ARCHON_WALLET_NAME || `archon-watch-${nodeId}`,
    backend: toBackend(process.env.ARCHON_WALLET_BACKEND),
    network,
    gapLimit: process.env.ARCHON_WALLET_GAP_LIMIT ? parseInt(process.env.ARCHON_WALLET_GAP_LIMIT) : 20,
    feeTarget: process.env.ARCHON_WALLET_FEE_TARGET ? parseInt(process.env.ARCHON_WALLET_FEE_TARGET) : 6,
    statePath: process.env.ARCHON_WALLET_STATE_PATH || './data/satoshi-wallet-state.json',
    refreshTtlMs: process.env.ARCHON_WALLET_REFRESH_TTL_MS ? parseInt(process.env.ARCHON_WALLET_REFRESH_TTL_MS) : 30_000,
};

export default config;
