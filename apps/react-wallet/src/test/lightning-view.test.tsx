import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LightningNotConfiguredError } from '@didcid/common/errors';
import LightningTab from '../../../../packages/wallet-ui/src/components/LightningTab';

const { keymaster, identity, notify } = vi.hoisted(() => ({
    keymaster: {
        addLightning: vi.fn(), removeLightning: vi.fn(), getLightningBalance: vi.fn(), createLightningInvoice: vi.fn(),
        payLightningInvoice: vi.fn(), checkLightningPayment: vi.fn(), decodeLightningInvoice: vi.fn(),
        publishLightning: vi.fn(), unpublishLightning: vi.fn(), zapLightning: vi.fn(), getLightningPayments: vi.fn(),
        resolveDID: vi.fn(),
    },
    identity: { current: 'Alice' },
    notify: { setError: vi.fn(), setSuccess: vi.fn(), setWarning: vi.fn() },
}));
vi.mock('../../../../packages/wallet-ui/src/contexts/WalletProvider', () => ({ useWalletContext: () => ({ keymaster }) }));
vi.mock('../../../../packages/wallet-ui/src/contexts/VariablesProvider', () => ({
    useVariablesContext: () => ({ currentId: identity.current, currentDID: `did:cid:${identity.current}`, agentList: [] }),
}));
vi.mock('../../../../packages/wallet-ui/src/contexts/SnackbarProvider', () => ({ useSnackbar: () => notify }));

const INVOICE_A = 'lnbcA';
const INVOICE_B = 'lnbcB';
const details = { amount: '5 sats', payment_hash: 'hashA' };

function deferred<T = unknown>() {
    let finish!: (value: T) => void;
    let fail!: (reason: unknown) => void;
    const promise = new Promise<T>((settle, reject) => { finish = settle; fail = reject; });
    return { promise, finish, fail };
}

async function openTab(name: string) {
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name }));
    return user;
}

function enterInvoice(value: string) {
    fireEvent.change(screen.getByLabelText(/^BOLT11 Invoice/), { target: { value } });
}

function moveTo(next: string, rerender: (ui: React.ReactElement) => void) {
    identity.current = next;
    rerender(<LightningTab />);
}

beforeEach(() => {
    vi.resetAllMocks();
    identity.current = 'Alice';
    keymaster.getLightningBalance.mockResolvedValue({ balance: 100 });
    keymaster.resolveDID.mockResolvedValue({ didDocument: { service: [] } });
    keymaster.getLightningPayments.mockResolvedValue([]);
    keymaster.decodeLightningInvoice.mockResolvedValue(details);
    keymaster.payLightningInvoice.mockResolvedValue({ paymentHash: 'hashA' });
    keymaster.checkLightningPayment.mockResolvedValue({ paid: true, paymentHash: 'hashA' });
});

describe('Lightning view: paying what was reviewed', () => {
    it('shows no details and offers no Pay when a decode returns for an invoice no longer in the field', async () => {
        const slow = deferred();
        keymaster.decodeLightningInvoice.mockReturnValue(slow.promise);
        render(<LightningTab />);
        const user = await openTab('Send');
        enterInvoice(INVOICE_A);
        await user.click(screen.getByRole('button', { name: 'Decode' }));
        enterInvoice(INVOICE_B);
        await act(async () => { slow.finish(details); });

        expect(keymaster.decodeLightningInvoice).toHaveBeenCalledWith(INVOICE_A);
        expect(screen.queryByText('5 sats')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Pay' })).toBeNull();
    });

    it('pays the reviewed invoice, as read', async () => {
        render(<LightningTab />);
        const user = await openTab('Send');
        enterInvoice(`  ${INVOICE_A}\n`);
        await user.click(screen.getByRole('button', { name: 'Decode' }));
        expect(await screen.findByText('5 sats')).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Pay' }));

        await waitFor(() => expect(keymaster.payLightningInvoice).toHaveBeenCalledWith(INVOICE_A, 'Alice'));
        await waitFor(() => expect(notify.setSuccess).toHaveBeenCalledWith('Payment sent successfully'));
        expect(screen.getByLabelText<HTMLTextAreaElement>(/^BOLT11 Invoice/).value).toBe('');
        expect(screen.queryByRole('button', { name: 'Pay' })).toBeNull();
    });

    it('keeps an invoice typed while a payment was finishing', async () => {
        const paying = deferred<{ paymentHash: string }>();
        keymaster.payLightningInvoice.mockReturnValue(paying.promise);
        render(<LightningTab />);
        const user = await openTab('Send');
        enterInvoice(INVOICE_A);
        await user.click(screen.getByRole('button', { name: 'Decode' }));
        await user.click(await screen.findByRole('button', { name: 'Pay' }));
        enterInvoice(INVOICE_B);
        await act(async () => { paying.finish({ paymentHash: 'hashA' }); });

        await waitFor(() => expect(notify.setSuccess).toHaveBeenCalledWith('Payment sent successfully'));
        expect(screen.getByLabelText<HTMLTextAreaElement>(/^BOLT11 Invoice/).value).toBe(INVOICE_B);
        expect(keymaster.payLightningInvoice).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('button', { name: 'Pay' })).toBeNull();
    });

    it('reports an invoice that turns out to be already paid, asking under the reviewed hash and identity', async () => {
        keymaster.payLightningInvoice.mockRejectedValue(new Error('already paid'));
        render(<LightningTab />);
        const user = await openTab('Send');
        enterInvoice(INVOICE_A);
        await user.click(screen.getByRole('button', { name: 'Decode' }));
        await user.click(await screen.findByRole('button', { name: 'Pay' }));

        await waitFor(() => expect(notify.setSuccess).toHaveBeenCalledWith('Invoice was already paid'));
        expect(keymaster.checkLightningPayment).toHaveBeenCalledWith('hashA', 'Alice');
        expect(notify.setError).not.toHaveBeenCalled();
    });
});

