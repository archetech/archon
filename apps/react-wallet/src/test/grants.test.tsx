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
    createAsset: vi.fn(), listAssets: vi.fn(), listRevocations: vi.fn(), resolveDID: vi.fn(), mergeData: vi.fn(), revokeDID: vi.fn(),
};
const notify = { error: vi.fn(), success: vi.fn() };

function view(props: Partial<React.ComponentProps<typeof GrantsView>> = {}) {
    return render(
        <GrantsView keymaster={keymaster as any} identity="Alice" registries={['hyperswarm', 'BTC:mainnet', 'ZEC:mainnet']} notify={notify} {...props} />
    );
}

// Metadata of a version anchored on a registry, and of one that is not: a
// creation is `confirmed` either way.
const anchoredOn = (chain: string, more: Record<string, unknown> = {}) =>
    ({ confirmed: true, versionSequence: '1', timestamp: { chain, upperBound: { height: 900000, timeISO: '2026-11-01T00:00:00Z' } }, ...more });
const pending = (more: Record<string, unknown> = {}) => ({ confirmed: true, versionSequence: '1', ...more });

function doc(data: unknown, metadata: Record<string, unknown> = anchoredOn('BTC:mainnet'), registry = 'BTC:mainnet') {
    return { didDocumentData: data, didDocumentMetadata: metadata, didDocumentRegistration: { registry } };
}

const ALICE = 'did:cid:bagaaieraalicealicealicealicealicealicealicealicealicealiceal';
const alice = (registry = 'BTC:mainnet') => ({ didDocument: { id: ALICE }, didDocumentMetadata: {}, didDocumentRegistration: { registry } });

// What the wallet holds: each DID's document, as the node resolves it.
function holding(docs: Record<string, unknown>) {
    keymaster.listAssets.mockResolvedValue(Object.keys(docs));
    keymaster.resolveDID.mockImplementation(async (did: string) => {
        if (did === 'Alice') {
            return alice();
        }
        if (!(did in docs)) {
            throw new Error('unknown DID');
        }
        return docs[did];
    });
}

