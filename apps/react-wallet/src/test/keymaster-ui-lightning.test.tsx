import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import KeymasterUI from '../../../../packages/keymaster-ui/src/KeymasterUI.jsx';

// The Lightning panel in the standalone clients keeps its state in one large component,
// so unlike LightningTab it can't drop an identity's state by being keyed.

let current = 'Alice';
const fns: Record<string, any> = {};
// The component reads a great deal on mount that has nothing to do with Lightning.
const keymaster = new Proxy(fns, {
    get(target, key: string) {
        if (key === 'then') {
            return undefined;
        }
        target[key] ??= vi.fn(async () => []);
        return target[key];
    },
});

function deferred<T = any>() {
    let finish!: (value: T) => void;
    const promise = new Promise<T>(settle => { finish = settle; });
    return { promise, finish };
}

const Panel = KeymasterUI as any;

async function mount() {
    render(<Panel keymaster={keymaster} title="Test" hasLightning />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Lightning' }));
    return user;
}

function enterInvoice(value: string) {
    fireEvent.change(screen.getByLabelText(/^BOLT11 Invoice/), { target: { value } });
}

function fieldValue(label: RegExp) {
    return screen.getByLabelText<HTMLInputElement>(label).value;
}

async function move(user: ReturnType<typeof userEvent.setup>, to: string) {
    const from = to === 'Bob' ? 'Alice' : 'Bob';
    fireEvent.mouseDown(screen.getAllByRole('combobox').find(box => box.textContent === from)!);
    await user.click(within(await screen.findByRole('listbox')).getByRole('option', { name: to }));
    await waitFor(() => expect(screen.getAllByRole('combobox').some(box => box.textContent === to)).toBe(true));
    // A completed change of identity leaves the Lightning tab.
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Lightning' }).getAttribute('aria-selected')).toBe('false'));
    await user.click(screen.getByRole('tab', { name: 'Lightning' }));
    await screen.findByText(to === 'Alice' ? 'Balance: 100 sats' : 'Balance: 7 sats');
}

async function reviewAndPay(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('tab', { name: 'Send' }));
    enterInvoice('lnbcA');
    await user.click(screen.getByRole('button', { name: 'Decode' }));
    await user.click(await screen.findByRole('button', { name: 'Pay' }));
}

beforeEach(() => {
    for (const key of Object.keys(fns)) {
        delete fns[key];
    }
    current = 'Alice';
    Object.assign(fns, {
        getCurrentId: vi.fn(async () => current),
        setCurrentId: vi.fn(async (id: string) => { current = id; return true; }),
        listIds: vi.fn(async () => ['Alice', 'Bob']),
        listAliases: vi.fn(async () => ({})),
        listRegistries: vi.fn(async () => ['hyperswarm']),
        getVersion: vi.fn(async () => ({ version: '0', commit: 'test' })),
        resolveDID: vi.fn(async (id: string) => ({
            didDocument: { id: `did:cid:${id}`, service: [] },
            didDocumentData: {},
            didDocumentMetadata: { version: 1 },
            didDocumentRegistration: {},
        })),
        getLightningBalance: vi.fn(async (id: string) => ({ balance: id === 'Alice' ? 100 : 7 })),
        decodeLightningInvoice: vi.fn(async () => ({ amount: '5 sats', payment_hash: 'hashA' })),
        payLightningInvoice: vi.fn(async () => ({ paymentHash: 'hashA' })),
        checkLightningPayment: vi.fn(async () => ({ paid: true, paymentHash: 'hashA' })),
    });
});

