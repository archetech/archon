import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ContextProviders } from '../contexts/ContextProviders';

// #914. See the twin file in apps/react-wallet for the full account: on #912
// both wallets rendered a blank page and every check stayed green, because
// nothing in this repo rendered a component.
//
// This app matters as much as the other one: the crash was in
// packages/wallet-ui, which both wallets mount, and the extension has its own
// provider tree with its own ordering.

const PASSPHRASE = 'render-smoke-test-passphrase';

function mount(children = <div data-testid="child">child</div>) {
    return render(
        <ContextProviders isBrowser={false}>
            {children}
        </ContextProviders>
    );
}

async function completeSetup() {
    const user = userEvent.setup();

    // Anchored regexes: MUI folds the required marker into the label text, so
    // these read "Passphrase *" and "Confirm Passphrase *".
    await user.type(await screen.findByLabelText(/^Passphrase/), PASSPHRASE);
    await user.type(await screen.findByLabelText(/^Confirm Passphrase/), PASSPHRASE);
    await user.click(screen.getByRole('button', { name: 'Submit' }));
}

describe('browser-extension provider tree', () => {
    it('mounts without throwing', () => {
        expect(() => mount()).not.toThrow();
    });

    it('reaches its first real screen', async () => {
        // Not the children: WalletProvider gates those behind isReady, and a
        // wallet with no stored data is correctly not ready. The passphrase
        // prompt is what a new user actually sees.
        mount();

        expect(await screen.findByText('Set a Passphrase')).toBeInTheDocument();
    });

    it('renders its children once the wallet is ready', async () => {
        // The assertion that covers #912. Mounting alone stops at the modal
        // above, and UIProvider -- the provider that threw -- lives inside that
        // gate, so a test that only mounts never runs the hook that failed.
        mount();

        await completeSetup();

        await waitFor(() => expect(screen.getByTestId('child')).toBeInTheDocument());
    });
});
