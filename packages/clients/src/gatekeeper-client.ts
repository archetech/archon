import { segment } from './path.js';
import { uploadBody } from './body.js';
import axiosModule, { AxiosError, type AxiosInstance, type AxiosStatic } from 'axios';
import {
    BatchMetadata,
    BlockId,
    BlockInfo,
    GatekeeperClientOptions,
    GatekeeperInterface,
    GatekeeperEvent,
    ListEventsOptions,
    ListEventsResult,
    ListChangesOptions,
    ListChangesResult,
    GetStatusResult,
    Operation,
    DidCidDocument,
    ResolveDIDOptions,
    GetDIDOptions,
    ImportBatchResult,
    ProcessEventsResult,
    VerifyDbResult,
} from './gatekeeper-types.js';

export * from './gatekeeper-types.js';

const VERSION = '/api/v1';
const ARCHON_ADMIN_HEADER = 'X-Archon-Admin-Key';

// Raised when Gatekeeper accepted the request but did not answer in time.
export class GatekeeperTimeoutError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'GatekeeperTimeoutError';
    }
}

// Raised when no response came back at all: refused, unresolvable, reset.
export class GatekeeperUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'GatekeeperUnavailableError';
    }
}

export function throwError(error: AxiosError | any): never {
    if (error.response) {
        throw error.response.data;
    }
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
        throw new GatekeeperTimeoutError(`Gatekeeper did not respond: ${error.message}`);
    }
    if (error.request) {
        throw new GatekeeperUnavailableError(`Gatekeeper unavailable: ${error.message || error.code}`);
    }
    throw error.message;
}

export default class GatekeeperClient implements GatekeeperInterface {
    protected API: string;
    protected baseUrl: string;
    protected axios: AxiosInstance;

    // Factory method
    static async create(options: GatekeeperClientOptions): Promise<GatekeeperClient> {
        const gatekeeper = new GatekeeperClient();
        await gatekeeper.connect(options);
        return gatekeeper;
    }

    constructor() {
        const axios =
            (axiosModule as AxiosStatic & { default?: AxiosInstance })?.default ??
            (axiosModule as AxiosInstance);

        this.API = VERSION;
        this.baseUrl = '';
        this.axios = axios.create();
    }

    addCustomHeader(header: string, value: string): void {
        this.axios.defaults.headers.common[header] = value;
    }

    removeCustomHeader(header: string): void {
        delete this.axios.defaults.headers.common[header];
    }

    get url(): string {
        return this.baseUrl;
    }

    async connect(options?: GatekeeperClientOptions) {
        if (options?.url) {
            this.baseUrl = new URL(options.url).origin;
            this.API = `${this.baseUrl}${VERSION}`;
        }

        if (options?.apiKey) {
            this.addCustomHeader(ARCHON_ADMIN_HEADER, options.apiKey);
        }

        if (options?.timeoutMs) {
            this.axios.defaults.timeout = options.timeoutMs;
        }

        // Only used for unit testing
        // TBD replace console with a real logging package
        if (options?.console) {
            // eslint-disable-next-line
            console = options.console;
        }

        if (options?.waitUntilReady) {
            await this.waitUntilReady(options);
        }
    }

    // Diagnostics go to stderr: a CLI's stdout is its output, which may be a token or
    // JSON that something is reading.
    async waitUntilReady(options: GatekeeperClientOptions) {
        let { intervalSeconds = 5, chatty = false, becomeChattyAfter = 0, maxRetries = 0 } = options;
        let ready = false;
        let retries = 0;

        if (chatty) {
            console.error(`Connecting to gatekeeper at ${this.API}`);
        }

        while (!ready) {
            ready = await this.isReady();

            if (!ready) {
                if (chatty) {
                    console.error('Waiting for Gatekeeper to be ready...');
                }
                // wait for 1 second before checking again
                await new Promise(resolve => setTimeout(resolve, intervalSeconds * 1000));
            }

            retries += 1;

            if (maxRetries > 0 && retries > maxRetries) {
                return;
            }

            if (!chatty && becomeChattyAfter > 0 && retries > becomeChattyAfter) {
                console.error(`Connecting to gatekeeper at ${this.API}`);
                chatty = true;
            }
        }

        if (chatty) {
            console.error('Gatekeeper service is ready!');
        }
    }

    async listRegistries(): Promise<string[]> {
        try {
            const response = await this.axios.get(`${this.API}/registries`);
            return response.data;
        }
        catch (error) {
            throwError(error);
        }
    }

    async resetDb(): Promise<boolean> {
        try {
            const response = await this.axios.get(`${this.API}/db/reset`);
            return response.data;
        }
        catch (error) {
            throwError(error);
        }
    }

    async verifyDb(): Promise<VerifyDbResult> {
        try {
            const response = await this.axios.get(`${this.API}/db/verify`);
            return response.data;
        }
        catch (error) {
            throwError(error);
        }
    }

    async isReady(): Promise<boolean> {
        try {
            const response = await this.axios.get(`${this.API}/ready`);
            return response.data;
        }
        catch (error) {
            return false;
        }
    }

