import axios from 'axios';
import type { Block, BlockVerbose, BlockHeader } from './types/bitcoin-core/index.js';

export default class ZecRpcClient {
    private readonly client;

    constructor(config: { host: string; port: number; user?: string; pass?: string }) {
        this.client = axios.create({
            baseURL: `http://${config.host}:${config.port}`,
            auth: config.user || config.pass ? {
                username: config.user || '',
                password: config.pass || '',
            } : undefined,
            headers: { 'content-type': 'application/json' },
        });
    }

    private async command<T>(method: string, params: unknown[] = []): Promise<T> {
        const { data } = await this.client.post('/', {
            jsonrpc: '2.0',
            id: Date.now(),
            method,
            params,
        });

        if (data?.error) {
            throw Object.assign(new Error(data.error.message || `Zcash RPC ${method} failed`), { code: data.error.code });
        }

        return data.result as T;
    }

    getBlock(hash: string, verbosity?: number): Promise<Block | BlockVerbose | string> {
        return this.command('getblock', verbosity === undefined ? [hash] : [hash, verbosity]);
    }

    getBlockHeader(hash: string): Promise<BlockHeader> {
        return this.command('getblockheader', [hash]);
    }

    getBlockHash(height: number): Promise<string> {
        return this.command('getblockhash', [height]);
    }

    getBlockCount(): Promise<number> {
        return this.command('getblockcount');
    }

    getNetworkInfo(): Promise<{ relayfee?: number }> {
        return this.command('getnetworkinfo');
    }

    getBlockchainInfo(): Promise<unknown> {
        return this.command('getblockchaininfo');
    }
}
