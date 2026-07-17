import path from 'path';

export type WalletType = 'json' | 'sqlite';

export interface McpServerConfig {
    nodeUrl: string;
    walletType: WalletType;
    walletPath: string;
    passphrase?: string;
    defaultRegistry?: string;
    readOnly: boolean;
    /** Byte size at or below which a file asset is inlined rather than linked. */
    inlineLimit: number;
}

// A file asset's bytes are base64 in a tool result, so they cost roughly bytes/3 tokens of
// the model's context (4/3 expansion, ~4 chars per token). 16 KiB is ~5.5k tokens: enough
// for the small text, JSON, and icon assets where a link would just add a round trip, and
// far below the point where one call crowds out the conversation. The bar is deliberately
// low because base64 is not something a model can read -- inlining only ever helps the
// client render or save it, so paying much context for it buys nothing.
export const DEFAULT_INLINE_LIMIT = 16 * 1024;

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

function parseInlineLimit(value: string | undefined): number {
    if (value === undefined || value === '') {
        return DEFAULT_INLINE_LIMIT;
    }

    const limit = Number(value);

    if (!Number.isInteger(limit) || limit < 0) {
        throw new Error(`ARCHON_MCP_INLINE_LIMIT must be a non-negative integer, got "${value}"`);
    }

    return limit;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpServerConfig {
    return {
        nodeUrl: env.ARCHON_NODE_URL || env.ARCHON_GATEKEEPER_URL || 'https://archon.technology',
        walletType: parseWalletType(env.ARCHON_WALLET_TYPE),
        walletPath: env.ARCHON_WALLET_PATH || './wallet.json',
        passphrase: env.ARCHON_PASSPHRASE,
        defaultRegistry: env.ARCHON_DEFAULT_REGISTRY,
        readOnly: parseBool(env.ARCHON_MCP_READ_ONLY),
        inlineLimit: parseInlineLimit(env.ARCHON_MCP_INLINE_LIMIT),
    };
}

export function walletLocation(walletPath: string): { directory: string; file: string } {
    return {
        directory: path.dirname(walletPath),
        file: path.basename(walletPath),
    };
}
