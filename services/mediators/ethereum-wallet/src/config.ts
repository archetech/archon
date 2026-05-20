import dotenv from 'dotenv';

dotenv.config();

export type WalletNetwork = 'mainnet' | 'sepolia' | 'holesky' | 'local';

export interface AppConfig {
    port: number;
    metricsPort: number;
    keymasterURL: string;
    adminApiKey?: string;
    rpcUrl: string;
    chainId: number;
    network: WalletNetwork;
    derivationPath: string;
}

function toNetwork(name: string | undefined): WalletNetwork {
    switch (name) {
    case 'mainnet':
    case undefined:
        return 'mainnet';
    case 'sepolia':
        return 'sepolia';
    case 'holesky':
        return 'holesky';
    case 'local':
        return 'local';
    default:
        throw new Error(`Unsupported Ethereum network "${name}"`);
    }
}

function defaultChainId(network: WalletNetwork): number {
    switch (network) {
    case 'mainnet':
        return 1;
    case 'sepolia':
        return 11155111;
    case 'holesky':
        return 17000;
    case 'local':
        return 31337;
    }
}

const network = toNetwork(process.env.ARCHON_WALLET_ETH_NETWORK || process.env.ARCHON_ETH_NETWORK);

const config: AppConfig = {
    port: process.env.ARCHON_WALLET_PORT ? parseInt(process.env.ARCHON_WALLET_PORT) : 4252,
    metricsPort: process.env.ARCHON_WALLET_METRICS_PORT ? parseInt(process.env.ARCHON_WALLET_METRICS_PORT) : 4253,
    keymasterURL: process.env.ARCHON_KEYMASTER_URL || 'http://localhost:4226',
    adminApiKey: process.env.ARCHON_ADMIN_API_KEY,
    rpcUrl: process.env.ARCHON_WALLET_ETH_RPC_URL || process.env.ARCHON_ETH_RPC_URL || 'http://localhost:8545',
    chainId: process.env.ARCHON_WALLET_ETH_CHAIN_ID
        ? parseInt(process.env.ARCHON_WALLET_ETH_CHAIN_ID)
        : process.env.ARCHON_ETH_CHAIN_ID
            ? parseInt(process.env.ARCHON_ETH_CHAIN_ID)
            : defaultChainId(network),
    network,
    derivationPath: process.env.ARCHON_WALLET_ETH_DERIVATION_PATH || "m/44'/60'/0'/0/0",
};

export default config;
