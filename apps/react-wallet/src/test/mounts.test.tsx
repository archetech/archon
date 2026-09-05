import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ContextProviders } from '../contexts/ContextProviders';
import { clearSessionPassphrase } from '../utils/sessionPassphrase';

// #914: nothing in this repo rendered a component, so a crash on first render
// shipped with every check green. That is not hypothetical -- on #912 both
// wallets rendered a blank page:
//
//   Uncaught Error: useWalletNavigation must be used within WalletNavigationProvider
//       at useWalletData -> at UIProvider
//
// and the commit passed tsc in both apps, eslint, the vite build, the webpack
// build, 84 wallet tests and all 30 CI checks. A human opening the app found it.
//
// The cause was a provider-ordering cycle: UIProvider called a hook that
// required a context mounted inside UIProvider. Types cannot see that -- the
// hook's signature is satisfied either way, and the failure is a runtime
// useContext returning null.
//
// So the assertion here is deliberately weak. "It mounts" is the property that
// was missing; what it renders is a different question, and pinning that here
// would make this test fragile against ordinary UI work without catching
// anything more.

// Mounting alone stops at the passphrase modal, because WalletProvider gates
// its children behind isReady and a wallet with no stored data is correctly not
// ready. That matters more than it sounds: UIProvider -- the provider that
// caused #912 -- lives INSIDE that gate, so a test that only mounts never runs
// the hook that threw. Verified by reintroducing the bug against an
// earlier version of this file, which stayed green.
//
// So the tree has to be taken through setup to be worth anything.
async function completeSetup() {
    const user = userEvent.setup();

    // Anchored regexes: MUI folds the required marker into the label text, so
    // these read "Passphrase *" and "Confirm Passphrase *", and a plain
    // 'Passphrase' matches neither.
    await user.type(await screen.findByLabelText(/^Passphrase/), PASSPHRASE);
    await user.type(await screen.findByLabelText(/^Confirm Passphrase/), PASSPHRASE);
    await user.click(screen.getByRole('button', { name: 'Submit' }));
}

const PASSPHRASE = 'render-smoke-test-passphrase';

// WalletWeb's default localStorage key.
const WALLET_KEY = 'archon-keymaster';

describe('react-wallet provider tree', () => {
    it('mounts without throwing', () => {
        expect(() =>
            render(
                <ContextProviders>
                    <div data-testid="child">child</div>
                </ContextProviders>
            )
        ).not.toThrow();
    });

    it('reaches its first real screen', async () => {
        // Mounting without throwing is not enough on its own: a tree that
        // rendered null everywhere would satisfy the check above while showing
        // the user the same blank page. So assert it gets somewhere.
        //
        // Not the children, though -- WalletProvider gates those behind
        // isReady, and a wallet with no stored data is correctly not ready. Its
        // first screen is the passphrase prompt, which is what a new user
        // actually sees.
        render(
            <ContextProviders>
                <div data-testid="child">child</div>
            </ContextProviders>
        );

        expect(await screen.findByText('Set a Passphrase')).toBeInTheDocument();
    });

    it('renders its children once the wallet is ready', async () => {
        // The assertion that actually covers #912: reaching this point means
        // UIProvider mounted and useWalletData ran, which is where the
        // provider-ordering cycle threw.
        render(
            <ContextProviders>
                <div data-testid="child">child</div>
            </ContextProviders>
        );

        await completeSetup();

        await waitFor(
            () => expect(screen.getByTestId('child')).toBeInTheDocument(),
            { timeout: 20000 }
        );
    }, 30000);
});

// The wallet's own setup flow is the only place that may provision. A rebuild
// -- restoring a session, reloading the page, decrypting -- fails closed and
// returns to setup, so a store cleared underneath the app is never answered
// with a fresh identity (#1037).
describe('a cleared wallet store under a live session', () => {
    it('returns to setup instead of minting a replacement', async () => {
        const { unmount } = render(
            <ContextProviders>
                <div data-testid="child">child</div>
            </ContextProviders>
        );

        await completeSetup();
        await waitFor(
            () => expect(screen.getByTestId('child')).toBeInTheDocument(),
            { timeout: 20000 }
        );

        // The session passphrase survives; the store does not. A volume that
        // failed to mount, cleared site data, a different browser profile.
        expect(window.localStorage.getItem(WALLET_KEY)).not.toBeNull();
        window.localStorage.removeItem(WALLET_KEY);
        unmount();

        render(
            <ContextProviders>
                <div data-testid="child">child</div>
            </ContextProviders>
        );

        // Setup, not a wallet conjured out of the session.
        expect(await screen.findByText('Set a Passphrase')).toBeInTheDocument();
        expect(window.localStorage.getItem(WALLET_KEY)).toBeNull();
    }, 40000);
});

// The decrypt prompt is the other rebuild path. A store that empties while it
// is open must not be answered by minting on submit, and must not leave the
// user at a prompt that silently ignores every attempt.
describe('a cleared wallet store under an open decrypt prompt', () => {
    it('returns to setup instead of minting or hanging', async () => {
        const first = render(
            <ContextProviders>
                <div data-testid="child">child</div>
            </ContextProviders>
        );
        await completeSetup();
        await waitFor(() => expect(screen.getByTestId('child')).toBeInTheDocument(), { timeout: 20000 });
        first.unmount();

        // Store present, session gone: the app opens on the decrypt prompt.
        clearSessionPassphrase();
        render(
            <ContextProviders>
                <div data-testid="child">child</div>
            </ContextProviders>
        );
        expect(await screen.findByText('Enter Your Wallet Passphrase')).toBeInTheDocument();

        // The store vanishes while the prompt is open, then the user submits.
        window.localStorage.removeItem(WALLET_KEY);
        const user = userEvent.setup();
        await user.type(await screen.findByLabelText(/^Passphrase/), PASSPHRASE);
        await user.click(screen.getByRole('button', { name: 'Submit' }));

        expect(await screen.findByText('Set a Passphrase')).toBeInTheDocument();
        expect(window.localStorage.getItem(WALLET_KEY)).toBeNull();
    }, 40000);
});
