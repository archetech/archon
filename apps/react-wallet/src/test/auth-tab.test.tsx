import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AuthTab from '../../../../packages/wallet-ui/src/components/AuthTab';

// The Auth tab holds what a service asks of an identity: to sign in, and to
// grant a client.

const { keymaster, navigation } = vi.hoisted(() => ({
    keymaster: {
        listAssets: vi.fn(), listRevocations: vi.fn(), resolveDID: vi.fn(), resolveAsset: vi.fn(), createResponse: vi.fn(),
        createAsset: vi.fn(), decryptJSON: vi.fn(),
    },
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

    it('shows a grant request that arrives by a link for review, and answers and creates nothing', async () => {
        const REQUEST = 'did:cid:bagaaierarequestrequestrequestrequestrequestrequestrequestre';
        const data = { exampleGrantRequest: { name: 'Example', registries: ['BTC:mainnet'], actions: ['read'] } };

        keymaster.resolveAsset.mockResolvedValue(data);
        keymaster.resolveDID.mockImplementation(async (did: string) => (did === REQUEST
            ? {
                didDocument: { id: REQUEST, controller: 'did:cid:client' }, didDocumentData: data,
                didDocumentRegistration: { type: 'asset' }, didDocumentMetadata: { versionSequence: '1' },
            }
            : { didDocumentData: {}, didDocumentMetadata: {}, didDocumentRegistration: {} }));
        navigation.pendingChallenge = REQUEST;
        render(<AuthTab />);

        const panel = await screen.findByRole('tabpanel', { name: 'Grants' });
        expect(await within(panel).findByRole('button', { name: 'Create Grant' })).toBeTruthy();
        expect(within(panel).getByText('did:cid:client')).toBeTruthy();
        expect(within(panel).getByText('Example')).toBeTruthy();
        expect(within(panel).getByLabelText('read')).toBeTruthy();
        expect(keymaster.createResponse).not.toHaveBeenCalled();
        expect(keymaster.createAsset).not.toHaveBeenCalled();
    });

    it('answers a challenge that arrives by a link as signing in', async () => {
        keymaster.resolveAsset.mockResolvedValue({ challenge: { callback: 'https://example.org/callback' } });
        keymaster.createResponse.mockResolvedValue('did:cid:response');
        keymaster.decryptJSON.mockResolvedValue({ response: { challenge: 'did:cid:arrived', credentials: [], requested: 0, fulfilled: 0, match: true } });
        navigation.pendingChallenge = 'did:cid:arrived';
        render(<AuthTab />);

        await waitFor(() => expect(keymaster.createResponse).toHaveBeenCalledWith('did:cid:arrived', { retries: 10 }));
        expect(screen.getByRole('tab', { name: 'Sign in' }).getAttribute('aria-selected')).toBe('true');
        expect(screen.queryByRole('tabpanel', { name: 'Grants' })).toBeNull();
    });

    it('hands on a grant request typed where a challenge goes', async () => {
        const user = userEvent.setup();
        keymaster.resolveAsset.mockResolvedValue({ exampleGrantRequest: { registries: ['BTC:mainnet'] } });
        render(<AuthTab />);
        await user.type(screen.getByLabelText('Challenge'), 'did:cid:asked');
        await user.click(screen.getByRole('button', { name: 'Respond' }));

        expect(await screen.findByRole('tabpanel', { name: 'Grants' })).toBeTruthy();
        expect(keymaster.createResponse).not.toHaveBeenCalled();
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
