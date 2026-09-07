import path from 'path';

// Where a wallet lives when nothing says otherwise.
//
// A globally installed CLI resolving ./wallet.json ties the identity to
// whichever directory it was created in: `cd ..` and it is gone, and the
// "not found" message reads as an invitation to create a second one, leaving
// the first on disk somewhere the user is not looking (#980).
//
// The passphrase that unlocks a wallet is kept under the home directory, so
// the wallet belongs there too. A wallet already sitting in the working
// directory still wins, so a setup built that way goes on working untouched.

export const ARCHON_HOME_DIRECTORY = '.archon';

// SQLite's own default is wallet.db, which the CLI never reaches because it
// always passes a path. Without a name per backend, a SQLite database is
// written under a .json one.
export function defaultWalletFile(walletType: string): string {
    return walletType === 'sqlite' ? 'wallet.db' : 'wallet.json';
}

export function homeWalletPath(homeDirectory: string, walletType: string): string {
    return path.join(homeDirectory, ARCHON_HOME_DIRECTORY, defaultWalletFile(walletType));
}

// What to look for in the working directory, in the order it should win.
// Some SQLite wallets are named wallet.json, those are the ones holding an
// identity, and nothing about the name says which backend wrote it.
export function directoryWallets(walletType: string): string[] {
    return walletType === 'sqlite' ? ['./wallet.json', './wallet.db'] : ['./wallet.json'];
}

// Where a backend keeps the wallet it is handed. The JSON one uses the path as
// given; the SQLite one treats a relative one as a name under its own data
// folder, so `./wallet.json` is stored at `data/wallet.json`.
//
// Asking whether a wallet is already in the working directory means asking
// where that backend would have put it. Looking at the name instead reports no
// wallet to a SQLite user who has one, and sends them to the home default.
export function storedAt(walletType: string, walletPath: string): string {
    return walletType === 'sqlite' && !path.isAbsolute(walletPath)
        ? path.join('data', walletPath)
        : walletPath;
}

export interface WalletLocation {
    env: Record<string, string | undefined>;
    directoryWallets: string[];
    homeWallet: string;
    exists: (candidate: string) => boolean;
}

export function resolveWalletPath(location: WalletLocation): string {
    // An explicit path is an instruction, not a preference: it wins even when
    // it points at nothing, so the error names what was asked for.
    const configured = location.env.ARCHON_WALLET_PATH;

    if (configured) {
        return configured;
    }

    const found = location.directoryWallets.find(candidate => location.exists(candidate));

    return found ?? location.homeWallet;
}

// Said when a wallet is not where it was looked for. `create-wallet` is only
// the right answer if there is not one already, and the commonest case is a
// wallet sitting in another directory.
export function walletNotFoundMessage(walletPath: string, homeWallet: string): string[] {
    const lines = [`Error: no wallet at ${walletPath}`];

    if (walletPath !== homeWallet) {
        lines.push(`This node's own wallet lives at ${homeWallet} unless ARCHON_WALLET_PATH says otherwise.`);
    }

    return [
        ...lines,
        'A wallet made in another directory is still there — point ARCHON_WALLET_PATH at it.',
        'To start a new identity instead, run: keymaster create-wallet',
    ];
}
