import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import JsonViewer from '../../../../packages/wallet-ui/src/components/JsonViewer';

const { keymaster, navigation, setError } = vi.hoisted(() => ({
    keymaster: { checkDID: vi.fn(), repairDID: vi.fn(), resolveDID: vi.fn() },
    navigation: { openView: vi.fn(), pendingView: null, clearPendingView: vi.fn() },
    setError: vi.fn(),
}));
vi.mock('../../../../packages/wallet-ui/src/contexts/WalletProvider', () => ({ useWalletContext: () => ({ keymaster }) }));
vi.mock('../../../../packages/wallet-ui/src/contexts/WalletNavigation', () => ({ useWalletNavigation: () => navigation }));
vi.mock('../../../../packages/wallet-ui/src/contexts/SnackbarProvider', () => ({ useSnackbar: () => ({ setError }) }));

const repairedDid = 'did:cid:repaired';
const repairable = {
    did: repairedDid, confirmed: true, canRepair: true,
    issues: [{ code: 'missing-operation-permission', message: 'Missing permission.' }],
    changes: { didDocument: { id: repairedDid, capabilityInvocation: ['#key-1'] } },
};

beforeEach(() => {
    vi.resetAllMocks();
    keymaster.checkDID.mockResolvedValue(repairable);
    keymaster.repairDID.mockResolvedValue({ ...repairable, issues: [], changes: null, canRepair: false, submitted: true });
    keymaster.resolveDID.mockResolvedValue({
        didDocument: { id: repairedDid }, didDocumentData: {}, didDocumentMetadata: { version: 2 },
    });
});

describe('viewer repair refresh', () => {
    it.each(['alias', 'edited target', 'controller'])('loads the canonical repaired DID after checking an %s', async mode => {
        if (mode === 'controller') {
            keymaster.checkDID.mockResolvedValueOnce({
                ...repairable, did: 'did:cid:asset', canRepair: false, changes: null,
                issues: [{ code: 'controller-needs-repair', message: 'Check controller.', relatedDid: repairedDid }],
            });
        }
        const user = userEvent.setup();
        render(<JsonViewer browserTab="viewer" showResolveField />);
        await user.type(screen.getByLabelText('Resolve DID', { selector: 'input' }), 'friend');
        await user.click(screen.getByRole('button', { name: 'Repair...' }));
        if (mode === 'controller') {
            await user.click(await screen.findByRole('button', { name: 'Check controller DID' }));
        } else if (mode === 'edited target') {
            await screen.findByText('Proposed changes');
            await user.clear(screen.getByLabelText('DID or alias'));
            await user.type(screen.getByLabelText('DID or alias'), 'another');
            await user.click(screen.getByRole('button', { name: 'Check DID' }));
        }
        await screen.findByText('Proposed changes');
        await user.click(screen.getByRole('button', { name: 'Repair DID' }));
        await waitFor(() => expect(keymaster.resolveDID).toHaveBeenCalledExactlyOnceWith(repairedDid));
        expect(screen.getByLabelText('Resolve DID', { selector: 'input' })).toHaveValue(repairedDid);
        expect(setError).not.toHaveBeenCalled();
    });
});
