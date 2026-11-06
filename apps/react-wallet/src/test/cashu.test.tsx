import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import CashuView from '../../../../packages/wallet-ui/src/components/CashuView';

const NODE = 'https://node.example.com/cashu';
const OTHER = 'https://other.example.com';
const mintInfo = (url: string, isNodeMint = false) => ({ url, nuts: {}, keysets: [{ id: '00', unit: 'sat', active: true }], isNodeMint });

const keymaster = {
    addCashu: vi.fn(), removeCashu: vi.fn(), addCashuMint: vi.fn(), removeCashuMint: vi.fn(), listCashuMints: vi.fn(),
    publishCashu: vi.fn(), unpublishCashu: vi.fn(), getCashuBalance: vi.fn(),
    createCashuMintQuote: vi.fn(), claimCashuMintQuote: vi.fn(), listCashuQuotes: vi.fn(),
    meltCashu: vi.fn(), sendCashu: vi.fn(), receiveCashu: vi.fn(), checkCashu: vi.fn(), restoreCashu: vi.fn(),
    listCashuSends: vi.fn(), reclaimCashu: vi.fn(), sendCashuTo: vi.fn(), listCashuMessages: vi.fn(), receiveCashuMessages: vi.fn(),
    getLightningBalance: vi.fn(), payLightningInvoice: vi.fn(), decodeLightningInvoice: vi.fn(), resolveDID: vi.fn(),
};
const notify = { error: vi.fn(), success: vi.fn(), warning: vi.fn() };

function view(props: Partial<React.ComponentProps<typeof CashuView>> = {}) {
    return render(
        <CashuView keymaster={keymaster as any} identity="Alice" hasNodeMint={false} hasDidComm recipients={['Bob']} notify={notify} {...props} />,
    );
}

function deferred() {
    let finish!: (value: unknown) => void;
    const promise = new Promise(settle => { finish = settle; });
    return { promise, finish };
}

function holding(...mints: ReturnType<typeof mintInfo>[]) {
    keymaster.listCashuMints.mockResolvedValue(mints);
}

async function open(tab: string) {
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: tab }));
    return user;
}

beforeEach(() => {
    vi.resetAllMocks();
    keymaster.getCashuBalance.mockResolvedValue({ spendable: 1000, inFlight: 0, outstanding: 0 });
    keymaster.listCashuQuotes.mockResolvedValue([]);
    keymaster.listCashuSends.mockResolvedValue([]);
    keymaster.listCashuMessages.mockResolvedValue([]);
    keymaster.getLightningBalance.mockRejectedValue(new Error('Lightning not configured'));
    keymaster.resolveDID.mockResolvedValue({ didDocument: { service: [] } });
});

