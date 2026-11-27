import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { WalletNotFoundError } from '@didcid/common/errors';
import type { NodeCapabilities, WalletBase, WalletEncFile, WalletFile } from '@didcid/keymaster/types';
import {
    WalletProvider,
    useWalletContext,
    type WalletSession,
} from '../../../../packages/wallet-ui/src/contexts/WalletProvider';

// WalletProvider opens the wallet: it connects to the node, asks for the
// passphrase (or takes it from the session), builds the Keymaster, and offers
// reset and mnemonic recovery. Keymaster, the node client and the cipher are
// replaced so each path can be driven directly; the wallet store is a plain
// object with the WalletBase methods.

const { km, gatekeeper, cipher, constructed, encryptWithPassphrase } = vi.hoisted(() => ({
    km: {
        loadWallet: vi.fn(), loadOrCreateWallet: vi.fn(), newWallet: vi.fn(), recoverWallet: vi.fn(),
        getNodeCapabilities: vi.fn(),
    },
    gatekeeper: { connect: vi.fn(), isLightningSupported: vi.fn() },
    cipher: { generateHDKey: vi.fn(), generateJwk: vi.fn(), decryptMessage: vi.fn() },
    constructed: [] as Array<{ wallet: unknown; passphrase: string }>,
    encryptWithPassphrase: vi.fn(),
}));

vi.mock('@didcid/keymaster', () => ({
    default: class {
        constructor(options: { wallet: unknown; passphrase: string }) {
            constructed.push({ wallet: options.wallet, passphrase: options.passphrase });
            return km;
        }
    },
}));
vi.mock('@didcid/clients/drawbridge', () => ({
    default: class {
        constructor() {
            return gatekeeper;
        }
    },
}));
vi.mock('@didcid/cipher', () => ({
    default: class {
        constructor() {
            return cipher;
        }
    },
}));
vi.mock('@didcid/cipher/passphrase', () => ({ encryptWithPassphrase }));

const NODE_URL = 'http://node.test:4222';
const MNEMONIC = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
const mnemonicEnc = { salt: 'c2FsdA', iv: 'aXY', data: 'ZGF0YQ' };

// What a wallet store holds: the encrypted wallet.
const storedWallet: WalletEncFile = { version: 2, seed: { mnemonicEnc }, enc: 'ciphertext' };
// What Keymaster's load and create calls return: the decrypted wallet.
const walletFile: WalletFile = { version: 2, seed: { mnemonicEnc }, counter: 0, ids: {} };
const capabilities: NodeCapabilities = { didcomm: true, lightning: false, names: true };

let store!: { [K in keyof WalletBase]: Mock<WalletBase[K]> };
let session!: { [K in keyof WalletSession]: Mock<WalletSession[K]> };

beforeEach(() => {
    vi.resetAllMocks();
    constructed.length = 0;
    store = {
        loadWallet: vi.fn<WalletBase['loadWallet']>().mockResolvedValue(storedWallet),
        saveWallet: vi.fn<WalletBase['saveWallet']>().mockResolvedValue(true),
        updateWallet: vi.fn<WalletBase['updateWallet']>().mockResolvedValue(undefined),
    };
    session = {
        get: vi.fn<WalletSession['get']>().mockResolvedValue(''),
        set: vi.fn<WalletSession['set']>().mockResolvedValue(undefined),
        clear: vi.fn<WalletSession['clear']>().mockResolvedValue(undefined),
    };
    gatekeeper.connect.mockResolvedValue(undefined);
    gatekeeper.isLightningSupported.mockResolvedValue(true);
    km.loadWallet.mockResolvedValue(walletFile);
    km.loadOrCreateWallet.mockResolvedValue(walletFile);
    km.newWallet.mockResolvedValue(walletFile);
    km.recoverWallet.mockResolvedValue(walletFile);
    km.getNodeCapabilities.mockResolvedValue(capabilities);
    cipher.generateHDKey.mockReturnValue({ privateKey: new Uint8Array(32) });
    cipher.generateJwk.mockReturnValue({ publicJwk: { kty: 'EC' }, privateJwk: { kty: 'EC', d: 'x' } });
    cipher.decryptMessage.mockReturnValue('{}');
    encryptWithPassphrase.mockResolvedValue({ salt: 'bmV3', iv: 'bmV3', data: 'bmV3' });
});

