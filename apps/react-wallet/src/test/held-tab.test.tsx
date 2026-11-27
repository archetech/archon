import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import HeldTab from '../../../../packages/wallet-ui/src/components/HeldTab';

// The Held tab accepts a credential by its DID and lists the credentials the
// identity holds, each to show, publish, reveal, unpublish or remove.

const { keymaster, wallet, variables, walletData, navigation, platform, setError, setWarning } = vi.hoisted(() => {
    const keymaster = {
        acceptCredential: vi.fn(), getCredential: vi.fn(), publishCredential: vi.fn(),
        unpublishCredential: vi.fn(), removeCredential: vi.fn(),
    };

    return {
        keymaster,
        wallet: { keymaster: keymaster as typeof keymaster | null },
        variables: {
            heldList: [] as string[],
            manifest: undefined as Record<string, unknown> | undefined,
        },
        walletData: { updateManifest: vi.fn(), refreshHeld: vi.fn(), handleCopyDID: vi.fn() },
        navigation: {
            openView: vi.fn(),
            pendingHeldDID: null as string | null,
            setPendingHeldDID: vi.fn() as ReturnType<typeof vi.fn> | undefined,
        },
        platform: {
            scanQr: undefined as ReturnType<typeof vi.fn> | undefined,
            requestRefresh: undefined as ReturnType<typeof vi.fn> | undefined,
        },
        setError: vi.fn(),
        setWarning: vi.fn(),
    };
});
vi.mock('../../../../packages/wallet-ui/src/contexts/WalletProvider', () => ({ useWalletContext: () => wallet }));
vi.mock('../../../../packages/wallet-ui/src/contexts/VariablesProvider', () => ({ useVariablesContext: () => variables }));
vi.mock('../../../../packages/wallet-ui/src/contexts/SnackbarProvider', () => ({
    useSnackbar: () => ({ setError, setWarning }),
}));
vi.mock('../../../../packages/wallet-ui/src/contexts/WalletNavigation', () => ({ useWalletNavigation: () => navigation }));
vi.mock('../../../../packages/wallet-ui/src/contexts/PlatformCapabilities', () => ({ usePlatformCapabilities: () => platform }));
vi.mock('../../../../packages/wallet-ui/src/hooks/useWalletData', () => ({ useWalletData: () => walletData }));
// The viewer is its own component with its own tests; the tab only places it.
vi.mock('../../../../packages/wallet-ui/src/components/JsonViewer', () => ({ default: () => null }));

const DEGREE = 'did:cid:degree';
const LICENCE = 'did:cid:licence';
const PASSPORT = 'did:cid:passport';
const OFFERED = 'did:cid:offered';
const credential = { type: ['VerifiableCredential'], credentialSubject: { id: 'did:cid:alice' } };

beforeEach(() => {
    vi.resetAllMocks();
    wallet.keymaster = keymaster;
    variables.heldList = [DEGREE];
    variables.manifest = {};
    navigation.pendingHeldDID = null;
    navigation.setPendingHeldDID = vi.fn();
    platform.scanQr = undefined;
    platform.requestRefresh = vi.fn();
    keymaster.getCredential.mockResolvedValue(credential);
});

const didField = () => screen.getByLabelText('Accept Credential DID');
// The first of each is for the DID typed; the held credentials follow in order.
const button = (name: string, index = 0) => screen.getAllByRole('button', { name })[index];

async function openMenu(user: UserEvent, row = 0) {
    await user.click(screen.getAllByRole('button', { name: 'Manage' })[row]);
    return screen.findByRole('menu');
}

async function choose(user: UserEvent, action: string, row = 0) {
    const menu = await openMenu(user, row);
    await user.click(within(menu).getByRole('menuitem', { name: action }));
}

const shownAs = (did: string, contents?: unknown) => ({ did, contents, tab: 'credentials', subTab: 'held' });