describe('Lightning view: one identity at a time', () => {
    it('does not carry a created invoice over to the next identity', async () => {
        keymaster.createLightningInvoice.mockResolvedValue({ paymentRequest: 'lnbcAlice' });
        const { rerender } = render(<LightningTab />);
        const user = await openTab('Receive');
        fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: '50' } });
        await user.click(screen.getByRole('button', { name: 'Create Invoice' }));
        expect(await screen.findByDisplayValue('lnbcAlice')).toBeTruthy();
        expect(keymaster.createLightningInvoice).toHaveBeenCalledWith(50, '', 'Alice');

        moveTo('Bob', rerender);
        expect(screen.queryByDisplayValue('lnbcAlice')).toBeNull();
        await openTab('Receive');
        expect(screen.queryByDisplayValue('lnbcAlice')).toBeNull();
    });

    it('keeps an invoice still being created out of the next identity', async () => {
        const creating = deferred<{ paymentRequest: string }>();
        keymaster.createLightningInvoice.mockReturnValue(creating.promise);
        const { rerender } = render(<LightningTab />);
        const user = await openTab('Receive');
        fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: '50' } });
        await user.click(screen.getByRole('button', { name: 'Create Invoice' }));

        moveTo('Bob', rerender);
        await openTab('Receive');
        await act(async () => { creating.finish({ paymentRequest: 'lnbcAlice' }); });
        expect(screen.queryByDisplayValue('lnbcAlice')).toBeNull();
    });

    it('keeps a slow invoice from the first visit out of a later one by the same identity', async () => {
        const creating = deferred<{ paymentRequest: string }>();
        keymaster.createLightningInvoice.mockReturnValueOnce(creating.promise);
        keymaster.createLightningInvoice.mockResolvedValue({ paymentRequest: 'lnbcNewer' });
        const { rerender } = render(<LightningTab />);
        let user = await openTab('Receive');
        fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: '50' } });
        await user.click(screen.getByRole('button', { name: 'Create Invoice' }));

        moveTo('Bob', rerender);
        moveTo('Alice', rerender);
        user = await openTab('Receive');
        fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: '60' } });
        await user.click(screen.getByRole('button', { name: 'Create Invoice' }));
        expect(await screen.findByDisplayValue('lnbcNewer')).toBeTruthy();

        await act(async () => { creating.finish({ paymentRequest: 'lnbcOlder' }); });
        expect(screen.getByDisplayValue('lnbcNewer')).toBeTruthy();
        expect(screen.queryByDisplayValue('lnbcOlder')).toBeNull();
    });

    it('does not offer Pay to the next identity on the strength of a decode the last one started', async () => {
        const slow = deferred();
        keymaster.decodeLightningInvoice.mockReturnValue(slow.promise);
        const { rerender } = render(<LightningTab />);
        const user = await openTab('Send');
        enterInvoice(INVOICE_A);
        await user.click(screen.getByRole('button', { name: 'Decode' }));

        moveTo('Bob', rerender);
        await openTab('Send');
        enterInvoice(INVOICE_A);
        await act(async () => { slow.finish(details); });
        expect(screen.queryByText('5 sats')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Pay' })).toBeNull();
    });

    it('checks a finished payment under the identity that paid, after the view moves on', async () => {
        const paying = deferred<{ paymentHash: string }>();
        keymaster.payLightningInvoice.mockReturnValue(paying.promise);
        const { rerender } = render(<LightningTab />);
        const user = await openTab('Send');
        enterInvoice(INVOICE_A);
        await user.click(screen.getByRole('button', { name: 'Decode' }));
        await user.click(await screen.findByRole('button', { name: 'Pay' }));
        expect(keymaster.payLightningInvoice).toHaveBeenCalledWith(INVOICE_A, 'Alice');

        moveTo('Bob', rerender);
        await act(async () => { paying.finish({ paymentHash: 'hashA' }); });

        await waitFor(() => expect(keymaster.checkLightningPayment).toHaveBeenCalledWith('hashA', 'Alice'));
        await waitFor(() => expect(notify.setSuccess).toHaveBeenCalledWith('Payment sent successfully'));
        expect(keymaster.checkLightningPayment).not.toHaveBeenCalledWith('hashA', 'Bob');
    });

    it('checks a zap under the identity that sent it, on every attempt', async () => {
        const zapping = deferred<{ paymentHash: string }>();
        keymaster.zapLightning.mockReturnValue(zapping.promise);
        const { rerender } = render(<LightningTab />);
        const user = await openTab('Zap');
        fireEvent.change(screen.getByLabelText(/^Recipient/), { target: { value: 'Carol' } });
        fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: '21' } });
        await user.click(screen.getByRole('button', { name: 'Zap' }));
        expect(keymaster.zapLightning).toHaveBeenCalledWith('Carol', 21, undefined, 'Alice');

        moveTo('Bob', rerender);
        await act(async () => { zapping.finish({ paymentHash: 'hashZ' }); });

        await waitFor(() => expect(keymaster.checkLightningPayment).toHaveBeenCalledWith('hashZ', 'Alice'));
        expect(keymaster.checkLightningPayment).not.toHaveBeenCalledWith('hashZ', 'Bob');
    });

    it('reads, and acts for, the identity on screen', async () => {
        keymaster.getLightningPayments.mockResolvedValue([]);
        keymaster.publishLightning.mockResolvedValue(true);
        keymaster.removeLightning.mockResolvedValue(true);
        render(<LightningTab />);
        const user = userEvent.setup();
        await user.click(await screen.findByRole('button', { name: 'Publish Lightning' }));
        await waitFor(() => expect(keymaster.publishLightning).toHaveBeenCalledWith('Alice'));
        await user.click(await screen.findByRole('button', { name: 'Unpublish Lightning' }));
        await waitFor(() => expect(keymaster.unpublishLightning).toHaveBeenCalledWith('Alice'));
        await user.click(screen.getByRole('button', { name: 'Disconnect Wallet' }));
        await waitFor(() => expect(keymaster.removeLightning).toHaveBeenCalledWith('Alice'));
        await user.click(screen.getByRole('tab', { name: 'Payments' }));
        await waitFor(() => expect(keymaster.getLightningPayments).toHaveBeenCalledWith('Alice'));

        expect(keymaster.getLightningBalance).toHaveBeenCalledWith('Alice');
        expect(keymaster.resolveDID).toHaveBeenCalledWith('Alice');
    });

    it('shows the next identity its own balance and publish state, not the previous one', async () => {
        keymaster.getLightningBalance.mockImplementation(async (name: string) => ({ balance: name === 'Alice' ? 100 : 7 }));
        keymaster.resolveDID.mockImplementation(async (name: string) => ({
            didDocument: { service: name === 'Alice' ? [{ id: '#lightning' }] : [] },
        }));
        const { rerender } = render(<LightningTab />);
        await screen.findByRole('button', { name: 'Unpublish Lightning' });

        moveTo('Bob', rerender);
        expect(await screen.findByText('Balance: 7 sats')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Publish Lightning' })).toBeTruthy();
    });
});