describe('Cashu view: enabling', () => {
    it('offers an outside mint on a node with no mint, and not the node mint', async () => {
        holding();
        view();
        expect(await screen.findByLabelText(/^Mint URL/)).toBeTruthy();
        expect(screen.queryByRole('button', { name: "Use This Node's Mint" })).toBeNull();
        expect(keymaster.getCashuBalance).not.toHaveBeenCalled();
    });

    it('adds the node mint in one step where the node has one', async () => {
        holding();
        keymaster.addCashu.mockResolvedValue(mintInfo(NODE, true));
        view({ hasNodeMint: true });
        const user = userEvent.setup();
        await user.click(await screen.findByRole('button', { name: "Use This Node's Mint" }));
        await waitFor(() => expect(keymaster.addCashu).toHaveBeenCalled());
    });

    it('asks before discarding ecash, and only then forces the removal', async () => {
        holding(mintInfo(NODE, true));
        keymaster.removeCashu.mockRejectedValueOnce({ error: 'Cashu state present: this identity holds ecash' });
        keymaster.removeCashu.mockResolvedValue(true);
        view();
        const user = userEvent.setup();
        await user.click(await screen.findByRole('button', { name: 'Remove Cashu' }));
        await screen.findByText('Discard ecash?');
        expect(keymaster.removeCashu).toHaveBeenCalledTimes(1);
        expect(keymaster.removeCashu).toHaveBeenLastCalledWith(false, 'Alice');
        await user.click(screen.getByRole('button', { name: 'Discard' }));
        await waitFor(() => expect(keymaster.removeCashu).toHaveBeenLastCalledWith(true, 'Alice'));
    });

    it('leaves the ecash alone when the discard is declined', async () => {
        holding(mintInfo(NODE, true));
        keymaster.removeCashu.mockRejectedValueOnce(new Error('Cashu state present: this identity holds ecash'));
        view();
        const user = userEvent.setup();
        await user.click(await screen.findByRole('button', { name: 'Remove Cashu' }));
        await user.click(await screen.findByRole('button', { name: 'Keep It' }));
        expect(keymaster.removeCashu).toHaveBeenCalledTimes(1);
    });

    it('shows a first token and the mint it needs before any mint is added, without offering to claim it', async () => {
        holding();
        keymaster.listCashuMessages.mockResolvedValue([
            { id: 'm1', sender: 'did:cid:bob', amount: 30, mint: NODE, redeemable: false, reason: `the mint ${NODE} is not added` },
        ]);
        view();
        expect(await screen.findByText(/from did:cid:bob/)).toBeTruthy();
        expect(screen.getByText(`the mint ${NODE} is not added`)).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Claim All' })).toBeNull();
        expect(keymaster.listCashuMessages).toHaveBeenCalledWith('Alice');
    });

    it('says nothing when an inbox nobody asked to read cannot be read', async () => {
        holding();
        keymaster.listCashuMessages.mockRejectedValue(new Error('no route'));
        view();
        await waitFor(() => expect(keymaster.listCashuMessages).toHaveBeenCalled());
        await screen.findByLabelText(/^Mint URL/);
        expect(notify.error).not.toHaveBeenCalled();
    });

    it('does not read the inbox on a node without DIDComm', async () => {
        holding();
        view({ hasDidComm: false });
        await screen.findByLabelText(/^Mint URL/);
        expect(keymaster.listCashuMessages).not.toHaveBeenCalled();
    });

    it('shows the wallet when the DID document cannot be read, and does not guess whether it is published', async () => {
        holding(mintInfo(NODE, true));
        keymaster.resolveDID.mockRejectedValueOnce(new Error('gatekeeper down'));
        view();
        await screen.findByRole('heading', { name: 'Balance: 1,000 sats' });
        expect(await screen.findByText(/published is unknown.*gatekeeper down/)).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Publish Cashu' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Unpublish Cashu' })).toBeNull();
        const user = userEvent.setup();
        await user.click(screen.getByRole('button', { name: 'Refresh' }));
        expect(await screen.findByRole('button', { name: 'Publish Cashu' })).toBeTruthy();
        expect(screen.queryByText(/published is unknown/)).toBeNull();
    });

    it('offers a retry when the first read fails', async () => {
        keymaster.listCashuMints.mockRejectedValueOnce(new Error('wallet locked'));
        keymaster.listCashuMints.mockResolvedValue([mintInfo(NODE, true)]);
        view();
        expect(await screen.findByText('wallet locked')).toBeTruthy();
        const user = userEvent.setup();
        await user.click(screen.getByRole('button', { name: 'Retry' }));
        expect(await screen.findByRole('heading', { name: 'Balance: 1,000 sats' })).toBeTruthy();
    });

    it('says why a mint is not answering, and says nothing of a mint that is', async () => {
        holding(
            { url: OTHER, nuts: {}, keysets: [], isNodeMint: false, error: 'Cashu mint unavailable: HTTP 502' } as any,
            mintInfo(NODE, true),
        );
        keymaster.getCashuBalance.mockResolvedValue({ spendable: 0, inFlight: 0, outstanding: 0, mints: {} });
        view();
        expect(await screen.findByText(/Not answering right now: Cashu mint unavailable: HTTP 502/)).toBeTruthy();
        expect(screen.getAllByText(/Not answering right now/)).toHaveLength(1);
    });

    it('can still unpublish after the last mint is gone', async () => {
        holding();
        keymaster.resolveDID.mockResolvedValue({ didDocument: { service: [{ id: 'did:cid:a#cashu', type: 'Cashu', serviceEndpoint: [NODE] }] } });
        keymaster.unpublishCashu.mockResolvedValue(true);
        view();
        const user = userEvent.setup();
        await user.click(await screen.findByRole('button', { name: 'Unpublish Cashu' }));
        await waitFor(() => expect(keymaster.unpublishCashu).toHaveBeenCalledWith('Alice'));
        expect(keymaster.getCashuBalance).not.toHaveBeenCalled();
    });

    it('does not let a slow read put older figures back', async () => {
        holding(mintInfo(NODE, true));
        const finishSlowRead = deferred();
        keymaster.getCashuBalance.mockResolvedValueOnce({ spendable: 100, inFlight: 0, outstanding: 0 });
        keymaster.getCashuBalance.mockReturnValueOnce(finishSlowRead.promise);
        keymaster.getCashuBalance.mockResolvedValue({ spendable: 700, inFlight: 0, outstanding: 0 });
        keymaster.checkCashu.mockResolvedValue({ settled: 1, open: 0 });
        view();
        const user = userEvent.setup();
        await screen.findByRole('heading', { name: 'Balance: 100 sats' });
        await user.click(screen.getByRole('button', { name: 'Refresh' }));
        await waitFor(() => expect(keymaster.getCashuBalance).toHaveBeenCalledTimes(2));
        await user.click(screen.getByRole('button', { name: 'Check' }));
        await screen.findByRole('heading', { name: 'Balance: 700 sats' });
        await act(async () => { finishSlowRead.finish({ spendable: 100, inFlight: 0, outstanding: 0 }); });
        expect(screen.getByRole('heading', { name: 'Balance: 700 sats' })).toBeTruthy();
    });

    it('offers to update a published list that no longer matches the mints', async () => {
        holding(mintInfo(NODE, true), mintInfo(OTHER));
        keymaster.getCashuBalance.mockResolvedValue({ spendable: 0, inFlight: 0, outstanding: 0, mints: {} });
        keymaster.resolveDID.mockResolvedValue({ didDocument: { service: [{ id: 'did:cid:a#cashu', type: 'Cashu', serviceEndpoint: [NODE] }] } });
        view();
        expect(await screen.findByRole('button', { name: 'Update Published Mints' })).toBeTruthy();
    });
});