function linkFor(request: Record<string, unknown> = {}) {
    return encodeGrantLink({ v: 1, client: CLIENT, name: 'Memepool', nonce: NONCE, registries: ['BTC:mainnet', 'ZEC:mainnet'], ...request });
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
    keymaster.listRevocations.mockResolvedValue([]);
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
        expect(memeplexGrant.expiresAt).toBe('2030-01-02T03:04:00Z');
        expect(validateGrant(memeplexGrant)).toBe('valid');
    });

    it('creates no grant for a local identity, whose assets cannot be on a chain', async () => {
        holding({});
        keymaster.resolveDID.mockResolvedValue(alice('local'));
        view();
        const user = await review(linkFor());
        await user.click(screen.getByRole('button', { name: 'Create Grant' }));

        await waitFor(() => expect(notify.error).toHaveBeenCalled());
        expect(String(notify.error.mock.calls[0][0])).toMatch(/local identity/);
        expect(keymaster.createAsset).not.toHaveBeenCalled();
    });

    it('creates no grant to the identity itself', async () => {
        view();
        const user = await review(linkFor({ client: ALICE }));
        await user.click(screen.getByRole('button', { name: 'Create Grant' }));

        await waitFor(() => expect(notify.error).toHaveBeenCalled());
        expect(String(notify.error.mock.calls[0][0])).toMatch(/cannot grant itself/);
        expect(keymaster.createAsset).not.toHaveBeenCalled();
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

    it('offers, of the registries this node supports, only those the client can publish on', async () => {
        view();
        const user = await review(linkFor({ registries: ['ZEC:mainnet', 'SOL:mainnet-beta'] }));

        await user.click(screen.getByRole('combobox', { name: 'Registry' }));
        expect(screen.getAllByRole('option').map(option => option.textContent)).toStrictEqual(['ZEC:mainnet']);
        await user.keyboard('{Escape}');
        await user.click(screen.getByRole('button', { name: 'Create Grant' }));

        await waitFor(() => expect(keymaster.createAsset).toHaveBeenCalledTimes(1));
        const [data, options] = keymaster.createAsset.mock.calls[0];
        expect(options.registry).toBe('ZEC:mainnet');
        // The grant says nothing of registries: it is on one.
        expect(data).toStrictEqual({ memeplexGrant: { v: 1, client: CLIENT, nonce: NONCE } });
    });

    it('creates nothing, and says why, when the client can publish on no registry this node supports', async () => {
        view();
        await review(linkFor({ registries: ['SOL:mainnet-beta'] }));

        expect(screen.getByText(/This client can publish only on SOL:mainnet-beta, and this node supports\s+none of them/)).toBeTruthy();
        expect((screen.getByRole('button', { name: 'Create Grant' }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('follows the node when a registry it was offering goes', async () => {
        const shown = view();
        const user = await review(linkFor({ registries: ['BTC:mainnet', 'ZEC:mainnet'] }));
        const props = { keymaster: keymaster as any, identity: 'Alice', notify };

        shown.rerender(<GrantsView {...props} registries={['hyperswarm', 'ZEC:mainnet']} />);
        await user.click(screen.getByRole('button', { name: 'Create Grant' }));
        await waitFor(() => expect(keymaster.createAsset).toHaveBeenCalledTimes(1));
        expect(keymaster.createAsset.mock.calls[0][1].registry).toBe('ZEC:mainnet');
    });

    it('creates nothing once the node supports none of the registries it was offering', async () => {
        const shown = view();
        await review(linkFor({ registries: ['BTC:mainnet'] }));

        shown.rerender(<GrantsView keymaster={keymaster as any} identity="Alice" notify={notify} registries={['hyperswarm', 'ZEC:mainnet']} />);
        expect((screen.getByRole('button', { name: 'Create Grant' }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('does not carry one request\'s registry over to another that does not list it', async () => {
        view();
        const user = await review(linkFor({ registries: ['BTC:mainnet'] }));
        await user.click(screen.getByRole('button', { name: 'Cancel' }));

        await review(linkFor({ registries: ['ZEC:mainnet'] }));
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
            'did:cid:two': doc({ memeplexGrant: { v: 1, client: `${CLIENT}2`, expiresAt: '2020-01-01T00:00:00Z' } }, anchoredOn('ZEC:mainnet'), 'ZEC:mainnet'),
            'did:cid:three': doc({ memeplexGrant: { v: 1, client: `${CLIENT}3` } }, pending()),
            'did:cid:four': doc({ memeplexGrant: { v: 1, client: `${CLIENT}4` } }, pending({ versionSequence: '2' })),
            'did:cid:five': doc({ memeplexGrant: { v: 1, client: `${CLIENT}5` } }, anchoredOn('ZEC:mainnet')),
            'did:cid:image': doc({ image: { width: 1 } }),
            'did:cid:invalid': doc({ memeplexGrant: { v: 1 } }),
            'did:cid:revoked': doc({}, anchoredOn('BTC:mainnet', { deactivated: true })),
        });
        view();

        const cards = await screen.findAllByTestId('grant');
        expect(cards).toHaveLength(5);
        expect(within(cards[3]).getByText('Change awaiting anchoring')).toBeTruthy();
        expect(within(cards[3]).getByText(/Until then the grant is as it was/)).toBeTruthy();
        // Anchored on another chain than the grant's own.
        expect(within(cards[4]).getByText('Awaiting anchoring')).toBeTruthy();
        expect(keymaster.listAssets).toHaveBeenCalledWith('Alice');
        expect(within(cards[0]).getByText('Post, Rate')).toBeTruthy();
        expect(within(cards[0]).getByText('Active')).toBeTruthy();
        expect(within(cards[0]).getByText('Never')).toBeTruthy();
        expect(within(cards[1]).getByText('All core kinds')).toBeTruthy();
        expect(within(cards[1]).getByText('Expired')).toBeTruthy();
        expect(within(cards[1]).getByText('ZEC:mainnet')).toBeTruthy();
        expect(within(cards[2]).getByText('Awaiting anchoring')).toBeTruthy();
        expect(within(cards[2]).getByText(/cannot publish until this grant is anchored/)).toBeTruthy();
    });

    it('lists the rest when one asset cannot be read, says the list may be short, and reads again on Retry', async () => {
        const docs = { 'did:cid:one': doc({ memeplexGrant: { v: 1, client: CLIENT } }) };
        holding(docs);
        keymaster.listAssets.mockResolvedValue(['did:cid:gone', 'did:cid:one']);
        view();

        expect(await screen.findAllByTestId('grant')).toHaveLength(1);
        expect(screen.getByText(/One asset of this identity could not be read/)).toBeTruthy();

        holding({ ...docs, 'did:cid:gone': doc({ memeplexGrant: { v: 1, client: `${CLIENT}2` } }) });
        await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));

        await waitFor(() => expect(screen.getAllByTestId('grant')).toHaveLength(2));
        expect(screen.queryByText(/could not be read/)).toBeNull();
    });

    it('does not say there are no grants when an asset could not be read', async () => {
        keymaster.listAssets.mockResolvedValue(['did:cid:gone']);
        view();

        expect(await screen.findByText(/could not be read/)).toBeTruthy();
        expect(screen.queryByText('No grants')).toBeNull();
    });

    it('reads the grants again at each interval', async () => {
        holding({ [GRANT]: doc({ memeplexGrant: { v: 1, client: CLIENT } }, pending()) });
        view({ pollMs: 20 });
        expect(await screen.findByText('Awaiting anchoring')).toBeTruthy();

        holding({ [GRANT]: doc({ memeplexGrant: { v: 1, client: CLIENT } }) });
        expect(await screen.findByText('Active')).toBeTruthy();
    });

    it('keeps a field it does not know, and an expiry it was not asked to change, exactly', async () => {
        holding({ [GRANT]: doc({ memeplexGrant: { v: 1, client: CLIENT, nonce: NONCE, expiresAt: '2030-01-02T03:04:59.500Z', note: 'kept' } }) });
        view();
        const user = userEvent.setup();
        await user.click(await screen.findByRole('button', { name: 'Change' }));
        const dialog = screen.getByRole('dialog');
        await user.click(within(dialog).getByLabelText('Tag'));
        await user.click(within(dialog).getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(keymaster.mergeData).toHaveBeenCalledTimes(1));
        expect(keymaster.mergeData.mock.calls[0][1]).toStrictEqual({
            memeplexGrant: {
                v: 1, client: CLIENT, nonce: NONCE, note: 'kept',
                actions: ['memeplex:post', 'memeplex:reply', 'memeplex:rate'], expiresAt: '2030-01-02T03:04:59.500Z',
            },
        });
    });

    it('will not save a change to a grant that has changed since it was shown', async () => {
        holding({ [GRANT]: doc({ memeplexGrant: { v: 1, client: CLIENT } }) });
        view();
        const user = userEvent.setup();
        await user.click(await screen.findByRole('button', { name: 'Change' }));
        // Narrowed from another device while the editor is open.
        holding({ [GRANT]: doc({ memeplexGrant: { v: 1, client: CLIENT, actions: ['memeplex:post'] } }) });
        await user.clear(within(screen.getByRole('dialog')).getByLabelText('Expires'));
        await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(notify.error).toHaveBeenCalled());
        expect(String(notify.error.mock.calls[0][0])).toMatch(/has changed since/);
        expect(keymaster.mergeData).not.toHaveBeenCalled();
        expect(await screen.findByText('Post')).toBeTruthy();
    });

    it('shows a change that is not anchored as awaiting anchoring, whatever expiry it sets', async () => {
        holding({ [GRANT]: doc({ memeplexGrant: { v: 1, client: CLIENT, expiresAt: '2020-01-01T00:00:00Z' } }, pending({ versionSequence: '2' })) });
        view();

        expect(await screen.findByText('Change awaiting anchoring')).toBeTruthy();
        expect(screen.queryByText('Expired')).toBeNull();
    });

    it('says the grants could not be read, and not that there are none, when the list fails', async () => {
        keymaster.listAssets.mockRejectedValue(new Error('node unreachable'));
        view();

        expect(await screen.findByText(/grants could not be read/)).toBeTruthy();
        expect(screen.queryByText('No grants')).toBeNull();

        holding({ [GRANT]: doc({ memeplexGrant: { v: 1, client: CLIENT } }) });
        await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
        expect(await screen.findByTestId('grant')).toBeTruthy();
        expect(screen.queryByText(/grants could not be read/)).toBeNull();
    });

    it('keeps the editor open and says so when the node refuses a change', async () => {
        keymaster.mergeData.mockResolvedValue(false);
        holding({ [GRANT]: doc({ memeplexGrant: { v: 1, client: CLIENT } }) });
        view();
        const user = userEvent.setup();
        await user.click(await screen.findByRole('button', { name: 'Change' }));
        await user.click(within(screen.getByRole('dialog')).getByLabelText('Tag'));
        await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(notify.error).toHaveBeenCalled());
        expect(notify.success).not.toHaveBeenCalled();
        expect(screen.getByRole('dialog')).toBeTruthy();
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
    // Revocations are remembered by identity while the wallet is open, so each
    // case has an identity of its own.
    let identity = '';
    let cases = 0;

    beforeEach(() => {
        identity = `Revoker${cases += 1}`;
    });

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
        view({ identity });
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
        // A node that accepts a deletion resolves the grant as deactivated at once.
        keymaster.revokeDID.mockImplementation(async () => {
            holding({ [GRANT]: doc({}, pending({ deactivated: true })) });
            return true;
        });
        holding(held);
        view({ pollMs: 20, identity });
        await revoke();
        expect(await screen.findByText('Revocation submitted')).toBeTruthy();

        // Confirmed, and anchored on another chain, is not anchored on the grant's.
        holding({ [GRANT]: doc({}, anchoredOn('ZEC:mainnet', { deactivated: true })) });
        await new Promise(wait => setTimeout(wait, 80));
        expect(screen.getByText('Revocation submitted')).toBeTruthy();

        holding({ [GRANT]: doc({}, anchoredOn('BTC:mainnet', { deactivated: true })) });
        expect(await screen.findByText('Revoked')).toBeTruthy();
        expect(screen.queryByText(/can still publish/)).toBeNull();

        // A reorganization withdraws the anchor.
        holding({ [GRANT]: doc({}, pending({ deactivated: true })) });
        expect(await screen.findByText('Revocation submitted')).toBeTruthy();
        expect(screen.getByText(/can still publish/)).toBeTruthy();
    });

    it('still warns after the user leaves the tab and returns, and not under another identity', async () => {
        holding(held);
        const first = view({ identity: 'Carol' });
        await revoke();
        expect(await screen.findByText('Revocation submitted')).toBeTruthy();
        first.unmount();

        holding({ [GRANT]: doc({}, pending({ deactivated: true })) });
        const other = view({ identity: 'Dave' });
        await screen.findByText('No grants');
        expect(screen.queryByText(/Revocation/)).toBeNull();
        other.unmount();

        view({ identity: 'Carol' });
        expect(await screen.findByText('Revocation submitted')).toBeTruthy();
        expect(screen.getByText(/can still publish/)).toBeTruthy();
    });

    it('puts the grant back when the node refuses', async () => {
        keymaster.revokeDID.mockResolvedValue(false);
        holding(held);
        view({ identity });
        await revoke();

        await waitFor(() => expect(notify.error).toHaveBeenCalled());
        expect(await screen.findByTestId('grant')).toBeTruthy();
        expect(screen.queryByText(/Revocation/)).toBeNull();
    });

    it('treats a revocation that failed after the node accepted it as submitted', async () => {
        keymaster.revokeDID.mockImplementation(async () => {
            holding({ [GRANT]: doc({}, pending({ deactivated: true })) });
            throw new Error('connection lost');
        });
        holding(held);
        view({ identity });
        await revoke();

        expect(await screen.findByText('Revocation submitted')).toBeTruthy();
        expect(screen.getByText(/can still publish/)).toBeTruthy();
    });

    it('puts the grant back when a revocation failed and the node still resolves the grant', async () => {
        keymaster.revokeDID.mockRejectedValue(new Error('refused'));
        holding(held);
        view({ identity });
        await revoke();

        expect(await screen.findByTestId('grant')).toBeTruthy();
        expect(screen.queryByText(/Revocation/)).toBeNull();
        expect(notify.error).toHaveBeenCalledTimes(1);
    });

    it('shows a revocation the node accepted after the user left the tab, when they return', async () => {
        let accept!: (ok: boolean) => void;
        keymaster.revokeDID.mockReturnValue(new Promise(settle => { accept = settle; }));
        holding(held);
        const first = view({ identity });
        await revoke();
        expect(await screen.findByText('Revocation requested')).toBeTruthy();
        first.unmount();

        await act(async () => accept(true));
        view({ identity });
        expect(await screen.findByText('Revocation submitted')).toBeTruthy();
    });

    it('does not show the grant again while its revocation is under way', async () => {
        keymaster.revokeDID.mockReturnValue(new Promise(() => undefined));
        holding(held);
        view({ identity, pollMs: 20 });
        await revoke();
        expect(await screen.findByText('Revocation requested')).toBeTruthy();

        await new Promise(wait => setTimeout(wait, 100));
        expect(screen.queryByTestId('grant')).toBeNull();
        expect(screen.getByText('Revocation requested')).toBeTruthy();
    });

    it('puts the grant back when neither the revocation nor the check answered and the node later resolves it live', async () => {
        keymaster.revokeDID.mockImplementation(async () => {
            keymaster.resolveDID.mockRejectedValue(new Error('node unreachable'));
            throw new Error('node unreachable');
        });
        holding(held);
        view({ identity, pollMs: 20 });
        await revoke();
        expect(await screen.findByText('Revocation submitted')).toBeTruthy();

        holding(held);
        expect(await screen.findByTestId('grant')).toBeTruthy();
        expect(screen.queryByText(/Revocation/)).toBeNull();
    });

    it('shows the grants when reading them takes longer than the interval', async () => {
        holding(held);
        const resolve = keymaster.resolveDID.getMockImplementation()!;
        keymaster.resolveDID.mockImplementation(async (did: string) => {
            await new Promise(wait => setTimeout(wait, 60));
            return resolve(did);
        });
        view({ identity, pollMs: 10 });

        expect(await screen.findByTestId('grant')).toBeTruthy();
    });

    it('says when an accepted revocation lost its place to another change, and revokes again', async () => {
        const deleted = { [GRANT]: doc({}, pending({ deactivated: true })) };
        keymaster.revokeDID.mockImplementation(async () => {
            holding(deleted);
            keymaster.listAssets.mockResolvedValue([]);
            return true;
        });
        holding(held);
        view({ identity, pollMs: 20 });
        const user = await revoke();
        expect(await screen.findByText('Revocation submitted')).toBeTruthy();

        // The grant is live, and Keymaster does not list it.
        holding(held);
        keymaster.listAssets.mockResolvedValue([]);
        expect(await screen.findByText('Revocation did not take effect')).toBeTruthy();
        expect(screen.getByText(/can still publish/)).toBeTruthy();

        await user.click(await screen.findByRole('button', { name: 'Revoke Again' }));
        expect(await screen.findByText('Revocation submitted')).toBeTruthy();
        expect(keymaster.revokeDID).toHaveBeenCalledTimes(2);
    });

    describe('held by Keymaster from before the wallet was opened', () => {
        const granted = doc({ memeplexGrant: { v: 1, client: CLIENT } });
        const deleted = (metadata: Record<string, unknown>) => doc({}, { ...metadata, deactivated: true, versionSequence: '2' });

        // A deleted grant, as the node resolves it now and at its first version.
        function revoked(now: unknown, did = GRANT, first: unknown = granted) {
            keymaster.listAssets.mockResolvedValue([]);
            keymaster.resolveDID.mockImplementation(async (id: string, options?: { versionSequence?: number }) => {
                if (id !== did) {
                    throw new Error('unknown DID');
                }
                return options?.versionSequence === 1 ? first : now;
            });
        }

        it('shows a revocation Keymaster reports as submitted, with no record from this session', async () => {
            keymaster.listRevocations.mockResolvedValue([{ did: GRANT, registry: 'BTC:mainnet', status: 'pending' }]);
            revoked(deleted(pending()));
            view({ identity });

            expect(await screen.findByText('Revocation submitted')).toBeTruthy();
            expect(screen.getByText(CLIENT)).toBeTruthy();
            expect(screen.getByText(/can still publish until the revocation is anchored on BTC:mainnet/)).toBeTruthy();
            expect(screen.queryByTestId('grant')).toBeNull();
            expect(keymaster.listRevocations).toHaveBeenCalledWith(identity);
        });

        it('shows it as effective once it is anchored and Keymaster has dropped it', async () => {
            keymaster.listRevocations.mockResolvedValue([{ did: GRANT, registry: 'BTC:mainnet', status: 'pending' }]);
            revoked(deleted(pending()));
            view({ identity, pollMs: 20 });
            expect(await screen.findByText('Revocation submitted')).toBeTruthy();

            keymaster.listRevocations.mockResolvedValue([]);
            revoked(deleted(anchoredOn('BTC:mainnet')));
            expect(await screen.findByText('Revoked')).toBeTruthy();
            expect(screen.queryByText(/can still publish/)).toBeNull();
        });

        it('says when Keymaster reports the revocation displaced, and revokes again', async () => {
            keymaster.listRevocations.mockResolvedValueOnce([{ did: GRANT, registry: 'BTC:mainnet', status: 'displaced' }]);
            holding({ [GRANT]: granted });
            keymaster.revokeDID.mockImplementation(async () => {
                revoked(deleted(pending()));
                return true;
            });
            view({ identity, pollMs: 20 });

            expect(await screen.findByText('Revocation did not take effect')).toBeTruthy();
            expect(screen.getByText(/can still publish/)).toBeTruthy();
            expect(screen.queryByTestId('grant')).toBeNull();

            const user = userEvent.setup();
            await user.click(screen.getByRole('button', { name: 'Revoke Again' }));
            expect(await screen.findByText('Revocation submitted')).toBeTruthy();
            expect(keymaster.revokeDID).toHaveBeenCalledWith(GRANT);
        });

        it('shows no revocation for an asset that was not a grant', async () => {
            keymaster.listRevocations.mockResolvedValue([{ did: GRANT, registry: 'BTC:mainnet', status: 'pending' }]);
            revoked(deleted(pending()), GRANT, doc({ name: 'not a grant' }));
            view({ identity });

            await screen.findByText('No grants');
            expect(screen.queryByText(/Revocation/)).toBeNull();
        });

        it('shows the grants, and says they may be incomplete, when Keymaster cannot say what it holds', async () => {
            keymaster.listRevocations.mockRejectedValue(new Error('wallet locked'));
            holding(held);
            view({ identity });

            expect(await screen.findByTestId('grant')).toBeTruthy();
            expect(screen.getByText(/grants could not be read/)).toBeTruthy();
            expect(screen.queryByText(/Revocation/)).toBeNull();
        });

        it('does not say there are no grants when Keymaster cannot say what it holds, and reads again on Retry', async () => {
            keymaster.listRevocations.mockRejectedValue(new Error('wallet locked'));
            revoked(deleted(pending()));
            view({ identity });

            expect(await screen.findByText(/grants could not be read/)).toBeTruthy();
            expect(screen.queryByText('No grants')).toBeNull();
            expect(notify.error).toHaveBeenCalledTimes(1);

            keymaster.listRevocations.mockResolvedValue([{ did: GRANT, registry: 'BTC:mainnet', status: 'pending' }]);
            await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));

            expect(await screen.findByText('Revocation submitted')).toBeTruthy();
            await waitFor(() => expect(screen.queryByText(/grants could not be read/)).toBeNull());
        });

        it('says an asset could not be read when Keymaster reports a revocation unresolved', async () => {
            keymaster.listRevocations.mockResolvedValue([{ did: GRANT, status: 'unresolved' }]);
            view({ identity });

            expect(await screen.findByText(/One asset of this identity could not be read/)).toBeTruthy();
            expect(screen.queryByText('No grants')).toBeNull();
        });

        it('says an asset could not be read when the grant a revocation deleted cannot be read', async () => {
            keymaster.listRevocations.mockResolvedValue([{ did: GRANT, registry: 'BTC:mainnet', status: 'pending' }]);
            keymaster.listAssets.mockResolvedValue([]);
            keymaster.resolveDID.mockRejectedValue(new Error('node unreachable'));
            view({ identity });

            expect(await screen.findByText(/One asset of this identity could not be read/)).toBeTruthy();
            expect(screen.queryByText('No grants')).toBeNull();
            expect(screen.queryByText(/Revocation/)).toBeNull();
        });
    });

    it('revokes nothing when the user cancels', async () => {
        holding(held);
        view({ identity });
        const user = userEvent.setup();
        await user.click(await screen.findByRole('button', { name: 'Revoke' }));
        await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));

        expect(keymaster.revokeDID).not.toHaveBeenCalled();
    });
});