describe('KeymasterUI Lightning: paying what was reviewed', () => {
    it('shows no details and offers no Pay when a decode returns for an invoice no longer in the field', async () => {
        const slow = deferred();
        fns.decodeLightningInvoice = vi.fn(() => slow.promise);
        const user = await mount();
        await user.click(screen.getByRole('tab', { name: 'Send' }));
        enterInvoice('lnbcA');
        await user.click(screen.getByRole('button', { name: 'Decode' }));
        enterInvoice('lnbcB');
        await act(async () => { slow.finish({ amount: '5 sats' }); });

        expect(screen.queryByText('5 sats')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Pay' })).toBeNull();
    });

    it('does not let an older decode replace the review of a newer one', async () => {
        const slow = deferred();
        fns.decodeLightningInvoice = vi.fn().mockReturnValueOnce(slow.promise).mockResolvedValue({ amount: '9 sats' });
        const user = await mount();
        await user.click(screen.getByRole('tab', { name: 'Send' }));
        enterInvoice('lnbcA');
        await user.click(screen.getByRole('button', { name: 'Decode' }));
        enterInvoice('lnbcB');
        await user.click(screen.getByRole('button', { name: 'Decode' }));
        await screen.findByText('9 sats');
        await act(async () => { slow.finish({ amount: '5 sats' }); });

        expect(screen.getByText('9 sats')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Pay' })).toBeTruthy();
    });

    it('pays the reviewed invoice, as read, and names the identity', async () => {
        const user = await mount();
        await user.click(screen.getByRole('tab', { name: 'Send' }));
        enterInvoice(' lnbcA\n');
        await user.click(screen.getByRole('button', { name: 'Decode' }));
        await user.click(await screen.findByRole('button', { name: 'Pay' }));

        await waitFor(() => expect(fieldValue(/^BOLT11 Invoice/)).toBe(''));
        expect(fns.payLightningInvoice).toHaveBeenCalledWith('lnbcA', 'Alice');
        expect(fns.checkLightningPayment).toHaveBeenCalledWith('hashA', 'Alice');
    });

    it('keeps an invoice typed while a payment was finishing', async () => {
        const paying = deferred();
        fns.payLightningInvoice = vi.fn(() => paying.promise);
        const user = await mount();
        await reviewAndPay(user);
        enterInvoice('lnbcB');
        await act(async () => { paying.finish({ paymentHash: 'hashA' }); });

        await screen.findByText('Payment sent successfully');
        expect(fieldValue(/^BOLT11 Invoice/)).toBe('lnbcB');
    });
});

describe('KeymasterUI Lightning: one identity at a time', () => {
    it('does not carry a created invoice over to the next identity', async () => {
        fns.createLightningInvoice = vi.fn(async () => ({ paymentRequest: 'lnbcAlice' }));
        const user = await mount();
        await user.click(screen.getByRole('tab', { name: 'Receive' }));
        fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: '50' } });
        await user.click(screen.getByRole('button', { name: 'Create Invoice' }));
        await screen.findByDisplayValue('lnbcAlice');
        expect(fns.createLightningInvoice).toHaveBeenCalledWith(50, '', 'Alice');

        await move(user, 'Bob');
        await user.click(screen.getByRole('tab', { name: 'Receive' }));
        expect(screen.queryByDisplayValue('lnbcAlice')).toBeNull();
        expect(fieldValue(/^Amount/)).toBe('');
    });

    it('checks a finished payment under the identity that paid, after moving on', async () => {
        const paying = deferred();
        fns.payLightningInvoice = vi.fn(() => paying.promise);
        const user = await mount();
        await reviewAndPay(user);
        await move(user, 'Bob');
        await act(async () => { paying.finish({ paymentHash: 'hashA' }); });

        await waitFor(() => expect(fns.checkLightningPayment).toHaveBeenCalledWith('hashA', 'Alice'));
        expect(fns.checkLightningPayment).not.toHaveBeenCalledWith('hashA', 'Bob');
    });

    it('checks a zap under the identity that sent it, after moving on', async () => {
        const zapping = deferred();
        fns.zapLightning = vi.fn(() => zapping.promise);
        const user = await mount();
        await user.click(screen.getByRole('tab', { name: 'Zap' }));
        fireEvent.change(screen.getByLabelText(/^Recipient/), { target: { value: 'Carol' } });
        fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: '21' } });
        await user.click(screen.getByRole('button', { name: 'Zap' }));
        expect(fns.zapLightning).toHaveBeenCalledWith('Carol', 21, undefined, 'Alice');
        await move(user, 'Bob');
        await act(async () => { zapping.finish({ paymentHash: 'hashZ' }); });

        await waitFor(() => expect(fns.checkLightningPayment).toHaveBeenCalledWith('hashZ', 'Alice'));
        expect(fns.checkLightningPayment).not.toHaveBeenCalledWith('hashZ', 'Bob');
    });

    it('does not offer Pay to the next identity on the strength of a decode the last one started', async () => {
        const slow = deferred();
        fns.decodeLightningInvoice = vi.fn(() => slow.promise);
        const user = await mount();
        await user.click(screen.getByRole('tab', { name: 'Send' }));
        enterInvoice('lnbcA');
        await user.click(screen.getByRole('button', { name: 'Decode' }));
        await move(user, 'Bob');
        await user.click(screen.getByRole('tab', { name: 'Send' }));
        enterInvoice('lnbcA');
        await act(async () => { slow.finish({ amount: '5 sats' }); });

        expect(screen.queryByText('5 sats')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Pay' })).toBeNull();
    });

    it("keeps a slow balance read out of the next identity's panel", async () => {
        const slow = deferred();
        const user = await mount();
        await screen.findByText('Balance: 100 sats');
        fns.getLightningBalance.mockImplementation(async (id: string) => (id === 'Alice' ? slow.promise : { balance: 7 }));
        await user.click(screen.getByRole('button', { name: 'Refresh' }));
        await move(user, 'Bob');
        await act(async () => { slow.finish({ balance: 100 }); });

        expect(screen.getByText('Balance: 7 sats')).toBeTruthy();
    });

    it("keeps a balance read from before a move made on another tab out of the next identity's panel", async () => {
        const slow = deferred();
        const nextRead = deferred();
        const user = await mount();
        await screen.findByText('Balance: 100 sats');
        fns.getLightningBalance.mockImplementation(async (id: string) => (id === 'Alice' ? slow.promise : nextRead.promise));
        await user.click(screen.getByRole('button', { name: 'Refresh' }));
        await user.click(screen.getByRole('tab', { name: 'Assets' }));
        fireEvent.mouseDown(screen.getAllByRole('combobox').find(box => box.textContent === 'Alice')!);
        await user.click(within(await screen.findByRole('listbox')).getByRole('option', { name: 'Bob' }));
        // A completed change of identity leaves whichever tab was open.
        await waitFor(() => expect(screen.getByRole('tab', { name: 'Identities' }).getAttribute('aria-selected')).toBe('true'));
        await act(async () => { slow.finish({ balance: 100 }); });
        await user.click(screen.getByRole('tab', { name: 'Lightning' }));

        expect(screen.queryByText('Balance: 100 sats')).toBeNull();
        await act(async () => { nextRead.finish({ balance: 7 }); });
        expect(await screen.findByText('Balance: 7 sats')).toBeTruthy();
    });

    it("keeps a slow disconnect out of the next identity's panel", async () => {
        const removing = deferred();
        fns.removeLightning = vi.fn(() => removing.promise);
        const user = await mount();
        await user.click(await screen.findByRole('button', { name: 'Disconnect Wallet' }));
        expect(fns.removeLightning).toHaveBeenCalledWith('Alice');
        await move(user, 'Bob');
        await act(async () => { removing.finish(true); });

        expect(screen.getByText('Balance: 7 sats')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Set Up Lightning' })).toBeNull();
    });

    it("keeps a slow setup's balance read away from the next identity", async () => {
        const adding = deferred();
        fns.addLightning = vi.fn(() => adding.promise);
        fns.getLightningBalance.mockImplementation(async (id: string) => {
            if (id === 'Alice') {
                throw new Error('Lightning not configured');
            }
            return { balance: 7 };
        });
        const user = await mount();
        await user.click(await screen.findByRole('button', { name: 'Set Up Lightning' }));
        expect(fns.addLightning).toHaveBeenCalledWith('Alice');
        const readsBefore = fns.getLightningBalance.mock.calls.filter(([id]: [string]) => id === 'Alice').length;
        await move(user, 'Bob');
        await act(async () => { adding.finish({}); });

        expect(fns.getLightningBalance.mock.calls.filter(([id]: [string]) => id === 'Alice').length).toBe(readsBefore);
        expect(screen.getByText('Balance: 7 sats')).toBeTruthy();
    });

    it("keeps a slow publish out of the next identity's panel", async () => {
        const publishing = deferred();
        fns.publishLightning = vi.fn(() => publishing.promise);
        const user = await mount();
        await user.click(await screen.findByRole('button', { name: 'Publish Lightning' }));
        expect(fns.publishLightning).toHaveBeenCalledWith('Alice');
        await move(user, 'Bob');
        await act(async () => { publishing.finish(true); });

        expect(screen.getByRole('button', { name: 'Publish Lightning' })).toBeTruthy();
    });
});