describe('Cashu view: several mints', () => {
    beforeEach(() => {
        holding(mintInfo(NODE, true), mintInfo(OTHER));
        keymaster.getCashuBalance.mockResolvedValue({
            spendable: 300, inFlight: 0, outstanding: 0,
            mints: { [NODE]: { spendable: 100, inFlight: 0, outstanding: 0 }, [OTHER]: { spendable: 200, inFlight: 0, outstanding: 0 } },
        });
    });

    it('shows the balance per mint', async () => {
        view();
        expect(await screen.findByText('100 sats')).toBeTruthy();
        expect(screen.getByText('200 sats')).toBeTruthy();
    });

    it('settles and restores every mint, since the Wallet tab has no mint to choose', async () => {
        keymaster.checkCashu.mockResolvedValue({ settled: 1, open: 0 });
        keymaster.restoreCashu.mockResolvedValue({ restored: 1, amount: 10 });
        view();
        const user = userEvent.setup();
        await user.click(await screen.findByRole('button', { name: 'Check' }));
        await waitFor(() => expect(notify.success).toHaveBeenCalledWith('2 settled, 0 still open'));
        expect(keymaster.checkCashu.mock.calls.map(call => call[0])).toEqual([NODE, OTHER]);
        await user.click(screen.getByRole('button', { name: 'Restore From Seed' }));
        await waitFor(() => expect(notify.success).toHaveBeenCalledWith('Recovered 20 sats'));
    });

    it('goes on to the other mints when one cannot answer, and says which', async () => {
        keymaster.restoreCashu.mockRejectedValueOnce(new Error('mint down'));
        keymaster.restoreCashu.mockResolvedValue({ restored: 1, amount: 10 });
        keymaster.checkCashu.mockRejectedValueOnce(new Error('mint down'));
        keymaster.checkCashu.mockResolvedValue({ settled: 1, open: 0 });
        view();
        const user = userEvent.setup();
        await user.click(await screen.findByRole('button', { name: 'Restore From Seed' }));
        await waitFor(() => expect(notify.warning).toHaveBeenCalledWith(`Recovered 10 sats. Not done at ${NODE}: mint down`));
        expect(keymaster.restoreCashu.mock.calls).toEqual([[NODE, 'Alice'], [OTHER, 'Alice']]);
        await user.click(screen.getByRole('button', { name: 'Check' }));
        await waitFor(() => expect(notify.warning).toHaveBeenCalledWith(`1 settled, 0 still open. Not done at ${NODE}: mint down`));
        expect(keymaster.checkCashu.mock.calls).toEqual([[NODE, 'Alice'], [OTHER, 'Alice']]);
        expect(notify.error).not.toHaveBeenCalled();
    });

    const lockedResult = { token: 't', amount: 50, fee: 0, operationId: 'o', mint: OTHER, recipient: 'did:cid:b', messageId: 'm', locktime: 1, delivered: true };

    it('leaves the choice of mint for a locked send to Keymaster unless one is chosen', async () => {
        keymaster.sendCashuTo.mockResolvedValue(lockedResult);
        view();
        const user = await open('DIDComm');
        await user.type(screen.getByLabelText(/^Recipient/), 'Bob');
        await user.type(screen.getByLabelText(/^Amount/), '50');
        await user.click(screen.getByRole('button', { name: 'Send' }));
        await waitFor(() => expect(keymaster.sendCashuTo).toHaveBeenCalledWith('Bob', 50, { name: 'Alice' }));
    });

    it('sends a locked token at a mint chosen for it', async () => {
        keymaster.sendCashuTo.mockResolvedValue(lockedResult);
        view();
        const user = await open('DIDComm');
        await user.click(screen.getByRole('combobox', { name: 'Mint' }));
        await user.click(await screen.findByRole('option', { name: OTHER }));
        await user.type(screen.getByLabelText(/^Recipient/), 'Bob');
        await user.type(screen.getByLabelText(/^Amount/), '50');
        await user.click(screen.getByRole('button', { name: 'Send' }));
        await waitFor(() => expect(keymaster.sendCashuTo).toHaveBeenCalledWith('Bob', 50, { mint: OTHER, name: 'Alice' }));
    });

    it('claims a quote at the mint that issued it, whatever is chosen afterwards', async () => {
        keymaster.createCashuMintQuote.mockResolvedValue({ quote: 'q1', request: 'lnbc1', amount: 50, state: 'UNPAID' });
        keymaster.claimCashuMintQuote.mockResolvedValue({ amount: 50, mint: NODE });
        view();
        const user = await open('Mint');
        await user.type(screen.getByLabelText(/^Amount/), '50');
        await user.click(screen.getByRole('button', { name: 'Create Invoice' }));
        await screen.findByLabelText(/^Invoice to pay/);
        expect(keymaster.createCashuMintQuote).toHaveBeenCalledWith(50, NODE, 'Alice');
        await user.click(screen.getByRole('combobox', { name: 'Mint' }));
        await user.click(await screen.findByRole('option', { name: OTHER }));
        await user.click(screen.getByRole('button', { name: 'Claim Once Paid' }));
        await waitFor(() => expect(keymaster.claimCashuMintQuote).toHaveBeenCalledWith('q1', NODE, 'Alice'));
    });
});

