import dotenv from 'dotenv';

dotenv.config();

export type NetworkName = 'mainnet' | 'testnet' | 'regtest';
export type ChainName = 'ZEC:mainnet' | 'ZEC:testnet';
export type ZcashDB = 'json' | 'sqlite' | 'mongodb' | 'redis';

export interface AppConfig {
    nodeID?: string;
    adminApiKey?: string;
    gatekeeperURL: string;
    keymasterURL?: string;
    walletURL?: string;
    chain: ChainName;
    network: NetworkName;
    host: string;
    port: number;
    user?: string;
    pass?: string;
    importInterval: number;
    exportInterval: number;
    feeConf: number;
    feeMax: number;
    feeFallback: number;
    feeOracleUrl: string;
    rbfEnabled: boolean;
    startBlock: number;
    reimport: boolean;
    db: ZcashDB;
    dbName: string;
    metricsPort: number;
}

function toChain(name: string | undefined): ChainName {
    switch (name) {
    case 'ZEC:mainnet':
    case undefined:
        return 'ZEC:mainnet';
    case 'ZEC:testnet':
        return 'ZEC:testnet';
    default:
        throw new Error(`Unsupported chain "${name}"`);
    }
}

function toNetwork(name: string | undefined): NetworkName {
    switch (name) {
    case 'mainnet':
    case undefined:
        return 'mainnet';
    case 'testnet':
        return 'testnet';
    case 'regtest':
        return 'regtest';
    default:
        throw new Error(`Unsupported network "${name}"`);
    }
}

function toDB(name: string | undefined): ZcashDB {
    switch (name) {
    case 'json':
    case undefined:
        return 'json';
    case 'sqlite':
        return 'sqlite';
    case 'mongodb':
        return 'mongodb';
    case 'redis':
        return 'redis';
    default:
        throw new Error(`Unsupported DB "${name}"`);
    }
}

const config: AppConfig = {
    nodeID: process.env.ARCHON_NODE_ID,
    adminApiKey: process.env.ARCHON_ADMIN_API_KEY,
    gatekeeperURL: process.env.ARCHON_GATEKEEPER_URL || 'http://localhost:4224',
    keymasterURL: process.env.ARCHON_KEYMASTER_URL,
    walletURL: process.env.ARCHON_WALLET_URL,
    chain: toChain(process.env.ARCHON_ZEC_CHAIN),
    network: toNetwork(process.env.ARCHON_ZEC_NETWORK),
    host: process.env.ARCHON_ZEC_HOST || '100.70.86.134',
    port: process.env.ARCHON_ZEC_PORT ? parseInt(process.env.ARCHON_ZEC_PORT) : 8232,
    user: process.env.ARCHON_ZEC_USER,
    pass: process.env.ARCHON_ZEC_PASS,
    importInterval: process.env.ARCHON_ZEC_IMPORT_INTERVAL ? parseInt(process.env.ARCHON_ZEC_IMPORT_INTERVAL) : 0,
    exportInterval: process.env.ARCHON_ZEC_EXPORT_INTERVAL ? parseInt(process.env.ARCHON_ZEC_EXPORT_INTERVAL) : 0,
    feeConf: process.env.ARCHON_ZEC_FEE_BLOCK_TARGET ? parseInt(process.env.ARCHON_ZEC_FEE_BLOCK_TARGET) : 1,
    feeFallback: process.env.ARCHON_ZEC_FEE_FALLBACK_ZAT_BYTE ? parseInt(process.env.ARCHON_ZEC_FEE_FALLBACK_ZAT_BYTE) : 10,
    feeMax: process.env.ARCHON_ZEC_FEE_MAX ? parseFloat(process.env.ARCHON_ZEC_FEE_MAX) : 0.0001,
    feeOracleUrl: process.env.ARCHON_ZEC_FEE_ORACLE_URL || '',
    rbfEnabled: process.env.ARCHON_ZEC_RBF_ENABLED === 'true',
    startBlock: process.env.ARCHON_ZEC_START_BLOCK ? parseInt(process.env.ARCHON_ZEC_START_BLOCK) : 0,
    reimport: process.env.ARCHON_ZEC_REIMPORT ? (process.env.ARCHON_ZEC_REIMPORT === 'true') : true,
    db: toDB(process.env.ARCHON_ZEC_DB),
    dbName: process.env.ARCHON_ZEC_DB_NAME || toChain(process.env.ARCHON_ZEC_CHAIN).replace(/:/g, '-'),
    metricsPort: process.env.ARCHON_ZEC_METRICS_PORT ? parseInt(process.env.ARCHON_ZEC_METRICS_PORT) : 4238,
};

export default config;