describe('KeymasterUI Lightning: a change of identity under way', () => {
    it("keeps showing the identity whose panel is on screen until the change is done", async () => {
        const switching = deferred();
        fns.createLightningInvoice = vi.fn(async () => ({ paymentRequest: 'lnbcAlice' }));
        fns.setCurrentId = vi.fn(async (id: string) => { await switching.promise; current = id; return true; });
        const user = await mount();
        await user.click(screen.getByRole('tab', { name: 'Receive' }));
        fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: '50' } });
        await user.click(screen.getByRole('button', { name: 'Create Invoice' }));
        await screen.findByDisplayValue('lnbcAlice');

        fireEvent.mouseDown(screen.getAllByRole('combobox').find(box => box.textContent === 'Alice')!);
        await user.click(within(await screen.findByRole('listbox')).getByRole('option', { name: 'Bob' }));
        await waitFor(() => expect(fns.setCurrentId).toHaveBeenCalledWith('Bob'));
        expect(screen.getAllByRole('combobox').some(box => box.textContent === 'Alice')).toBe(true);
        expect(screen.getAllByRole('combobox').some(box => box.textContent === 'Bob')).toBe(false);

        await act(async () => { switching.finish(undefined); });
        await waitFor(() => expect(screen.getAllByRole('combobox').some(box => box.textContent === 'Bob')).toBe(true));
        expect(screen.queryByDisplayValue('lnbcAlice')).toBeNull();
    });

    it('keeps showing the current identity when the change fails', async () => {
        fns.setCurrentId = vi.fn(async () => { throw new Error('wallet locked'); });
        const user = await mount();
        fireEvent.mouseDown(screen.getAllByRole('combobox').find(box => box.textContent === 'Alice')!);
        await user.click(within(await screen.findByRole('listbox')).getByRole('option', { name: 'Bob' }));

        await screen.findByText('wallet locked');
        expect(screen.getAllByRole('combobox').some(box => box.textContent === 'Alice')).toBe(true);
    });
});