describe('Cashu view: the identity a call belongs to', () => {
    const moveToBob = (rerender: (ui: React.ReactNode) => void) => rerender(
        <CashuView key="Bob" keymaster={keymaster as any} identity="Bob" hasNodeMint={false} hasDidComm recipients={[]} notify={notify} />,
    );

    it('finishes a payment under the identity that started it, after the view has moved on', async () => {
        holding(mintInfo(NODE, true));
        keymaster.getLightningBalance.mockResolvedValue({ balance: 5000 });
        keymaster.createCashuMintQuote.mockResolvedValue({ quote: 'q1', request: 'lnbc1', amount: 50, state: 'UNPAID' });
        const finishPayment = deferred();
        keymaster.payLightningInvoice.mockReturnValue(finishPayment.promise);
        keymaster.claimCashuMintQuote.mockResolvedValue({ amount: 50, mint: NODE });
        const { rerender } = view();
        const user = await open('Mint');
        await user.type(screen.getByLabelText(/^Amount/), '50');
        await user.click(screen.getByRole('button', { name: 'Create Invoice' }));
        await user.click(await screen.findByRole('button', { name: /^Pay From Lightning/ }));
        moveToBob(rerender);
        await act(async () => { finishPayment.finish({ paymentHash: 'h' }); });
        await waitFor(() => expect(keymaster.claimCashuMintQuote).toHaveBeenCalledWith('q1', NODE, 'Alice'));
        expect(keymaster.payLightningInvoice).toHaveBeenCalledWith('lnbc1', 'Alice');
    });

    it('checks every mint under the identity that started it, after the view has moved on', async () => {
        holding(mintInfo(NODE, true), mintInfo(OTHER));
        keymaster.getCashuBalance.mockResolvedValue({ spendable: 0, inFlight: 0, outstanding: 0, mints: {} });
        const finishFirst = deferred();
        keymaster.checkCashu.mockReturnValueOnce(finishFirst.promise);
        keymaster.checkCashu.mockResolvedValue({ settled: 0, open: 0 });
        const { rerender } = view();
        const user = userEvent.setup();
        await user.click(await screen.findByRole('button', { name: 'Check' }));
        moveToBob(rerender);
        await act(async () => { finishFirst.finish({ settled: 0, open: 0 }); });
        await waitFor(() => expect(keymaster.checkCashu).toHaveBeenCalledTimes(2));
        expect(keymaster.checkCashu.mock.calls).toEqual([[NODE, 'Alice'], [OTHER, 'Alice']]);
    });
});

