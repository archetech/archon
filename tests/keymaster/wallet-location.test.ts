import { homeWalletPath, resolveWalletPath, walletNotFoundMessage } from '../../packages/keymaster/src/wallet-location.ts';

// A globally installed CLI resolving ./wallet.json ties the identity to
// whichever directory it was created in, and the passphrase that unlocks it is
// kept under the home directory — so the wallet belongs there too (#980).

const HOME_WALLET = homeWalletPath('/home/someone');

function location(env: Record<string, string | undefined>, exists: (candidate: string) => boolean = () => false) {
    return { env, directoryWallet: './wallet.json', homeWallet: HOME_WALLET, exists };
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
