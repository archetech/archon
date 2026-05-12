import axios, { type AxiosInstance } from 'axios';
import config from './config.js';

export interface RpcClient {
    command<T = any>(method: string, params?: any[]): Promise<T>;
}

export function createZcashClient(): RpcClient {
    const client: AxiosInstance = axios.create({
        baseURL: `http://${config.zecHost}:${config.zecPort}`,
        auth: config.zecUser || config.zecPass ? {
            username: config.zecUser || '',
            password: config.zecPass || '',
        } : undefined,
        headers: { 'content-type': 'application/json' },
    });

    return {
        async command<T = any>(method: string, params: any[] = []): Promise<T> {
            const response = await client.post('/', {
                jsonrpc: '2.0',
                id: Date.now(),
                method,
                params,
            });

            if (response.data?.error) {
                throw new Error(response.data.error.message || `Zcash RPC ${method} failed`);
            }

            return response.data.result as T;
        },
    };
}
