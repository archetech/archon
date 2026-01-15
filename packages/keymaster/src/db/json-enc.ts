import { StoredWallet, WalletBase } from '../types.js';
import { AbstractBase } from './abstract-base.js';

/**
 * @deprecated This class only supported V0 encrypted wallet format.
 * V0 format is no longer supported. Use V1 format with mnemonicEnc instead.
 */
export default class WalletEncrypted extends AbstractBase {
    private baseWallet: WalletBase;

    constructor(baseWallet: WalletBase, _passphrase: string) {
        super();
        this.baseWallet = baseWallet;
    }

    async saveWallet(wallet: StoredWallet, overwrite: boolean = false): Promise<boolean> {
        return this.baseWallet.saveWallet(wallet, overwrite);
    }

    async loadWallet(): Promise<StoredWallet | null> {
        const data = await this.baseWallet.loadWallet();
        if (!data) {
            return null;
        }

        // V0 encrypted format is no longer supported
        if ('salt' in data && 'iv' in data && 'data' in data && !('version' in data)) {
            throw new Error('V0 encrypted wallet format is no longer supported.');
        }

        return data;
    }
}
