import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { encodeGrantLink, validateGrant } from '@didcid/memeplex';
import GrantsView from '../../../../packages/wallet-ui/src/components/GrantsView';

const CLIENT = 'did:cid:bagaaieraclientclientclientclientclientclientclientclientcli';
const GRANT = 'did:cid:bagaaieragrantgrantgrantgrantgrantgrantgrantgrantgrantgran';
const NONCE = 'Qm9vdHN0cmFwIG5vbmNlMTIz';
const SCHEMA = `did:cid:bagaaieraschema?versionId=b${'a'.repeat(58)}`;

const keymaster = {
    createAsset: vi.fn(), listAssets: vi.fn(), resolveDID: vi.fn(), mergeData: vi.fn(), revokeDID: vi.fn(),
};
const notify = { error: vi.fn(), success: vi.fn() };

function view(props: Partial<React.ComponentProps<typeof GrantsView>> = {}) {
    return render(
        <GrantsView keymaster={keymaster as any} identity="Alice" registries={['hyperswarm', 'BTC:mainnet', 'ZEC:mainnet']} notify={notify} {...props} />
    );
}

function doc(data: unknown, metadata: Record<string, unknown> = { confirmed: true }, registry = 'BTC:mainnet') {
    return { didDocumentData: data, didDocumentMetadata: metadata, didDocumentRegistration: { registry } };
}

// What the wallet holds: each DID's document, as the node resolves it.
function holding(docs: Record<string, unknown>) {
    keymaster.listAssets.mockResolvedValue(Object.keys(docs));
    keymaster.resolveDID.mockImplementation(async (did: string) => {
        if (!(did in docs)) {
            throw new Error('unknown DID');
        }
        return docs[did];
    });
}

function linkFor(request: Record<string, unknown> = {}) {
    return encodeGrantLink({ v: 1, client: CLIENT, name: 'Memepool', nonce: NONCE, ...request });
}

async function review(link: string) {
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText('Grant link'));
    await user.paste(link);
    await user.click(screen.getByRole('button', { name: 'Review' }));
    return user;
}

beforeEach(() => {
    vi.resetAllMocks();
    holding({});
    keymaster.createAsset.mockResolvedValue(GRANT);
    keymaster.mergeData.mockResolvedValue(true);
    keymaster.revokeDID.mockResolvedValue(true);
});