describe('Lightning view: one call at a time', () => {
    it('sets up once on a double click, and offers the button again after a failure', async () => {
        const adding = deferred();
        keymaster.getLightningBalance.mockRejectedValue(new LightningNotConfiguredError());
        keymaster.addLightning.mockReturnValue(adding.promise);
        render(<LightningTab />);
        const user = userEvent.setup();
        const button = await screen.findByRole<HTMLButtonElement>('button', { name: 'Set Up Lightning' });
        await user.dblClick(button);

        expect(keymaster.addLightning).toHaveBeenCalledTimes(1);
        expect(keymaster.addLightning).toHaveBeenCalledWith('Alice');
        await act(async () => { adding.fail(new Error('no gateway')); });
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Set Up Lightning' }).disabled).toBe(false);
    });

    it('disconnects once on a double click, and offers the button again after a failure', async () => {
        const removing = deferred();
        keymaster.removeLightning.mockReturnValue(removing.promise);
        render(<LightningTab />);
        const user = userEvent.setup();
        await user.dblClick(await screen.findByRole('button', { name: 'Disconnect Wallet' }));

        expect(keymaster.removeLightning).toHaveBeenCalledTimes(1);
        await act(async () => { removing.fail(new Error('no gateway')); });
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Disconnect Wallet' }).disabled).toBe(false);
    });

    it('pays once on a double click', async () => {
        keymaster.payLightningInvoice.mockReturnValue(deferred().promise);
        render(<LightningTab />);
        const user = await openTab('Send');
        enterInvoice(INVOICE_A);
        await user.click(screen.getByRole('button', { name: 'Decode' }));
        await user.dblClick(await screen.findByRole('button', { name: 'Pay' }));

        expect(keymaster.payLightningInvoice).toHaveBeenCalledTimes(1);
    });
});

