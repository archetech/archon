import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import KeymasterUI from '../../../../packages/keymaster-ui/src/KeymasterUI.jsx';

// Grants in the standalone clients: the wallets' Grants section, under Auth,
// handed this client's own Keymaster.

const CLIENT = 'did:cid:bagaaieraclientclientclientclientclientclientclientclientcli';
const REQUEST = 'did:cid:bagaaierarequestrequestrequestrequestrequestrequestrequestre';
const GRANT = 'did:cid:bagaaieragrantgrantgrantgrantgrantgrantgrantgrantgrantgran';

const fns: Record<string, any> = {};
// The component reads a great deal on mount that has nothing to do with grants.
const keymaster = new Proxy(fns, {
    get(target, key: string) {
        if (key === 'then') {
            return undefined;
        }
        target[key] ??= vi.fn(async () => []);
        return target[key];
    },
});

const Panel = KeymasterUI as any;

const documents: Record<string, unknown> = {
    [REQUEST]: {
        didDocument: { id: REQUEST, controller: CLIENT },
        didDocumentData: { exampleGrantRequest: { name: 'Example', registries: ['BTC:mainnet'], actions: ['read', 'write'] } },
        didDocumentRegistration: { type: 'asset', registry: 'hyperswarm' },
        didDocumentMetadata: { versionSequence: '1' },
    },
    [GRANT]: {
        didDocument: { id: GRANT, controller: 'did:cid:Alice' },
        didDocumentData: { exampleGrant: { client: CLIENT, request: REQUEST, actions: ['read', 'write'] } },
        didDocumentRegistration: { type: 'asset', registry: 'BTC:mainnet' },
        didDocumentMetadata: { versionSequence: '1', timestamp: { chain: 'BTC:mainnet', upperBound: { height: 900000, timeISO: '2026-11-01T00:00:00Z' } } },
    },
};

beforeEach(() => {
    for (const key of Object.keys(fns)) {
        delete fns[key];
    }
    Object.assign(fns, {
        getCurrentId: vi.fn(async () => 'Alice'),
        listIds: vi.fn(async () => ['Alice']),
        listAliases: vi.fn(async () => ({})),
        listRegistries: vi.fn(async () => ['hyperswarm', 'BTC:mainnet']),
        getVersion: vi.fn(async () => ({ version: '0', commit: 'test' })),
        resolveDID: vi.fn(async (id: string) => documents[id] ?? {
            didDocument: { id: `did:cid:${id}`, service: [] },
            didDocumentData: {},
            didDocumentMetadata: { version: 1 },
            didDocumentRegistration: {},
        }),
        listAssets: vi.fn(async () => [GRANT]),
        listRevocations: vi.fn(async () => []),
        createAsset: vi.fn(async () => 'did:cid:new'),
        updateGrant: vi.fn(async () => true),
        revokeDID: vi.fn(async () => true),
    });
});

async function openGrants(props: Record<string, unknown> = {}) {
    render(<Panel keymaster={keymaster} title="Test" {...props} />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('tab', { name: 'Auth' }));
    await user.click(await screen.findByRole('tab', { name: 'Grants' }));

    return user;
}

describe('grants in the standalone clients', () => {
    it('are a section of Auth, beside signing in', async () => {
        render(<Panel keymaster={keymaster} title="Test" />);
        const user = userEvent.setup();

        await user.click(await screen.findByRole('tab', { name: 'Auth' }));
        expect(screen.getByRole('tab', { name: 'Sign in' }).getAttribute('aria-selected')).toBe('true');
        expect(screen.getByText('Challenge')).toBeTruthy();
        expect(screen.queryByLabelText('Grant link')).toBeNull();

        await user.click(screen.getByRole('tab', { name: 'Grants' }));
        expect(await screen.findByLabelText('Grant link')).toBeTruthy();
        expect(screen.queryByText('Challenge')).toBeNull();
    });

    it('list the identity\'s grants, of any app, from this client\'s Keymaster', async () => {
        await openGrants();
        const card = await screen.findByTestId('grant');

        expect(within(card).getByText('example')).toBeTruthy();
        expect(within(card).getByText('read, write')).toBeTruthy();
        expect(within(card).getByText('Active')).toBeTruthy();
        expect(fns.listAssets).toHaveBeenCalledWith('Alice');
        expect(fns.listRevocations).toHaveBeenCalledWith('Alice');
    });

    it('review a request and create the grant it asks for', async () => {
        const user = await openGrants();

        await user.click(await screen.findByLabelText('Grant link'));
        await user.paste(`archon://auth?grant=${REQUEST}`);
        await user.click(screen.getByRole('button', { name: 'Review' }));
        await user.click(await screen.findByLabelText('write'));
        await user.click(screen.getByRole('button', { name: 'Create Grant' }));

        await waitFor(() => expect(fns.createAsset).toHaveBeenCalledTimes(1));
        expect(fns.createAsset.mock.calls[0]).toStrictEqual([
            { exampleGrant: { client: CLIENT, request: REQUEST, actions: ['read'] } },
            { registry: 'BTC:mainnet', controller: 'Alice' },
        ]);
    });

    it('change and revoke a grant through Keymaster', async () => {
        const user = await openGrants();
        const card = await screen.findByTestId('grant');

        await user.click(within(card).getByRole('button', { name: 'Change' }));
        await user.click(within(screen.getByRole('dialog')).getByLabelText('write'));
        await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(fns.updateGrant).toHaveBeenCalledWith(GRANT, { actions: ['read'], expiresAt: null }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

        await user.click(within(await screen.findByTestId('grant')).getByRole('button', { name: 'Revoke' }));
        await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke' }));
        await waitFor(() => expect(fns.revokeDID).toHaveBeenCalledWith(GRANT));
    });

    it('are never read for one identity under another\'s DID while the identity is changing', async () => {
        let current = 'Alice';
        let release!: (value: unknown) => void;
        const resolved = (id: string) => documents[id] ?? {
            didDocument: { id: `did:cid:${id}`, service: [] }, didDocumentData: {}, didDocumentMetadata: { version: 1 }, didDocumentRegistration: {},
        };

        fns.getCurrentId = vi.fn(async () => current);
        fns.setCurrentId = vi.fn(async (id: string) => { current = id; return true; });
        fns.listIds = vi.fn(async () => ['Alice', 'Bob']);
        const user = await openGrants();
        await waitFor(() => expect(fns.listRevocations).toHaveBeenCalledWith('Alice'));
        fns.resolveDID.mockImplementation(async (id: string) => (id === 'Bob' ? new Promise(resolve => { release = resolve; }) : resolved(id)));
        fns.listRevocations.mockClear();

        // Bob is chosen, and his DID takes a while to resolve.
        await user.click(screen.getAllByRole('combobox').find(box => box.textContent === 'Alice')!);
        await user.click(within(await screen.findByRole('listbox')).getByRole('option', { name: 'Bob' }));
        await waitFor(() => expect(release).toBeDefined());

        expect(fns.listRevocations).not.toHaveBeenCalledWith('Bob');
        release(resolved('Bob'));
    });

    it('open on a grant request named where the client was opened, ready for review', async () => {
        render(<Panel keymaster={keymaster} title="Test" grantDID={REQUEST} />);

        expect(await screen.findByRole('button', { name: 'Create Grant' })).toBeTruthy();
        expect(screen.getByRole('tab', { name: 'Grants' }).getAttribute('aria-selected')).toBe('true');
        // The client that asks, in the review and on the grant it already has.
        expect(screen.getAllByText(CLIENT)).toHaveLength(2);
        expect(fns.createAsset).not.toHaveBeenCalled();
    });
});
