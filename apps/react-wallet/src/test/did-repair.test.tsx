import { describe, it, expect, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DIDRepairDialog from '../../../../packages/wallet-ui/src/components/DIDRepairDialog';
import type { CheckDIDResult } from '@didcid/clients/keymaster-types';

const did = 'did:cid:agent';
const available: CheckDIDResult = {
    did, type: 'agent', confirmed: true, canRepair: true,
    issues: [{ code: 'missing-operation-permission', message: 'Authorize the operation-signing method in capabilityInvocation.' }],
    changes: { didDocument: { id: did, capabilityInvocation: ['#key-1'] } },
};
const healthy: CheckDIDResult = { ...available, issues: [], changes: null, canRepair: false };
function mount(report = available) {
    const checkDID = vi.fn().mockResolvedValue(report);
    const repairDID = vi.fn().mockResolvedValue({ ...healthy, submitted: true, confirmed: false });
    const onRepaired = vi.fn();
    render(<DIDRepairDialog did="Alice" checkDID={checkDID} repairDID={repairDID} onClose={vi.fn()} onRepaired={onRepaired} />);
    return { checkDID, repairDID, onRepaired, user: userEvent.setup() };
}

describe('shared DID repair dialog', () => {
    it('shows proposed changes before explicitly repairing the checked canonical DID', async () => {
        const { repairDID, onRepaired, user } = mount();
        await screen.findByText('Proposed changes');
        expect(screen.getByText(/"capabilityInvocation"/)).toBeInTheDocument();
        expect(repairDID).not.toHaveBeenCalled();
        await user.click(screen.getByRole('button', { name: 'Repair DID' }));
        await screen.findByText('Repair accepted; awaiting confirmation.');
        expect(repairDID).toHaveBeenCalledExactlyOnceWith(did);
        expect(onRepaired).toHaveBeenCalledExactlyOnceWith(did);
        expect(screen.getByRole('button', { name: 'Repair DID' })).toBeDisabled();
    });

    it.each([true, false])('reports accepted/confirmed and no-op outcomes (submitted=%s)', async submitted => {
        const { repairDID, user } = mount();
        repairDID.mockResolvedValue({ ...healthy, submitted });
        await screen.findByText('Proposed changes');
        await user.click(screen.getByRole('button', { name: 'Repair DID' }));
        await screen.findByText(submitted ? 'Repair accepted and confirmed.' : 'No repair was submitted.');
    });

    it('preserves acceptance status if refreshing the background viewer fails', async () => {
        const { onRepaired, user } = mount();
        onRepaired.mockRejectedValue(new Error('offline'));
        await screen.findByText('Proposed changes');
        await user.click(screen.getByRole('button', { name: 'Repair DID' }));
        await screen.findByText('Repair accepted, but the background document view could not be refreshed.');
        expect(screen.getByText('Repair accepted; awaiting confirmation.')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Repair DID' })).toBeDisabled();
    });

    it('reports no known problems without offering a repair', async () => {
        const { repairDID } = mount(healthy);
        await screen.findByText('No known problems found.');
        expect(screen.getByRole('button', { name: 'Repair DID' })).toBeDisabled();
        expect(repairDID).not.toHaveBeenCalled();
    });

    it.each(['Deactivated DIDs cannot be repaired.', 'The current operation-signing key is unavailable in this wallet.'])(
        'explains unavailable repair: %s', async reason => {
            const { repairDID } = mount({ ...available, canRepair: false, changes: null, reason });
            await screen.findByText(reason);
            expect(screen.getByRole('button', { name: 'Repair DID' })).toBeDisabled();
            expect(repairDID).not.toHaveBeenCalled();
        },
    );

    it('checks an asset controller separately and never repairs the asset implicitly', async () => {
        const { checkDID, repairDID, onRepaired, user } = mount({ ...healthy, did: 'did:cid:asset', type: 'asset',
            issues: [{ code: 'controller-needs-repair', message: 'Check and repair the controlling agent separately.', relatedDid: did }] });
        await screen.findByText('Check and repair the controlling agent separately.');
        expect(screen.getByRole('button', { name: 'Repair DID' })).toBeDisabled();
        checkDID.mockResolvedValue(available);
        await user.click(screen.getByRole('button', { name: 'Check controller DID' }));
        await screen.findByText('Proposed changes');
        expect(checkDID).toHaveBeenLastCalledWith(did);
        expect(repairDID).not.toHaveBeenCalled();
        await user.click(screen.getByRole('button', { name: 'Repair DID' }));
        expect(repairDID).toHaveBeenCalledExactlyOnceWith(did);
        expect(onRepaired).toHaveBeenCalledExactlyOnceWith(did);
    });

    it('ignores inspection results after the target is edited', async () => {
        let resolve!: (report: CheckDIDResult) => void;
        const checkDID = vi.fn().mockImplementationOnce(() => new Promise<CheckDIDResult>(done => { resolve = done; })).mockResolvedValue(healthy);
        const repairDID = vi.fn();
        render(<DIDRepairDialog did="Alice" checkDID={checkDID} repairDID={repairDID} onClose={vi.fn()} />);
        const user = userEvent.setup();
        await user.clear(screen.getByLabelText('DID or alias'));
        await user.type(screen.getByLabelText('DID or alias'), 'Bob');
        await act(async () => resolve(available));
        expect(screen.queryByText('Proposed changes')).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Repair DID' })).toBeDisabled();
        await user.click(screen.getByRole('button', { name: 'Check DID' }));
        await screen.findByText('No known problems found.');
        expect(checkDID).toHaveBeenLastCalledWith('Bob');
    });

    it('shows lookup errors and requires another check after a failed repair', async () => {
        const { checkDID, repairDID, user } = mount();
        await screen.findByText('Proposed changes');
        repairDID.mockRejectedValue(new Error('Invalid predecessor'));
        await user.click(screen.getByRole('button', { name: 'Repair DID' }));
        await screen.findByText('Invalid predecessor');
        expect(screen.getByRole('button', { name: 'Repair DID' })).toBeDisabled();
        checkDID.mockRejectedValue(new Error('DID not found'));
        await user.click(screen.getByRole('button', { name: 'Check DID' }));
        await screen.findByText('DID not found');
    });
});