let context!: ReturnType<typeof useWalletContext>;

function Child() {
    context = useWalletContext();
    return (
        <dl>
            <dt>ready</dt><dd>{context.keymaster ? 'wallet open' : 'no wallet'}</dd>
            <dt>node</dt><dd>{context.gatekeeperUrl}</dd>
            <dt>features</dt>
            <dd>{`lightning=${context.hasLightning} didcomm=${context.hasDidComm} cashu=${context.hasCashu}`}</dd>
            <dt>refreshes</dt><dd>{`refresh ${context.refreshFlag}`}</dd>
        </dl>
    );
}

function renderProvider(options: { isBrowser?: boolean } = {}) {
    return render(
        <WalletProvider
            walletStore={store}
            session={session}
            resolveGatekeeperUrl={() => NODE_URL}
            isBrowser={options.isBrowser}
        >
            <Child />
        </WalletProvider>
    );
}

async function submitPassphrase(user: UserEvent, passphrase: string, confirm = false) {
    await user.type(await screen.findByLabelText(/^Passphrase/), passphrase);
    if (confirm) {
        await user.type(screen.getByLabelText(/^Confirm Passphrase/), passphrase);
    }
    await user.click(screen.getByRole('button', { name: 'Submit' }));
}

const walletOpen = () => screen.findByText('wallet open');

describe('opening with a session passphrase', () => {
    it('opens the wallet without asking, and reports the node and its features', async () => {
        session.get.mockResolvedValue('secret');
        renderProvider();

        await walletOpen();

        expect(gatekeeper.connect).toHaveBeenCalledWith({ url: NODE_URL });
        expect(screen.getByText(NODE_URL)).toBeInTheDocument();
        expect(screen.getByText('lightning=true didcomm=true cashu=false')).toBeInTheDocument();
        expect(screen.getByText('refresh 1')).toBeInTheDocument();
        expect(constructed).toEqual([{ wallet: store, passphrase: 'secret' }]);
        // A rebuild never provisions.
        expect(km.loadWallet).toHaveBeenCalledOnce();
        expect(km.loadOrCreateWallet).not.toHaveBeenCalled();
        expect(session.set).toHaveBeenCalledWith('secret');
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it.each([
        ['a node without DIDComm', { ...capabilities, didcomm: false }, 'didcomm=false cashu=false'],
        ['a node with Cashu', { ...capabilities, cashu: true }, 'didcomm=true cashu=true'],
        ['a node with no capability manifest', null, 'didcomm=true cashu=false'],
    ])('follows the capabilities of %s', async (_label, manifest, expected) => {
        km.getNodeCapabilities.mockResolvedValue(manifest);
        session.get.mockResolvedValue('secret');
        renderProvider();

        await walletOpen();

        expect(screen.getByText(`lightning=true ${expected}`)).toBeInTheDocument();
    });

    it('opens anyway when the capabilities or the node cannot be read', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            gatekeeper.connect.mockRejectedValue(new Error('connection refused'));
            km.getNodeCapabilities.mockRejectedValue(new Error('timeout'));
            session.get.mockResolvedValue('secret');
            renderProvider();

            await walletOpen();

            expect(screen.getByText(NODE_URL)).toBeInTheDocument();
            expect(screen.getByText('lightning=false didcomm=true cashu=false')).toBeInTheDocument();
            expect(consoleError).toHaveBeenCalledWith('Failed to connect to gatekeeper:', expect.any(Error));
            expect(consoleError).toHaveBeenCalledWith('Failed to read node capabilities:', expect.any(Error));
        } finally {
            consoleError.mockRestore();
        }
    });

    it('forgets a session passphrase that no longer opens the wallet and asks for it', async () => {
        km.loadWallet.mockRejectedValueOnce(new Error('Incorrect passphrase'));
        session.get.mockResolvedValue('stale');
        renderProvider();

        expect(await screen.findByText('Enter Your Wallet Passphrase')).toBeInTheDocument();
        expect(session.clear).toHaveBeenCalledOnce();
        // The stale session is not the user's mistake, so no error is shown.
        expect(screen.queryByText('Incorrect passphrase')).not.toBeInTheDocument();
        expect(screen.queryByText('wallet open')).not.toBeInTheDocument();
    });
});

