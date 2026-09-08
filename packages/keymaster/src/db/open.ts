import fs from 'fs';
import type { WalletBase } from '../types.js';
import { splitWalletPath, strandedWallet, strandedWalletMessage } from '../wallet-location.js';
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
    // Before anything is created: opening writes the file, and a caller that
    // provisions -- create-wallet, create-id, the MCP tools behind
    // loadOrCreateWallet -- would then hold a new identity while the owner's
    // wallet sits where an earlier release left it.
    const stranded = strandedWallet(walletType, walletPath, (candidate) => fs.existsSync(candidate));

    if (stranded) {
        throw new Error(strandedWalletMessage(walletPath, stranded));
    }

    const { directory, file } = splitWalletPath(walletPath);

    if (walletType === 'sqlite') {
        return WalletSQLite.create(file, directory);
    }

    return new WalletJson(file, directory);
}
