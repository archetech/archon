import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LightningTab from '../../../../packages/wallet-ui/src/components/LightningTab';

const { keymaster } = vi.hoisted(() => ({
    keymaster: {
        getLightningBalance: vi.fn(async () => ({ balance: 0 })),
        createLightningInvoice: vi.fn(async () => ({ paymentRequest: 'lnbc1invoice' })),
        resolveDID: vi.fn(async () => ({ didDocument: { service: [] } })),
    },
}));
vi.mock('../../../../packages/wallet-ui/src/contexts/WalletProvider', () => ({ useWalletContext: () => ({ keymaster }) }));
vi.mock('../../../../packages/wallet-ui/src/contexts/VariablesProvider', () => ({
    useVariablesContext: () => ({ currentDID: 'did:cid:alice', agentList: [] }),
}));
vi.mock('../../../../packages/wallet-ui/src/contexts/SnackbarProvider', () => ({
    useSnackbar: () => ({ setError: vi.fn(), setSuccess: vi.fn(), setWarning: vi.fn() }),
}));

describe('Lightning invoice field', () => {
    it('selects the invoice when it is clicked, and copes with a click on its label', async () => {
        const user = userEvent.setup();
        render(<LightningTab />);
        await user.click(await screen.findByRole('tab', { name: 'Receive' }));
        await user.type(screen.getByLabelText(/^Amount/), '50');
        await user.click(screen.getByRole('button', { name: 'Create Invoice' }));
        const field = await screen.findByLabelText<HTMLTextAreaElement>(/^BOLT11 Invoice/);

        const errors: unknown[] = [];
        const onError = (event: ErrorEvent) => { errors.push(event.error); };
        window.addEventListener('error', onError);
        await user.click(document.querySelector(`label[for="${field.id}"]`) as HTMLElement);
        await user.click(field);
        window.removeEventListener('error', onError);

        expect(errors).toEqual([]);
        expect(field.value.slice(field.selectionStart, field.selectionEnd)).toBe('lnbc1invoice');
    });
});
