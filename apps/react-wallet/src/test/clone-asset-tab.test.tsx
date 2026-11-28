import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CloneAssetTab from '../../../../packages/wallet-ui/src/components/CloneAssetTab';

// The Clone tab makes a copy of an asset under a new alias, on a chosen registry.

const { keymaster, wallet, variables, refreshAliases, setError } = vi.hoisted(() => {
    const keymaster = { cloneAsset: vi.fn() };

    return {
        keymaster,
        wallet: { keymaster: keymaster as typeof keymaster | null },
        variables: { registries: [] as string[] },
        refreshAliases: vi.fn(),
        setError: vi.fn(),
    };
});
vi.mock('../../../../packages/wallet-ui/src/contexts/WalletProvider', () => ({ useWalletContext: () => wallet }));
vi.mock('../../../../packages/wallet-ui/src/contexts/VariablesProvider', () => ({ useVariablesContext: () => variables }));
vi.mock('../../../../packages/wallet-ui/src/contexts/SnackbarProvider', () => ({ useSnackbar: () => ({ setError }) }));
vi.mock('../../../../packages/wallet-ui/src/hooks/useWalletData', () => ({ useWalletData: () => ({ refreshAliases }) }));

const ASSET = 'did:cid:asset';

beforeEach(() => {
    vi.resetAllMocks();
    wallet.keymaster = keymaster;
    variables.registries = ['hyperswarm', 'BTC:mainnet'];
    // cloneAsset answers with the DID of the copy.
    keymaster.cloneAsset.mockResolvedValue('did:cid:copy');
});

const nameField = () => screen.getByLabelText('Asset Name');
const didField = () => screen.getByLabelText('Asset DID');
const cloneButton = () => screen.getByRole('button', { name: 'Clone Asset' });

describe('cloning an asset', () => {
    it('offers Clone only once a name and a DID are given', async () => {
        const user = userEvent.setup({ delay: null });
        render(<CloneAssetTab />);

        expect(cloneButton()).toBeDisabled();

        await user.type(nameField(), 'copy');
        expect(cloneButton()).toBeDisabled();

        await user.type(didField(), ASSET);
        expect(cloneButton()).toBeEnabled();

        await user.clear(nameField());
        expect(cloneButton()).toBeDisabled();
    });

    it('does not offer Clone for a name of only spaces', async () => {
        const user = userEvent.setup({ delay: null });
        render(<CloneAssetTab />);

        await user.type(nameField(), '   ');
        await user.type(didField(), ASSET);
        expect(cloneButton()).toBeDisabled();
    });

    it('clones on hyperswarm unless another registry is chosen, then empties the form', async () => {
        const user = userEvent.setup({ delay: null });
        render(<CloneAssetTab />);

        await user.type(nameField(), 'copy');
        await user.type(didField(), ASSET);
        await user.click(cloneButton());

        await waitFor(() => expect(refreshAliases).toHaveBeenCalledTimes(1));
        expect(keymaster.cloneAsset).toHaveBeenCalledWith(ASSET, { alias: 'copy', registry: 'hyperswarm' });
        await waitFor(() => expect(nameField()).toHaveValue(''));
        expect(didField()).toHaveValue('');
        expect(cloneButton()).toBeDisabled();
        expect(setError).not.toHaveBeenCalled();
    });

    it('clones on the registry chosen', async () => {
        const user = userEvent.setup({ delay: null });
        render(<CloneAssetTab />);

        await user.type(nameField(), 'copy');
        await user.type(didField(), ASSET);
        await user.click(screen.getByRole('combobox'));
        await user.click(await screen.findByRole('option', { name: 'BTC:mainnet' }));
        await user.click(cloneButton());

        await waitFor(() =>
            expect(keymaster.cloneAsset).toHaveBeenCalledWith(ASSET, { alias: 'copy', registry: 'BTC:mainnet' }));
    });

    it('reports a clone that fails and keeps what was typed', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.cloneAsset.mockRejectedValue(new Error('Invalid parameter: id'));
        render(<CloneAssetTab />);

        await user.type(nameField(), 'copy');
        await user.type(didField(), 'did:cid:agent');
        await user.click(cloneButton());

        await waitFor(() => expect(setError).toHaveBeenCalledWith('Only assets can be cloned'));
        expect(refreshAliases).not.toHaveBeenCalled();
        expect(nameField()).toHaveValue('copy');
        expect(didField()).toHaveValue('did:cid:agent');
    });

    it('does nothing while the wallet has no keymaster', async () => {
        const user = userEvent.setup({ delay: null });
        wallet.keymaster = null;
        render(<CloneAssetTab />);

        await user.type(nameField(), 'copy');
        await user.type(didField(), ASSET);
        await user.click(cloneButton());

        expect(keymaster.cloneAsset).not.toHaveBeenCalled();
        expect(refreshAliases).not.toHaveBeenCalled();
        expect(setError).not.toHaveBeenCalled();
        expect(nameField()).toHaveValue('copy');
    });
});