describe('the passphrase prompt', () => {
    it('asks for a new passphrase on first run and provisions the wallet', async () => {
        store.loadWallet.mockResolvedValue(null);
        const user = userEvent.setup({ delay: null });
        renderProvider();

        expect(await screen.findByText('Set a Passphrase')).toBeInTheDocument();
        // Nothing to cancel back to, and nothing to reset or recover.
        expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Recover' })).not.toBeInTheDocument();
        await submitPassphrase(user, 'new secret', true);

        await walletOpen();
        expect(km.loadOrCreateWallet).toHaveBeenCalledOnce();
        expect(km.loadWallet).not.toHaveBeenCalled();
        expect(session.set).toHaveBeenCalledWith('new secret');
    });

    it('does not provision when a wallet appeared behind the first-run prompt', async () => {
        store.loadWallet.mockResolvedValueOnce(null);
        const user = userEvent.setup({ delay: null });
        renderProvider();
        await screen.findByText('Set a Passphrase');

        await submitPassphrase(user, 'secret', true);

        await walletOpen();
        expect(km.loadWallet).toHaveBeenCalledOnce();
        expect(km.loadOrCreateWallet).not.toHaveBeenCalled();
    });

    it('decrypts a stored wallet with the passphrase entered', async () => {
        const user = userEvent.setup({ delay: null });
        renderProvider();

        expect(await screen.findByText('Enter Your Wallet Passphrase')).toBeInTheDocument();
        await submitPassphrase(user, 'secret');

        await walletOpen();
        expect(constructed[constructed.length - 1]).toEqual({ wallet: store, passphrase: 'secret' });
        expect(km.loadOrCreateWallet).not.toHaveBeenCalled();
    });

    it.each([
        ['a wrong passphrase', new Error('Incorrect passphrase'), 'Incorrect passphrase'],
        ['any other failure', new Error('Unsupported wallet version'), 'Unsupported wallet version'],
    ])('keeps the prompt open and explains %s', async (_label, error, message) => {
        km.loadWallet.mockRejectedValueOnce(error);
        const user = userEvent.setup({ delay: null });
        renderProvider();
        await screen.findByText('Enter Your Wallet Passphrase');

        await submitPassphrase(user, 'wrong');

        expect(await screen.findByText(message)).toBeInTheDocument();
        expect(screen.getByText('Enter Your Wallet Passphrase')).toBeInTheDocument();
        expect(session.set).not.toHaveBeenCalled();
    });

    it('sends the user to setup when the store has emptied under the prompt', async () => {
        km.loadWallet.mockRejectedValueOnce(new WalletNotFoundError());
        const user = userEvent.setup({ delay: null });
        renderProvider();
        await screen.findByText('Enter Your Wallet Passphrase');

        await submitPassphrase(user, 'secret');

        expect(await screen.findByText('Set a Passphrase')).toBeInTheDocument();
        expect(km.loadOrCreateWallet).not.toHaveBeenCalled();
    });

    it('stays open when closed with no wallet to fall back to', async () => {
        store.loadWallet.mockResolvedValue(null);
        const user = userEvent.setup({ delay: null });
        renderProvider();
        await screen.findByText('Set a Passphrase');

        await user.keyboard('{Escape}');

        await waitFor(() => expect(store.loadWallet).toHaveBeenCalledTimes(2));
        expect(screen.getByText('Set a Passphrase')).toBeInTheDocument();
    });
});

