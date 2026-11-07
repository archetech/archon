import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LightningTab from '../../../../packages/wallet-ui/src/components/LightningTab';

const DID = 'did:cid:alice';

const { keymaster, snackbar } = vi.hoisted(() => ({
    keymaster: {
        getLightningBalance: vi.fn(),
        removeLightning: vi.fn(),
        resolveDID: vi.fn(async () => ({ didDocument: { service: [] } })),
    },
    snackbar: { setError: vi.fn(), setSuccess: vi.fn(), setWarning: vi.fn() },
}));
vi.mock('../../../../packages/wallet-ui/src/contexts/WalletProvider', () => ({ useWalletContext: () => ({ keymaster }) }));
vi.mock('../../../../packages/wallet-ui/src/contexts/VariablesProvider', () => ({
    useVariablesContext: () => ({ currentDID: 'did:cid:alice', agentList: [] }),
}));
vi.mock('../../../../packages/wallet-ui/src/contexts/SnackbarProvider', () => ({ useSnackbar: () => snackbar }));

// A refusal as a client rethrows it, the service's reply body, and as Keymaster itself throws it.
const OVER_HTTP = { error: 'Error: Lightning state present: the wallet holds 1000 sats; use force to discard it' };
const IN_PROCESS = new Error('Lightning state present: the wallet holds 1000 sats; use force to discard it');

async function clickRemove() {
    const user = userEvent.setup();
    render(<LightningTab />);
    await user.click(await screen.findByRole('button', { name: 'Remove Wallet' }));
    return user;
}

describe('removing a Lightning wallet', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        keymaster.getLightningBalance.mockResolvedValue({ balance: 1000 });
    });

    it('removes without asking when Keymaster does not refuse', async () => {
        keymaster.removeLightning.mockResolvedValue(true);

        await clickRemove();

        await waitFor(() => expect(snackbar.setSuccess).toHaveBeenCalledWith('Lightning wallet removed'));
        expect(keymaster.removeLightning).toHaveBeenCalledTimes(1);
        expect(keymaster.removeLightning).toHaveBeenCalledWith(DID, false);
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(await screen.findByRole('button', { name: /set up|create|add/i })).toBeTruthy();
    });

    it.each([['over HTTP', OVER_HTTP], ['in process', IN_PROCESS]])('asks before discarding after a refusal %s, and says why', async (_how, refusal) => {
        keymaster.removeLightning.mockRejectedValueOnce(refusal).mockResolvedValue(true);

        const user = await clickRemove();

        const dialog = await screen.findByRole('dialog');
        expect(dialog.textContent).toContain('the wallet holds 1000 sats.');
        expect(dialog.textContent).not.toContain('use force');
        expect(keymaster.removeLightning).toHaveBeenCalledTimes(1);
        expect(snackbar.setError).not.toHaveBeenCalled();

        await user.click(screen.getByRole('button', { name: 'Discard' }));

        await waitFor(() => expect(keymaster.removeLightning).toHaveBeenLastCalledWith(DID, true));
        await waitFor(() => expect(snackbar.setSuccess).toHaveBeenCalledWith('Lightning wallet removed'));
    });

    it('keeps the wallet when the discard is declined', async () => {
        keymaster.removeLightning.mockRejectedValueOnce(OVER_HTTP);

        const user = await clickRemove();
        await screen.findByRole('dialog');
        await user.click(screen.getByRole('button', { name: 'Keep It' }));

        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(keymaster.removeLightning).toHaveBeenCalledTimes(1);
        expect(snackbar.setSuccess).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: 'Remove Wallet' })).toBeTruthy();
    });

    it('reports any other failure without offering to discard', async () => {
        const failure = new Error('wallet is locked');
        keymaster.removeLightning.mockRejectedValueOnce(failure);

        await clickRemove();

        await waitFor(() => expect(snackbar.setError).toHaveBeenCalledWith(failure));
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('reports a failed discard rather than asking again', async () => {
        const failure = new Error('Lightning state present: unexpected');
        keymaster.removeLightning.mockRejectedValueOnce(OVER_HTTP).mockRejectedValueOnce(failure);

        const user = await clickRemove();
        await screen.findByRole('dialog');
        await user.click(screen.getByRole('button', { name: 'Discard' }));

        await waitFor(() => expect(snackbar.setError).toHaveBeenCalledWith(failure));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });
});