describe('Cashu view: minting', () => {
    beforeEach(() => holding(mintInfo(NODE, true)));

    it('offers to pay from Lightning only to an identity with a Lightning wallet', async () => {
        keymaster.createCashuMintQuote.mockResolvedValue({ quote: 'q1', request: 'lnbc1', amount: 50, state: 'UNPAID' });
        view();
        const user = await open('Mint');
        await user.type(screen.getByLabelText(/^Amount/), '50');
        await user.click(screen.getByRole('button', { name: 'Create Invoice' }));
        await screen.findByLabelText(/^Invoice to pay/);
        expect(screen.queryByRole('button', { name: /^Pay From Lightning/ })).toBeNull();
    });

    it('pays from Lightning, then claims once the mint has seen it', async () => {
        keymaster.getLightningBalance.mockResolvedValue({ balance: 5000 });
        keymaster.createCashuMintQuote.mockResolvedValue({ quote: 'q1', request: 'lnbc1', amount: 50, state: 'UNPAID' });
        keymaster.payLightningInvoice.mockResolvedValue({ paymentHash: 'h' });
        keymaster.claimCashuMintQuote.mockRejectedValueOnce({ error: 'Cashu quote not paid: q1' });
        keymaster.claimCashuMintQuote.mockResolvedValue({ amount: 50, mint: NODE });
        view();
        const user = await open('Mint');
        await user.type(screen.getByLabelText(/^Amount/), '50');
        await user.click(screen.getByRole('button', { name: 'Create Invoice' }));
        await user.click(await screen.findByRole('button', { name: /^Pay From Lightning \(5,000 sats\)/ }));
        await waitFor(() => expect(notify.success).toHaveBeenCalledWith('Minted 50 sats'), { timeout: 5000 });
        expect(keymaster.claimCashuMintQuote).toHaveBeenCalledTimes(2);
        expect(keymaster.payLightningInvoice).toHaveBeenCalledTimes(1);
    });

    it('says a claim is early rather than reporting a failure', async () => {
        keymaster.listCashuQuotes.mockResolvedValue([
            { operationId: 'o1', kind: 'mint', quote: 'q1', mint: NODE, amount: 50, request: 'lnbc1', created: '2026-01-01T00:00:00Z' },
        ]);
        keymaster.claimCashuMintQuote.mockRejectedValue({ error: 'Cashu quote not paid: q1' });
        view();
        const user = await open('Mint');
        await user.click(await screen.findByRole('button', { name: 'Claim' }));
        await waitFor(() => expect(notify.warning).toHaveBeenCalled());
        expect(notify.error).not.toHaveBeenCalled();
    });
});

