import {
    DrawbridgeInterface,
    GatekeeperClientOptions,
    LightningBalance,
    LightningConfig,
    LightningInvoice,
    LightningPayment,
    LightningPaymentStatus,
} from './types.js';
import GatekeeperClient from './gatekeeper-client.js';

function throwError(error: any): never {
    if (error.response) {
        if (error.response.status === 404) {
            throw new Error('Lightning service unavailable: Server does not support Lightning');
        }
        throw error.response.data;
    }
    throw error.message;
}

export default class DrawbridgeClient extends GatekeeperClient implements DrawbridgeInterface {

    static override async create(options: GatekeeperClientOptions): Promise<DrawbridgeClient> {
        const client = new DrawbridgeClient();
        await client.connect(options);
        return client;
    }

    async isLightningSupported(): Promise<boolean> {
        try {
            const response = await this.axios.get(`${this.API}/lightning/supported`);
            return response.data?.supported === true;
        } catch {
            return false;
        }
    }

    async createLightningWallet(name: string): Promise<LightningConfig> {
        try {
            const response = await this.axios.post(`${this.API}/lightning/wallet`, { name });
            return response.data;
        } catch (error) {
            throwError(error);
        }
    }

    async getLightningBalance(invoiceKey: string): Promise<LightningBalance> {
        try {
            const response = await this.axios.post(`${this.API}/lightning/balance`, { invoiceKey });
            return response.data;
        } catch (error) {
            throwError(error);
        }
    }

    async createLightningInvoice(invoiceKey: string, amount: number, memo: string): Promise<LightningInvoice> {
        try {
            const response = await this.axios.post(`${this.API}/lightning/invoice`, { invoiceKey, amount, memo });
            return response.data;
        } catch (error) {
            throwError(error);
        }
    }

    async payLightningInvoice(adminKey: string, bolt11: string): Promise<LightningPayment> {
        try {
            const response = await this.axios.post(`${this.API}/lightning/pay`, { adminKey, bolt11 });
            return response.data;
        } catch (error) {
            throwError(error);
        }
    }

    async checkLightningPayment(invoiceKey: string, paymentHash: string): Promise<LightningPaymentStatus> {
        try {
            const response = await this.axios.post(`${this.API}/lightning/payment`, { invoiceKey, paymentHash });
            return response.data;
        } catch (error) {
            throwError(error);
        }
    }

    async publishLightning(did: string, invoiceKey: string): Promise<{ ok: boolean; publicHost?: string }> {
        try {
            const response = await this.axios.post(`${this.API}/lightning/publish`, { did, invoiceKey });
            return response.data;
        } catch (error) {
            throwError(error);
        }
    }

    async unpublishLightning(did: string): Promise<boolean> {
        try {
            const response = await this.axios.delete(`${this.API}/lightning/publish/${encodeURIComponent(did)}`);
            return response.data.ok;
        } catch (error) {
            throwError(error);
        }
    }

    async zapLightning(adminKey: string, did: string, amount: number, memo?: string): Promise<LightningPayment> {
        try {
            const response = await this.axios.post(`${this.API}/lightning/zap`, { adminKey, did, amount, memo });
            return response.data;
        } catch (error) {
            throwError(error);
        }
    }
}
