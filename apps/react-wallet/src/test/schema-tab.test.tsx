import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import SchemaTab from '../../../../packages/wallet-ui/src/components/SchemaTab';

// The Schemas tab creates a schema, and for the schema picked shows its JSON
// to edit and save, and renames it.

const { keymaster, wallet, variables, walletData, setError, setSuccess, openView } = vi.hoisted(() => {
    const keymaster = {
        createSchema: vi.fn(), getSchema: vi.fn(), setSchema: vi.fn(), addAlias: vi.fn(), removeAlias: vi.fn(),
    };

    return {
        keymaster,
        wallet: { keymaster: keymaster as typeof keymaster | null },
        variables: {
            registries: [] as string[],
            aliasList: {} as Record<string, string>,
            schemaList: [] as string[] | null,
        },
        walletData: { refreshAliases: vi.fn(), handleCopyDID: vi.fn() },
        setError: vi.fn(),
        setSuccess: vi.fn(),
        openView: vi.fn(),
    };
});
vi.mock('../../../../packages/wallet-ui/src/contexts/WalletProvider', () => ({ useWalletContext: () => wallet }));
vi.mock('../../../../packages/wallet-ui/src/contexts/VariablesProvider', () => ({ useVariablesContext: () => variables }));
vi.mock('../../../../packages/wallet-ui/src/contexts/SnackbarProvider', () => ({
    useSnackbar: () => ({ setError, setSuccess }),
}));
vi.mock('../../../../packages/wallet-ui/src/contexts/WalletNavigation', () => ({ useWalletNavigation: () => ({ openView }) }));
vi.mock('../../../../packages/wallet-ui/src/hooks/useWalletData', () => ({ useWalletData: () => walletData }));

const DEGREE = 'did:cid:degree-schema';
// With `$schema`, as Keymaster requires of a schema it is given.
const DRAFT = 'http://json-schema.org/draft-07/schema#';
const schema = { $schema: DRAFT, type: 'object', properties: { grade: { type: 'string' } }, required: ['grade'] };
const amended = { $schema: DRAFT, type: 'object', properties: { grade: { type: 'string' }, year: { type: 'integer' } } };

beforeEach(() => {
    vi.resetAllMocks();
    wallet.keymaster = keymaster;
    variables.registries = ['hyperswarm', 'BTC:mainnet'];
    variables.aliasList = { degree: DEGREE, taken: 'did:cid:other' };
    variables.schemaList = ['degree'];
    keymaster.getSchema.mockResolvedValue(schema);
});

// Neither picker has a label: they are told apart by order.
const registryPicker = () => screen.getAllByRole('combobox')[0];
const schemaPicker = () => screen.getAllByRole('combobox')[1];
const renameButton = () => within(screen.getByLabelText('Rename')).getByRole('button');
const resolveButton = () => within(screen.getByLabelText('Resolve')).getByRole('button');
// The schema's JSON has no label either; it follows the name field.
const editor = () => screen.getAllByRole('textbox')[1];
const saveButton = () => screen.getByRole('button', { name: 'Save Schema' });

async function openSchema(user: UserEvent, name = 'degree') {
    await user.click(schemaPicker());
    await user.click(await screen.findByRole('option', { name }));
    await screen.findByRole('button', { name: 'Save Schema' });
}

function retype(text: string) {
    fireEvent.change(editor(), { target: { value: text } });
}

