import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import PropertiesTab from '../../../../packages/wallet-ui/src/components/PropertiesTab';

// The Properties tab shows the data of the identity or alias picked, and lets
// the owner add, change and remove a property.

const { keymaster, wallet, variables, setError, setSuccess } = vi.hoisted(() => {
    const keymaster = { resolveDID: vi.fn(), mergeData: vi.fn() };

    return {
        keymaster,
        wallet: { keymaster: keymaster as typeof keymaster | null },
        variables: {
            agentList: [] as string[] | null,
            aliasList: {} as Record<string, string> | null,
            currentId: '',
        },
        setError: vi.fn(),
        setSuccess: vi.fn(),
    };
});
vi.mock('../../../../packages/wallet-ui/src/contexts/WalletProvider', () => ({ useWalletContext: () => wallet }));
vi.mock('../../../../packages/wallet-ui/src/contexts/VariablesProvider', () => ({ useVariablesContext: () => variables }));
vi.mock('../../../../packages/wallet-ui/src/contexts/SnackbarProvider', () => ({
    useSnackbar: () => ({ setError, setSuccess }),
}));

// A document as Keymaster's resolveDID returns it, which always adds `version`
// and `isOwned` to the metadata.
function resolved(name: string, data: unknown, isOwned = true) {
    return {
        didDocument: { '@context': ['https://www.w3.org/ns/did/v1'], id: `did:cid:${name}` },
        didDocumentMetadata: {
            created: '2026-01-02T03:04:05Z',
            versionId: `version-of-${name}`,
            versionSequence: '1',
            confirmed: true,
            version: 1,
            isOwned,
        },
        didDocumentData: data,
        didDocumentRegistration: { version: 1, type: 'agent', registry: 'hyperswarm' },
        didResolutionMetadata: { retrieved: '2026-01-02T03:04:06Z' },
    };
}

// What the mocked Keymaster resolves, by name.
let documents: Record<string, unknown>;

beforeEach(() => {
    vi.resetAllMocks();
    wallet.keymaster = keymaster;
    variables.agentList = ['Bob', 'Alice'];
    variables.aliasList = { notes: 'did:cid:notes', Alice: 'did:cid:Alice', stranger: 'did:cid:stranger' };
    variables.currentId = 'Alice';
    documents = {
        Alice: resolved('Alice', { nickname: 'Al', age: 42, tags: ['a', 'b'] }),
        Bob: resolved('Bob', {}),
        notes: resolved('notes', { title: 'Notes' }),
        stranger: resolved('stranger', { motto: 'Hello' }, false),
    };
    keymaster.resolveDID.mockImplementation(async (name: string) => {
        if (!(name in documents)) {
            throw new Error(`Invalid DID: ${name}`);
        }
        return documents[name];
    });
    // mergeData answers true once the update is accepted.
    keymaster.mergeData.mockResolvedValue(true);
});

const picker = () => screen.getByRole('combobox');
// The row of a property: its name, its value and its buttons.
const row = (key: string) => screen.getByText(key, { selector: 'p' }).parentElement as HTMLElement;

async function pick(user: UserEvent, name: string) {
    await user.click(picker());
    await user.click(await screen.findByRole('option', { name }));
}

// Renders the tab with Alice, the current identity, picked and loaded.
async function openAlice() {
    render(<PropertiesTab />);
    await screen.findByText('nickname');
}

