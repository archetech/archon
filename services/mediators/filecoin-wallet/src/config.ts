import dotenv from 'dotenv';

dotenv.config();

export interface AppConfig {
    port: number;
    metricsPort: number;
    adminApiKey?: string;
    // filecoin-pin auth: private key OR session key (walletAddress + sessionKey)
    privateKey?: string;       // 0x-prefixed Ethereum private key
    walletAddress?: string;    // 0x-prefixed wallet address (session key mode)
    sessionKey?: string;       // 0x-prefixed session key (session key mode)
    network: 'mainnet' | 'calibration';
    rpcUrl?: string;           // optional Filecoin RPC override
    ipfsApiUrl: string;        // Archon IPFS API for fetching operation content
}

const config: AppConfig = {
    port: process.env.ARCHON_FIL_WALLET_PORT ? parseInt(process.env.ARCHON_FIL_WALLET_PORT) : 4242,
    metricsPort: process.env.ARCHON_FIL_WALLET_METRICS_PORT ? parseInt(process.env.ARCHON_FIL_WALLET_METRICS_PORT) : 4243,
    adminApiKey: process.env.ARCHON_ADMIN_API_KEY,
    privateKey: process.env.ARCHON_FIL_PRIVATE_KEY,
    walletAddress: process.env.ARCHON_FIL_WALLET_ADDRESS,
    sessionKey: process.env.ARCHON_FIL_SESSION_KEY,
    network: (process.env.ARCHON_FIL_NETWORK as 'mainnet' | 'calibration') || 'calibration',
    rpcUrl: process.env.ARCHON_FIL_RPC_URL,
    ipfsApiUrl: process.env.ARCHON_IPFS_API_URL || 'http://localhost:5001',
};

export default config;
