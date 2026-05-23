import dotenv from 'dotenv';

dotenv.config();

export type FilecoinNetwork = 'mainnet' | 'calibration';

export interface AppConfig {
    port: number;
    metricsPort: number;
    adminApiKey?: string;
    privateKey?: string;
    walletAddress?: string;
    sessionKey?: string;
    network: FilecoinNetwork;
    rpcUrl?: string;
    ipfsApiUrl: string;
}

function toNetwork(value: string | undefined): FilecoinNetwork {
    switch (value) {
    case 'mainnet':
        return 'mainnet';
    case 'calibration':
    case undefined:
        return 'calibration';
    default:
        throw new Error(`Unsupported Filecoin network "${value}"`);
    }
}

function normalizeIpfsApiUrl(value: string | undefined): string {
    const url = value || 'http://localhost:5001/api/v0';
    return url.endsWith('/api/v0') ? url : `${url.replace(/\/$/, '')}/api/v0`;
}

const config: AppConfig = {
    port: process.env.ARCHON_FIL_WALLET_PORT ? parseInt(process.env.ARCHON_FIL_WALLET_PORT) : 4270,
    metricsPort: process.env.ARCHON_FIL_WALLET_METRICS_PORT ? parseInt(process.env.ARCHON_FIL_WALLET_METRICS_PORT) : 4272,
    adminApiKey: process.env.ARCHON_ADMIN_API_KEY,
    privateKey: process.env.ARCHON_FIL_PRIVATE_KEY,
    walletAddress: process.env.ARCHON_FIL_WALLET_ADDRESS,
    sessionKey: process.env.ARCHON_FIL_SESSION_KEY,
    network: toNetwork(process.env.ARCHON_FIL_NETWORK),
    rpcUrl: process.env.ARCHON_FIL_RPC_URL,
    ipfsApiUrl: normalizeIpfsApiUrl(process.env.ARCHON_IPFS_API_URL || process.env.ARCHON_IPFS_URL),
};

export default config;