describe('Grants view: a grant link', () => {
    it('shows the client, its name as its own claim, and what it asks for', async () => {
        view();
        await review(linkFor({ actions: ['memeplex:post', 'memeplex:tag'] }));

        expect(screen.getByText(CLIENT)).toBeTruthy();
        expect(screen.getByText('Memepool')).toBeTruthy();
        expect(screen.getByText(/the client's own claim/)).toBeTruthy();
        expect(screen.getAllByRole('checkbox').map(box => (box as HTMLInputElement).checked)).toStrictEqual([true, true]);
        expect(screen.getByLabelText('Post')).toBeTruthy();
        expect(screen.getByLabelText('Tag')).toBeTruthy();
        expect(screen.queryByLabelText('Rate')).toBeNull();
    });

    it('creates the grant asked for, for this identity, on the chosen registry', async () => {
        view();
        const user = await review(linkFor({ actions: ['memeplex:post', 'memeplex:tag'] }));
        await user.click(screen.getByRole('button', { name: 'Create Grant' }));

        await waitFor(() => expect(keymaster.createAsset).toHaveBeenCalledTimes(1));
        const [data, options] = keymaster.createAsset.mock.calls[0];
        expect(data).toStrictEqual({ memeplexGrant: { v: 1, client: CLIENT, actions: ['memeplex:post', 'memeplex:tag'], nonce: NONCE } });
        expect(validateGrant(data.memeplexGrant)).toBe('valid');
        expect(options).toStrictEqual({ registry: 'BTC:mainnet', controller: 'Alice' });
        await waitFor(() => expect(notify.success).toHaveBeenCalledWith('Grant created'));
    });

    it('grants every core kind by leaving actions out, when that is what is asked', async () => {
        view();
        const user = await review(linkFor());

        expect(screen.getAllByRole('checkbox')).toHaveLength(4);
        await user.click(screen.getByRole('button', { name: 'Create Grant' }));

        await waitFor(() => expect(keymaster.createAsset).toHaveBeenCalledTimes(1));
        expect(keymaster.createAsset.mock.calls[0][0]).toStrictEqual({ memeplexGrant: { v: 1, client: CLIENT, nonce: NONCE } });
    });

    it('grants a narrower scope when the user unticks an action', async () => {
        view();
        const user = await review(linkFor());
        await user.click(screen.getByLabelText('Rate'));
        await user.click(screen.getByRole('button', { name: 'Create Grant' }));

        await waitFor(() => expect(keymaster.createAsset).toHaveBeenCalledTimes(1));
        const { memeplexGrant } = keymaster.createAsset.mock.calls[0][0];
        expect(memeplexGrant.actions).toStrictEqual(['memeplex:post', 'memeplex:reply', 'memeplex:tag']);
        expect(validateGrant(memeplexGrant)).toBe('valid');
    });

    it('will not create a grant with no actions left', async () => {
        view();
        const user = await review(linkFor({ actions: ['memeplex:post'] }));
        await user.click(screen.getByLabelText('Post'));

        expect((screen.getByRole('button', { name: 'Create Grant' }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('keeps a requested expiry and an extension action', async () => {
        view();
        const user = await review(linkFor({ actions: ['memeplex:post', SCHEMA], expiresAt: '2030-01-02T03:04:00Z' }));
        await user.click(screen.getByRole('button', { name: 'Create Grant' }));

        await waitFor(() => expect(keymaster.createAsset).toHaveBeenCalledTimes(1));
        const { memeplexGrant } = keymaster.createAsset.mock.calls[0][0];
        expect(memeplexGrant.actions).toStrictEqual(['memeplex:post', SCHEMA]);
        expect(new Date(memeplexGrant.expiresAt).getTime()).toBe(new Date('2030-01-02T03:04:00Z').getTime());
        expect(validateGrant(memeplexGrant)).toBe('valid');
    });

    it('offers only the permitted registries this node supports', async () => {
        view();
        const user = await review(linkFor());
        await user.click(screen.getByRole('combobox', { name: 'Registry' }));

        expect(screen.getAllByRole('option').map(option => option.textContent)).toStrictEqual(['BTC:mainnet', 'ZEC:mainnet']);
        await user.click(screen.getByRole('option', { name: 'ZEC:mainnet' }));
        await user.click(screen.getByRole('button', { name: 'Create Grant' }));

        await waitFor(() => expect(keymaster.createAsset).toHaveBeenCalledTimes(1));
        expect(keymaster.createAsset.mock.calls[0][1].registry).toBe('ZEC:mainnet');
    });

    it('says so, and creates nothing, on a node with no permitted registry', async () => {
        view({ registries: ['hyperswarm', 'local'] });
        await review(linkFor());

        expect(screen.getByText(/supports none of the registries/)).toBeTruthy();
        expect((screen.getByRole('button', { name: 'Create Grant' }) as HTMLButtonElement).disabled).toBe(true);
    });

    it.each([
        ['archon://auth?challenge=did:cid:abc', /not a grant link/],
        ['archon://grant?request=!!!', /cannot be read/],
        [`archon://grant?request=${Buffer.from('{"memeplexGrantRequest":{"v":1}}').toString('base64url')}`, /valid grant request/],
    ])('refuses %s and creates nothing', async (link, message) => {
        view();
        await review(link);

        expect(screen.getByText(message)).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Create Grant' })).toBeNull();
        expect(keymaster.createAsset).not.toHaveBeenCalled();
    });

    it('reports a failure and keeps the request', async () => {
        keymaster.createAsset.mockRejectedValue(new Error('registry unavailable'));
        view();
        const user = await review(linkFor());
        await user.click(screen.getByRole('button', { name: 'Create Grant' }));

        await waitFor(() => expect(notify.error).toHaveBeenCalled());
        expect(screen.getByText(CLIENT)).toBeTruthy();
    });
});

describe('Grants view: the grants an identity holds', () => {
    it('lists grants among the identity\'s assets, with scope, expiry, registry and state', async () => {
        holding({
            'did:cid:one': doc({ memeplexGrant: { v: 1, client: CLIENT, actions: ['memeplex:post', 'memeplex:rate'] } }),
            'did:cid:two': doc({ memeplexGrant: { v: 1, client: `${CLIENT}2`, expiresAt: '2020-01-01T00:00:00Z' } }, { confirmed: true }, 'ZEC:mainnet'),
            'did:cid:three': doc({ memeplexGrant: { v: 1, client: `${CLIENT}3` } }, { confirmed: false }),
            'did:cid:image': doc({ image: { width: 1 } }),
            'did:cid:invalid': doc({ memeplexGrant: { v: 1 } }),
            'did:cid:revoked': doc({}, { deactivated: true, confirmed: true }),
        });
        view();

        const cards = await screen.findAllByTestId('grant');
        expect(cards).toHaveLength(3);
        expect(keymaster.listAssets).toHaveBeenCalledWith('Alice');
        expect(within(cards[0]).getByText('Post, Rate')).toBeTruthy();
        expect(within(cards[0]).getByText('Active')).toBeTruthy();
        expect(within(cards[0]).getByText('Never')).toBeTruthy();
        expect(within(cards[1]).getByText('All core kinds')).toBeTruthy();
        expect(within(cards[1]).getByText('Expired')).toBeTruthy();
        expect(within(cards[1]).getByText('ZEC:mainnet')).toBeTruthy();
        expect(within(cards[2]).getByText('Awaiting anchoring')).toBeTruthy();
    });

    it('lists the rest when one asset cannot be resolved', async () => {
        holding({ 'did:cid:one': doc({ memeplexGrant: { v: 1, client: CLIENT } }) });
        keymaster.listAssets.mockResolvedValue(['did:cid:gone', 'did:cid:one']);
        view();

        expect(await screen.findAllByTestId('grant')).toHaveLength(1);
    });

    it('says when there are none', async () => {
        view();
        expect(await screen.findByText('No grants')).toBeTruthy();
    });

    it('changes scope and expiry in place, keeping the client and the nonce', async () => {
        holding({ [GRANT]: doc({ memeplexGrant: { v: 1, client: CLIENT, nonce: NONCE, expiresAt: '2030-01-02T03:04:00Z' } }) });
        view();
        const user = userEvent.setup();
        await user.click(await screen.findByRole('button', { name: 'Change' }));
        const dialog = screen.getByRole('dialog');
        await user.click(within(dialog).getByLabelText('Reply'));
        await user.clear(within(dialog).getByLabelText('Expires'));
        await user.click(within(dialog).getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(keymaster.mergeData).toHaveBeenCalledTimes(1));
        const [did, data] = keymaster.mergeData.mock.calls[0];
        expect(did).toBe(GRANT);
        expect(data).toStrictEqual({
            memeplexGrant: { v: 1, client: CLIENT, actions: ['memeplex:post', 'memeplex:rate', 'memeplex:tag'], nonce: NONCE },
        });
        expect(validateGrant(data.memeplexGrant)).toBe('valid');
    });

    it('widens a narrowed grant to every core kind by leaving actions out', async () => {
        holding({ [GRANT]: doc({ memeplexGrant: { v: 1, client: CLIENT, actions: ['memeplex:post', SCHEMA] } }) });
        view();
        const user = userEvent.setup();
        await user.click(await screen.findByRole('button', { name: 'Change' }));
        const dialog = screen.getByRole('dialog');
        for (const name of ['Reply', 'Rate', 'Tag']) {
            await user.click(within(dialog).getByLabelText(name));
        }
        await user.click(within(dialog).getByLabelText(SCHEMA));
        await user.click(within(dialog).getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(keymaster.mergeData).toHaveBeenCalledTimes(1));
        expect(keymaster.mergeData.mock.calls[0][1]).toStrictEqual({ memeplexGrant: { v: 1, client: CLIENT } });
    });

    it('keeps an extension action beside every core kind', async () => {
        holding({ [GRANT]: doc({ memeplexGrant: { v: 1, client: CLIENT, actions: ['memeplex:post', SCHEMA] } }) });
        view();
        const user = userEvent.setup();
        await user.click(await screen.findByRole('button', { name: 'Change' }));
        const dialog = screen.getByRole('dialog');
        for (const name of ['Reply', 'Rate', 'Tag']) {
            await user.click(within(dialog).getByLabelText(name));
        }
        await user.click(within(dialog).getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(keymaster.mergeData).toHaveBeenCalledTimes(1));
        const { memeplexGrant } = keymaster.mergeData.mock.calls[0][1];
        expect(memeplexGrant.actions).toStrictEqual(['memeplex:post', 'memeplex:reply', 'memeplex:rate', 'memeplex:tag', SCHEMA]);
        expect(validateGrant(memeplexGrant)).toBe('valid');
    });
});

describe('Grants view: revoking', () => {
    const held = { [GRANT]: doc({ memeplexGrant: { v: 1, client: CLIENT } }) };

    async function revoke() {
        const user = userEvent.setup();
        await user.click(await screen.findByRole('button', { name: 'Revoke' }));
        await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke' }));
        return user;
    }

    it('shows a revocation as requested until the node accepts it, then submitted', async () => {
        let accept!: (ok: boolean) => void;
        keymaster.revokeDID.mockReturnValue(new Promise(settle => { accept = settle; }));
        holding(held);
        view();
        await revoke();

        expect(await screen.findByText('Revocation requested')).toBeTruthy();
        expect(screen.getByText(/can still publish/)).toBeTruthy();
        expect(screen.queryByTestId('grant')).toBeNull();
        expect(keymaster.revokeDID).toHaveBeenCalledWith(GRANT);

        await act(async () => accept(true));
        expect(await screen.findByText('Revocation submitted')).toBeTruthy();
        expect(screen.getByText(/can still publish/)).toBeTruthy();
    });

    it('shows it as effective once the deletion is anchored, and not before', async () => {
        holding(held);
        view({ pollMs: 20 });
        await revoke();
        expect(await screen.findByText('Revocation submitted')).toBeTruthy();

        holding({ [GRANT]: doc({}, { deactivated: true, confirmed: false }) });
        await new Promise(wait => setTimeout(wait, 80));
        expect(screen.getByText('Revocation submitted')).toBeTruthy();

        holding({ [GRANT]: doc({}, { deactivated: true, confirmed: true }) });
        expect(await screen.findByText('Revoked')).toBeTruthy();
        expect(screen.queryByText(/can still publish/)).toBeNull();
    });

    it('puts the grant back when the node refuses', async () => {
        keymaster.revokeDID.mockResolvedValue(false);
        holding(held);
        view();
        await revoke();

        await waitFor(() => expect(notify.error).toHaveBeenCalled());
        expect(await screen.findByTestId('grant')).toBeTruthy();
        expect(screen.queryByText(/Revocation/)).toBeNull();
    });

    it('revokes nothing when the user cancels', async () => {
        holding(held);
        view();
        const user = userEvent.setup();
        await user.click(await screen.findByRole('button', { name: 'Revoke' }));
        await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));

        expect(keymaster.revokeDID).not.toHaveBeenCalled();
    });
});
