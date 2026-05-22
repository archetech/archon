import dotenv from 'dotenv';
import { Commitment, Keypair } from '@solana/web3.js';
import { createHash } from 'crypto';

dotenv.config();

export type SolanaNetwork = 'mainnet-beta' | 'devnet' | 'testnet' | 'local';
export type SolanaDB = 'json' | 'sqlite' | 'mongodb' | 'redis';

export interface AppConfig {
    nodeID?: string;
    adminApiKey?: string;
    gatekeeperURL: string;
    keymasterURL?: string;
    walletURL?: string;
    chain: string;
    network: SolanaNetwork;
    rpcUrl: string;
    commitment: Commitment;
    memoProgramId: string;
    registryAddress: string;
    importInterval: number;
    exportInterval: number;
    signaturePageLimit: number;
    signaturePageMax: number;
    pendingTxTimeoutSlots: number;
    startSlot: number;
    minSolBalanceLamports: bigint;
    reimport: boolean;
    db: SolanaDB;
    dbName: string;
    metricsPort: number;
}

function toNetwork(name: string | undefined): SolanaNetwork {
    switch (name) {
    case 'mainnet-beta':
    case undefined:
        return 'mainnet-beta';
    case 'devnet':
        return 'devnet';
    case 'testnet':
        return 'testnet';
    case 'local':
        return 'local';
    default:
        throw new Error(`Unsupported Solana network "${name}"`);
    }
}

function toDB(name: string | undefined): SolanaDB {
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

function defaultChain(network: SolanaNetwork): string {
    return network === 'mainnet-beta' ? 'SOL:mainnet-beta' : `SOL:${network}`;
}

function defaultRpcUrl(network: SolanaNetwork): string {
    switch (network) {
    case 'mainnet-beta':
        return 'https://api.mainnet-beta.solana.com';
    case 'devnet':
        return 'https://api.devnet.solana.com';
    case 'testnet':
        return 'https://api.testnet.solana.com';
    case 'local':
        return 'http://localhost:8899';
    }
}

function toCommitment(value: string | undefined): Commitment {
    switch (value) {
    case 'processed':
    case 'confirmed':
    case 'finalized':
        return value;
    case undefined:
        return 'confirmed';
    default:
        throw new Error(`Unsupported Solana commitment "${value}"`);
    }
}

const network = toNetwork(process.env.ARCHON_SOL_NETWORK);
const chain = process.env.ARCHON_SOL_CHAIN || defaultChain(network);
const memoProgramId = process.env.ARCHON_SOL_MEMO_PROGRAM_ID || 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

function registryAddress(): string {
    const seed = createHash('sha256')
        .update('archon-solana-registry-signer-v1')
        .update(chain)
        .update(memoProgramId)
        .digest();
    return Keypair.fromSeed(seed).publicKey.toBase58();
}

const config: AppConfig = {
    nodeID: process.env.ARCHON_NODE_ID,
    adminApiKey: process.env.ARCHON_ADMIN_API_KEY,
    gatekeeperURL: process.env.ARCHON_GATEKEEPER_URL || 'http://localhost:4224',
    keymasterURL: process.env.ARCHON_KEYMASTER_URL,
    walletURL: process.env.ARCHON_WALLET_URL,
    chain,
    network,
    rpcUrl: process.env.ARCHON_SOL_RPC_URL || defaultRpcUrl(network),
    commitment: toCommitment(process.env.ARCHON_SOL_COMMITMENT),
    memoProgramId,
    registryAddress: registryAddress(),
    importInterval: process.env.ARCHON_SOL_IMPORT_INTERVAL ? parseInt(process.env.ARCHON_SOL_IMPORT_INTERVAL) : 0,
    exportInterval: process.env.ARCHON_SOL_EXPORT_INTERVAL ? parseInt(process.env.ARCHON_SOL_EXPORT_INTERVAL) : 0,
    signaturePageLimit: process.env.ARCHON_SOL_SIGNATURE_PAGE_LIMIT ? parseInt(process.env.ARCHON_SOL_SIGNATURE_PAGE_LIMIT) : 100,
    signaturePageMax: process.env.ARCHON_SOL_SIGNATURE_PAGE_MAX ? parseInt(process.env.ARCHON_SOL_SIGNATURE_PAGE_MAX) : 20,
    pendingTxTimeoutSlots: process.env.ARCHON_SOL_PENDING_TX_TIMEOUT_SLOTS ? parseInt(process.env.ARCHON_SOL_PENDING_TX_TIMEOUT_SLOTS) : 150,
    startSlot: process.env.ARCHON_SOL_START_SLOT ? parseInt(process.env.ARCHON_SOL_START_SLOT) : 0,
    minSolBalanceLamports: BigInt(process.env.ARCHON_SOL_MIN_BALANCE_LAMPORTS || '10000000'),
    reimport: process.env.ARCHON_SOL_REIMPORT ? (process.env.ARCHON_SOL_REIMPORT === 'true') : true,
    db: toDB(process.env.ARCHON_SOL_DB),
    dbName: process.env.ARCHON_SOL_DB_NAME || chain.replace(/:/g, '-'),
    metricsPort: process.env.ARCHON_SOL_METRICS_PORT ? parseInt(process.env.ARCHON_SOL_METRICS_PORT) : 4249,
};

export default config;
