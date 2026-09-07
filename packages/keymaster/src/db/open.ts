import type { WalletBase } from '../types.js';
import { splitWalletPath } from '../wallet-location.js';
import WalletJson from './json.js';
import WalletSQLite from './sqlite.js';

// Opens the local wallet store a path names, whichever backend is configured.
//
// Both stores are constructed from a folder and a name, and every caller that
// resolves ARCHON_WALLET_PATH has one path. Splitting it in each of them is how
// a path came to mean one thing under JSON and another under SQLite, where it
// was passed whole as the name and so hung under the store's own data folder
// (#1073). One opener leaves nothing for a caller to get right.
export async function openWalletStore(walletType: string, walletPath: string): Promise<WalletBase> {
    const { directory, file } = splitWalletPath(walletPath);

    if (walletType === 'sqlite') {
        return WalletSQLite.create(file, directory);
    }

    return new WalletJson(file, directory);
}