describe('Cashu view: paying', () => {
    beforeEach(() => {
        holding(mintInfo(NODE, true));
        keymaster.decodeLightningInvoice.mockResolvedValue({ amount: '700 sats' });
    });

    async function pay() {
        view();
        const user = await open('Pay');
        await user.type(screen.getByLabelText(/^BOLT11 Invoice/), 'lnbc1');
        await user.click(screen.getByRole('button', { name: 'Decode' }));
        await screen.findByText('700 sats');
        await user.click(screen.getByRole('button', { name: 'Pay' }));
        return user;
    }

    it('does not offer to pay an invoice other than the one decoded', async () => {
        const finishDecode = deferred();
        keymaster.decodeLightningInvoice.mockReturnValue(finishDecode.promise);
        view();
        const user = await open('Pay');
        const field = screen.getByLabelText(/^BOLT11 Invoice/);
        await user.type(field, 'lnbcA');
        await user.click(screen.getByRole('button', { name: 'Decode' }));
        await user.clear(field);
        await user.type(field, 'lnbcB');
        await act(async () => { finishDecode.finish({ amount: '700 sats' }); });
        expect(screen.queryByText('700 sats')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Pay' })).toBeNull();
    });

    it('pays the invoice that was reviewed and keeps one typed since', async () => {
        const finishMelt = deferred();
        keymaster.meltCashu.mockReturnValue(finishMelt.promise);
        const user = await pay();
        const field = screen.getByLabelText<HTMLTextAreaElement>(/^BOLT11 Invoice/);
        await user.clear(field);
        await user.type(field, 'lnbcNEXT');
        await act(async () => { finishMelt.finish({ paid: true, fee: 1, change: 0 }); });
        expect(keymaster.meltCashu).toHaveBeenCalledWith('lnbc1', NODE, 'Alice');
        await waitFor(() => expect(notify.success).toHaveBeenCalled());
        expect(field.value).toBe('lnbcNEXT');
    });

    it('reports a paid invoice with its fee', async () => {
        keymaster.meltCashu.mockResolvedValue({ paid: true, fee: 1, change: 323, preimage: 'abc' });
        await pay();
        await waitFor(() => expect(notify.success).toHaveBeenCalledWith('Paid, with a fee of 1 sat'));
        expect(keymaster.meltCashu).toHaveBeenCalledWith('lnbc1', NODE, 'Alice');
    });

    it('does not call a payment still in flight paid', async () => {
        keymaster.meltCashu.mockResolvedValue({ paid: false, pending: true, change: 0 });
        await pay();
        await waitFor(() => expect(notify.warning).toHaveBeenCalled());
        expect(notify.success).not.toHaveBeenCalled();
    });

    it('stays usable while a melt is held', async () => {
        keymaster.meltCashu.mockReturnValue(new Promise(() => undefined));
        const user = await pay();
        await user.click(screen.getByRole('tab', { name: 'Outstanding' }));
        expect(await screen.findByText('Nothing outstanding.')).toBeTruthy();
    });
});

describe('Cashu view: sending', () => {
    beforeEach(() => holding(mintInfo(NODE, true)));

    async function createToken(token: string) {
        keymaster.sendCashu.mockResolvedValue({ token, amount: 50, fee: 0, operationId: 'o1' });
        view();
        const user = await open('Send');
        await user.type(screen.getByLabelText(/^Amount/), '50');
        await user.click(screen.getByRole('button', { name: 'Create Token' }));
        await screen.findByLabelText(/^Token for 50 sats/);
    }

    it('shows a token with a QR code', async () => {
        await createToken('cashuBshort');
        expect(document.querySelector('svg')).toBeTruthy();
        expect(screen.queryByText(/Too long for a QR code/)).toBeNull();
    });

    it('selects the token when it is clicked, and copes with a click on its label', async () => {
        await createToken('cashuBshort');
        const errors: unknown[] = [];
        const onError = (event: ErrorEvent) => { errors.push(event.error); };
        window.addEventListener('error', onError);
        const user = userEvent.setup();
        const field = screen.getByLabelText<HTMLTextAreaElement>(/^Token for 50 sats/);
        await user.click(document.querySelector(`label[for="${field.id}"]`) as HTMLElement);
        await user.click(field);
        window.removeEventListener('error', onError);
        expect(errors).toEqual([]);
        expect(field.value.slice(field.selectionStart, field.selectionEnd)).toBe('cashuBshort');
    });

    it('offers a token too long for a QR code as text, rather than crashing', async () => {
        await createToken(`cashuB${'a'.repeat(5000)}`);
        expect(screen.getByText(/Too long for a QR code/)).toBeTruthy();
    });

    it('receives a pasted token and says what someone else already spent', async () => {
        keymaster.receiveCashu.mockResolvedValue({ amount: 30, mint: NODE, spent: 20 });
        view();
        const user = await open('Receive');
        await user.type(screen.getByLabelText(/^Token/), ' cashuB1 ');
        await user.click(screen.getByRole('button', { name: 'Receive' }));
        await waitFor(() => expect(keymaster.receiveCashu).toHaveBeenCalledWith('cashuB1', 'Alice'));
        await waitFor(() => expect(notify.warning).toHaveBeenCalledWith(expect.stringContaining('20 sats')));
    });

    it('keeps a token pasted while another is being received, and names the busy button', async () => {
        const receiving = deferred();
        keymaster.receiveCashu.mockReturnValue(receiving.promise);
        view();
        const user = await open('Receive');
        const field = screen.getByLabelText<HTMLTextAreaElement>(/^Token/);
        await user.type(field, 'cashuBfirst');
        await user.click(screen.getByRole('button', { name: 'Receive' }));
        const busy = await screen.findByRole<HTMLButtonElement>('button', { name: 'Receive' });
        await waitFor(() => expect(busy.disabled).toBe(true));
        await user.clear(field);
        await user.type(field, 'cashuBsecond');
        await act(async () => { receiving.finish({ amount: 1, mint: NODE }); });
        await waitFor(() => expect(notify.success).toHaveBeenCalled());
        expect(keymaster.receiveCashu).toHaveBeenCalledWith('cashuBfirst', 'Alice');
        expect(field.value).toBe('cashuBsecond');
    });

    it('clears the token once it is received, when nothing else has been typed', async () => {
        keymaster.receiveCashu.mockResolvedValue({ amount: 1, mint: NODE });
        view();
        const user = await open('Receive');
        const field = screen.getByLabelText<HTMLTextAreaElement>(/^Token/);
        await user.type(field, 'cashuBfirst');
        await user.click(screen.getByRole('button', { name: 'Receive' }));
        await waitFor(() => expect(field.value).toBe(''));
    });

    it('enables a reclaim when the locktime passes with the view left open', async () => {
        keymaster.listCashuSends.mockResolvedValue([
            { operationId: 'soon', mint: NODE, amount: 2, created: '2026-01-01T00:00:00Z', recipient: 'did:cid:b', locktime: Math.floor(Date.now() / 1000) + 2, delivered: true },
        ]);
        view();
        await open('Outstanding');
        const reclaim = await screen.findByRole<HTMLButtonElement>('button', { name: 'Reclaim' });
        expect(reclaim.disabled).toBe(true);
        await waitFor(() => expect(reclaim.disabled).toBe(false), { timeout: 4000 });
    });

    it('offers a reclaim only once it can be reclaimed', async () => {
        const inSeconds = (seconds: number) => Math.floor(Date.now() / 1000) + seconds;
        keymaster.listCashuSends.mockResolvedValue([
            { operationId: 'unlocked', mint: NODE, amount: 1, created: '2026-01-01T00:00:00Z' },
            { operationId: 'expired', mint: NODE, amount: 2, created: '2026-01-01T00:00:00Z', recipient: 'did:cid:b', locktime: inSeconds(-60), delivered: true },
            { operationId: 'locked', mint: NODE, amount: 3, created: '2026-01-01T00:00:00Z', recipient: 'did:cid:b', locktime: inSeconds(3600), delivered: false },
        ]);
        keymaster.reclaimCashu.mockResolvedValue({ amount: 1, mint: NODE });
        view();
        const user = await open('Outstanding');
        const buttons = await screen.findAllByRole<HTMLButtonElement>('button', { name: 'Reclaim' });
        expect(buttons.map(button => button.disabled)).toEqual([false, false, true]);
        expect(screen.getByText(/Not delivered yet/)).toBeTruthy();
        await user.click(buttons[1]);
        await waitFor(() => expect(keymaster.reclaimCashu).toHaveBeenCalledWith('expired', 'Alice'));
    });
});

describe('Cashu view: DIDComm', () => {
    beforeEach(() => holding(mintInfo(NODE, true)));

    it('is left out on a node without DIDComm', async () => {
        view({ hasDidComm: false });
        await screen.findByRole('tab', { name: 'Wallet' });
        expect(screen.queryByRole('tab', { name: 'DIDComm' })).toBeNull();
    });

    it('sends locked to a recipient, converting the hours', async () => {
        keymaster.sendCashuTo.mockResolvedValue({ token: 't', amount: 50, fee: 0, operationId: 'o', mint: NODE, recipient: 'did:cid:b', messageId: 'm', locktime: 1, delivered: true });
        view();
        const user = await open('DIDComm');
        await user.type(screen.getByLabelText(/^Recipient/), 'Bob');
        await user.type(screen.getByLabelText(/^Amount/), '50');
        await user.type(screen.getByLabelText(/^Memo/), 'lunch');
        await user.type(screen.getByLabelText(/^Hours/), '2');
        await user.click(screen.getByRole('button', { name: 'Send' }));
        await waitFor(() => expect(keymaster.sendCashuTo).toHaveBeenCalledWith('Bob', 50, { memo: 'lunch', locktime: 7200, name: 'Alice' }));
    });

    it('does not call an undelivered send sent', async () => {
        keymaster.sendCashuTo.mockResolvedValue({ token: 't', amount: 50, fee: 0, operationId: 'o', mint: NODE, recipient: 'did:cid:b', messageId: 'm', locktime: 1, delivered: false, error: 'relay down' });
        view();
        const user = await open('DIDComm');
        await user.type(screen.getByLabelText(/^Recipient/), 'Bob');
        await user.type(screen.getByLabelText(/^Amount/), '50');
        await user.click(screen.getByRole('button', { name: 'Send' }));
        await waitFor(() => expect(notify.warning).toHaveBeenCalledWith(expect.stringContaining('relay down')));
        expect(notify.success).not.toHaveBeenCalled();
    });

    it('lists incoming tokens, says why one cannot be redeemed, and claims', async () => {
        keymaster.listCashuMessages.mockResolvedValueOnce([
            { id: 'm1', sender: 'did:cid:bob', amount: 30, mint: NODE, memo: 'lunch', redeemable: true },
            { id: 'm2', amount: 10, mint: OTHER, redeemable: false, reason: `Add the mint ${OTHER}` },
        ]);
        keymaster.receiveCashuMessages.mockResolvedValue({
            redeemed: [{ id: 'm1', amount: 30, mint: NODE }],
            failed: [{ id: 'm2', reason: `Add the mint ${OTHER}`, acknowledged: false }],
        });
        view();
        const user = await open('DIDComm');
        expect(await screen.findByText(/from did:cid:bob/)).toBeTruthy();
        expect(screen.getByText(/from an unverified sender/)).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Claim All' }));
        await waitFor(() => expect(notify.success).toHaveBeenCalledWith('Redeemed 30 sats'));
        expect(notify.warning).toHaveBeenCalledWith('1 could not be redeemed');
    });

    it('does not re-read the inbox when a host re-renders with new notify functions', async () => {
        // A host re-renders on each notification, so depending on these would turn one
        // failed read into a loop of failed reads.
        keymaster.listCashuMessages.mockRejectedValue(new Error('no route'));
        let rerender: () => void = () => undefined;
        function Host() {
            const [count, setCount] = useState(0);
            rerender = () => setCount(count + 1);
            return (
                <CashuView keymaster={keymaster as any} identity="Alice" hasNodeMint={false} hasDidComm recipients={[]}
                    notify={{ error: () => rerender(), success: vi.fn(), warning: vi.fn() }} />
            );
        }
        render(<Host />);
        await open('DIDComm');
        await waitFor(() => expect(keymaster.listCashuMessages).toHaveBeenCalled());
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
        expect(keymaster.listCashuMessages).toHaveBeenCalledTimes(1);
    });
});
