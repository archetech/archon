import dotenv from 'dotenv';

dotenv.config();

export type WalletNetwork = 'mainnet' | 'signet';

export interface AppConfig {
    port: number;
    metricsPort: number;
    keymasterURL: string;
    adminApiKey?: string;
    btcHost: string;
    btcPort: number;
    btcUser?: string;
    btcPass?: string;
    walletName: string;
    network: WalletNetwork;
    gapLimit: number;
    feeTarget: number;
}

function toNetwork(name: string | undefined): WalletNetwork {
    switch (name) {
    case 'mainnet':
        return 'mainnet';
    case 'signet':
    case undefined:
        return 'signet';
    default:
        throw new Error(`Unsupported network "${name}"`);
    }
}

const config: AppConfig = {
    port: process.env.ARCHON_WALLET_PORT ? parseInt(process.env.ARCHON_WALLET_PORT) : 4240,
    metricsPort: process.env.ARCHON_WALLET_METRICS_PORT ? parseInt(process.env.ARCHON_WALLET_METRICS_PORT) : 4241,
    keymasterURL: process.env.ARCHON_KEYMASTER_URL || 'http://localhost:4226',
    adminApiKey: process.env.ARCHON_ADMIN_API_KEY,
    btcHost: process.env.ARCHON_WALLET_BTC_HOST || 'localhost',
    btcPort: process.env.ARCHON_WALLET_BTC_PORT ? parseInt(process.env.ARCHON_WALLET_BTC_PORT) : 38332,
    btcUser: process.env.ARCHON_WALLET_BTC_USER,
    btcPass: process.env.ARCHON_WALLET_BTC_PASS,
    walletName: process.env.ARCHON_WALLET_NAME || 'archon-watch',
    network: toNetwork(process.env.ARCHON_WALLET_NETWORK),
    gapLimit: process.env.ARCHON_WALLET_GAP_LIMIT ? parseInt(process.env.ARCHON_WALLET_GAP_LIMIT) : 20,
    feeTarget: process.env.ARCHON_WALLET_FEE_TARGET ? parseInt(process.env.ARCHON_WALLET_FEE_TARGET) : 6,
};

export default config;