    async getVersion(): Promise<{ version: string; commit: string }> {
        try {
            const response = await this.axios.get(`${this.API}/version`);
            return response.data;
        }
        catch (error) {
            throwError(error);
        }
    }

    async getStatus(): Promise<GetStatusResult> {
        try {
            const response = await this.axios.get(`${this.API}/status`);
            return response.data;
        }
        catch (error) {
            throwError(error);
        }
    }

    async createDID(operation: Operation): Promise<string> {
        try {
            const response = await this.axios.post(`${this.API}/did`, operation);
            return response.data;
        }
        catch (error) {
            throwError(error);
        }
    }

    async getGenesis(did: string): Promise<DidCidDocument> {
        try {
            const response = await this.axios.get(`${this.API}/did/${segment(did)}/genesis`);
            return response.data;
        } catch (error) {
            throwError(error);
        }
    }

    async resolveDID(did: string, options?: ResolveDIDOptions): Promise<DidCidDocument> {
        try {
            if (options) {
                const queryParams = new URLSearchParams(options as Record<string, string>);
                const response = await this.axios.get(`${this.API}/did/${segment(did)}?${queryParams.toString()}`);
                return response.data;
            }
            else {
                const response = await this.axios.get(`${this.API}/did/${segment(did)}`);
                return response.data;
            }
        }
        catch (error) {
            throwError(error);
        }
    }

    // eslint-disable-next-line sonarjs/no-identical-functions
    async updateDID(operation: Operation): Promise<boolean> {
        try {
            const response = await this.axios.post(`${this.API}/did`, operation);
            return response.data;
        }
        catch (error) {
            throwError(error);
        }
    }

    // eslint-disable-next-line sonarjs/no-identical-functions
    async deleteDID(operation: Operation): Promise<boolean> {
        try {
            const response = await this.axios.post(`${this.API}/did`, operation);
            return response.data;
        }
        catch (error) {
            throwError(error);
        }
    }

    async getDIDs(options?: GetDIDOptions): Promise<string[] | DidCidDocument[]> {
        try {
            const response = await this.axios.post(`${this.API}/dids`, options);
            return response.data;
        }
        catch (error) {
            throwError(error);
        }
    }

    async exportDIDs(dids?: string[]): Promise<GatekeeperEvent[][]> {
        try {
            const response = await this.axios.post(`${this.API}/dids/export`, { dids });
            return response.data;
        }
        catch (error) {
            throwError(error);
        }
    }

    async resolveVersions(dids: string[]): Promise<DidCidDocument[][]> {
        try {
            const response = await this.axios.post(`${this.API}/dids/versions`, { dids });
            return response.data;
        }
        catch (error) {
            throwError(error);
        }
    }

    async listEvents(options: ListEventsOptions = {}): Promise<ListEventsResult> {
        try {
            const response = await this.axios.get(`${this.API}/events`, { params: options });
            return response.data;
        }
        catch (error) {
            throwError(error);
        }
    }

    async listChanges(options: ListChangesOptions = {}): Promise<ListChangesResult> {
        try {
            const response = await this.axios.get(`${this.API}/changes`, { params: options });
            return response.data;
        }
        catch (error) {
            throwError(error);
        }
    }

    async importDIDs(dids: GatekeeperEvent[][]): Promise<ImportBatchResult> {
        try {
            const response = await this.axios.post(`${this.API}/dids/import`, dids);
            return response.data;
        }
        catch (error) {
            throwError(error);
        }
    }

    async exportBatch(dids?: string[]): Promise<GatekeeperEvent[]> {
        try {
            const response = await this.axios.post(`${this.API}/batch/export`, { dids });
            return response.data;
        }
        catch (error) {
            throwError(error);
        }
    }

    async importBatch(batch: GatekeeperEvent[]): Promise<ImportBatchResult> {
        try {
            const response = await this.axios.post(`${this.API}/batch/import`, batch);
            return response.data;
        }
        catch (error) {
            throwError(error);
        }
    }

    async importBatchByCids(cids: string[], metadata: BatchMetadata): Promise<ImportBatchResult> {
        try {
            const response = await this.axios.post(`${this.API}/batch/import/cids`, { cids, metadata });
            return response.data;
        }
        catch (error) {
            throwError(error);
        }
    }

    async removeDIDs(dids: string[]): Promise<boolean> {
        try {
            const response = await this.axios.post(`${this.API}/dids/remove`, dids);
            return response.data;
        }
        catch (error) {
            throwError(error);
        }
    }

    async getQueue(registry: string): Promise<Operation[]> {
        try {
            const response = await this.axios.get(`${this.API}/queue/${segment(registry)}`);
            return response.data;
        }
        catch (error) {
            throwError(error);
        }
    }

    async clearQueue(registry: string, events: Operation[]): Promise<boolean> {
        try {
            const response = await this.axios.post(`${this.API}/queue/${segment(registry)}/clear`, events);
            return response.data;
        }
        catch (error) {
            throwError(error);
        }
    }

    async processEvents(): Promise<ProcessEventsResult> {
        try {
            const response = await this.axios.post(`${this.API}/events/process`);
            return response.data;
        }
        catch (error) {
            throwError(error);
        }
    }

