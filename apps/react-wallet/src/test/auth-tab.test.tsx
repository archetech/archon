import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AuthTab from '../../../../packages/wallet-ui/src/components/AuthTab';

// The Auth tab holds what a service asks of an identity: to sign in, and to
// grant a client.

const { keymaster, navigation } = vi.hoisted(() => ({
    keymaster: { listAssets: vi.fn(), listRevocations: vi.fn(), resolveDID: vi.fn(), createResponse: vi.fn() },
    navigation: { pendingChallenge: null as string | null, setPendingChallenge: vi.fn(), dispatchDeepLink: vi.fn(), openView: vi.fn() },
}));
vi.mock('../../../../packages/wallet-ui/src/contexts/WalletProvider', () => ({ useWalletContext: () => ({ keymaster }) }));
vi.mock('../../../../packages/wallet-ui/src/contexts/VariablesProvider', () => ({
    useVariablesContext: () => ({
        currentId: 'Alice', currentDID: 'did:cid:alice', registries: ['hyperswarm', 'BTC:mainnet'], schemaList: [], agentList: [],
    }),
}));
vi.mock('../../../../packages/wallet-ui/src/contexts/SnackbarProvider', () => ({
    useSnackbar: () => ({ setError: vi.fn(), setSuccess: vi.fn() }),
}));
vi.mock('../../../../packages/wallet-ui/src/contexts/WalletNavigation', () => ({ useWalletNavigation: () => navigation }));
vi.mock('../../../../packages/wallet-ui/src/contexts/PlatformCapabilities', () => ({ usePlatformCapabilities: () => ({}) }));

const GRANT = 'did:cid:bagaaieragrantgrantgrantgrantgrantgrantgrantgrantgrantgran';

beforeEach(() => {
    vi.resetAllMocks();
    navigation.pendingChallenge = null;
    keymaster.listRevocations.mockResolvedValue([]);
    keymaster.listAssets.mockResolvedValue([GRANT]);
    keymaster.resolveDID.mockResolvedValue({
        didDocumentData: { exampleGrant: { client: 'did:cid:client', actions: ['read'] } },
        didDocumentMetadata: { versionSequence: '1' },
        didDocumentRegistration: { registry: 'BTC:mainnet' },
    });
});

describe('the Auth tab', () => {
    it('opens on signing in, and has grants beside it', async () => {
        render(<AuthTab />);

        expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toStrictEqual(['Sign in', 'Grants']);
        expect(screen.getByRole('tab', { name: 'Sign in' }).getAttribute('aria-selected')).toBe('true');
        expect(screen.getByRole('tabpanel', { name: 'Sign in' })).toBeTruthy();
        expect(screen.queryByRole('tabpanel', { name: 'Grants' })).toBeNull();
        expect(screen.getByLabelText('Challenge')).toBeTruthy();
        expect(screen.queryByLabelText('Grant link')).toBeNull();
        expect(keymaster.listAssets).not.toHaveBeenCalled();
    });

    it('shows the identity\'s grants under Grants, and keeps what was typed under Sign in', async () => {
        const user = userEvent.setup();
        render(<AuthTab />);
        await user.type(screen.getByLabelText('Challenge'), 'did:cid:challenge');
        await user.click(screen.getByRole('tab', { name: 'Grants' }));

        expect(await screen.findByLabelText('Grant link')).toBeTruthy();
        expect(within(screen.getByRole('tabpanel', { name: 'Grants' })).getByLabelText('Grant link')).toBeTruthy();
        expect(within(await screen.findByTestId('grant')).getByText('example')).toBeTruthy();
        expect(keymaster.listAssets).toHaveBeenCalledWith('Alice');
        // Signing in stays mounted, out of sight.
        expect(screen.getByLabelText('Challenge').closest('[hidden]')).not.toBeNull();

        await user.click(screen.getByRole('tab', { name: 'Sign in' }));
        expect((screen.getByLabelText('Challenge') as HTMLInputElement).value).toBe('did:cid:challenge');
        expect(screen.getByLabelText('Challenge').closest('[hidden]')).toBeNull();
        expect(screen.queryByLabelText('Grant link')).toBeNull();
    });

    it('comes back to signing in when a challenge arrives by a link', async () => {
        const user = userEvent.setup();
        const shown = render(<AuthTab />);
        await user.click(screen.getByRole('tab', { name: 'Grants' }));
        expect(await screen.findByLabelText('Grant link')).toBeTruthy();

        keymaster.resolveDID.mockRejectedValue(new Error('not found'));
        navigation.pendingChallenge = 'did:cid:arrived';
        await act(async () => { shown.rerender(<AuthTab />); });

        expect(screen.getByRole('tab', { name: 'Sign in' }).getAttribute('aria-selected')).toBe('true');
        expect(screen.queryByLabelText('Grant link')).toBeNull();
    });
});
