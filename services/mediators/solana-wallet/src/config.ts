import dotenv from 'dotenv';
import { Commitment, PublicKey } from '@solana/web3.js';

dotenv.config();

export type WalletNetwork = 'mainnet-beta' | 'devnet' | 'testnet' | 'local';

export interface AppConfig {
    port: number;
    metricsPort: number;
    keymasterURL: string;
    adminApiKey?: string;
    rpcUrl: string;
    network: WalletNetwork;
    commitment: Commitment;
    memoProgramId: string;
    registryAddress: string;
    derivationPath: string;
}

function toNetwork(name: string | undefined): WalletNetwork {
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

function defaultRpcUrl(network: WalletNetwork): string {
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

const network = toNetwork(process.env.ARCHON_WALLET_SOL_NETWORK || process.env.ARCHON_SOL_NETWORK);
const chain = process.env.ARCHON_SOL_CHAIN || (network === 'mainnet-beta' ? 'SOL:mainnet-beta' : `SOL:${network}`);
const memoProgramId = process.env.ARCHON_SOL_MEMO_PROGRAM_ID || 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

function defaultRegistryAddress(): string {
    const [address] = PublicKey.findProgramAddressSync(
        [Buffer.from('archon-batch-v1'), Buffer.from(chain)],
        new PublicKey(memoProgramId)
    );
    return address.toBase58();
}

const config: AppConfig = {
    port: process.env.ARCHON_WALLET_PORT ? parseInt(process.env.ARCHON_WALLET_PORT) : 4262,
    metricsPort: process.env.ARCHON_WALLET_METRICS_PORT ? parseInt(process.env.ARCHON_WALLET_METRICS_PORT) : 4263,
    keymasterURL: process.env.ARCHON_KEYMASTER_URL || 'http://localhost:4226',
    adminApiKey: process.env.ARCHON_ADMIN_API_KEY,
    rpcUrl: process.env.ARCHON_WALLET_SOL_RPC_URL || process.env.ARCHON_SOL_RPC_URL || defaultRpcUrl(network),
    network,
    commitment: toCommitment(process.env.ARCHON_WALLET_SOL_COMMITMENT || process.env.ARCHON_SOL_COMMITMENT),
    memoProgramId,
    registryAddress: process.env.ARCHON_SOL_REGISTRY_ADDRESS || defaultRegistryAddress(),
    derivationPath: process.env.ARCHON_WALLET_SOL_DERIVATION_PATH || "m/44'/501'/0'/0'",
};

export default config;