describe('KeymasterUI Lightning: away from an identity and back', () => {
    async function awayAndBack(user: ReturnType<typeof userEvent.setup>) {
        await move(user, 'Bob');
        await move(user, 'Alice');
    }

    it('does not let an invoice from the first visit replace a newer one', async () => {
        const creating = deferred();
        fns.createLightningInvoice = vi.fn().mockReturnValueOnce(creating.promise).mockResolvedValue({ paymentRequest: 'lnbcNewer' });
        const user = await mount();
        await user.click(screen.getByRole('tab', { name: 'Receive' }));
        fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: '50' } });
        await user.click(screen.getByRole('button', { name: 'Create Invoice' }));
        await awayAndBack(user);
        await user.click(screen.getByRole('tab', { name: 'Receive' }));
        fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: '60' } });
        await user.click(screen.getByRole('button', { name: 'Create Invoice' }));
        await screen.findByDisplayValue('lnbcNewer');
        await act(async () => { creating.finish({ paymentRequest: 'lnbcOlder' }); });

        expect(screen.getByDisplayValue('lnbcNewer')).toBeTruthy();
        expect(screen.queryByDisplayValue('lnbcOlder')).toBeNull();
    });

    it('does not let a payment from the first visit clear the field or show its result', async () => {
        const paying = deferred();
        fns.payLightningInvoice = vi.fn(() => paying.promise);
        const user = await mount();
        await reviewAndPay(user);
        await awayAndBack(user);
        await user.click(screen.getByRole('tab', { name: 'Send' }));
        enterInvoice('lnbcA');
        await act(async () => { paying.finish({ paymentHash: 'hashA' }); });

        await screen.findByText('Payment sent successfully');
        expect(fieldValue(/^BOLT11 Invoice/)).toBe('lnbcA');
        expect(screen.queryByText('hashA')).toBeNull();
    });

    it('does not let a zap from the first visit clear the form or show its result', async () => {
        const zapping = deferred();
        fns.zapLightning = vi.fn(() => zapping.promise);
        const user = await mount();
        await user.click(screen.getByRole('tab', { name: 'Zap' }));
        fireEvent.change(screen.getByLabelText(/^Recipient/), { target: { value: 'Carol' } });
        fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: '21' } });
        await user.click(screen.getByRole('button', { name: 'Zap' }));
        await awayAndBack(user);
        await user.click(screen.getByRole('tab', { name: 'Zap' }));
        fireEvent.change(screen.getByLabelText(/^Recipient/), { target: { value: 'Dave' } });
        await act(async () => { zapping.finish({ paymentHash: 'hashZ' }); });

        await screen.findByText('Zap sent successfully');
        expect(screen.getByRole<HTMLInputElement>('combobox', { name: /^Recipient/ }).value).toBe('Dave');
        expect(screen.queryByText('hashZ')).toBeNull();
    });
});