    async addJSON(data: object): Promise<string> {
        try {
            const response = await this.axios.post(`${this.API}/ipfs/json`, data);
            return response.data;
        }
        catch (error) {
            throwError(error);
        }
    }

    async rewindRegistry(registry: string, fromHeight: number): Promise<boolean> {
        try {
            const response = await this.axios.post(`${this.API}/block/${segment(registry)}/rewind`, { fromHeight });
            return response.data;
        } catch (error) {
            throwError(error);
        }
    }

    async getJSON(cid: string): Promise<object> {
        try {
            const response = await this.axios.get(`${this.API}/ipfs/json/${segment(cid)}`);
            return response.data;
        }
        catch (error) {
            throwError(error);
        }
    }

    async addText(data: string): Promise<string> {
        try {
            const response = await this.axios.post(`${this.API}/ipfs/text`, data, {
                headers: {
                    'Content-Type': 'text/plain'
                }
            });
            return response.data;
        } catch (error) {
            throwError(error);
        }
    }

    async getText(cid: string, limit?: number): Promise<string> {
        try {
            // Text is returned as it was stored. Left to itself the HTTP
            // client reads a body that looks like JSON as JSON, so that `123`
            // would come back a number and `"a"` without its quotes.
            const response = await this.axios.get(`${this.API}/ipfs/text/${segment(cid)}`, {
                params: limit === undefined ? undefined : { limit },
                responseType: 'text',
                transformResponse: [(data: unknown) => data],
            });
            return response.data;
        }
        catch (error: any) {
            // An error's body is the server's JSON, read here since the
            // request asked for text.
            if (typeof error?.response?.data === 'string') {
                try {
                    error.response.data = JSON.parse(error.response.data);
                }
                catch {
                    // Not JSON: thrown as the text it is.
                }
            }
            throwError(error);
        }
    }

    async addData(data: Buffer): Promise<string> {
        try {
            const response = await this.axios.post(`${this.API}/ipfs/data`, data, {
                headers: {
                    'Content-Type': 'application/octet-stream'
                }
            });
            return response.data;
        }
        catch (error) {
            throwError(error);
        }
    }

    async getData(cid: string, limit?: number): Promise<Buffer> {
        try {
            const response = await this.axios.get(`${this.API}/ipfs/data/${segment(cid)}`, {
                params: limit === undefined ? undefined : { limit },
                responseType: 'arraybuffer'
            });
            return Buffer.from(response.data);
        } catch (error) {
            const axiosError = error as AxiosError;
            if (axiosError.response && axiosError.response.data instanceof Uint8Array) {
                const textDecoder = new TextDecoder();
                const errorMessage = textDecoder.decode(axiosError.response.data);
                axiosError.response.data = JSON.parse(errorMessage);
            }
            throwError(axiosError);
        }
    }

    async addDataStream(stream: AsyncIterable<Uint8Array>): Promise<string> {
        try {
            const response = await this.axios.post(`${this.API}/ipfs/stream`, await uploadBody(stream), {
                headers: { 'Content-Type': 'application/octet-stream' },
                responseType: 'text',
                maxBodyLength: Infinity,
                maxContentLength: Infinity,
            });
            return response.data;
        } catch (error) {
            throwError(error);
        }
    }

    async *getDataStream(cid: string): AsyncGenerator<Uint8Array> {
        let response: any;
        try {
            response = await this.axios.get(`${this.API}/ipfs/stream/${segment(cid)}`, {
                responseType: 'stream',
            });
            yield* response.data;
        } catch (error: any) {
            if (response?.data?.destroy) {
                response.data.destroy();
            }
            if (error?.response?.status) {
                throw new Error(`HTTP ${error.response.status}`);
            }
            throwError(error);
        }
    }

    async getBlock(registry: string, block?: BlockId): Promise<BlockInfo | null> {
        try {
            const url = block !== undefined
                ? `${this.API}/block/${segment(registry)}/${segment(block)}`
                : `${this.API}/block/${segment(registry)}/latest`;
            const response = await this.axios.get(url);
            return response.data;
        } catch (error) {
            throwError(error);
        }
    }

    async addBlock(registry: string, block: BlockInfo): Promise<boolean> {
        try {
            const response = await this.axios.post(`${this.API}/block/${segment(registry)}`, block);
            return response.data;
        }
        catch (error) {
            throwError(error);
        }
    }

    async generateDID(operation: Operation): Promise<string> {
        try {
            const response = await this.axios.post(`${this.API}/did/generate`, operation);
            return response.data;
        } catch (error) {
            throwError(error);
        }
    }

    async searchDocs(q: string): Promise<string[]> {
        try {
            const response = await this.axios.get(`${this.API}/search`, { params: { q } });
            return response.data;
        } catch (error) {
            throwError(error);
        }
    }

    async queryDocs(where: Record<string, unknown>): Promise<string[]> {
        try {
            const response = await this.axios.post(`${this.API}/query`, { where });
            return response.data;
        } catch (error) {
            throwError(error);
        }
    }

    async search(query: { where: Record<string, unknown> }): Promise<string[]> {
        return this.queryDocs(query.where);
    }
}
