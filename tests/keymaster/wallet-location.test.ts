import { defaultWalletFile, directoryWallets, homeWalletPath, resolveWalletPath, storedAt, walletNotFoundMessage } from '../../packages/keymaster/src/wallet-location.ts';

// A globally installed CLI resolving ./wallet.json ties the identity to
// whichever directory it was created in, and the passphrase that unlocks it is
// kept under the home directory — so the wallet belongs there too (#980).

const HOME_WALLET = homeWalletPath('/home/someone', 'json');

function location(
    env: Record<string, string | undefined>,
    exists: (candidate: string) => boolean = () => false,
    walletType = 'json',
) {
    return {
        env,
        directoryWallets: directoryWallets(walletType),
        homeWallet: homeWalletPath('/home/someone', walletType),
        exists,
    };
}

describe('resolveWalletPath', () => {
    it('puts a new wallet under the home directory', () => {
        expect(resolveWalletPath(location({}))).toBe('/home/someone/.archon/wallet.json');
    });

    // A setup built around a wallet in the working directory goes on working
    // without being touched.
    it('keeps using a wallet already in the working directory', () => {
        expect(resolveWalletPath(location({}, (candidate) => candidate === './wallet.json'))).toBe('./wallet.json');
    });

    // Reporting no wallet here is what sends an existing SQLite user to a new
    // identity in the home directory.
    it('finds a SQLite wallet still under the older name', () => {
        const chosen = resolveWalletPath(location({}, (candidate) => candidate === './wallet.json', 'sqlite'));

        expect(chosen).toBe('./wallet.json');
    });

    it('puts a new SQLite wallet under a .db name', () => {
        expect(resolveWalletPath(location({}, () => false, 'sqlite'))).toBe('/home/someone/.archon/wallet.db');
    });

    it('obeys an explicit path over both', () => {
        const chosen = resolveWalletPath(location({ ARCHON_WALLET_PATH: '/srv/keys/wallet.json' }, () => true));

        expect(chosen).toBe('/srv/keys/wallet.json');
    });

    // An explicit path is an instruction: pointing it at nothing has to fail
    // naming what was asked for, not silently fall back somewhere else.
    it('obeys an explicit path that does not exist', () => {
        expect(resolveWalletPath(location({ ARCHON_WALLET_PATH: '/gone.json' }))).toBe('/gone.json');
    });
});

describe('defaultWalletFile', () => {
    // The CLI passed one path for both backends, so a SQLite database was
    // written under a .json name and WalletSQLite's own default never ran.
    it('names a SQLite wallet for what it is', () => {
        expect(defaultWalletFile('sqlite')).toBe('wallet.db');
        expect(homeWalletPath('/home/someone', 'sqlite')).toBe('/home/someone/.archon/wallet.db');
    });

    it('leaves the JSON wallet alone', () => {
        expect(defaultWalletFile('json')).toBe('wallet.json');
    });
});

describe('directoryWallets', () => {
    // Some SQLite wallets are named wallet.json and those hold an identity, so
    // that name is looked for first.
    it('looks for the older SQLite name before the corrected one', () => {
        expect(directoryWallets('sqlite')).toStrictEqual(['./wallet.json', './wallet.db']);
    });

    it('has one name for the JSON backend', () => {
        expect(directoryWallets('json')).toStrictEqual(['./wallet.json']);
    });
});

describe('storedAt', () => {
    it('is the path itself for the JSON backend', () => {
        expect(storedAt('json', './wallet.json')).toBe('./wallet.json');
    });

    // Asking the name instead reports no wallet to a SQLite user who has one,
    // and sends them to the home default.
    it('is under the data folder for a relative SQLite path', () => {
        expect(storedAt('sqlite', './wallet.json')).toBe('data/wallet.json');
    });

    it('leaves an absolute SQLite path alone', () => {
        expect(storedAt('sqlite', '/home/someone/.archon/wallet.json')).toBe('/home/someone/.archon/wallet.json');
    });
});

describe('walletNotFoundMessage', () => {
    // Offering create-wallet as the only route leads a user whose identity
    // is in another directory to make a second one, leaving the first where
    // they are not looking.
    it('says a wallet elsewhere is still there before offering to make one', () => {
        const lines = walletNotFoundMessage('./wallet.json', HOME_WALLET).join(' ');

        expect(lines).toContain('another directory');
        expect(lines).toContain('ARCHON_WALLET_PATH');
        expect(lines.indexOf('another directory')).toBeLessThan(lines.indexOf('create-wallet'));
    });

    it('names the home location when that is not where it looked', () => {
        expect(walletNotFoundMessage('./wallet.json', HOME_WALLET).join(' ')).toContain(HOME_WALLET);
    });

    it('does not point at the home location when that is where it looked', () => {
        const lines = walletNotFoundMessage(HOME_WALLET, HOME_WALLET);

        expect(lines.join(' ')).toContain(HOME_WALLET);
        expect(lines.filter(line => line.includes('unless ARCHON_WALLET_PATH'))).toHaveLength(0);
    });
});