describe('Lightning view: slow reads', () => {
    it('does not let a slow balance read put an older figure back', async () => {
        const slow = deferred<{ balance: number }>();
        keymaster.getLightningBalance.mockReturnValueOnce(slow.promise);
        keymaster.getLightningBalance.mockResolvedValue({ balance: 700 });
        render(<LightningTab />);
        const user = await openTab('Send');
        await user.click(screen.getByRole('tab', { name: 'Wallet' }));
        expect(await screen.findByText('Balance: 700 sats')).toBeTruthy();

        await act(async () => { slow.finish({ balance: 100 }); });
        expect(screen.getByText('Balance: 700 sats')).toBeTruthy();
    });

    it('does not let a slow failing balance read replace a newer figure with its error', async () => {
        const slow = deferred<{ balance: number }>();
        keymaster.getLightningBalance.mockReturnValueOnce(slow.promise);
        keymaster.getLightningBalance.mockResolvedValue({ balance: 700 });
        render(<LightningTab />);
        const user = await openTab('Send');
        await user.click(screen.getByRole('tab', { name: 'Wallet' }));
        await screen.findByText('Balance: 700 sats');

        await act(async () => { slow.fail(new Error('node unreachable')); });
        expect(screen.getByText('Balance: 700 sats')).toBeTruthy();
        expect(screen.queryByText('node unreachable')).toBeNull();
    });

    it('keeps showing a spinner until the newest balance read answers', async () => {
        const first = deferred<{ balance: number }>();
        const second = deferred<{ balance: number }>();
        keymaster.getLightningBalance.mockReturnValueOnce(first.promise);
        keymaster.getLightningBalance.mockReturnValueOnce(second.promise);
        render(<LightningTab />);
        const user = await openTab('Send');
        await user.click(screen.getByRole('tab', { name: 'Wallet' }));

        await act(async () => { first.finish({ balance: 100 }); });
        expect(screen.getByRole('progressbar')).toBeTruthy();
        await act(async () => { second.finish({ balance: 700 }); });
        expect(await screen.findByText('Balance: 700 sats')).toBeTruthy();
    });

    it('does not let a slow payments read put older rows back', async () => {
        const slow = deferred<any[]>();
        const row = (memo: string) => ({ time: '', amount: 1, fee: 0, status: 'success', memo, paymentHash: memo });
        keymaster.getLightningPayments.mockReturnValueOnce(slow.promise);
        keymaster.getLightningPayments.mockResolvedValue([row('newer')]);
        render(<LightningTab />);
        const user = await openTab('Payments');
        await user.click(screen.getByRole('tab', { name: 'Send' }));
        await user.click(screen.getByRole('tab', { name: 'Payments' }));
        expect(await screen.findByText('newer')).toBeTruthy();

        await act(async () => { slow.finish([row('older')]); });
        expect(screen.getByText('newer')).toBeTruthy();
        expect(screen.queryByText('older')).toBeNull();
    });
});
