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

export function homeWalletPath(homeDirectory: string): string {
    return path.join(homeDirectory, ARCHON_HOME_DIRECTORY, 'wallet.json');
}

export interface WalletLocation {
    env: Record<string, string | undefined>;
    directoryWallet: string;
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

    if (location.exists(location.directoryWallet)) {
        return location.directoryWallet;
    }

    return location.homeWallet;
}

// Said when a wallet is not where it was looked for. `create-wallet` is only
// the right answer if there is not one already, and the commonest case is one
// made in another directory before this default existed.
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