describe('a credential DID typed in', () => {
    it('offers its actions only once a DID is typed', async () => {
        const user = userEvent.setup({ delay: null });
        variables.heldList = [];
        render(<HeldTab />);

        for (const name of ['Resolve', 'Decrypt', 'Accept', 'Clear']) {
            expect(button(name)).toBeDisabled();
        }

        await user.type(didField(), OFFERED);

        for (const name of ['Resolve', 'Decrypt', 'Accept', 'Clear']) {
            expect(button(name)).toBeEnabled();
        }
    });

    it('opens the DID in the viewer', async () => {
        const user = userEvent.setup({ delay: null });
        render(<HeldTab />);

        await user.type(didField(), OFFERED);
        await user.click(button('Resolve'));

        expect(navigation.openView).toHaveBeenCalledWith(shownAs(OFFERED));
        expect(keymaster.getCredential).not.toHaveBeenCalled();
    });

    it('opens the decrypted credential in the viewer', async () => {
        const user = userEvent.setup({ delay: null });
        render(<HeldTab />);

        await user.type(didField(), OFFERED);
        await user.click(button('Decrypt'));

        await waitFor(() => expect(navigation.openView).toHaveBeenCalledWith(shownAs(OFFERED, credential)));
        expect(keymaster.getCredential).toHaveBeenCalledWith(OFFERED);
    });

    it('reports a credential that cannot be decrypted', async () => {
        const user = userEvent.setup({ delay: null });
        const failure = new Error('not the subject');
        keymaster.getCredential.mockRejectedValue(failure);
        render(<HeldTab />);

        await user.type(didField(), OFFERED);
        await user.click(button('Decrypt'));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(navigation.openView).not.toHaveBeenCalled();
    });

    it('accepts the credential, reads the held list again and empties the field', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.acceptCredential.mockResolvedValue(true);
        render(<HeldTab />);

        await user.type(didField(), OFFERED);
        await user.click(button('Accept'));

        await waitFor(() => expect(didField()).toHaveValue(''));
        expect(keymaster.acceptCredential).toHaveBeenCalledWith(OFFERED);
        expect(walletData.refreshHeld).toHaveBeenCalled();
        expect(setWarning).not.toHaveBeenCalled();
        expect(setError).not.toHaveBeenCalled();
    });

    it('warns when the credential is not accepted and keeps the DID', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.acceptCredential.mockResolvedValue(false);
        render(<HeldTab />);

        await user.type(didField(), OFFERED);
        await user.click(button('Accept'));

        await waitFor(() => expect(setWarning).toHaveBeenCalledWith('Credential not accepted'));
        expect(walletData.refreshHeld).not.toHaveBeenCalled();
        expect(didField()).toHaveValue(OFFERED);
    });

    it('reports a failure to accept', async () => {
        const user = userEvent.setup({ delay: null });
        const failure = new Error('unknown DID');
        keymaster.acceptCredential.mockRejectedValue(failure);
        render(<HeldTab />);

        await user.type(didField(), OFFERED);
        await user.click(button('Accept'));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(walletData.refreshHeld).not.toHaveBeenCalled();
        expect(didField()).toHaveValue(OFFERED);
    });

    it('empties the field on Clear', async () => {
        const user = userEvent.setup({ delay: null });
        render(<HeldTab />);

        await user.type(didField(), OFFERED);
        await user.click(button('Clear'));

        expect(didField()).toHaveValue('');
        expect(button('Accept')).toBeDisabled();
    });

    it('takes a DID the wallet was opened with, once', () => {
        navigation.pendingHeldDID = OFFERED;
        render(<HeldTab />);

        expect(didField()).toHaveValue(OFFERED);
        expect(navigation.setPendingHeldDID).toHaveBeenCalledWith(null);
    });

    it('takes such a DID from a host that cannot clear it', () => {
        navigation.pendingHeldDID = OFFERED;
        navigation.setPendingHeldDID = undefined;
        render(<HeldTab />);

        expect(didField()).toHaveValue(OFFERED);
    });
});

describe('scanning a credential DID', () => {
    const scanButton = () => within(screen.getByLabelText('Scan QR')).getByRole('button');

    it('is not offered where there is no camera', () => {
        render(<HeldTab />);

        expect(screen.queryByLabelText('Scan QR')).toBeNull();
    });

    it('puts the scanned DID in the field', async () => {
        const user = userEvent.setup({ delay: null });
        platform.scanQr = vi.fn().mockResolvedValue(OFFERED);
        render(<HeldTab />);

        await user.click(scanButton());

        await waitFor(() => expect(didField()).toHaveValue(OFFERED));
        expect(setError).not.toHaveBeenCalled();
    });

    it('reports a scan that read nothing', async () => {
        const user = userEvent.setup({ delay: null });
        platform.scanQr = vi.fn().mockResolvedValue(null);
        render(<HeldTab />);

        await user.click(scanButton());

        await waitFor(() => expect(setError).toHaveBeenCalledWith('Failed to scan QR code'));
        expect(didField()).toHaveValue('');
    });
});

