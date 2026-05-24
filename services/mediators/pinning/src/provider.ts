import axios, { AxiosInstance } from 'axios';
import config from './config.js';
import type { PinStatus } from './state.js';

export interface ProviderPinStatus {
    requestid?: string;
    status: PinStatus;
    response: unknown;
}

export interface ProviderPinRequest {
    cid: string;
    name: string;
    meta: Record<string, string>;
    origins?: string[];
}

export class PinningServiceProvider {
    private readonly client: AxiosInstance;

    constructor(
        private readonly provider: string,
        apiUrl: string,
        apiToken: string | undefined
    ) {
        if (!apiToken) {
            throw new Error('ARCHON_PIN_API_TOKEN is required');
        }

        this.client = axios.create({
            baseURL: apiUrl.replace(/\/+$/, ''),
            timeout: 60_000,
            headers: {
                Authorization: `Bearer ${apiToken}`,
                'Content-Type': 'application/json',
            },
        });
    }

    get name(): string {
        return this.provider;
    }

    async pin(request: ProviderPinRequest): Promise<ProviderPinStatus> {
        const response = await this.client.post('/pins', {
            cid: request.cid,
            name: request.name,
            origins: request.origins || [],
            meta: request.meta,
        });
        return normalizeStatus(response.data);
    }

    async getStatus(requestid: string): Promise<ProviderPinStatus> {
        const response = await this.client.get(`/pins/${encodeURIComponent(requestid)}`);
        return normalizeStatus(response.data);
    }
}

export function createProvider(): PinningServiceProvider {
    return new PinningServiceProvider(config.provider, config.apiUrl, config.apiToken);
}

export function normalizeStatus(response: any): ProviderPinStatus {
    const rawStatus = typeof response?.status === 'string' ? response.status : 'pinning';
    const status: PinStatus = ['queued', 'pinning', 'pinned', 'failed'].includes(rawStatus)
        ? rawStatus as PinStatus
        : 'pinning';

    return {
        requestid: typeof response?.requestid === 'string' ? response.requestid : undefined,
        status,
        response,
    };
}

export function providerError(error: any): string {
    return error?.response?.data?.error?.details
        || error?.response?.data?.error?.reason
        || error?.response?.data?.error
        || error?.response?.data?.message
        || error?.message
        || String(error);
}