describe('picking a DID', () => {
    it('offers every identity and alias once, by name', async () => {
        const user = userEvent.setup({ delay: null });
        await openAlice();

        await user.click(picker());

        const names = (await screen.findAllByRole('option')).map(option => option.textContent);
        expect(names).toEqual(['Select a DID...', 'Alice', 'Bob', 'notes', 'stranger']);
    });

    it('starts on the current identity and shows its properties by name', async () => {
        await openAlice();

        expect(picker()).toHaveTextContent('Alice');
        expect(keymaster.resolveDID).toHaveBeenCalledWith('Alice');
        expect(row('age')).toHaveTextContent('42');
        expect(row('nickname')).toHaveTextContent('Al');
        expect(row('tags')).toHaveTextContent('["a","b"]');
        const keys = screen.getAllByText(/^(age|nickname|tags)$/).map(key => key.textContent);
        expect(keys).toEqual(['age', 'nickname', 'tags']);
        expect(setError).not.toHaveBeenCalled();
    });

    it('starts with nothing picked when the current identity is not in the list', () => {
        variables.currentId = 'Zed';
        render(<PropertiesTab />);

        expect(picker()).toHaveTextContent('Select a DID...');
        expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull();
        expect(screen.queryByLabelText('Key')).toBeNull();
        expect(keymaster.resolveDID).not.toHaveBeenCalled();
    });

    it('offers nothing while the wallet has no names', async () => {
        const user = userEvent.setup({ delay: null });
        variables.agentList = null;
        variables.aliasList = null;
        render(<PropertiesTab />);

        await user.click(picker());

        expect((await screen.findAllByRole('option')).map(option => option.textContent)).toEqual(['Select a DID...']);
    });

    it('shows the properties of the DID picked', async () => {
        const user = userEvent.setup({ delay: null });
        await openAlice();

        await pick(user, 'notes');

        expect(await screen.findByText('title')).toBeInTheDocument();
        expect(row('title')).toHaveTextContent('Notes');
        expect(screen.queryByText('nickname')).toBeNull();
        expect(keymaster.resolveDID).toHaveBeenLastCalledWith('notes');
    });

    it('says so while the properties are being read', async () => {
        let finish!: (doc: unknown) => void;
        keymaster.resolveDID.mockReturnValue(new Promise(resolve => { finish = resolve; }));
        render(<PropertiesTab />);

        expect(await screen.findByText('Loading...')).toBeInTheDocument();

        finish(documents.Alice);
        expect(await screen.findByText('nickname')).toBeInTheDocument();
        expect(screen.queryByText('Loading...')).toBeNull();
    });

    it('says so when the DID has no properties', async () => {
        variables.currentId = 'Bob';
        render(<PropertiesTab />);

        expect(await screen.findByText('No properties set')).toBeInTheDocument();
    });

    it('reports a DID that cannot be resolved and shows no properties', async () => {
        const user = userEvent.setup({ delay: null });
        const failure = new Error('Invalid DID: unknown');
        await openAlice();
        keymaster.resolveDID.mockRejectedValue(failure);

        await pick(user, 'notes');

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(await screen.findByText('No properties set')).toBeInTheDocument();
        expect(screen.queryByLabelText('Key')).toBeNull();
    });

    it('reads the properties again on Refresh', async () => {
        const user = userEvent.setup({ delay: null });
        await openAlice();
        documents.Alice = resolved('Alice', { nickname: 'Ally' });

        await user.click(screen.getByRole('button', { name: 'Refresh' }));

        await waitFor(() => expect(row('nickname')).toHaveTextContent('Ally'));
        expect(screen.queryByText('age')).toBeNull();
        expect(keymaster.resolveDID).toHaveBeenCalledTimes(2);
    });

    it('reads nothing while the wallet has no keymaster', async () => {
        wallet.keymaster = null;
        render(<PropertiesTab />);

        expect(await screen.findByText('No properties set')).toBeInTheDocument();
        expect(keymaster.resolveDID).not.toHaveBeenCalled();
    });
});

describe('a DID the wallet does not own', () => {
    it('shows its properties with nothing to add, change or remove', async () => {
        const user = userEvent.setup({ delay: null });
        await openAlice();

        await pick(user, 'stranger');

        expect(await screen.findByText('motto')).toBeInTheDocument();
        expect(row('motto')).toHaveTextContent('Hello');
        await waitFor(() => expect(screen.queryByLabelText('Key')).toBeNull());
        expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    });
});

