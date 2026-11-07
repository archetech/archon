import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentType } from 'react';
import KeymasterUI from '../../../../packages/keymaster-ui/src/KeymasterUI.jsx';

// Not under test, and it imports a wallet-ui subpath this app has no alias for.
vi.mock('../../../../packages/keymaster-ui/src/CashuPanel.jsx', () => ({ default: () => null }));

const DID = 'did:cid:alice';
const REFUSAL = { error: 'Error: Lightning state present: the wallet holds 1000 sats; use force to discard it' };

const removeLightning = vi.fn();

// Everything the client asks for on the way to the Lightning tab, answered blandly.
const known: Record<string, unknown> = {
    getCurrentId: 'Alice',
    listIds: ['Alice'],
    resolveDID: { didDocument: { id: DID, service: [] }, didDocumentMetadata: {}, didDocumentRegistration: { type: 'agent' } },
    getLightningBalance: { balance: 1000 },
    listAliases: {},
    listRegistries: ['local'],
    getNodeCapabilities: { lightning: true },
};
const keymaster = new Proxy({ removeLightning } as Record<string, unknown>, {
    get: (target, property: string) => target[property] ?? (async () => (property in known ? known[property] : [])),
});

async function clickRemove() {
    const user = userEvent.setup();
    const Client = KeymasterUI as unknown as ComponentType<Record<string, unknown>>;
    render(<Client keymaster={keymaster} title="Client" hasLightning />);
    await user.click(await screen.findByRole('tab', { name: 'Lightning' }));
    await user.click(await screen.findByRole('button', { name: 'Remove Wallet' }));
    return user;
}

describe('removing a Lightning wallet from the demo client', () => {
    beforeEach(() => {
        removeLightning.mockReset();
    });

    it('asks before discarding after a refusal, and says why', async () => {
        removeLightning.mockRejectedValueOnce(REFUSAL).mockResolvedValue(true);

        const user = await clickRemove();

        expect((await screen.findByRole('dialog')).textContent).toContain('the wallet holds 1000 sats.');
        expect(removeLightning).toHaveBeenCalledTimes(1);

        await user.click(screen.getByRole('button', { name: 'OK' }));

        await waitFor(() => expect(removeLightning).toHaveBeenLastCalledWith('Alice', true));
        expect(await screen.findByText('Lightning wallet removed')).toBeTruthy();
    });

    it('keeps the wallet when the discard is declined', async () => {
        removeLightning.mockRejectedValueOnce(REFUSAL);

        const user = await clickRemove();
        await screen.findByRole('dialog');
        await user.click(screen.getByRole('button', { name: 'Cancel' }));

        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(removeLightning).toHaveBeenCalledTimes(1);
    });
});