describe('KeymasterUI Lightning: one call at a time', () => {
    async function openInvoiceForm(user: ReturnType<typeof userEvent.setup>) {
        await user.click(screen.getByRole('tab', { name: 'Receive' }));
        fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: '50' } });
    }

    async function openZapForm(user: ReturnType<typeof userEvent.setup>) {
        await user.click(screen.getByRole('tab', { name: 'Zap' }));
        fireEvent.change(screen.getByLabelText(/^Recipient/), { target: { value: 'Carol' } });
        fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: '21' } });
    }

    async function openPayButton(user: ReturnType<typeof userEvent.setup>) {
        await user.click(screen.getByRole('tab', { name: 'Send' }));
        enterInvoice('lnbcA');
        await user.click(screen.getByRole('button', { name: 'Decode' }));
        await screen.findByRole('button', { name: 'Pay' });
    }

    it('pays once on a double click', async () => {
        const paying = deferred();
        fns.payLightningInvoice = vi.fn(() => paying.promise);
        const user = await mount();
        await openPayButton(user);
        await user.dblClick(screen.getByRole('button', { name: 'Pay' }));

        expect(fns.payLightningInvoice).toHaveBeenCalledTimes(1);
        await act(async () => { paying.finish({ paymentHash: 'hashA' }); });
        await screen.findByText('Payment sent successfully');
        expect(fns.payLightningInvoice).toHaveBeenCalledTimes(1);
    });

    it('offers Pay again after a payment that failed', async () => {
        fns.payLightningInvoice = vi.fn(async () => { throw new Error('no route'); });
        fns.checkLightningPayment = vi.fn(async () => ({ paid: false }));
        const user = await mount();
        await openPayButton(user);
        await user.click(screen.getByRole('button', { name: 'Pay' }));

        await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Pay' }).disabled).toBe(false));
    });

    it('creates one invoice on a double click, and offers the button again afterwards', async () => {
        const creating = deferred();
        fns.createLightningInvoice = vi.fn(() => creating.promise);
        const user = await mount();
        await openInvoiceForm(user);
        await user.dblClick(screen.getByRole('button', { name: 'Create Invoice' }));

        expect(fns.createLightningInvoice).toHaveBeenCalledTimes(1);
        await act(async () => { creating.finish({ paymentRequest: 'lnbcAlice' }); });
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Create Invoice' }).disabled).toBe(false);
    });

    it('zaps once on a double click', async () => {
        fns.zapLightning = vi.fn(() => deferred().promise);
        const user = await mount();
        await openZapForm(user);
        await user.dblClick(screen.getByRole('button', { name: 'Zap' }));

        expect(fns.zapLightning).toHaveBeenCalledTimes(1);
    });

    it('sets up once on a double click', async () => {
        fns.addLightning = vi.fn(() => deferred().promise);
        fns.getLightningBalance.mockRejectedValue(new Error('Lightning not configured'));
        await mount();
        const user = userEvent.setup();
        await user.dblClick(await screen.findByRole('button', { name: 'Set Up Lightning' }));

        expect(fns.addLightning).toHaveBeenCalledTimes(1);
    });

    it('publishes once on a double click', async () => {
        fns.publishLightning = vi.fn(() => deferred().promise);
        await mount();
        const user = userEvent.setup();
        await user.dblClick(await screen.findByRole('button', { name: 'Publish Lightning' }));

        expect(fns.publishLightning).toHaveBeenCalledTimes(1);
    });

    it('disconnects once on a double click', async () => {
        fns.removeLightning = vi.fn(() => deferred().promise);
        await mount();
        const user = userEvent.setup();
        await user.dblClick(await screen.findByRole('button', { name: 'Disconnect Wallet' }));

        expect(fns.removeLightning).toHaveBeenCalledTimes(1);
    });

    it("leaves the next identity's buttons usable while the last one's calls run", async () => {
        fns.createLightningInvoice = vi.fn(() => deferred().promise);
        fns.payLightningInvoice = vi.fn(() => deferred().promise);
        fns.zapLightning = vi.fn(() => deferred().promise);
        fns.removeLightning = vi.fn(() => deferred().promise);
        fns.publishLightning = vi.fn(() => deferred().promise);
        const user = await mount();
        await user.click(await screen.findByRole('button', { name: 'Publish Lightning' }));
        await user.click(screen.getByRole('button', { name: 'Disconnect Wallet' }));
        await openInvoiceForm(user);
        await user.click(screen.getByRole('button', { name: 'Create Invoice' }));
        await openPayButton(user);
        await user.click(screen.getByRole('button', { name: 'Pay' }));
        await openZapForm(user);
        await user.click(screen.getByRole('button', { name: 'Zap' }));
        await move(user, 'Bob');

        const enabled = (name: string) => expect(screen.getByRole<HTMLButtonElement>('button', { name }).disabled).toBe(false);
        enabled('Publish Lightning');
        enabled('Disconnect Wallet');
        await openInvoiceForm(user);
        enabled('Create Invoice');
        await openPayButton(user);
        enabled('Pay');
        await openZapForm(user);
        enabled('Zap');
    });

    it("leaves the next identity's Set Up button usable while the last one's setup runs", async () => {
        fns.addLightning = vi.fn(() => deferred().promise);
        fns.getLightningBalance.mockRejectedValue(new Error('Lightning not configured'));
        const user = await mount();
        await user.click(await screen.findByRole('button', { name: 'Set Up Lightning' }));
        fireEvent.mouseDown(screen.getAllByRole('combobox').find(box => box.textContent === 'Alice')!);
        await user.click(within(await screen.findByRole('listbox')).getByRole('option', { name: 'Bob' }));
        await waitFor(() => expect(screen.getByRole('tab', { name: 'Lightning' }).getAttribute('aria-selected')).toBe('false'));
        await user.click(screen.getByRole('tab', { name: 'Lightning' }));

        expect((await screen.findByRole<HTMLButtonElement>('button', { name: 'Set Up Lightning' })).disabled).toBe(false);
    });

    it("keeps the next identity's call marked busy when the last one's finishes", async () => {
        const alice = deferred();
        fns.createLightningInvoice = vi.fn((_amount: number, _memo: string, id: string) => (id === 'Alice' ? alice.promise : deferred().promise));
        const user = await mount();
        await openInvoiceForm(user);
        await user.click(screen.getByRole('button', { name: 'Create Invoice' }));
        await move(user, 'Bob');
        await openInvoiceForm(user);
        await user.click(screen.getByRole('button', { name: 'Create Invoice' }));
        await act(async () => { alice.finish({ paymentRequest: 'lnbcAlice' }); });

        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Creating...' }).disabled).toBe(true);
    });
});