describe('creating a schema', () => {
    it('offers Create only once a name is typed', async () => {
        const user = userEvent.setup({ delay: null });
        render(<SchemaTab />);

        const create = screen.getByRole('button', { name: 'Create' });
        expect(create).toBeDisabled();

        await user.type(screen.getByLabelText('Schema Name'), 'licence');
        expect(create).toBeEnabled();
    });

    it('creates the schema on the chosen registry, names it and opens it', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.createSchema.mockResolvedValue('did:cid:licence-schema');
        walletData.refreshAliases.mockImplementation(async () => {
            variables.aliasList = { ...variables.aliasList, licence: 'did:cid:licence-schema' };
            variables.schemaList = ['degree', 'licence'];
        });
        render(<SchemaTab />);

        await user.type(screen.getByLabelText('Schema Name'), ' licence  ');
        await user.click(registryPicker());
        await user.click(await screen.findByRole('option', { name: 'BTC:mainnet' }));
        await user.click(screen.getByRole('button', { name: 'Create' }));

        expect(await screen.findByRole('button', { name: 'Save Schema' })).toBeInTheDocument();
        expect(keymaster.createSchema).toHaveBeenCalledWith(null, { registry: 'BTC:mainnet' });
        expect(keymaster.addAlias).toHaveBeenCalledWith('licence', 'did:cid:licence-schema');
        expect(walletData.refreshAliases).toHaveBeenCalled();
        expect(keymaster.getSchema).toHaveBeenCalledWith('licence');
        expect(screen.getByLabelText('Schema Name')).toHaveValue('');
        expect(schemaPicker()).toHaveTextContent('licence');
        expect(editor()).toHaveValue(JSON.stringify(schema, null, 4));
        expect(setError).not.toHaveBeenCalled();
    });

    it('creates on hyperswarm unless another registry is chosen', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.createSchema.mockResolvedValue('did:cid:licence-schema');
        render(<SchemaTab />);

        await user.type(screen.getByLabelText('Schema Name'), 'licence');
        await user.click(screen.getByRole('button', { name: 'Create' }));

        await waitFor(() => expect(keymaster.createSchema).toHaveBeenCalledWith(null, { registry: 'hyperswarm' }));
    });

    it('refuses a name that is already an alias', async () => {
        const user = userEvent.setup({ delay: null });
        render(<SchemaTab />);

        await user.type(screen.getByLabelText('Schema Name'), 'taken');
        await user.click(screen.getByRole('button', { name: 'Create' }));

        expect(setError).toHaveBeenCalledWith('taken already in use');
        expect(keymaster.createSchema).not.toHaveBeenCalled();
    });

    it('reports a failure to create the schema', async () => {
        const user = userEvent.setup({ delay: null });
        const failure = new Error('registry unavailable');
        keymaster.createSchema.mockRejectedValue(failure);
        render(<SchemaTab />);

        await user.type(screen.getByLabelText('Schema Name'), 'licence');
        await user.click(screen.getByRole('button', { name: 'Create' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(keymaster.addAlias).not.toHaveBeenCalled();
        expect(screen.queryByRole('button', { name: 'Save Schema' })).toBeNull();
    });

    it('does nothing while the wallet has no keymaster', async () => {
        const user = userEvent.setup({ delay: null });
        wallet.keymaster = null;
        render(<SchemaTab />);

        await user.type(screen.getByLabelText('Schema Name'), 'licence');
        await user.click(screen.getByRole('button', { name: 'Create' }));

        expect(keymaster.createSchema).not.toHaveBeenCalled();
        expect(setError).not.toHaveBeenCalled();
    });
});

describe('picking a schema', () => {
    it('shows no schema picker before the schema list is loaded', () => {
        variables.schemaList = null;
        render(<SchemaTab />);

        expect(screen.getAllByRole('combobox')).toHaveLength(1);
        expect(screen.queryByLabelText('Rename')).toBeNull();
    });

    it('offers nothing for a schema before one is picked', () => {
        render(<SchemaTab />);

        expect(schemaPicker()).toHaveTextContent('Select schema');
        expect(renameButton()).toBeDisabled();
        expect(resolveButton()).toBeDisabled();
        expect(screen.queryByRole('button', { name: 'Save Schema' })).toBeNull();
    });

    it('shows the JSON of the schema picked', async () => {
        const user = userEvent.setup({ delay: null });
        render(<SchemaTab />);

        await openSchema(user);

        expect(keymaster.getSchema).toHaveBeenCalledWith('degree');
        expect(editor()).toHaveValue(JSON.stringify(schema, null, 4));
        expect(schemaPicker()).toHaveTextContent('degree');
        expect(renameButton()).toBeEnabled();
    });

    it('opens the schema picked in the viewer', async () => {
        const user = userEvent.setup({ delay: null });
        render(<SchemaTab />);
        await openSchema(user);

        await user.click(resolveButton());

        expect(openView).toHaveBeenCalledWith({ did: DEGREE, tab: 'viewer' });
    });

    it('reports a schema that cannot be read', async () => {
        const user = userEvent.setup({ delay: null });
        const failure = new Error('unknown schema');
        keymaster.getSchema.mockRejectedValue(failure);
        render(<SchemaTab />);

        await user.click(schemaPicker());
        await user.click(await screen.findByRole('option', { name: 'degree' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(screen.queryByRole('button', { name: 'Save Schema' })).toBeNull();
    });
});

describe('saving a schema', () => {
    it('saves the edited JSON and shows the schema as it now is', async () => {
        const user = userEvent.setup({ delay: null });
        render(<SchemaTab />);
        await openSchema(user);

        retype(JSON.stringify(amended));
        keymaster.getSchema.mockResolvedValue(amended);
        await user.click(saveButton());

        await waitFor(() => expect(setSuccess).toHaveBeenCalledWith('Schema saved'));
        expect(keymaster.setSchema).toHaveBeenCalledWith('degree', amended);
        expect(editor()).toHaveValue(JSON.stringify(amended, null, 4));
        expect(setError).not.toHaveBeenCalled();
    });

    it('keeps the editor when its text is cleared, so that it can be typed again', async () => {
        const user = userEvent.setup({ delay: null });
        render(<SchemaTab />);
        await openSchema(user);

        await user.clear(editor());

        expect(editor()).toHaveValue('');
        expect(saveButton()).toBeDisabled();

        await user.click(editor());
        await user.paste(JSON.stringify(amended));
        expect(editor()).toHaveValue(JSON.stringify(amended));
        expect(saveButton()).toBeEnabled();
    });

    it('offers no Save for text that is not a JSON object', async () => {
        const user = userEvent.setup({ delay: null });
        render(<SchemaTab />);
        await openSchema(user);

        await user.type(editor(), ' oops');
        expect(saveButton()).toBeDisabled();

        for (const text of ['[]', 'null', '"text"']) {
            retype(text);
            expect(saveButton()).toBeDisabled();
        }
        expect(keymaster.setSchema).not.toHaveBeenCalled();
    });

    it('reports a failure to save and keeps the edit', async () => {
        const user = userEvent.setup({ delay: null });
        const failure = new Error('invalid schema');
        keymaster.setSchema.mockRejectedValue(failure);
        render(<SchemaTab />);
        await openSchema(user);

        retype(JSON.stringify(amended));
        await user.click(saveButton());

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(setSuccess).not.toHaveBeenCalled();
        expect(editor()).toHaveValue(JSON.stringify(amended));
    });
});

describe('renaming a schema', () => {
    async function rename(user: UserEvent, to: string) {
        await user.click(renameButton());
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByText('Rename \'degree\' to:')).toBeInTheDocument();
        const field = within(dialog).getByLabelText('New Name');
        expect(field).toHaveValue('degree');
        await user.clear(field);
        if (to) {
            await user.type(field, to);
        }
        await user.click(within(dialog).getByRole('button', { name: 'Rename' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    }

    it('gives the schema its new alias and drops the old one', async () => {
        const user = userEvent.setup({ delay: null });
        walletData.refreshAliases.mockImplementation(async () => {
            variables.aliasList = { diploma: DEGREE, taken: 'did:cid:other' };
            variables.schemaList = ['diploma'];
        });
        render(<SchemaTab />);
        await openSchema(user);

        await rename(user, 'diploma');

        await waitFor(() => expect(setSuccess).toHaveBeenCalledWith('Schema renamed'));
        expect(keymaster.addAlias).toHaveBeenCalledWith('diploma', DEGREE);
        expect(keymaster.removeAlias).toHaveBeenCalledWith('degree');
        expect(walletData.refreshAliases).toHaveBeenCalled();
        expect(schemaPicker()).toHaveTextContent('diploma');
        // The schema stays open under its new name.
        expect(editor()).toHaveValue(JSON.stringify(schema, null, 4));
    });

    it('refuses a name that is already an alias', async () => {
        const user = userEvent.setup({ delay: null });
        render(<SchemaTab />);
        await openSchema(user);

        await rename(user, 'taken');

        expect(setError).toHaveBeenCalledWith('taken already in use');
        expect(keymaster.addAlias).not.toHaveBeenCalled();
        expect(keymaster.removeAlias).not.toHaveBeenCalled();
    });

    it('changes nothing when the name is left as it was or left empty', async () => {
        const user = userEvent.setup({ delay: null });
        render(<SchemaTab />);
        await openSchema(user);

        await rename(user, 'degree');
        await rename(user, '');

        expect(keymaster.addAlias).not.toHaveBeenCalled();
        expect(keymaster.removeAlias).not.toHaveBeenCalled();
        expect(setError).not.toHaveBeenCalled();
        expect(setSuccess).not.toHaveBeenCalled();
    });

    it('changes nothing when the rename is cancelled', async () => {
        const user = userEvent.setup({ delay: null });
        render(<SchemaTab />);
        await openSchema(user);

        await user.click(renameButton());
        const dialog = await screen.findByRole('dialog');
        await user.type(within(dialog).getByLabelText('New Name'), '-two');
        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(keymaster.addAlias).not.toHaveBeenCalled();
    });

    it('reports a failure to rename', async () => {
        const user = userEvent.setup({ delay: null });
        const failure = new Error('invalid alias');
        keymaster.addAlias.mockRejectedValue(failure);
        render(<SchemaTab />);
        await openSchema(user);

        await rename(user, 'diploma');

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(keymaster.removeAlias).not.toHaveBeenCalled();
        expect(setSuccess).not.toHaveBeenCalled();
        expect(schemaPicker()).toHaveTextContent('degree');
    });
});

describe('a schema left open when the wallet loses its keymaster', () => {
    it('asks nothing of the keymaster and reports nothing', async () => {
        const user = userEvent.setup({ delay: null });
        variables.schemaList = ['degree', 'taken'];
        const shown = render(<SchemaTab />);
        await openSchema(user);
        retype(JSON.stringify(amended));

        wallet.keymaster = null;
        shown.rerender(<SchemaTab />);
        vi.clearAllMocks();

        await user.click(saveButton());

        await user.click(renameButton());
        const dialog = await screen.findByRole('dialog');
        await user.type(within(dialog).getByLabelText('New Name'), '-two');
        await user.click(within(dialog).getByRole('button', { name: 'Rename' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

        await user.click(schemaPicker());
        await user.click(await screen.findByRole('option', { name: 'taken' }));

        for (const method of Object.values(keymaster)) {
            expect(method).not.toHaveBeenCalled();
        }
        expect(editor()).toHaveValue(JSON.stringify(amended));
        expect(setError).not.toHaveBeenCalled();
        expect(setSuccess).not.toHaveBeenCalled();
    });
});