describe('resetting the wallet', () => {
    async function startReset(user: UserEvent) {
        renderProvider();
        await screen.findByText('Enter Your Wallet Passphrase');
        await user.click(screen.getByRole('button', { name: 'Reset' }));
        expect(await screen.findByText('Overwrite wallet with a new one?')).toBeInTheDocument();
    }

    it('can be cancelled at the warning', async () => {
        const user = userEvent.setup({ delay: null });
        await startReset(user);

        await user.click(screen.getByRole('button', { name: 'Cancel' }));

        await waitFor(() => expect(screen.queryByText('Overwrite wallet with a new one?')).not.toBeInTheDocument());
        expect(km.newWallet).not.toHaveBeenCalled();
    });

    it('creates a new wallet under the new passphrase and opens it', async () => {
        const user = userEvent.setup({ delay: null });
        await startReset(user);

        await user.click(screen.getByRole('button', { name: 'Confirm' }));
        expect(await screen.findByText('Set a Passphrase')).toBeInTheDocument();
        await submitPassphrase(user, 'fresh', true);

        await walletOpen();
        expect(km.newWallet).toHaveBeenCalledWith(undefined, true);
        expect(constructed.map(c => c.passphrase)).toEqual(['fresh', 'fresh']);
        expect(constructed.every(c => c.wallet === store)).toBe(true);
    });

    it('explains a reset that failed and keeps the prompt', async () => {
        km.newWallet.mockRejectedValue(new Error('storage full'));
        const user = userEvent.setup({ delay: null });
        await startReset(user);
        await user.click(screen.getByRole('button', { name: 'Confirm' }));

        await submitPassphrase(user, 'fresh', true);

        expect(await screen.findByText('Failed to reset wallet. Try again.')).toBeInTheDocument();
        expect(screen.getByText('Set a Passphrase')).toBeInTheDocument();
    });

    it('can be abandoned at the new passphrase', async () => {
        const user = userEvent.setup({ delay: null });
        await startReset(user);
        await user.click(screen.getByRole('button', { name: 'Confirm' }));
        await screen.findByText('Set a Passphrase');

        await user.click(screen.getByRole('button', { name: 'Cancel' }));

        await waitFor(() => expect(screen.queryByText('Set a Passphrase')).not.toBeInTheDocument());
        expect(screen.getByText('Enter Your Wallet Passphrase')).toBeInTheDocument();
        expect(km.newWallet).not.toHaveBeenCalled();
    });
});

describe('recovering with the mnemonic', () => {
    async function enterMnemonic(user: UserEvent, mnemonic = MNEMONIC) {
        await user.click(screen.getByRole('button', { name: 'Recover' }));
        expect(await screen.findByText('Import Mnemonic')).toBeInTheDocument();
        await user.type(screen.getByPlaceholderText(/12 words total/), mnemonic);
        await user.click(screen.getByRole('button', { name: 'Confirm' }));
    }

    it('checks the mnemonic against the stored wallet, then sets a new passphrase', async () => {
        const newEnc = { salt: 'bmV3', iv: 'bmV3', data: 'bmV3' };
        encryptWithPassphrase.mockResolvedValue(newEnc);
        const user = userEvent.setup({ delay: null });
        renderProvider();
        await screen.findByText('Enter Your Wallet Passphrase');

        await enterMnemonic(user);
        expect(await screen.findByText('Set a New Passphrase')).toBeInTheDocument();
        expect(cipher.generateHDKey).toHaveBeenCalledWith(MNEMONIC);
        expect(cipher.decryptMessage).toHaveBeenCalledWith({ kty: 'EC', d: 'x' }, 'ciphertext', { kty: 'EC' });

        await submitPassphrase(user, 'recovered', true);

        await walletOpen();
        expect(encryptWithPassphrase).toHaveBeenCalledWith(MNEMONIC, 'recovered');
        expect(store.saveWallet).toHaveBeenCalledWith({ version: 2, seed: { mnemonicEnc: newEnc }, enc: 'ciphertext' }, true);
        expect(constructed[constructed.length - 1]).toEqual({ wallet: store, passphrase: 'recovered' });
    });

    it('rejects a mnemonic that does not decrypt the wallet', async () => {
        cipher.decryptMessage.mockImplementation(() => {
            throw new Error('invalid tag');
        });
        const user = userEvent.setup({ delay: null });
        renderProvider();
        await screen.findByText('Enter Your Wallet Passphrase');

        await enterMnemonic(user);

        expect(await screen.findByText('Mnemonic is incorrect. Try again.')).toBeInTheDocument();
        expect(screen.queryByText('Set a New Passphrase')).not.toBeInTheDocument();
    });

    it('refuses recovery for a wallet that is not encrypted with a mnemonic', async () => {
        const user = userEvent.setup({ delay: null });
        renderProvider();
        await screen.findByText('Enter Your Wallet Passphrase');
        store.loadWallet.mockResolvedValue({ ...walletFile, seed: {} });

        await enterMnemonic(user);

        expect(await screen.findByText('Recovery not available for this wallet type.')).toBeInTheDocument();
        expect(cipher.decryptMessage).not.toHaveBeenCalled();
    });

    it('refuses the new passphrase if the stored wallet changed type meanwhile', async () => {
        const user = userEvent.setup({ delay: null });
        renderProvider();
        await screen.findByText('Enter Your Wallet Passphrase');
        await enterMnemonic(user);
        await screen.findByText('Set a New Passphrase');
        store.loadWallet.mockResolvedValue(null);

        await submitPassphrase(user, 'recovered', true);

        expect(await screen.findByText('Recovery not available for this wallet type.')).toBeInTheDocument();
        expect(store.saveWallet).not.toHaveBeenCalled();
    });

    it('explains a new passphrase that could not be saved', async () => {
        store.saveWallet.mockRejectedValue(new Error('quota exceeded'));
        const user = userEvent.setup({ delay: null });
        renderProvider();
        await screen.findByText('Enter Your Wallet Passphrase');
        await enterMnemonic(user);
        await screen.findByText('Set a New Passphrase');

        await submitPassphrase(user, 'recovered', true);

        expect(await screen.findByText('Failed to update passphrase. Try again.')).toBeInTheDocument();
    });

    it('can be cancelled at either step', async () => {
        const user = userEvent.setup({ delay: null });
        renderProvider();
        await screen.findByText('Enter Your Wallet Passphrase');

        await user.click(screen.getByRole('button', { name: 'Recover' }));
        await screen.findByText('Import Mnemonic');
        await user.click(screen.getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByText('Import Mnemonic')).not.toBeInTheDocument());

        await enterMnemonic(user);
        await screen.findByText('Set a New Passphrase');
        await user.click(screen.getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByText('Set a New Passphrase')).not.toBeInTheDocument());
        expect(store.saveWallet).not.toHaveBeenCalled();
    });
});

