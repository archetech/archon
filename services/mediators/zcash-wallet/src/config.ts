import dotenv from 'dotenv';

dotenv.config();

export type WalletNetwork = 'mainnet' | 'testnet';

export interface AppConfig {
    port: number;
    metricsPort: number;
    keymasterURL: string;
    adminApiKey?: string;
    zecHost: string;
    zecPort: number;
    zecUser?: string;
    zecPass?: string;
    walletName: string;
    network: WalletNetwork;
    gapLimit: number;
    feeTarget: number;
    defaultFeeZat: number;
    defaultFeeRateZatKb: number;
}

function toNetwork(name: string | undefined): WalletNetwork {
    switch (name) {
    case 'mainnet':
    case undefined:
        return 'mainnet';
    case 'testnet':
        return 'testnet';
    default:
        throw new Error(`Unsupported Zcash network "${name}"`);
    }
}

const network = toNetwork(process.env.ARCHON_WALLET_NETWORK);
const nodeId = (process.env.ARCHON_NODE_ID || 'default').toLowerCase();

const config: AppConfig = {
    port: process.env.ARCHON_WALLET_PORT ? parseInt(process.env.ARCHON_WALLET_PORT) : 4250,
    metricsPort: process.env.ARCHON_WALLET_METRICS_PORT ? parseInt(process.env.ARCHON_WALLET_METRICS_PORT) : 4251,
    keymasterURL: process.env.ARCHON_KEYMASTER_URL || 'http://localhost:4226',
    adminApiKey: process.env.ARCHON_ADMIN_API_KEY,
    zecHost: process.env.ARCHON_WALLET_ZEC_HOST || process.env.ARCHON_WALLET_BTC_HOST || '100.70.86.134',
    zecPort: process.env.ARCHON_WALLET_ZEC_PORT
        ? parseInt(process.env.ARCHON_WALLET_ZEC_PORT)
        : process.env.ARCHON_WALLET_BTC_PORT
            ? parseInt(process.env.ARCHON_WALLET_BTC_PORT)
            : 8232,
    zecUser: process.env.ARCHON_WALLET_ZEC_USER || process.env.ARCHON_WALLET_BTC_USER,
    zecPass: process.env.ARCHON_WALLET_ZEC_PASS || process.env.ARCHON_WALLET_BTC_PASS,
    walletName: process.env.ARCHON_WALLET_NAME || `archon-zec-${nodeId}`,
    network,
    gapLimit: process.env.ARCHON_WALLET_GAP_LIMIT ? parseInt(process.env.ARCHON_WALLET_GAP_LIMIT) : 20,
    feeTarget: process.env.ARCHON_WALLET_FEE_TARGET ? parseInt(process.env.ARCHON_WALLET_FEE_TARGET) : 6,
    defaultFeeZat: process.env.ARCHON_WALLET_ZEC_DEFAULT_FEE_ZAT
        ? parseInt(process.env.ARCHON_WALLET_ZEC_DEFAULT_FEE_ZAT)
        : 10_000,
    defaultFeeRateZatKb: process.env.ARCHON_WALLET_ZEC_FALLBACK_FEE_ZAT_KB
        ? parseInt(process.env.ARCHON_WALLET_ZEC_FALLBACK_FEE_ZAT_KB)
        : 10_000,
};

export default config;
