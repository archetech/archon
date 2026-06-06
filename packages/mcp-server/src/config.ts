import path from 'path';

export type WalletType = 'json' | 'sqlite';

export interface McpServerConfig {
    nodeUrl: string;
    walletType: WalletType;
    walletPath: string;
    passphrase?: string;
    defaultRegistry?: string;
    readOnly: boolean;
}

function parseWalletType(value: string | undefined): WalletType {
    switch (value) {
    case undefined:
    case '':
    case 'json':
        return 'json';
    case 'sqlite':
        return 'sqlite';
    default:
        throw new Error(`Unsupported ARCHON_WALLET_TYPE "${value}"`);
    }
}

function parseBool(value: string | undefined): boolean {
    return value === 'true' || value === '1' || value === 'yes';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpServerConfig {
    return {
        nodeUrl: env.ARCHON_NODE_URL || env.ARCHON_GATEKEEPER_URL || 'https://archon.technology',
        walletType: parseWalletType(env.ARCHON_WALLET_TYPE),
        walletPath: env.ARCHON_WALLET_PATH || './wallet.json',
        passphrase: env.ARCHON_PASSPHRASE,
        defaultRegistry: env.ARCHON_DEFAULT_REGISTRY,
        readOnly: parseBool(env.ARCHON_MCP_READ_ONLY),
    };
}

export function walletLocation(walletPath: string): { directory: string; file: string } {
    return {
        directory: path.dirname(walletPath),
        file: path.basename(walletPath),
    };
}
