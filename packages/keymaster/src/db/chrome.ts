import { StoredWallet } from '../types.js';
import { AbstractBase } from './abstract-base.js';

export default class WalletChrome extends AbstractBase {
    walletName: string;

    constructor(walletName: string = 'archon-keymaster') {
        super();
        this.walletName = walletName;
    }

    async saveWallet(wallet: StoredWallet, overwrite: boolean = false): Promise<boolean> {
        if (!overwrite) {
            const res = await chrome.storage.local.get([this.walletName]);
            if (res[this.walletName]) {
                return false;
            }
        }

        await chrome.storage.local.set({ [this.walletName]: JSON.stringify(wallet) });
        return true;
    }

    async loadWallet(): Promise<StoredWallet | null> {
        const res = await chrome.storage.local.get([this.walletName]);
        const stored = res[this.walletName];

        // @types/chrome >= 0.2 types this as `unknown` rather than `any`, which
        // is the honest description: extension storage is shared with the rest
        // of the extension, so nothing guarantees the value is the JSON string
        // saveWallet() wrote. Narrow rather than assert, and treat anything
        // else as an absent wallet.
        if (typeof stored !== 'string') {
            return null;
        }

        return JSON.parse(stored);
    }
}