describe('with the wallet open', () => {
    async function openWallet(options: { isBrowser?: boolean } = {}) {
        session.get.mockResolvedValue('secret');
        renderProvider(options);
        await walletOpen();
        constructed.length = 0;
    }

    it('asks for the passphrase of an uploaded encrypted wallet and replaces the stored one with it', async () => {
        const uploaded: WalletEncFile = { version: 2, seed: { mnemonicEnc }, enc: 'uploaded ciphertext' };
        const user = userEvent.setup({ delay: null });
        await openWallet();

        await act(() => context.handleWalletUploadFile(uploaded));
        expect(await screen.findByText('Enter Your Wallet Passphrase')).toBeInTheDocument();
        // An upload is not a reset of the wallet already here.
        expect(screen.queryByRole('button', { name: 'Reset' })).not.toBeInTheDocument();
        await submitPassphrase(user, 'upload secret');

        await waitFor(() => expect(screen.queryByText('Enter Your Wallet Passphrase')).not.toBeInTheDocument());
        // First checked in memory, then saved, then opened from the store.
        expect(constructed[0].passphrase).toBe('upload secret');
        expect(constructed[0].wallet).not.toBe(store);
        expect(store.saveWallet).toHaveBeenCalledWith(uploaded, true);
        expect(constructed[1]).toEqual({ wallet: store, passphrase: 'upload secret' });
        expect(screen.getByText('refresh 2')).toBeInTheDocument();
    });

    it.each([
        ['a wrong passphrase', new Error('Incorrect passphrase'), 'Incorrect passphrase'],
        ['any other failure', new Error('Unsupported wallet version'), 'Unsupported wallet version'],
    ])('keeps the stored wallet when an upload fails with %s', async (_label, error, message) => {
        const uploaded: WalletEncFile = { version: 2, seed: { mnemonicEnc }, enc: 'uploaded ciphertext' };
        const user = userEvent.setup({ delay: null });
        await openWallet();
        km.loadWallet.mockRejectedValueOnce(error);

        await act(() => context.handleWalletUploadFile(uploaded));
        await submitPassphrase(user, 'wrong');

        expect(await screen.findByText(message)).toBeInTheDocument();
        expect(store.saveWallet).not.toHaveBeenCalled();
        expect(constructed).toHaveLength(1);
    });

    it('lets an upload be cancelled, leaving the open wallet', async () => {
        const user = userEvent.setup({ delay: null });
        await openWallet();

        await act(() => context.handleWalletUploadFile({ ...storedWallet }));
        await screen.findByText('Enter Your Wallet Passphrase');
        await user.click(screen.getByRole('button', { name: 'Cancel' }));

        await waitFor(() => expect(screen.queryByText('Enter Your Wallet Passphrase')).not.toBeInTheDocument());
        expect(context.pendingWallet).toBeNull();
        expect(screen.getByText('wallet open')).toBeInTheDocument();
    });

    it('recovers an uploaded wallet against the upload, not the store', async () => {
        const uploaded: WalletEncFile = { version: 2, seed: { mnemonicEnc }, enc: 'uploaded ciphertext' };
        const user = userEvent.setup({ delay: null });
        await openWallet();
        store.loadWallet.mockClear();

        await act(() => context.handleWalletUploadFile(uploaded));
        await user.click(await screen.findByRole('button', { name: 'Recover' }));
        // Recovering an upload replaces its passphrase prompt.
        await waitFor(() => expect(screen.queryByText('Enter Your Wallet Passphrase')).not.toBeInTheDocument());
        await user.type(screen.getByPlaceholderText(/12 words total/), MNEMONIC);
        await user.click(screen.getByRole('button', { name: 'Confirm' }));
        await screen.findByText('Set a New Passphrase');
        await submitPassphrase(user, 'recovered', true);

        await waitFor(() => expect(store.saveWallet).toHaveBeenCalledOnce());
        expect(cipher.decryptMessage).toHaveBeenCalledWith(expect.anything(), 'uploaded ciphertext', expect.anything());
        expect(store.saveWallet.mock.calls[0][0]).toMatchObject({ enc: 'uploaded ciphertext' });
        expect(store.loadWallet).not.toHaveBeenCalled();
    });

    it('refuses an upload that is not an encrypted wallet', async () => {
        const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
        try {
            await openWallet();

            await act(() => context.handleWalletUploadFile({ ...walletFile }));

            expect(alert).toHaveBeenCalledWith('Unsupported wallet type');
            expect(screen.queryByText('Enter Your Wallet Passphrase')).not.toBeInTheDocument();
        } finally {
            alert.mockRestore();
        }
    });

    it('restores a wallet from a mnemonic set before initialising', async () => {
        const user = userEvent.setup({ delay: null });
        await openWallet();

        act(() => context.setPendingMnemonic(MNEMONIC));
        await waitFor(() => expect(context.pendingMnemonic).toBe(MNEMONIC));
        await act(() => context.initialiseWallet());
        expect(await screen.findByText('Set a Passphrase')).toBeInTheDocument();
        await submitPassphrase(user, 'restored', true);

        await waitFor(() => expect(km.recoverWallet).toHaveBeenCalledOnce());
        expect(km.newWallet).toHaveBeenCalledWith(MNEMONIC, true);
        await waitFor(() => expect(context.pendingMnemonic).toBe(''));
    });

    describe('reloadBrowserWallet', () => {
        it('rebuilds the wallet from the session in the full-page view', async () => {
            await openWallet({ isBrowser: true });

            await act(() => context.reloadBrowserWallet());

            expect(constructed).toEqual([{ wallet: store, passphrase: 'secret' }]);
            await screen.findByText('refresh 2');
        });

        it('does nothing without a session passphrase', async () => {
            await openWallet({ isBrowser: true });
            session.get.mockResolvedValue('');

            await act(() => context.reloadBrowserWallet());

            expect(constructed).toEqual([]);
        });

        it('does nothing in a wallet with no full-page view', async () => {
            await openWallet();
            session.get.mockClear();

            await act(() => context.reloadBrowserWallet());

            expect(session.get).not.toHaveBeenCalled();
            expect(constructed).toEqual([]);
            expect(context.isBrowser).toBe(false);
        });
    });
});

describe('useWalletContext', () => {
    it('refuses to be used outside the provider', () => {
        // React logs the uncaught render error; keep it out of the output.
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            expect(() => renderHook(() => useWalletContext())).toThrow('Failed to get context from WalletContext.Provider');
        } finally {
            consoleError.mockRestore();
        }
    });
});

