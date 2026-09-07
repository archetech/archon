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
// identity, and nothing about the name says which backend wrote it. The
// data/ entries follow, because a SQLite wallet may still be sitting where an
// earlier release put it and its owner has nothing in the directory itself.
export function directoryWallets(walletType: string): string[] {
    const here = walletType === 'sqlite' ? ['./wallet.json', './wallet.db'] : ['./wallet.json'];
    const legacy = here
        .map(candidate => legacyWalletPath(walletType, candidate))
        .filter((candidate): candidate is string => candidate !== undefined);

    return [...here, ...legacy];
}

// Where a wallet ended up when a relative path was handed to the SQLite store
// as a *name*, which hung it under the store's own data folder: `./wallet.json`
// was written to `data/wallet.json` (#1073).
//
// Nothing resolves through this. It finds wallets written before a path meant a
// path, so they keep opening and so the "no wallet" message can name one it can
// see. Delete it, and its two callers, once those wallets have moved.
export function legacyWalletPath(walletType: string, walletPath: string): string | undefined {
    return walletType === 'sqlite' && !path.isAbsolute(walletPath)
        ? path.join('data', walletPath)
        : undefined;
}

// A store takes the folder and the name separately; every caller resolving
// ARCHON_WALLET_PATH has one path. Splitting it here keeps each caller from
// deciding for itself what a path handed to a store means.
export function splitWalletPath(walletPath: string): { directory: string, file: string } {
    return {
        directory: path.dirname(walletPath),
        file: path.basename(walletPath),
    };
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
export function walletNotFoundMessage(walletPath: string, homeWallet: string, foundAt?: string): string[] {
    // A wallet that can still be read is the whole answer, and offering to make
    // a second identity underneath it would only bury the first.
    if (foundAt) {
        return [
            `Error: no wallet at ${walletPath}`,
            `A wallet is still at ${foundAt}, where earlier releases put it.`,
            `Move it to ${walletPath}, or point ARCHON_WALLET_PATH there.`,
        ];
    }

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