describe('the credentials held', () => {
    it('says so when there are none', () => {
        variables.heldList = [];
        render(<HeldTab />);

        expect(screen.getByText('No credentials held')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Manage' })).toBeNull();
    });

    it('lists each credential with its actions', () => {
        variables.heldList = [DEGREE, LICENCE];
        render(<HeldTab />);

        expect(screen.getByText(DEGREE)).toBeInTheDocument();
        expect(screen.getByText(LICENCE)).toBeInTheDocument();
        expect(screen.queryByText('No credentials held')).toBeNull();
        expect(screen.getAllByRole('button', { name: 'Manage' })).toHaveLength(2);
    });

    it('opens a credential in the viewer', async () => {
        const user = userEvent.setup({ delay: null });
        variables.heldList = [DEGREE, LICENCE];
        render(<HeldTab />);

        await user.click(button('Resolve', 2));

        expect(navigation.openView).toHaveBeenCalledWith(shownAs(LICENCE));
    });

    it('opens a decrypted credential in the viewer', async () => {
        const user = userEvent.setup({ delay: null });
        render(<HeldTab />);

        await choose(user, 'Decrypt');

        await waitFor(() => expect(navigation.openView).toHaveBeenCalledWith(shownAs(DEGREE, credential)));
        expect(keymaster.getCredential).toHaveBeenCalledWith(DEGREE);
    });

    it('offers what a credential that is not published allows', async () => {
        const user = userEvent.setup({ delay: null });
        render(<HeldTab />);

        const menu = await openMenu(user);

        expect(within(menu).getByRole('menuitem', { name: 'Publish' })).not.toHaveAttribute('aria-disabled');
        expect(within(menu).getByRole('menuitem', { name: 'Reveal' })).not.toHaveAttribute('aria-disabled');
        expect(within(menu).getByRole('menuitem', { name: 'Unpublish' })).toHaveAttribute('aria-disabled', 'true');
        expect(within(menu).getByRole('menuitem', { name: 'Remove' })).not.toHaveAttribute('aria-disabled');
    });

    it('treats every credential as not published before the manifest is read', async () => {
        const user = userEvent.setup({ delay: null });
        variables.manifest = undefined;
        render(<HeldTab />);

        const menu = await openMenu(user);

        expect(within(menu).getByRole('menuitem', { name: 'Publish' })).not.toHaveAttribute('aria-disabled');
        expect(within(menu).getByRole('menuitem', { name: 'Reveal' })).not.toHaveAttribute('aria-disabled');
        expect(within(menu).getByRole('menuitem', { name: 'Unpublish' })).toHaveAttribute('aria-disabled', 'true');
        expect(within(menu).getByRole('menuitem', { name: 'Remove' })).not.toHaveAttribute('aria-disabled');
    });

    it('offers what a credential published without its contents allows', async () => {
        const user = userEvent.setup({ delay: null });
        variables.heldList = [DEGREE, LICENCE];
        variables.manifest = { [LICENCE]: { credential: null } };
        render(<HeldTab />);

        const menu = await openMenu(user, 1);

        expect(within(menu).getByRole('menuitem', { name: 'Publish' })).toHaveAttribute('aria-disabled', 'true');
        expect(within(menu).getByRole('menuitem', { name: 'Reveal' })).not.toHaveAttribute('aria-disabled');
        expect(within(menu).getByRole('menuitem', { name: 'Unpublish' })).not.toHaveAttribute('aria-disabled');
        // A published credential has to be unpublished before it is removed.
        expect(within(menu).getByRole('menuitem', { name: 'Remove' })).toHaveAttribute('aria-disabled', 'true');
    });

    it('offers what a revealed credential allows', async () => {
        const user = userEvent.setup({ delay: null });
        variables.heldList = [DEGREE, PASSPORT];
        variables.manifest = { [PASSPORT]: { credential } };
        render(<HeldTab />);

        const menu = await openMenu(user, 1);

        expect(within(menu).getByRole('menuitem', { name: 'Publish' })).not.toHaveAttribute('aria-disabled');
        expect(within(menu).getByRole('menuitem', { name: 'Reveal' })).toHaveAttribute('aria-disabled', 'true');
        expect(within(menu).getByRole('menuitem', { name: 'Unpublish' })).not.toHaveAttribute('aria-disabled');
        expect(within(menu).getByRole('menuitem', { name: 'Remove' })).toHaveAttribute('aria-disabled', 'true');
    });

    it('publishes a credential without its contents and shows it', async () => {
        const user = userEvent.setup({ delay: null });
        render(<HeldTab />);

        await choose(user, 'Publish');

        await waitFor(() => expect(navigation.openView).toHaveBeenCalledWith(shownAs(DEGREE, credential)));
        expect(keymaster.publishCredential).toHaveBeenCalledWith(DEGREE, { reveal: false });
        expect(walletData.updateManifest).toHaveBeenCalled();
        expect(setError).not.toHaveBeenCalled();
    });

    it('reveals a credential and shows it', async () => {
        const user = userEvent.setup({ delay: null });
        render(<HeldTab />);

        await choose(user, 'Reveal');

        await waitFor(() => expect(navigation.openView).toHaveBeenCalledWith(shownAs(DEGREE, credential)));
        expect(keymaster.publishCredential).toHaveBeenCalledWith(DEGREE, { reveal: true });
        expect(walletData.updateManifest).toHaveBeenCalled();
    });

    it('unpublishes a credential and shows it', async () => {
        const user = userEvent.setup({ delay: null });
        variables.manifest = { [DEGREE]: { credential: null } };
        render(<HeldTab />);

        await choose(user, 'Unpublish');

        await waitFor(() => expect(navigation.openView).toHaveBeenCalledWith(shownAs(DEGREE, credential)));
        expect(keymaster.unpublishCredential).toHaveBeenCalledWith(DEGREE);
        expect(walletData.updateManifest).toHaveBeenCalled();
    });

    it.each([
        ['Publish', 'publishCredential'],
        ['Reveal', 'publishCredential'],
        ['Unpublish', 'unpublishCredential'],
    ] as const)('reports a failure to %s', async (action, method) => {
        const user = userEvent.setup({ delay: null });
        const failure = new Error('registry unavailable');
        variables.manifest = action === 'Unpublish' ? { [DEGREE]: { credential: null } } : {};
        keymaster[method].mockRejectedValue(failure);
        render(<HeldTab />);

        await choose(user, action);

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(walletData.updateManifest).not.toHaveBeenCalled();
        expect(navigation.openView).not.toHaveBeenCalled();
    });
});

describe('removing a held credential', () => {
    it('removes it once the removal is confirmed', async () => {
        const user = userEvent.setup({ delay: null });
        variables.heldList = [DEGREE, LICENCE];
        render(<HeldTab />);

        await choose(user, 'Remove', 1);
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByText('Are you sure you want to remove the credential?')).toBeInTheDocument();
        expect(keymaster.removeCredential).not.toHaveBeenCalled();

        await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));

        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(keymaster.removeCredential).toHaveBeenCalledWith(LICENCE);
        expect(walletData.refreshHeld).toHaveBeenCalled();
        expect(platform.requestRefresh).toHaveBeenCalled();
        expect(setError).not.toHaveBeenCalled();
    });

    it('removes it on a host that has nothing else to refresh', async () => {
        const user = userEvent.setup({ delay: null });
        platform.requestRefresh = undefined;
        render(<HeldTab />);

        await choose(user, 'Remove');
        await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Confirm' }));

        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(keymaster.removeCredential).toHaveBeenCalledWith(DEGREE);
        expect(walletData.refreshHeld).toHaveBeenCalled();
        expect(setError).not.toHaveBeenCalled();
    });

    it('keeps it when the removal is cancelled', async () => {
        const user = userEvent.setup({ delay: null });
        render(<HeldTab />);

        await choose(user, 'Remove');
        await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));

        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(keymaster.removeCredential).not.toHaveBeenCalled();
    });

    it('reports a failure to remove and closes the question', async () => {
        const user = userEvent.setup({ delay: null });
        const failure = new Error('not held');
        keymaster.removeCredential.mockRejectedValue(failure);
        render(<HeldTab />);

        await choose(user, 'Remove');
        await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Confirm' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(walletData.refreshHeld).not.toHaveBeenCalled();
        expect(platform.requestRefresh).not.toHaveBeenCalled();
    });
});

describe('a wallet with no keymaster', () => {
    it('asks nothing of it and reports nothing', async () => {
        const user = userEvent.setup({ delay: null });
        wallet.keymaster = null;
        variables.manifest = { [DEGREE]: { credential: null } };
        render(<HeldTab />);

        await user.type(didField(), OFFERED);
        await user.click(button('Decrypt'));
        await user.click(button('Accept'));
        await choose(user, 'Reveal');
        await choose(user, 'Unpublish');

        variables.manifest = {};
        await user.click(button('Clear'));
        await choose(user, 'Publish');
        await choose(user, 'Remove');
        const dialog = await screen.findByRole('dialog');
        await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

        for (const method of Object.values(keymaster)) {
            expect(method).not.toHaveBeenCalled();
        }
        expect(walletData.refreshHeld).not.toHaveBeenCalled();
        expect(walletData.updateManifest).not.toHaveBeenCalled();
        expect(navigation.openView).not.toHaveBeenCalled();
        expect(setError).not.toHaveBeenCalled();
        expect(setWarning).not.toHaveBeenCalled();
    });
});