describe('adding a property', () => {
    it('offers Add only once a key is typed', async () => {
        const user = userEvent.setup({ delay: null });
        await openAlice();
        const add = screen.getByRole('button', { name: 'Add' });

        expect(add).toBeDisabled();
        await user.type(screen.getByLabelText('Key'), '   ');
        expect(add).toBeDisabled();
        await user.type(screen.getByLabelText('Key'), 'city');
        expect(add).toBeEnabled();
    });

    it('adds text as text, under the key without the spaces around it', async () => {
        const user = userEvent.setup({ delay: null });
        await openAlice();
        keymaster.mergeData.mockImplementation(async () => {
            documents.Alice = resolved('Alice', { nickname: 'Al', city: 'Paris, France' });
            return true;
        });

        await user.type(screen.getByLabelText('Key'), ' city ');
        await user.type(screen.getByLabelText('Value'), 'Paris, France');
        await user.click(screen.getByRole('button', { name: 'Add' }));

        expect(await screen.findByText('city')).toBeInTheDocument();
        expect(keymaster.mergeData).toHaveBeenCalledWith('Alice', { city: 'Paris, France' });
        expect(setSuccess).toHaveBeenCalledWith('Property added');
        expect(row('city')).toHaveTextContent('Paris, France');
        expect(screen.getByLabelText('Key')).toHaveValue('');
        expect(screen.getByLabelText('Value')).toHaveValue('');
        expect(setError).not.toHaveBeenCalled();
    });

    it('adds a value written as JSON as what it says', async () => {
        const user = userEvent.setup({ delay: null });
        await openAlice();

        await user.type(screen.getByLabelText('Key'), 'limits');
        // Braces and brackets are key names to `type`, so the value is pasted.
        await user.click(screen.getByLabelText('Value'));
        await user.paste('{"max": 3, "open": true}');
        await user.click(screen.getByRole('button', { name: 'Add' }));

        await waitFor(() =>
            expect(keymaster.mergeData).toHaveBeenCalledWith('Alice', { limits: { max: 3, open: true } }));
    });

    it('reports a property that cannot be added and keeps what was typed', async () => {
        const user = userEvent.setup({ delay: null });
        const failure = new Error('update refused');
        keymaster.mergeData.mockRejectedValue(failure);
        await openAlice();

        await user.type(screen.getByLabelText('Key'), 'city');
        await user.type(screen.getByLabelText('Value'), 'Paris');
        await user.click(screen.getByRole('button', { name: 'Add' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(setSuccess).not.toHaveBeenCalled();
        expect(screen.getByLabelText('Key')).toHaveValue('city');
        expect(screen.getByLabelText('Value')).toHaveValue('Paris');
        expect(keymaster.resolveDID).toHaveBeenCalledTimes(1);
    });

    it('empties the form when another DID is picked', async () => {
        const user = userEvent.setup({ delay: null });
        await openAlice();
        await user.type(screen.getByLabelText('Key'), 'city');
        await user.type(screen.getByLabelText('Value'), 'Paris');

        await pick(user, 'notes');

        await screen.findByText('title');
        expect(screen.getByLabelText('Key')).toHaveValue('');
        expect(screen.getByLabelText('Value')).toHaveValue('');
    });
});

describe('changing a property', () => {
    const edit = (key: string) => within(row(key)).getByRole('button', { name: 'Edit' });

    it('opens text for editing as it is', async () => {
        const user = userEvent.setup({ delay: null });
        await openAlice();

        await user.click(edit('nickname'));

        expect(within(row('nickname')).getByRole('textbox')).toHaveValue('Al');
        expect(within(row('nickname')).queryByRole('button', { name: 'Edit' })).toBeNull();
        // The other rows stay as they were.
        expect(edit('age')).toBeInTheDocument();
    });

    it('opens any other value for editing as indented JSON', async () => {
        const user = userEvent.setup({ delay: null });
        await openAlice();

        await user.click(edit('tags'));

        expect(within(row('tags')).getByRole('textbox')).toHaveValue('[\n  "a",\n  "b"\n]');
    });

    it('saves the new text and shows it', async () => {
        const user = userEvent.setup({ delay: null });
        await openAlice();
        keymaster.mergeData.mockImplementation(async () => {
            documents.Alice = resolved('Alice', { nickname: 'Ally', age: 42, tags: ['a', 'b'] });
            return true;
        });

        await user.click(edit('nickname'));
        const field = within(row('nickname')).getByRole('textbox');
        await user.clear(field);
        await user.type(field, 'Ally');
        await user.click(within(row('nickname')).getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(setSuccess).toHaveBeenCalledWith('Property updated'));
        expect(keymaster.mergeData).toHaveBeenCalledWith('Alice', { nickname: 'Ally' });
        await waitFor(() => expect(row('nickname')).toHaveTextContent('Ally'));
        expect(within(row('nickname')).queryByRole('textbox')).toBeNull();
        expect(setError).not.toHaveBeenCalled();
    });

    it('saves a value written as JSON as what it says', async () => {
        const user = userEvent.setup({ delay: null });
        await openAlice();

        await user.click(edit('tags'));
        const field = within(row('tags')).getByRole('textbox');
        await user.clear(field);
        await user.click(field);
        await user.paste('["a", "b", "c"]');
        await user.click(within(row('tags')).getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(keymaster.mergeData).toHaveBeenCalledWith('Alice', { tags: ['a', 'b', 'c'] }));
    });

    it('leaves the property alone on Cancel', async () => {
        const user = userEvent.setup({ delay: null });
        await openAlice();

        await user.click(edit('nickname'));
        await user.type(within(row('nickname')).getByRole('textbox'), 'ly');
        await user.click(within(row('nickname')).getByRole('button', { name: 'Cancel' }));

        expect(within(row('nickname')).queryByRole('textbox')).toBeNull();
        expect(row('nickname')).toHaveTextContent('Al');
        expect(keymaster.mergeData).not.toHaveBeenCalled();
    });

    it('reports a change that fails and keeps it open', async () => {
        const user = userEvent.setup({ delay: null });
        const failure = new Error('update refused');
        keymaster.mergeData.mockRejectedValue(failure);
        await openAlice();

        await user.click(edit('nickname'));
        await user.type(within(row('nickname')).getByRole('textbox'), 'ly');
        await user.click(within(row('nickname')).getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(setSuccess).not.toHaveBeenCalled();
        expect(within(row('nickname')).getByRole('textbox')).toHaveValue('Ally');
    });

    it('stops editing when another DID is picked', async () => {
        const user = userEvent.setup({ delay: null });
        documents.notes = resolved('notes', { nickname: 'pad' });
        await openAlice();
        await user.click(edit('nickname'));

        await pick(user, 'notes');

        await waitFor(() => expect(row('nickname')).toHaveTextContent('pad'));
        expect(within(row('nickname')).queryByRole('textbox')).toBeNull();
    });
});

describe('removing a property', () => {
    const remove = (key: string) => within(row(key)).getByRole('button', { name: 'Delete' });

    it('asks first, then removes it', async () => {
        const user = userEvent.setup({ delay: null });
        await openAlice();
        keymaster.mergeData.mockImplementation(async () => {
            documents.Alice = resolved('Alice', { nickname: 'Al', tags: ['a', 'b'] });
            return true;
        });

        await user.click(remove('age'));

        const dialog = await screen.findByRole('dialog');
        expect(dialog).toHaveTextContent('Remove Property');
        expect(dialog).toHaveTextContent("Are you sure you want to remove 'age'?");
        expect(keymaster.mergeData).not.toHaveBeenCalled();

        await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));

        await waitFor(() => expect(setSuccess).toHaveBeenCalledWith('Property removed'));
        // Keymaster drops a key that is merged in as null.
        expect(keymaster.mergeData).toHaveBeenCalledWith('Alice', { age: null });
        await waitFor(() => expect(screen.queryByText('age')).toBeNull());
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(setError).not.toHaveBeenCalled();
    });

    it('keeps the property on Cancel', async () => {
        const user = userEvent.setup({ delay: null });
        await openAlice();

        await user.click(remove('age'));
        await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));

        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(keymaster.mergeData).not.toHaveBeenCalled();
        expect(row('age')).toHaveTextContent('42');
    });

    it('reports a removal that fails and closes the question', async () => {
        const user = userEvent.setup({ delay: null });
        const failure = new Error('update refused');
        keymaster.mergeData.mockRejectedValue(failure);
        await openAlice();

        await user.click(remove('age'));
        await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Confirm' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(setSuccess).not.toHaveBeenCalled();
        expect(row('age')).toHaveTextContent('42');
    });
});

describe('a wallet that loses its keymaster', () => {
    it('adds, changes and removes nothing', async () => {
        const user = userEvent.setup({ delay: null });
        await openAlice();
        wallet.keymaster = null;

        await user.type(screen.getByLabelText('Key'), 'city');
        await user.click(screen.getByRole('button', { name: 'Add' }));

        await user.click(within(row('nickname')).getByRole('button', { name: 'Edit' }));
        await user.click(within(row('nickname')).getByRole('button', { name: 'Save' }));

        await user.click(within(row('age')).getByRole('button', { name: 'Delete' }));
        await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Confirm' }));

        expect(keymaster.mergeData).not.toHaveBeenCalled();
        expect(setSuccess).not.toHaveBeenCalled();
        expect(setError).not.toHaveBeenCalled();
    });
});
