import { archon, archonFails, freshWalletWithId, parseDid, resetAll, signedInvoice } from './helpers.ts';

// Runs against the node mint behind Drawbridge, whose fakewallet backend settles
// quotes by itself after a moment. See start-node-ci.

afterAll(async () => {
    await resetAll();
});

async function claim(quote: string, id?: string): Promise<any> {
    for (let attempt = 1; ; attempt++) {
        try {
            return JSON.parse(await archon('cashu-claim', quote, ...(id ? [id] : [])));
        }
        catch (error: any) {
            if (!String(error.stderr).includes('Cashu quote not paid') || attempt >= 10) {
                throw error;
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
}

async function fund(amount: number, id?: string): Promise<void> {
    const quote = JSON.parse(await archon('cashu-mint', String(amount), ...(id ? [id] : [])));
    await claim(quote.quote, id);
}

async function balance(id?: string): Promise<any> {
    return JSON.parse(await archon('cashu-balance', ...(id ? [id] : [])));
}

describe('cashu', () => {
    beforeEach(async () => {
        await freshWalletWithId('alice');
        await archon('add-cashu');
    });

    test('add-cashu joins the node mint', async () => {
        const mints = JSON.parse(await archon('list-cashu-mints'));

        expect(mints).toHaveLength(1);
        expect(mints[0]).toMatchObject({ url: 'https://mint.invalid/cashu', isNodeMint: true });
        expect(await balance()).toEqual({ spendable: 0, inFlight: 0, outstanding: 0 });
    });

    test('cashu-mint prints a quote that cashu-claim turns into ecash', async () => {
        const quote = JSON.parse(await archon('cashu-mint', '100'));
        expect(quote.request).toMatch(/^lnbc/);
        expect(JSON.parse(await archon('cashu-quotes')).map((open: any) => open.quote)).toContain(quote.quote);

        const claimed = await claim(quote.quote);

        expect(claimed).toMatchObject({ amount: 100, balance: { spendable: 100 } });
        expect(JSON.parse(await archon('cashu-quotes'))).toEqual([]);
    });

    test('a token moves to another identity and cannot be redeemed twice', async () => {
        await fund(100);
        const token = await archon('cashu-send', '30');
        expect(token).toMatch(/^cashuB\S+$/);
        expect(await balance()).toMatchObject({ spendable: 70, outstanding: 30 });

        await archon('create-id', '-r', 'local', 'bob');
        await archon('add-cashu', 'bob');
        const received = JSON.parse(await archon('cashu-receive', token, 'bob'));
        expect(received).toMatchObject({ amount: 30, balance: { spendable: 30 } });

        const { status, stderr } = await archonFails('cashu-receive', token, 'bob');
        expect(status).toBe(1);
        expect(stderr).toContain('Cashu token already spent');
    });

    test('cashu-reclaim takes back a send nobody redeemed', async () => {
        await fund(100);
        await archon('cashu-send', '30');
        const [send] = JSON.parse(await archon('cashu-sends'));
        expect(send).toMatchObject({ amount: 30 });

        const reclaimed = JSON.parse(await archon('cashu-reclaim', send.operationId));

        expect(reclaimed).toMatchObject({ amount: 30, balance: { spendable: 100, outstanding: 0 } });
        expect(JSON.parse(await archon('cashu-sends'))).toEqual([]);
    });

    test('cashu-melt pays an invoice and keeps the change', async () => {
        await fund(100);

        const melted = JSON.parse(await archon('cashu-melt', signedInvoice(10)));

        expect(melted).toMatchObject({ paid: true });
        expect(melted.balance.spendable).toBeGreaterThanOrEqual(100 - 10 - 2);
        expect(melted.balance.spendable).toBeLessThan(100);
    });

    test('cashu-restore recovers ecash from the seed', async () => {
        await fund(50);
        const mnemonic = await archon('show-mnemonic');

        await archon('import-wallet', mnemonic);
        await archon('create-id', '-r', 'local', 'alice');
        await archon('add-cashu');
        expect(await balance()).toMatchObject({ spendable: 0 });

        const result = JSON.parse(await archon('cashu-restore'));

        expect(result).toMatchObject({ amount: 50, balance: { spendable: 50 } });
    });

    test('cashu-check settles without changing a healthy balance', async () => {
        await fund(50);

        const result = JSON.parse(await archon('cashu-check'));

        expect(result).toMatchObject({ open: 0, balance: { spendable: 50 } });
    });

    test('publish-cashu lists the mint on the DID and unpublish-cashu removes it', async () => {
        const did = parseDid(await archon('resolve-id'));

        await archon('publish-cashu');
        const published = JSON.parse(await archon('resolve-did', did));
        expect(JSON.stringify(published.didDocument.service)).toContain('#cashu');

        await archon('unpublish-cashu');
        const unpublished = JSON.parse(await archon('resolve-did', did));
        expect(JSON.stringify(unpublished.didDocument.service ?? [])).not.toContain('#cashu');
    });

    test('remove-cashu refuses to discard ecash without --force', async () => {
        await fund(10);

        const { status, stderr } = await archonFails('remove-cashu');
        expect(status).toBe(1);
        expect(stderr).toContain('Cashu state present');
        expect(await balance()).toMatchObject({ spendable: 10 });

        expect(await archon('remove-cashu', '--force')).toBe('OK');
        expect(JSON.parse(await archon('list-cashu-mints'))).toEqual([]);
    });

    test.each(['0', '-1', '1.5', '10abc'])('cashu-send refuses the amount %s', async (amount) => {
        const { status, stderr } = await archonFails('cashu-send', '--', amount);

        expect(status).toBe(1);
        expect(stderr).toContain('positive whole number');
    });
});
