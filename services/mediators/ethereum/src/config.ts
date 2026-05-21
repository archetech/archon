import dotenv from 'dotenv';

dotenv.config();

export type NetworkName = 'mainnet' | 'sepolia' | 'holesky' | 'local';
export type EthereumDB = 'json' | 'sqlite' | 'mongodb' | 'redis';

export interface AppConfig {
    nodeID?: string;
    adminApiKey?: string;
    gatekeeperURL: string;
    keymasterURL?: string;
    walletURL?: string;
    chain: string;
    network: NetworkName;
    chainId: number;
    rpcUrl: string;
    contractAddress: string;
    importInterval: number;
    exportInterval: number;
    confirmations: number;
    logChunkSize: number;
    pendingTxTimeoutBlocks: number;
    minGasBalanceWei: bigint;
    startBlock: number;
    reimport: boolean;
    db: EthereumDB;
    dbName: string;
    metricsPort: number;
}

function toNetwork(name: string | undefined): NetworkName {
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

function toDB(name: string | undefined): EthereumDB {
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

function defaultChain(network: NetworkName): string {
    return network === 'mainnet' ? 'ETH:mainnet' : `ETH:${network}`;
}

function defaultChainId(network: NetworkName): number {
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

const network = toNetwork(process.env.ARCHON_ETH_NETWORK);
const chain = process.env.ARCHON_ETH_CHAIN || defaultChain(network);

const config: AppConfig = {
    nodeID: process.env.ARCHON_NODE_ID,
    adminApiKey: process.env.ARCHON_ADMIN_API_KEY,
    gatekeeperURL: process.env.ARCHON_GATEKEEPER_URL || 'http://localhost:4224',
    keymasterURL: process.env.ARCHON_KEYMASTER_URL,
    walletURL: process.env.ARCHON_WALLET_URL,
    chain,
    network,
    chainId: process.env.ARCHON_ETH_CHAIN_ID ? parseInt(process.env.ARCHON_ETH_CHAIN_ID) : defaultChainId(network),
    rpcUrl: process.env.ARCHON_ETH_RPC_URL || 'http://localhost:8545',
    contractAddress: process.env.ARCHON_ETH_CONTRACT || '',
    importInterval: process.env.ARCHON_ETH_IMPORT_INTERVAL ? parseInt(process.env.ARCHON_ETH_IMPORT_INTERVAL) : 0,
    exportInterval: process.env.ARCHON_ETH_EXPORT_INTERVAL ? parseInt(process.env.ARCHON_ETH_EXPORT_INTERVAL) : 0,
    confirmations: process.env.ARCHON_ETH_CONFIRMATIONS ? parseInt(process.env.ARCHON_ETH_CONFIRMATIONS) : 12,
    logChunkSize: process.env.ARCHON_ETH_LOG_CHUNK_SIZE ? parseInt(process.env.ARCHON_ETH_LOG_CHUNK_SIZE) : 2_000,
    pendingTxTimeoutBlocks: process.env.ARCHON_ETH_PENDING_TX_TIMEOUT_BLOCKS ? parseInt(process.env.ARCHON_ETH_PENDING_TX_TIMEOUT_BLOCKS) : 120,
    minGasBalanceWei: BigInt(process.env.ARCHON_ETH_MIN_GAS_BALANCE_WEI || '1000000000000000'),
    startBlock: process.env.ARCHON_ETH_START_BLOCK ? parseInt(process.env.ARCHON_ETH_START_BLOCK) : 0,
    reimport: process.env.ARCHON_ETH_REIMPORT ? (process.env.ARCHON_ETH_REIMPORT === 'true') : true,
    db: toDB(process.env.ARCHON_ETH_DB),
    dbName: process.env.ARCHON_ETH_DB_NAME || chain.replace(/:/g, '-'),
    metricsPort: process.env.ARCHON_ETH_METRICS_PORT ? parseInt(process.env.ARCHON_ETH_METRICS_PORT) : 4239,
};

export default config;
