import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import IdentitiesTab from '../../../../packages/wallet-ui/src/components/IdentitiesTab';

// The Identities tab manages the wallet's identities: creating, renaming,
// backing up and removing them, and the addresses, name, avatar and Nostr keys
// of the selected one.

const { keymaster, wallet, variables, gatekeeper, setError, setSuccess, refreshAll, resetCurrentID } = vi.hoisted(() => {
    const keymaster = {
        resolveDID: vi.fn(), checkDID: vi.fn(), repairDID: vi.fn(),
        createId: vi.fn(), renameId: vi.fn(), removeId: vi.fn(), backupId: vi.fn(), recoverId: vi.fn(),
        rotateKeys: vi.fn(), changeRegistry: vi.fn(), mergeData: vi.fn(),
        listAddresses: vi.fn(), getAddress: vi.fn(), checkAddress: vi.fn(), importAddress: vi.fn(),
        addAddress: vi.fn(), removeAddress: vi.fn(), publishAddress: vi.fn(), unpublishAddress: vi.fn(),
        addNostr: vi.fn(), removeNostr: vi.fn(), importNostr: vi.fn(), exportNsec: vi.fn(),
        createImage: vi.fn(), listAliases: vi.fn(), addAlias: vi.fn(),
    };
    return {
        keymaster,
        wallet: { keymaster: keymaster as typeof keymaster | null, gatekeeperUrl: '' },
        variables: {
            currentId: '', currentDID: '', registry: '', registries: [] as string[],
            imageList: [] as string[], aliasList: {} as Record<string, string>, setRegistry: vi.fn(),
        },
        gatekeeper: { connect: vi.fn(), getData: vi.fn() },
        setError: vi.fn(), setSuccess: vi.fn(), refreshAll: vi.fn(), resetCurrentID: vi.fn(),
    };
});

vi.mock('../../../../packages/wallet-ui/src/contexts/WalletProvider', () => ({ useWalletContext: () => wallet }));
vi.mock('../../../../packages/wallet-ui/src/contexts/VariablesProvider', () => ({ useVariablesContext: () => variables }));
vi.mock('../../../../packages/wallet-ui/src/contexts/SnackbarProvider', () => ({
    useSnackbar: () => ({ setError, setSuccess }),
}));
vi.mock('../../../../packages/wallet-ui/src/hooks/useWalletData', () => ({
    useWalletData: () => ({ refreshAll, resetCurrentID }),
}));
// The component builds its own Gatekeeper client when the module loads, and
// reads an avatar's bytes through it.
vi.mock('@didcid/clients/gatekeeper', () => ({
    default: class {
        connect = gatekeeper.connect;
        getData = gatekeeper.getData;
    },
}));
// The real viewer splits a document over many elements; the test only needs to
// see which document was handed to it.
vi.mock('@uiw/react-json-view', () => ({
    default: ({ value }: { value: unknown }) => <pre data-testid="did-document">{JSON.stringify(value)}</pre>,
}));

const DID = 'did:cid:alice';
const CAT = 'did:cid:cat';
const DOG = 'did:cid:dog';
// What the mocked Gatekeeper serves for an image, and the address an <img> gets for it.
const PNG = Buffer.from('png');
const PNG_URL = 'data:image/png;base64,cG5n';
const failure = new Error('refused');

const imageAsset = (did: string) => ({
    didDocument: { id: did },
    didDocumentData: { file: { cid: `cid-of-${did}`, type: 'image/png' }, image: { width: 1, height: 1 } },
});

// The selected identity's data, and what else the mocked Keymaster resolves.
let identity: Record<string, unknown>;
let assets: Record<string, unknown>;

beforeEach(() => {
    vi.resetAllMocks();
    wallet.keymaster = keymaster;
    wallet.gatekeeperUrl = 'http://node.example';
    // The lists stay the same objects for a whole test, as a context's state
    // does: the component's loaders depend on them and would run again on
    // every render otherwise.
    Object.assign(variables, {
        currentId: 'Alice', currentDID: DID, registry: 'hyperswarm', registries: ['hyperswarm', 'BTC:mainnet'],
        imageList: ['cat', 'dog'], aliasList: { cat: CAT, dog: DOG, Bob: 'did:cid:bob' },
    });
    identity = {};
    assets = { cat: imageAsset(CAT), [CAT]: imageAsset(CAT), dog: imageAsset(DOG), [DOG]: imageAsset(DOG) };
    keymaster.resolveDID.mockImplementation(async (id: string) => {
        if (id === 'Alice' || id === DID) {
            return { didDocument: { id: DID }, didDocumentData: identity };
        }
        if (id in assets) {
            return assets[id];
        }
        throw new Error(`unknown DID ${id}`);
    });
    // A merge is read back afterwards, so it has to change what resolves.
    keymaster.mergeData.mockImplementation(async (_id: string, data: Record<string, unknown>) => {
        identity = { ...identity, ...data };
        for (const key of Object.keys(data)) {
            if (data[key] === null) {
                delete identity[key];
            }
        }
        return true;
    });
    keymaster.listAddresses.mockResolvedValue({});
    gatekeeper.getData.mockResolvedValue(PNG);
});

function noIdentity() {
    variables.currentId = '';
    variables.currentDID = '';
}

async function manage(user: UserEvent, item: string) {
    await user.click(screen.getByRole('button', { name: 'Manage' }));
    await user.click(await screen.findByRole('menuitem', { name: item }));
}

async function more(user: UserEvent, item: string) {
    await user.click(screen.getByRole('button', { name: 'More' }));
    await user.click(await screen.findByRole('menuitem', { name: item }));
}

async function openTab(user: UserEvent, name: string) {
    await user.click(screen.getByRole('tab', { name }));
}

async function choose(user: UserEvent, combobox: HTMLElement, option: string) {
    await user.click(combobox);
    await user.click(await screen.findByRole('option', { name: option }));
}

// A confirmation dialog is not labelled by its title, so it is found by the
// heading it holds.
async function warning(title: string) {
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: title })).toBeInTheDocument();
    return dialog;
}

describe('the Identities tab with no identity', () => {
    beforeEach(noIdentity);

    it('asks for an identity to be created and offers nothing to manage', () => {
        render(<IdentitiesTab />);

        expect(screen.getByText('No identity selected')).toBeInTheDocument();
        expect(screen.getByText('Create an identity to start issuing and holding credentials.')).toBeInTheDocument();
        expect(screen.getAllByRole('button', { name: 'Create ID' })).toHaveLength(2);
        expect(screen.queryByRole('button', { name: 'Manage' })).toBeNull();
        expect(screen.queryByRole('tab')).toBeNull();
        expect(keymaster.resolveDID).not.toHaveBeenCalled();
        expect(keymaster.listAddresses).not.toHaveBeenCalled();
    });

    it('creates an identity on the current registry and closes the dialog', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.createId.mockResolvedValue('did:cid:bob');
        render(<IdentitiesTab />);
        await user.click(screen.getAllByRole('button', { name: 'Create ID' })[1]);

        const dialog = await screen.findByRole('dialog', { name: 'Create Identity' });
        const create = within(dialog).getByRole('button', { name: 'Create' });
        expect(create).toBeDisabled();
        expect(within(dialog).getByRole('combobox')).toHaveTextContent('hyperswarm');

        await user.type(within(dialog).getByLabelText('Name'), '   ');
        expect(create).toBeDisabled();
        await user.type(within(dialog).getByLabelText('Name'), 'Bob  ');
        await user.click(create);

        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(keymaster.createId).toHaveBeenCalledExactlyOnceWith('Bob', { registry: 'hyperswarm' });
        expect(resetCurrentID).toHaveBeenCalledTimes(1);
        expect(setError).not.toHaveBeenCalled();
    });

    it('passes on the registry chosen in the create dialog', async () => {
        const user = userEvent.setup({ delay: null });
        render(<IdentitiesTab />);
        await user.click(screen.getAllByRole('button', { name: 'Create ID' })[0]);

        const dialog = await screen.findByRole('dialog', { name: 'Create Identity' });
        await choose(user, within(dialog).getByRole('combobox'), 'BTC:mainnet');

        expect(variables.setRegistry).toHaveBeenCalledWith('BTC:mainnet');
    });

    it('does not create an identity while no registry is set', async () => {
        const user = userEvent.setup({ delay: null });
        variables.registry = '';
        render(<IdentitiesTab />);
        await user.click(screen.getAllByRole('button', { name: 'Create ID' })[0]);

        const dialog = await screen.findByRole('dialog', { name: 'Create Identity' });
        await user.type(within(dialog).getByLabelText('Name'), 'Bob');

        expect(within(dialog).getByRole('button', { name: 'Create' })).toBeDisabled();
    });

    it('reports a failed creation and leaves the dialog open', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.createId.mockRejectedValue(failure);
        render(<IdentitiesTab />);
        await user.click(screen.getAllByRole('button', { name: 'Create ID' })[0]);

        const dialog = await screen.findByRole('dialog', { name: 'Create Identity' });
        await user.type(within(dialog).getByLabelText('Name'), 'Bob');
        await user.click(within(dialog).getByRole('button', { name: 'Create' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(resetCurrentID).not.toHaveBeenCalled();
        expect(screen.getByRole('dialog', { name: 'Create Identity' })).toBeInTheDocument();

        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });
});

describe('the Identities tab with an identity', () => {
    it('names the identity, opens on its DID document and connects to the node', async () => {
        identity = { name: 'Alice A.' };
        render(<IdentitiesTab />);

        expect(screen.getByText('Managing Alice. Keys, addresses and profile for this identity.')).toBeInTheDocument();
        expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toStrictEqual(['Details', 'Addresses', 'Name', 'Avatar', 'Nostr']);
        expect(screen.getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true');
        expect(await screen.findByTestId('did-document')).toHaveTextContent('"id":"did:cid:alice"');
        expect(screen.getByTestId('did-document')).toHaveTextContent('"name":"Alice A."');
        expect(screen.queryByText('No identity selected')).toBeNull();
        expect(gatekeeper.connect).toHaveBeenCalledExactlyOnceWith({ url: 'http://node.example' });
    });

    it('waits for the node address before connecting', async () => {
        wallet.gatekeeperUrl = '';
        render(<IdentitiesTab />);

        await screen.findByTestId('did-document');
        expect(gatekeeper.connect).not.toHaveBeenCalled();
    });

    it('says so when the identity does not resolve', async () => {
        keymaster.resolveDID.mockRejectedValue(failure);
        render(<IdentitiesTab />);

        expect(await screen.findByText('No DID document')).toBeInTheDocument();
        expect(screen.queryByTestId('did-document')).toBeNull();
    });

    describe('managing it', () => {
        it('renames the identity', async () => {
            const user = userEvent.setup({ delay: null });
            render(<IdentitiesTab />);
            await manage(user, 'Rename');

            const dialog = await screen.findByRole('dialog', { name: 'Rename Identity' });
            expect(within(dialog).getByText('Rename Alice to')).toBeInTheDocument();
            await user.type(within(dialog).getByLabelText('New Name'), ' Alicia ');
            await user.click(within(dialog).getByRole('button', { name: 'Rename' }));

            await waitFor(() => expect(refreshAll).toHaveBeenCalledTimes(1));
            expect(keymaster.renameId).toHaveBeenCalledExactlyOnceWith('Alice', 'Alicia');
            await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        });

        it('refuses an empty new name', async () => {
            const user = userEvent.setup({ delay: null });
            render(<IdentitiesTab />);
            await manage(user, 'Rename');

            const dialog = await screen.findByRole('dialog', { name: 'Rename Identity' });
            await user.click(within(dialog).getByRole('button', { name: 'Rename' }));

            expect(setError).toHaveBeenCalledWith('Name cannot be empty');
            expect(keymaster.renameId).not.toHaveBeenCalled();
        });

        it('reports a failed rename', async () => {
            const user = userEvent.setup({ delay: null });
            keymaster.renameId.mockRejectedValue(failure);
            render(<IdentitiesTab />);
            await manage(user, 'Rename');

            const dialog = await screen.findByRole('dialog', { name: 'Rename Identity' });
            await user.type(within(dialog).getByLabelText('New Name'), 'Alicia');
            await user.click(within(dialog).getByRole('button', { name: 'Rename' }));

            await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
            expect(refreshAll).not.toHaveBeenCalled();
        });

        it('renames nothing when the dialog is cancelled', async () => {
            const user = userEvent.setup({ delay: null });
            render(<IdentitiesTab />);
            await manage(user, 'Rename');

            const dialog = await screen.findByRole('dialog', { name: 'Rename Identity' });
            await user.type(within(dialog).getByLabelText('New Name'), 'Alicia');
            await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

            await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
            expect(keymaster.renameId).not.toHaveBeenCalled();
        });

        it('backs the identity up', async () => {
            const user = userEvent.setup({ delay: null });
            keymaster.backupId.mockResolvedValue(true);
            render(<IdentitiesTab />);
            await manage(user, 'Backup');

            await waitFor(() => expect(setSuccess).toHaveBeenCalledWith('Alice backup succeeded'));
            expect(keymaster.backupId).toHaveBeenCalledExactlyOnceWith('Alice');
            expect(setError).not.toHaveBeenCalled();
        });

        it('reports a backup the wallet says did not succeed', async () => {
            const user = userEvent.setup({ delay: null });
            keymaster.backupId.mockResolvedValue(false);
            render(<IdentitiesTab />);
            await manage(user, 'Backup');

            await waitFor(() => expect(setError).toHaveBeenCalledWith('Alice backup failed'));
            expect(setSuccess).not.toHaveBeenCalled();
        });

        it('reports a backup that throws', async () => {
            const user = userEvent.setup({ delay: null });
            keymaster.backupId.mockRejectedValue(failure);
            render(<IdentitiesTab />);
            await manage(user, 'Backup');

            await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
            expect(setSuccess).not.toHaveBeenCalled();
        });

        it('recovers an identity from its DID', async () => {
            const user = userEvent.setup({ delay: null });
            keymaster.recoverId.mockResolvedValue('Bob');
            render(<IdentitiesTab />);
            await manage(user, 'Recover');

            const dialog = await screen.findByRole('dialog', { name: 'Recover Identity' });
            await user.type(within(dialog).getByLabelText('DID'), 'did:cid:bob');
            await user.click(within(dialog).getByRole('button', { name: 'Recover' }));

            await waitFor(() => expect(setSuccess).toHaveBeenCalledWith('Bob recovered'));
            expect(keymaster.recoverId).toHaveBeenCalledExactlyOnceWith('did:cid:bob');
            expect(refreshAll).toHaveBeenCalledTimes(1);
        });

        it('recovers nothing when no DID is given', async () => {
            const user = userEvent.setup({ delay: null });
            render(<IdentitiesTab />);
            await manage(user, 'Recover');

            const dialog = await screen.findByRole('dialog', { name: 'Recover Identity' });
            await user.click(within(dialog).getByRole('button', { name: 'Recover' }));

            await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
            expect(keymaster.recoverId).not.toHaveBeenCalled();
            expect(setError).not.toHaveBeenCalled();
        });

        it('reports a failed recovery', async () => {
            const user = userEvent.setup({ delay: null });
            keymaster.recoverId.mockRejectedValue(failure);
            render(<IdentitiesTab />);
            await manage(user, 'Recover');

            const dialog = await screen.findByRole('dialog', { name: 'Recover Identity' });
            await user.type(within(dialog).getByLabelText('DID'), 'did:cid:bob');
            await user.click(within(dialog).getByRole('button', { name: 'Recover' }));

            await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
            expect(refreshAll).not.toHaveBeenCalled();
            expect(setSuccess).not.toHaveBeenCalled();
        });

        it('rotates the identity\'s keys', async () => {
            const user = userEvent.setup({ delay: null });
            render(<IdentitiesTab />);
            await manage(user, 'Rotate keys');

            await waitFor(() => expect(refreshAll).toHaveBeenCalledTimes(1));
            expect(keymaster.rotateKeys).toHaveBeenCalledTimes(1);
        });

        it('reports a failed key rotation', async () => {
            const user = userEvent.setup({ delay: null });
            keymaster.rotateKeys.mockRejectedValue(failure);
            render(<IdentitiesTab />);
            await manage(user, 'Rotate keys');

            await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
            expect(refreshAll).not.toHaveBeenCalled();
        });

        it('migrates the identity to the chosen registry', async () => {
            const user = userEvent.setup({ delay: null });
            render(<IdentitiesTab />);
            await manage(user, 'Migrate registry');

            const dialog = await screen.findByRole('dialog', { name: 'Migrate Identity' });
            expect(within(dialog).getByText('Select registry for Alice')).toBeInTheDocument();
            await choose(user, within(dialog).getByRole('combobox'), 'BTC:mainnet');
            await user.click(within(dialog).getByRole('button', { name: 'Migrate' }));

            await waitFor(() => expect(setSuccess).toHaveBeenCalledWith('Alice migrated to BTC:mainnet'));
            expect(keymaster.changeRegistry).toHaveBeenCalledExactlyOnceWith('Alice', 'BTC:mainnet');
            expect(refreshAll).toHaveBeenCalledTimes(1);
        });

        it('reports a failed migration', async () => {
            const user = userEvent.setup({ delay: null });
            keymaster.changeRegistry.mockRejectedValue(failure);
            render(<IdentitiesTab />);
            await manage(user, 'Migrate registry');

            const dialog = await screen.findByRole('dialog', { name: 'Migrate Identity' });
            await user.click(within(dialog).getByRole('button', { name: 'Migrate' }));

            await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
            expect(keymaster.changeRegistry).toHaveBeenCalledExactlyOnceWith('Alice', 'hyperswarm');
            expect(setSuccess).not.toHaveBeenCalled();
        });

        it('removes the identity once that is confirmed', async () => {
            const user = userEvent.setup({ delay: null });
            render(<IdentitiesTab />);
            await manage(user, 'Remove identity');

            const dialog = await warning('Remove Identity');
            expect(within(dialog).getByText('Are you sure you want to remove Alice?')).toBeInTheDocument();
            expect(keymaster.removeId).not.toHaveBeenCalled();
            await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));

            await waitFor(() => expect(refreshAll).toHaveBeenCalledTimes(1));
            expect(keymaster.removeId).toHaveBeenCalledExactlyOnceWith('Alice');
            expect(screen.queryByRole('dialog')).toBeNull();
        });

        it('keeps the identity when removal is cancelled', async () => {
            const user = userEvent.setup({ delay: null });
            render(<IdentitiesTab />);
            await manage(user, 'Remove identity');

            const dialog = await warning('Remove Identity');
            await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

            expect(screen.queryByRole('dialog')).toBeNull();
            expect(keymaster.removeId).not.toHaveBeenCalled();
        });

        it('reports a failed removal', async () => {
            const user = userEvent.setup({ delay: null });
            keymaster.removeId.mockRejectedValue(failure);
            render(<IdentitiesTab />);
            await manage(user, 'Remove identity');

            const dialog = await warning('Remove Identity');
            await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));

            await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
            expect(refreshAll).not.toHaveBeenCalled();
        });

        it('checks the identity for repair, and shows the repaired document afterwards', async () => {
            const user = userEvent.setup({ delay: null });
            const report = {
                did: DID, type: 'agent', confirmed: true, canRepair: true,
                issues: [{ code: 'missing-operation-permission', message: 'The signing method is not authorized.' }],
                changes: { didDocument: { id: DID } },
            };
            keymaster.checkDID.mockResolvedValue(report);
            keymaster.repairDID.mockImplementation(async () => {
                identity = { repaired: true };
                return { ...report, issues: [], changes: null, canRepair: false, submitted: true };
            });
            render(<IdentitiesTab />);
            await manage(user, 'Repair...');

            const dialog = await screen.findByRole('dialog', { name: 'Check / Repair DID' });
            expect(await within(dialog).findByText('The signing method is not authorized.')).toBeInTheDocument();
            expect(keymaster.checkDID).toHaveBeenCalledExactlyOnceWith(DID);
            expect(keymaster.repairDID).not.toHaveBeenCalled();

            await user.click(within(dialog).getByRole('button', { name: 'Repair DID' }));
            expect(await within(dialog).findByText('Repair accepted and confirmed.')).toBeInTheDocument();
            expect(keymaster.repairDID).toHaveBeenCalledExactlyOnceWith(DID);

            await user.click(within(dialog).getByRole('button', { name: 'Close' }));
            await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
            expect(screen.getByTestId('did-document')).toHaveTextContent('"repaired":true');
        });
    });

    describe('addresses', () => {
        const stored = {
            'bob@example.com': { added: '2026-02-03T04:05:06.000Z' },
            'alice@example.com': { added: '2026-01-02T03:04:05.000Z' },
        };
        // The box that shows the raw answer has no label; it is the last text box.
        const details = () => screen.getAllByRole('textbox').slice(-1)[0] as HTMLTextAreaElement;
        const row = (address: string) => screen.getByRole('row', { name: new RegExp(address) });

        async function showAddresses(user: UserEvent) {
            render(<IdentitiesTab />);
            await openTab(user, 'Addresses');
            await waitFor(() => expect(keymaster.listAddresses).toHaveBeenCalled());
        }

        it('says there are none yet', async () => {
            const user = userEvent.setup({ delay: null });
            await showAddresses(user);

            expect(await screen.findByText('No addresses yet')).toBeInTheDocument();
            expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
            expect(screen.getByRole('button', { name: 'Check' })).toBeDisabled();
        });

        it('lists the wallet\'s addresses in order, with the published one offered for unpublishing', async () => {
            const user = userEvent.setup({ delay: null });
            keymaster.listAddresses.mockResolvedValue(stored);
            identity = { address: ' Bob@Example.com ' };
            await showAddresses(user);

            await screen.findByRole('row', { name: /alice@example.com/ });
            const rows = screen.getAllByRole('row').slice(1);
            expect(rows.map(each => within(each).getAllByRole('cell')[0].textContent)).toStrictEqual(['alice@example.com', 'bob@example.com']);
            expect(within(row('alice@example.com')).getByText('2026-01-02')).toBeInTheDocument();
            expect(within(row('alice@example.com')).getByRole('button', { name: 'Publish' })).toBeEnabled();
            expect(within(row('bob@example.com')).getByRole('button', { name: 'Unpublish' })).toBeEnabled();
            expect(screen.queryByText('No addresses yet')).toBeNull();
            expect(keymaster.resolveDID).toHaveBeenCalledWith('Alice');
        });

        it('reports addresses that cannot be listed', async () => {
            const user = userEvent.setup({ delay: null });
            keymaster.listAddresses.mockRejectedValue(failure);
            await showAddresses(user);

            await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        });

        it('adds an address from a name and a domain, and shows what was stored', async () => {
            const user = userEvent.setup({ delay: null });
            const info = { address: 'bob@example.com', name: 'bob', domain: 'example.com', added: '2026-02-03T04:05:06.000Z' };
            keymaster.getAddress.mockResolvedValue(info);
            await showAddresses(user);
            await user.type(screen.getByLabelText('Name'), 'Bob');
            expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
            await user.type(screen.getByLabelText('Domain'), 'Example.com');
            await user.click(screen.getByRole('button', { name: 'Add' }));

            await waitFor(() => expect(setSuccess).toHaveBeenCalledWith('bob@example.com added'));
            expect(keymaster.addAddress).toHaveBeenCalledExactlyOnceWith('bob@example.com');
            expect(keymaster.getAddress).toHaveBeenCalledExactlyOnceWith('example.com');
            expect(screen.getByLabelText('Name')).toHaveValue('bob');
            expect(screen.getByLabelText('Domain')).toHaveValue('example.com');
            expect(JSON.parse(details().value)).toStrictEqual(info);
            expect(setError).not.toHaveBeenCalled();
        });

        it('reports an address that cannot be added', async () => {
            const user = userEvent.setup({ delay: null });
            keymaster.addAddress.mockRejectedValue(failure);
            await showAddresses(user);
            await user.type(screen.getByLabelText('Name'), 'bob');
            await user.type(screen.getByLabelText('Domain'), 'example.com');
            await user.click(screen.getByRole('button', { name: 'Add' }));

            await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
            expect(setSuccess).not.toHaveBeenCalled();
            expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled();
        });

        it('asks for a name and a domain when what was typed holds neither', async () => {
            const user = userEvent.setup({ delay: null });
            await showAddresses(user);
            // Only what follows the last "@" of a domain is the domain, and only
            // what precedes it in a name is the name.
            await user.type(screen.getByLabelText('Name'), '@');
            await user.type(screen.getByLabelText('Domain'), 'example.com');

            await user.click(screen.getByRole('button', { name: 'Add' }));
            await waitFor(() => expect(setError).toHaveBeenCalledWith('Enter a name and domain'));
            setError.mockClear();
            await user.click(screen.getByRole('button', { name: 'Check' }));
            await waitFor(() => expect(setError).toHaveBeenCalledWith('Enter a name and domain'));
            setError.mockClear();
            await more(user, 'Remove address');
            await waitFor(() => expect(setError).toHaveBeenCalledWith('Select an address or enter a name and domain'));

            expect(keymaster.addAddress).not.toHaveBeenCalled();
            expect(keymaster.checkAddress).not.toHaveBeenCalled();
            expect(keymaster.removeAddress).not.toHaveBeenCalled();
        });

        it('checks whether an address is available', async () => {
            const user = userEvent.setup({ delay: null });
            const result = { address: 'bob@example.com', status: 'available', available: true, did: null };
            keymaster.checkAddress.mockResolvedValue(result);
            await showAddresses(user);
            await user.type(screen.getByLabelText('Name'), 'Bob');
            await user.type(screen.getByLabelText('Domain'), 'example.com');
            await user.click(screen.getByRole('button', { name: 'Check' }));

            await waitFor(() => expect(details().value).not.toBe(''));
            expect(JSON.parse(details().value)).toStrictEqual(result);
            expect(keymaster.checkAddress).toHaveBeenCalledExactlyOnceWith('bob@example.com');
            expect(screen.getByLabelText('Name')).toHaveValue('bob');
        });

        it('reports a check that fails', async () => {
            const user = userEvent.setup({ delay: null });
            keymaster.checkAddress.mockRejectedValue(failure);
            await showAddresses(user);
            await user.type(screen.getByLabelText('Name'), 'bob');
            await user.type(screen.getByLabelText('Domain'), 'example.com');
            await user.click(screen.getByRole('button', { name: 'Check' }));

            await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
            expect(details().value).toBe('');
        });

        it('offers nothing under More until there is something to act on', async () => {
            const user = userEvent.setup({ delay: null });
            await showAddresses(user);
            await user.click(screen.getByRole('button', { name: 'More' }));

            for (const name of ['Get stored address', 'Import from domain', 'Clear fields', 'Remove address']) {
                expect(await screen.findByRole('menuitem', { name })).toHaveAttribute('aria-disabled', 'true');
            }
        });

        it('gets the address stored for a domain', async () => {
            const user = userEvent.setup({ delay: null });
            const info = { address: 'alice@example.com', name: 'alice', domain: 'example.com', added: '2026-01-02T03:04:05.000Z' };
            keymaster.getAddress.mockResolvedValue(info);
            await showAddresses(user);
            await user.type(screen.getByLabelText('Domain'), 'Example.com');
            await more(user, 'Get stored address');

            await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('alice'));
            expect(keymaster.getAddress).toHaveBeenCalledExactlyOnceWith('example.com');
            expect(screen.getByLabelText('Domain')).toHaveValue('example.com');
            expect(JSON.parse(details().value)).toStrictEqual(info);
            expect(setError).not.toHaveBeenCalled();
        });

        it('says so when no address is stored for a domain', async () => {
            const user = userEvent.setup({ delay: null });
            keymaster.getAddress.mockResolvedValue(null);
            await showAddresses(user);
            await user.type(screen.getByLabelText('Domain'), 'example.com');
            await more(user, 'Get stored address');

            await waitFor(() => expect(setError).toHaveBeenCalledWith('No address stored for example.com'));
            expect(details().value).toBe('null');
        });

        it('reports a stored address that cannot be read', async () => {
            const user = userEvent.setup({ delay: null });
            keymaster.getAddress.mockRejectedValue(failure);
            await showAddresses(user);
            await user.type(screen.getByLabelText('Domain'), 'example.com');
            await more(user, 'Get stored address');

            await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        });

        it('asks for a domain when what was typed holds none', async () => {
            const user = userEvent.setup({ delay: null });
            await showAddresses(user);
            await user.type(screen.getByLabelText('Domain'), 'bob@');

            await more(user, 'Get stored address');
            await waitFor(() => expect(setError).toHaveBeenCalledWith('Enter a domain'));
            setError.mockClear();
            await more(user, 'Import from domain');
            await waitFor(() => expect(setError).toHaveBeenCalledWith('Enter a domain'));

            expect(keymaster.getAddress).not.toHaveBeenCalled();
            expect(keymaster.importAddress).not.toHaveBeenCalled();
        });

        it('imports the addresses a domain holds for this identity', async () => {
            const user = userEvent.setup({ delay: null });
            const imported = { 'alice@example.com': { added: '2026-01-02T03:04:05.000Z' } };
            keymaster.importAddress.mockResolvedValue(imported);
            await showAddresses(user);
            await user.type(screen.getByLabelText('Domain'), 'Example.com');
            keymaster.listAddresses.mockResolvedValue(imported);
            await more(user, 'Import from domain');

            await waitFor(() => expect(setSuccess).toHaveBeenCalledWith('Imported 1 address(es) from example.com'));
            expect(keymaster.importAddress).toHaveBeenCalledExactlyOnceWith('example.com');
            expect(screen.getByLabelText('Name')).toHaveValue('alice');
            expect(screen.getByLabelText('Domain')).toHaveValue('example.com');
            expect(JSON.parse(details().value)).toStrictEqual(imported);
            expect(row('alice@example.com')).toHaveClass('Mui-selected');
        });

        it('says so when a domain has nothing to import', async () => {
            const user = userEvent.setup({ delay: null });
            keymaster.importAddress.mockResolvedValue({});
            await showAddresses(user);
            await user.type(screen.getByLabelText('Domain'), 'example.com');
            await more(user, 'Import from domain');

            await waitFor(() => expect(setError).toHaveBeenCalledWith('No addresses imported from example.com'));
            expect(setSuccess).not.toHaveBeenCalled();
        });

        it('reports an import that fails', async () => {
            const user = userEvent.setup({ delay: null });
            keymaster.importAddress.mockRejectedValue(failure);
            await showAddresses(user);
            await user.type(screen.getByLabelText('Domain'), 'example.com');
            await more(user, 'Import from domain');

            await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        });

        it('selects a listed address and shows what is stored for it', async () => {
            const user = userEvent.setup({ delay: null });
            const info = { address: 'bob@example.com', name: 'bob', domain: 'example.com', added: '2026-02-03T04:05:06.000Z' };
            keymaster.listAddresses.mockResolvedValue(stored);
            keymaster.getAddress.mockResolvedValue(info);
            await showAddresses(user);
            await user.click(within(await screen.findByRole('row', { name: /bob@example.com/ })).getByRole('button', { name: 'Select' }));

            await waitFor(() => expect(details().value).not.toBe(''));
            expect(keymaster.getAddress).toHaveBeenCalledExactlyOnceWith('example.com');
            expect(screen.getByLabelText('Name')).toHaveValue('bob');
            expect(screen.getByLabelText('Domain')).toHaveValue('example.com');
            expect(row('bob@example.com')).toHaveClass('Mui-selected');
            expect(row('alice@example.com')).not.toHaveClass('Mui-selected');
        });

        it('clears the fields and the details', async () => {
            const user = userEvent.setup({ delay: null });
            keymaster.checkAddress.mockResolvedValue({ status: 'available' });
            await showAddresses(user);
            await user.type(screen.getByLabelText('Name'), 'bob');
            await user.type(screen.getByLabelText('Domain'), 'example.com');
            await user.click(screen.getByRole('button', { name: 'Check' }));
            await waitFor(() => expect(details().value).not.toBe(''));
            await more(user, 'Clear fields');

            await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue(''));
            expect(screen.getByLabelText('Domain')).toHaveValue('');
            expect(details().value).toBe('');
        });

        it('publishes an address on the identity', async () => {
            const user = userEvent.setup({ delay: null });
            keymaster.listAddresses.mockResolvedValue(stored);
            await showAddresses(user);
            await user.click(within(await screen.findByRole('row', { name: /alice@example.com/ })).getByRole('button', { name: 'Publish' }));

            await waitFor(() => expect(setSuccess).toHaveBeenCalledWith('alice@example.com published'));
            expect(keymaster.publishAddress).toHaveBeenCalledExactlyOnceWith('alice@example.com', 'Alice');
            expect(within(row('alice@example.com')).getByRole('button', { name: 'Unpublish' })).toBeInTheDocument();
            expect(within(row('bob@example.com')).getByRole('button', { name: 'Publish' })).toBeInTheDocument();
        });

        it('reports an address that cannot be published', async () => {
            const user = userEvent.setup({ delay: null });
            keymaster.listAddresses.mockResolvedValue(stored);
            keymaster.publishAddress.mockRejectedValue(failure);
            await showAddresses(user);
            await user.click(within(await screen.findByRole('row', { name: /alice@example.com/ })).getByRole('button', { name: 'Publish' }));

            await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
            expect(within(row('alice@example.com')).getByRole('button', { name: 'Publish' })).toBeEnabled();
            expect(setSuccess).not.toHaveBeenCalled();
        });

        it('unpublishes the published address', async () => {
            const user = userEvent.setup({ delay: null });
            keymaster.listAddresses.mockResolvedValue(stored);
            identity = { address: 'alice@example.com' };
            await showAddresses(user);
            await user.click(within(await screen.findByRole('row', { name: /alice@example.com/ })).getByRole('button', { name: 'Unpublish' }));

            await waitFor(() => expect(setSuccess).toHaveBeenCalledWith('Address unpublished'));
            expect(keymaster.unpublishAddress).toHaveBeenCalledExactlyOnceWith('Alice');
            expect(within(row('alice@example.com')).getByRole('button', { name: 'Publish' })).toBeInTheDocument();
        });

        it('reports an address that cannot be unpublished', async () => {
            const user = userEvent.setup({ delay: null });
            keymaster.listAddresses.mockResolvedValue(stored);
            keymaster.unpublishAddress.mockRejectedValue(failure);
            identity = { address: 'alice@example.com' };
            await showAddresses(user);
            await user.click(within(await screen.findByRole('row', { name: /alice@example.com/ })).getByRole('button', { name: 'Unpublish' }));

            await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
            expect(within(row('alice@example.com')).getByRole('button', { name: 'Unpublish' })).toBeEnabled();
        });

        it('removes the address typed in, leaving its domain behind', async () => {
            const user = userEvent.setup({ delay: null });
            keymaster.listAddresses.mockResolvedValue(stored);
            identity = { address: 'alice@example.com' };
            await showAddresses(user);
            await user.type(screen.getByLabelText('Name'), 'Bob');
            await user.type(screen.getByLabelText('Domain'), 'example.com');
            await more(user, 'Remove address');

            await waitFor(() => expect(setSuccess).toHaveBeenCalledWith('bob@example.com removed'));
            expect(keymaster.removeAddress).toHaveBeenCalledExactlyOnceWith('bob@example.com');
            // It was not the published one, so the identity is left as it is.
            expect(keymaster.unpublishAddress).not.toHaveBeenCalled();
        });

        it('unpublishes an address when the one removed is the published one', async () => {
            const user = userEvent.setup({ delay: null });
            keymaster.listAddresses.mockResolvedValue(stored);
            keymaster.getAddress.mockResolvedValue({ address: 'alice@example.com', name: 'alice' });
            identity = { address: 'alice@example.com' };
            await showAddresses(user);
            await user.click(within(await screen.findByRole('row', { name: /alice@example.com/ })).getByRole('button', { name: 'Select' }));
            await waitFor(() => expect(details().value).not.toBe(''));
            await more(user, 'Remove address');

            await waitFor(() => expect(setSuccess).toHaveBeenCalledWith('alice@example.com removed'));
            expect(keymaster.removeAddress).toHaveBeenCalledExactlyOnceWith('alice@example.com');
            expect(keymaster.unpublishAddress).toHaveBeenCalledExactlyOnceWith('Alice');
            expect(details().value).toBe('');
        });

        it('reports an address that cannot be removed', async () => {
            const user = userEvent.setup({ delay: null });
            keymaster.removeAddress.mockRejectedValue(failure);
            await showAddresses(user);
            await user.type(screen.getByLabelText('Name'), 'bob');
            await user.type(screen.getByLabelText('Domain'), 'example.com');
            await more(user, 'Remove address');

            await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
            expect(setSuccess).not.toHaveBeenCalled();
        });
    });

    describe('name', () => {
        it('shows the name the identity has and replaces it', async () => {
            const user = userEvent.setup({ delay: null });
            identity = { name: 'Alice A.' };
            render(<IdentitiesTab />);
            await openTab(user, 'Name');

            await waitFor(() => expect(screen.getByLabelText('Current Name')).toHaveValue('Alice A.'));
            expect(screen.getByLabelText('Name')).toHaveValue('Alice A.');
            await user.clear(screen.getByLabelText('Name'));
            expect(screen.getByRole('button', { name: 'Set Name' })).toBeDisabled();
            await user.type(screen.getByLabelText('Name'), '  Alice B. ');
            await user.click(screen.getByRole('button', { name: 'Set Name' }));

            await waitFor(() => expect(setSuccess).toHaveBeenCalledWith('Name updated'));
            expect(keymaster.mergeData).toHaveBeenCalledExactlyOnceWith('Alice', { name: 'Alice B.' });
            expect(screen.getByLabelText('Current Name')).toHaveValue('Alice B.');
        });

        it('has no name to remove when none is set', async () => {
            const user = userEvent.setup({ delay: null });
            render(<IdentitiesTab />);
            await screen.findByTestId('did-document');
            await openTab(user, 'Name');

            expect(screen.getByLabelText('Current Name')).toHaveValue('');
            expect(screen.getByLabelText('Current Name')).toHaveAttribute('placeholder', 'No name set');
            expect(screen.getByRole('button', { name: 'Remove Name' })).toBeDisabled();
            expect(screen.getByRole('button', { name: 'Set Name' })).toBeDisabled();
        });

        it('ignores a name that is not text', async () => {
            const user = userEvent.setup({ delay: null });
            identity = { name: { first: 'Alice' } };
            render(<IdentitiesTab />);
            await screen.findByTestId('did-document');
            await openTab(user, 'Name');

            expect(screen.getByLabelText('Current Name')).toHaveValue('');
            expect(screen.getByRole('button', { name: 'Remove Name' })).toBeDisabled();
        });

        it('removes the name', async () => {
            const user = userEvent.setup({ delay: null });
            identity = { name: 'Alice A.' };
            render(<IdentitiesTab />);
            await openTab(user, 'Name');
            await waitFor(() => expect(screen.getByRole('button', { name: 'Remove Name' })).toBeEnabled());
            await user.click(screen.getByRole('button', { name: 'Remove Name' }));

            await waitFor(() => expect(setSuccess).toHaveBeenCalledWith('Name removed'));
            expect(keymaster.mergeData).toHaveBeenCalledExactlyOnceWith('Alice', { name: null });
            expect(screen.getByLabelText('Current Name')).toHaveValue('');
            expect(screen.getByLabelText('Name')).toHaveValue('');
        });

        it.each(['Set Name', 'Remove Name'])('reports a failure of %s and keeps the name shown', async button => {
            const user = userEvent.setup({ delay: null });
            identity = { name: 'Alice A.' };
            keymaster.mergeData.mockRejectedValue(failure);
            render(<IdentitiesTab />);
            await openTab(user, 'Name');
            await waitFor(() => expect(screen.getByRole('button', { name: button })).toBeEnabled());
            await user.click(screen.getByRole('button', { name: button }));

            await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
            expect(setSuccess).not.toHaveBeenCalled();
            expect(screen.getByLabelText('Current Name')).toHaveValue('Alice A.');
        });

        it('warns when the identity cannot be read', async () => {
            const user = userEvent.setup({ delay: null });
            keymaster.resolveDID.mockRejectedValue(failure);
            render(<IdentitiesTab />);
            await openTab(user, 'Name');

            expect(await screen.findByText('Unable to load identity details')).toBeInTheDocument();
            expect(screen.getByLabelText('Current Name')).toHaveValue('');
        });
    });

    describe('avatar', () => {
        const picture = () => screen.queryByRole('img', { name: 'Alice avatar' });

        it('says no avatar is set', async () => {
            const user = userEvent.setup({ delay: null });
            render(<IdentitiesTab />);
            await screen.findByTestId('did-document');
            await openTab(user, 'Avatar');

            expect(await screen.findByText('No avatar set')).toBeInTheDocument();
            expect(screen.getByText('Current Avatar')).toBeInTheDocument();
            expect(screen.getByLabelText('Current Avatar DID')).toHaveValue('');
            expect(screen.getByRole('button', { name: 'Remove Avatar' })).toBeDisabled();
            expect(screen.getByRole('button', { name: 'Preview' })).toBeDisabled();
            expect(picture()).toBeNull();
        });

        it('shows the identity\'s avatar and the alias it has in the wallet', async () => {
            const user = userEvent.setup({ delay: null });
            identity = { avatar: ` ${CAT} ` };
            render(<IdentitiesTab />);
            await openTab(user, 'Avatar');

            await waitFor(() => expect(picture()).toHaveAttribute('src', PNG_URL));
            expect(gatekeeper.getData).toHaveBeenCalledWith(`cid-of-${CAT}`);
            expect(screen.getByLabelText('Current Avatar DID')).toHaveValue(CAT);
            expect(screen.getByRole('combobox')).toHaveTextContent('cat');
            expect(screen.getByRole('button', { name: 'Remove Avatar' })).toBeEnabled();
        });

        it('warns when the avatar is not an image', async () => {
            const user = userEvent.setup({ delay: null });
            identity = { avatar: 'did:cid:bob' };
            assets['did:cid:bob'] = { didDocument: { id: 'did:cid:bob' }, didDocumentData: {} };
            render(<IdentitiesTab />);
            await openTab(user, 'Avatar');

            expect(await screen.findByText('The current avatar does not resolve to an image asset.')).toBeInTheDocument();
            expect(screen.getByText('Avatar preview unavailable')).toBeInTheDocument();
            expect(screen.getByLabelText('Current Avatar DID')).toHaveValue('did:cid:bob');
            expect(picture()).toBeNull();
        });

        it('warns when the node has no data for the avatar\'s image', async () => {
            const user = userEvent.setup({ delay: null });
            identity = { avatar: CAT };
            gatekeeper.getData.mockResolvedValue(null);
            render(<IdentitiesTab />);
            await openTab(user, 'Avatar');

            expect(await screen.findByText('The current avatar does not resolve to an image asset.')).toBeInTheDocument();
            expect(picture()).toBeNull();
        });

        it('says no avatar is set when the identity\'s document has no data', async () => {
            const user = userEvent.setup({ delay: null });
            keymaster.resolveDID.mockResolvedValue({ didDocument: { id: DID } });
            render(<IdentitiesTab />);
            await screen.findByTestId('did-document');
            await openTab(user, 'Avatar');

            expect(await screen.findByText('No avatar set')).toBeInTheDocument();
            expect(screen.queryByText(/Cannot read properties/)).toBeNull();
            expect(screen.getByRole('button', { name: 'Remove Avatar' })).toBeDisabled();
        });

        it('warns when the avatar\'s document has no data', async () => {
            const user = userEvent.setup({ delay: null });
            identity = { avatar: 'did:cid:gone' };
            assets['did:cid:gone'] = { didDocument: { id: 'did:cid:gone' } };
            render(<IdentitiesTab />);
            await openTab(user, 'Avatar');

            expect(await screen.findByText('The current avatar does not resolve to an image asset.')).toBeInTheDocument();
            expect(screen.getByLabelText('Current Avatar DID')).toHaveValue('did:cid:gone');
            expect(screen.getByRole('button', { name: 'Remove Avatar' })).toBeEnabled();
        });

        it('says why when the avatar does not resolve', async () => {
            const user = userEvent.setup({ delay: null });
            identity = { avatar: 'did:cid:missing' };
            render(<IdentitiesTab />);
            await openTab(user, 'Avatar');

            expect(await screen.findByText('unknown DID did:cid:missing')).toBeInTheDocument();
            expect(screen.getByLabelText('Current Avatar DID')).toHaveValue('did:cid:missing');
            // It can still be taken off the identity.
            expect(screen.getByRole('button', { name: 'Remove Avatar' })).toBeEnabled();
        });

        it('says why when the identity does not resolve', async () => {
            const user = userEvent.setup({ delay: null });
            keymaster.resolveDID.mockRejectedValue({ error: 'node unreachable' });
            render(<IdentitiesTab />);
            await openTab(user, 'Avatar');

            expect(await screen.findByText('node unreachable')).toBeInTheDocument();
            expect(screen.getByRole('button', { name: 'Remove Avatar' })).toBeDisabled();
        });

        it('previews an image chosen by alias, then sets it as the avatar', async () => {
            const user = userEvent.setup({ delay: null });
            const changed = vi.fn();
            window.addEventListener('archon:avatar-changed', changed);
            render(<IdentitiesTab />);
            await screen.findByTestId('did-document');
            await openTab(user, 'Avatar');
            await choose(user, screen.getByRole('combobox'), 'dog');
            await user.click(screen.getByRole('button', { name: 'Preview' }));

            await waitFor(() => expect(picture()).toHaveAttribute('src', PNG_URL));
            expect(keymaster.resolveDID).toHaveBeenCalledWith('dog');
            expect(screen.getByText('Avatar Preview')).toBeInTheDocument();
            expect(screen.getByLabelText('Preview Avatar DID')).toHaveValue(DOG);
            expect(keymaster.mergeData).not.toHaveBeenCalled();

            await user.click(screen.getByRole('button', { name: 'Set Avatar' }));

            await waitFor(() => expect(setSuccess).toHaveBeenCalledWith('Avatar updated'));
            window.removeEventListener('archon:avatar-changed', changed);
            expect(keymaster.mergeData).toHaveBeenCalledExactlyOnceWith('Alice', { avatar: DOG });
            expect(changed).toHaveBeenCalledTimes(1);
            expect(screen.getByText('Current Avatar')).toBeInTheDocument();
            expect(screen.getByLabelText('Current Avatar DID')).toHaveValue(DOG);
            expect(screen.getByRole('combobox')).toHaveTextContent('dog');
            expect(picture()).toHaveAttribute('src', PNG_URL);
        });

        it('reports an avatar that cannot be set and keeps the preview', async () => {
            const user = userEvent.setup({ delay: null });
            keymaster.mergeData.mockRejectedValue(failure);
            render(<IdentitiesTab />);
            await screen.findByTestId('did-document');
            await openTab(user, 'Avatar');
            await choose(user, screen.getByRole('combobox'), 'dog');
            await user.click(screen.getByRole('button', { name: 'Preview' }));
            await user.click(await screen.findByRole('button', { name: 'Set Avatar' }));

            await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
            expect(setSuccess).not.toHaveBeenCalled();
            expect(screen.getByLabelText('Preview Avatar DID')).toHaveValue(DOG);
        });

        it('previews an image given by DID and goes back to the current avatar when the preview is cleared', async () => {
            const user = userEvent.setup({ delay: null });
            identity = { avatar: CAT };
            render(<IdentitiesTab />);
            await openTab(user, 'Avatar');
            await waitFor(() => expect(picture()).not.toBeNull());
            await user.click(screen.getByRole('radio', { name: 'DID' }));

            // The field starts from the avatar the identity has.
            expect(screen.getByLabelText('Avatar DID')).toHaveValue(CAT);
            await user.clear(screen.getByLabelText('Avatar DID'));
            expect(screen.getByRole('button', { name: 'Preview' })).toBeDisabled();
            await user.type(screen.getByLabelText('Avatar DID'), ` ${DOG} `);
            await user.click(screen.getByRole('button', { name: 'Preview' }));

            await waitFor(() => expect(screen.getByLabelText('Preview Avatar DID')).toHaveValue(DOG));
            expect(keymaster.resolveDID).toHaveBeenCalledWith(DOG);
            await user.click(screen.getByRole('button', { name: 'Clear Preview' }));

            expect(screen.getByLabelText('Current Avatar DID')).toHaveValue(CAT);
            expect(keymaster.mergeData).not.toHaveBeenCalled();
        });

        it('does not let something that is not an image be set as the avatar', async () => {
            const user = userEvent.setup({ delay: null });
            assets['did:cid:bob'] = { didDocument: { id: 'did:cid:bob' }, didDocumentData: { file: { cid: 'cid-of-bob', type: 'text/plain' } } };
            render(<IdentitiesTab />);
            await screen.findByTestId('did-document');
            await openTab(user, 'Avatar');
            await user.click(screen.getByRole('radio', { name: 'DID' }));
            await user.type(screen.getByLabelText('Avatar DID'), 'did:cid:bob');
            await user.click(screen.getByRole('button', { name: 'Preview' }));

            expect(await screen.findByText('Avatar must resolve to an image asset DID')).toBeInTheDocument();
            expect(screen.getByText('Preview unavailable')).toBeInTheDocument();
            expect(screen.getByLabelText('Preview Avatar DID')).toHaveValue('did:cid:bob');
            expect(screen.getByRole('button', { name: 'Set Avatar' })).toBeDisabled();
            expect(picture()).toBeNull();

            // Choosing another source drops the preview.
            await user.click(screen.getByRole('radio', { name: 'Image Alias' }));
            expect(screen.queryByText('Avatar must resolve to an image asset DID')).toBeNull();
            expect(screen.getByText('Current Avatar')).toBeInTheDocument();
        });

        it('does not let a DID whose document has no data be set as the avatar', async () => {
            const user = userEvent.setup({ delay: null });
            assets['did:cid:gone'] = { didDocument: { id: 'did:cid:gone' } };
            render(<IdentitiesTab />);
            await screen.findByTestId('did-document');
            await openTab(user, 'Avatar');
            await user.click(screen.getByRole('radio', { name: 'DID' }));
            await user.type(screen.getByLabelText('Avatar DID'), 'did:cid:gone');
            await user.click(screen.getByRole('button', { name: 'Preview' }));

            expect(await screen.findByText('Avatar must resolve to an image asset DID')).toBeInTheDocument();
            expect(screen.getByLabelText('Preview Avatar DID')).toHaveValue('did:cid:gone');
            expect(screen.getByRole('button', { name: 'Set Avatar' })).toBeDisabled();
        });

        it('says why when the DID to preview does not resolve', async () => {
            const user = userEvent.setup({ delay: null });
            render(<IdentitiesTab />);
            await screen.findByTestId('did-document');
            await openTab(user, 'Avatar');
            await user.click(screen.getByRole('radio', { name: 'DID' }));
            await user.type(screen.getByLabelText('Avatar DID'), 'did:cid:missing');
            await user.click(screen.getByRole('button', { name: 'Preview' }));

            expect(await screen.findByText('unknown DID did:cid:missing')).toBeInTheDocument();
            expect(screen.getByRole('button', { name: 'Set Avatar' })).toBeDisabled();
            expect(screen.getByRole('button', { name: 'Clear Preview' })).toBeEnabled();
        });

        it('reports a preview whose document names no DID', async () => {
            const user = userEvent.setup({ delay: null });
            assets['did:cid:odd'] = { didDocumentData: {} };
            render(<IdentitiesTab />);
            await screen.findByTestId('did-document');
            await openTab(user, 'Avatar');
            await user.click(screen.getByRole('radio', { name: 'DID' }));
            await user.type(screen.getByLabelText('Avatar DID'), 'did:cid:odd');
            await user.click(screen.getByRole('button', { name: 'Preview' }));

            await waitFor(() => expect(setError).toHaveBeenCalledWith('Unable to resolve avatar DID'));
            expect(screen.getByText('Current Avatar')).toBeInTheDocument();
        });

        it('removes the avatar', async () => {
            const user = userEvent.setup({ delay: null });
            const changed = vi.fn();
            window.addEventListener('archon:avatar-changed', changed);
            identity = { avatar: CAT };
            render(<IdentitiesTab />);
            await openTab(user, 'Avatar');
            await waitFor(() => expect(screen.getByRole('button', { name: 'Remove Avatar' })).toBeEnabled());
            await user.click(screen.getByRole('button', { name: 'Remove Avatar' }));

            await waitFor(() => expect(setSuccess).toHaveBeenCalledWith('Avatar removed'));
            window.removeEventListener('archon:avatar-changed', changed);
            expect(keymaster.mergeData).toHaveBeenCalledExactlyOnceWith('Alice', { avatar: null });
            expect(changed).toHaveBeenCalledTimes(1);
            expect(screen.getByText('No avatar set')).toBeInTheDocument();
            expect(screen.getByLabelText('Current Avatar DID')).toHaveValue('');
            expect(picture()).toBeNull();
        });

        it('reports an avatar that cannot be removed and keeps it shown', async () => {
            const user = userEvent.setup({ delay: null });
            identity = { avatar: CAT };
            keymaster.mergeData.mockRejectedValue(failure);
            render(<IdentitiesTab />);
            await openTab(user, 'Avatar');
            await waitFor(() => expect(screen.getByRole('button', { name: 'Remove Avatar' })).toBeEnabled());
            await user.click(screen.getByRole('button', { name: 'Remove Avatar' }));

            await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
            expect(screen.getByLabelText('Current Avatar DID')).toHaveValue(CAT);
        });

        describe('uploading an image', () => {
            const file = () => new File([new Uint8Array([1, 2, 3])], 'portrait.png', { type: 'image/png' });
            const input = () => document.getElementById('avatarUpload') as HTMLInputElement;

            async function showUpload(user: UserEvent) {
                render(<IdentitiesTab />);
                await screen.findByTestId('did-document');
                await openTab(user, 'Avatar');
                await user.click(screen.getByRole('radio', { name: 'Upload Image' }));
            }

            it('creates the image on the chosen registry, names it after the file and previews it', async () => {
                const user = userEvent.setup({ delay: null });
                const NEW = 'did:cid:portrait';
                assets[NEW] = imageAsset(NEW);
                keymaster.createImage.mockResolvedValue(NEW);
                keymaster.listAliases.mockResolvedValue({ cat: CAT });
                await showUpload(user);
                expect(screen.getByRole('combobox')).toHaveTextContent('hyperswarm');
                await user.upload(input(), file());

                await waitFor(() => expect(setSuccess).toHaveBeenCalledWith(
                    'Avatar image uploaded successfully: portrait.png. Review the preview, then set the avatar.'));
                expect(keymaster.createImage).toHaveBeenCalledExactlyOnceWith(expect.anything(), { registry: 'hyperswarm' });
                expect([...keymaster.createImage.mock.calls[0][0]]).toStrictEqual([1, 2, 3]);
                expect(keymaster.addAlias).toHaveBeenCalledExactlyOnceWith('portrait.png', NEW);
                expect(refreshAll).toHaveBeenCalledTimes(1);
                expect(screen.getByLabelText('Preview Avatar DID')).toHaveValue(NEW);
                expect(picture()).toHaveAttribute('src', PNG_URL);
                // Nothing is set until the preview is accepted.
                expect(keymaster.mergeData).not.toHaveBeenCalled();
            });

            it('picks another alias when the file\'s name is taken', async () => {
                const user = userEvent.setup({ delay: null });
                const NEW = 'did:cid:portrait';
                assets[NEW] = imageAsset(NEW);
                keymaster.createImage.mockResolvedValue(NEW);
                keymaster.listAliases.mockResolvedValue({ 'portrait.png': CAT, 'portrait.png (1)': DOG });
                await showUpload(user);
                await user.upload(input(), file());

                await waitFor(() => expect(keymaster.addAlias).toHaveBeenCalledExactlyOnceWith('portrait.png (2)', NEW));
            });

            it('reports an image that cannot be created', async () => {
                const user = userEvent.setup({ delay: null });
                keymaster.createImage.mockRejectedValue(failure);
                await showUpload(user);
                await user.upload(input(), file());

                await waitFor(() => expect(setError).toHaveBeenCalledExactlyOnceWith(failure));
                expect(keymaster.addAlias).not.toHaveBeenCalled();
                expect(setSuccess).not.toHaveBeenCalled();
            });

            it('reports a Keymaster error from the upload as it is given', async () => {
                const user = userEvent.setup({ delay: null });
                const refusal = { error: 'Image too large' };
                keymaster.createImage.mockRejectedValue(refusal);
                await showUpload(user);
                await user.upload(input(), file());

                await waitFor(() => expect(setError).toHaveBeenCalledExactlyOnceWith(refusal));
            });

            // The reader reports a failure with an event; what went wrong is the reader's `error`.
            function failRead(error: DOMException | null) {
                return vi.spyOn(FileReader.prototype, 'readAsArrayBuffer').mockImplementation(function (this: FileReader) {
                    Object.defineProperty(this, 'error', { value: error });
                    this.onerror?.(new ProgressEvent('error') as ProgressEvent<FileReader>);
                });
            }

            it('reports why a file cannot be read', async () => {
                const user = userEvent.setup({ delay: null });
                const unreadable = new DOMException('The file could not be read', 'NotReadableError');
                const read = failRead(unreadable);
                await showUpload(user);
                await user.upload(input(), file());
                read.mockRestore();

                expect(setError).toHaveBeenCalledExactlyOnceWith(unreadable);
                expect(keymaster.createImage).not.toHaveBeenCalled();
            });

            it('says a file cannot be read when the reader does not say why', async () => {
                const user = userEvent.setup({ delay: null });
                const read = failRead(null);
                await showUpload(user);
                await user.upload(input(), file());
                read.mockRestore();

                expect(setError).toHaveBeenCalledExactlyOnceWith('Unable to read the file');
                expect(keymaster.createImage).not.toHaveBeenCalled();
            });

            it('does nothing when the file picker is closed without a file', async () => {
                const user = userEvent.setup({ delay: null });
                await showUpload(user);
                fireEvent.change(input(), { target: { files: [] } });

                expect(keymaster.createImage).not.toHaveBeenCalled();
                expect(setError).not.toHaveBeenCalled();
            });

            it('opens the file picker from the button, and offers the registries', async () => {
                const user = userEvent.setup({ delay: null });
                await showUpload(user);
                const opened = vi.spyOn(input(), 'click');
                await user.click(screen.getByRole('button', { name: 'Upload Image...' }));
                expect(opened).toHaveBeenCalledTimes(1);

                await choose(user, screen.getByRole('combobox'), 'BTC:mainnet');
                expect(variables.setRegistry).toHaveBeenCalledWith('BTC:mainnet');
            });

            it('does not offer an upload while no registry is set', async () => {
                const user = userEvent.setup({ delay: null });
                variables.registry = '';
                await showUpload(user);

                expect(screen.getByRole('button', { name: 'Upload Image...' })).toBeDisabled();
            });
        });
    });

    describe('nostr', () => {
        const keys = { npub: 'npub1alice', pubkey: 'a1b2c3' };

        async function showNostr(user: UserEvent) {
            render(<IdentitiesTab />);
            await screen.findByTestId('did-document');
            await openTab(user, 'Nostr');
        }

        it('adds Nostr keys to an identity that has none', async () => {
            const user = userEvent.setup({ delay: null });
            keymaster.addNostr.mockResolvedValue(keys);
            await showNostr(user);
            expect(screen.getByText('No Nostr keys')).toBeInTheDocument();
            expect(screen.queryByRole('button', { name: 'Show nsec' })).toBeNull();
            await user.click(screen.getByRole('button', { name: 'Add Nostr' }));

            await waitFor(() => expect(setSuccess).toHaveBeenCalledWith('Nostr keys added'));
            expect(screen.getByText('npub: npub1alice')).toBeInTheDocument();
            expect(screen.getByText('pubkey: a1b2c3')).toBeInTheDocument();
            expect(screen.getByRole('button', { name: 'Remove Nostr' })).toBeInTheDocument();
            expect(screen.queryByRole('button', { name: 'Add Nostr' })).toBeNull();
        });

        it('reports keys that cannot be added', async () => {
            const user = userEvent.setup({ delay: null });
            keymaster.addNostr.mockRejectedValue(failure);
            await showNostr(user);
            await user.click(screen.getByRole('button', { name: 'Add Nostr' }));

            await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
            expect(screen.getByText('No Nostr keys')).toBeInTheDocument();
        });

        it('imports an nsec', async () => {
            const user = userEvent.setup({ delay: null });
            keymaster.importNostr.mockResolvedValue(keys);
            await showNostr(user);
            await user.click(screen.getByRole('button', { name: 'Import nsec' }));

            const dialog = await screen.findByRole('dialog', { name: 'Import Nostr nsec' });
            const field = within(dialog).getByLabelText('nsec');
            // The key is hidden as it is typed.
            expect(field).toHaveAttribute('type', 'password');
            await user.type(field, 'nsec1secret');
            await user.click(within(dialog).getByRole('button', { name: 'Import' }));

            await waitFor(() => expect(setSuccess).toHaveBeenCalledWith('Nostr keys imported'));
            expect(keymaster.importNostr).toHaveBeenCalledExactlyOnceWith('nsec1secret');
            expect(screen.getByText('npub: npub1alice')).toBeInTheDocument();
        });

        it('imports nothing when no nsec is given or the dialog is cancelled', async () => {
            const user = userEvent.setup({ delay: null });
            await showNostr(user);
            await user.click(screen.getByRole('button', { name: 'Import nsec' }));
            await user.click(within(await screen.findByRole('dialog', { name: 'Import Nostr nsec' })).getByRole('button', { name: 'Import' }));
            await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

            await user.click(screen.getByRole('button', { name: 'Import nsec' }));
            const dialog = await screen.findByRole('dialog', { name: 'Import Nostr nsec' });
            await user.type(within(dialog).getByLabelText('nsec'), 'nsec1secret');
            await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
            await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

            expect(keymaster.importNostr).not.toHaveBeenCalled();
            expect(setError).not.toHaveBeenCalled();
        });

        it('reports an nsec that cannot be imported', async () => {
            const user = userEvent.setup({ delay: null });
            keymaster.importNostr.mockRejectedValue(failure);
            await showNostr(user);
            await user.click(screen.getByRole('button', { name: 'Import nsec' }));
            const dialog = await screen.findByRole('dialog', { name: 'Import Nostr nsec' });
            await user.type(within(dialog).getByLabelText('nsec'), 'nsec1wrong');
            await user.click(within(dialog).getByRole('button', { name: 'Import' }));

            await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
            expect(screen.getByText('No Nostr keys')).toBeInTheDocument();
        });

        it('shows the keys an identity has, and its nsec only when asked', async () => {
            const user = userEvent.setup({ delay: null });
            identity = { nostr: keys };
            keymaster.exportNsec.mockResolvedValue('nsec1secret');
            await showNostr(user);

            expect(await screen.findByText('npub: npub1alice')).toBeInTheDocument();
            expect(screen.queryByRole('button', { name: 'Add Nostr' })).toBeNull();
            expect(screen.queryByRole('button', { name: 'Import nsec' })).toBeNull();
            expect(screen.queryByText(/nsec:/)).toBeNull();

            await user.click(screen.getByRole('button', { name: 'Show nsec' }));
            expect(await screen.findByText('nsec: nsec1secret')).toBeInTheDocument();

            await user.click(screen.getByRole('button', { name: 'Hide nsec' }));
            expect(screen.queryByText(/nsec:/)).toBeNull();
            expect(screen.getByRole('button', { name: 'Show nsec' })).toBeInTheDocument();
        });

        it('reports an nsec that cannot be exported', async () => {
            const user = userEvent.setup({ delay: null });
            identity = { nostr: keys };
            keymaster.exportNsec.mockRejectedValue(failure);
            await showNostr(user);
            await user.click(await screen.findByRole('button', { name: 'Show nsec' }));

            await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
            expect(screen.queryByText(/nsec:/)).toBeNull();
        });

        it('removes the keys once that is confirmed, and the nsec that was shown with them', async () => {
            const user = userEvent.setup({ delay: null });
            identity = { nostr: keys };
            keymaster.exportNsec.mockResolvedValue('nsec1secret');
            await showNostr(user);
            await user.click(await screen.findByRole('button', { name: 'Show nsec' }));
            await screen.findByText('nsec: nsec1secret');
            await user.click(screen.getByRole('button', { name: 'Remove Nostr' }));

            const dialog = await warning('Remove Nostr Keys');
            expect(keymaster.removeNostr).not.toHaveBeenCalled();
            await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));

            await waitFor(() => expect(setSuccess).toHaveBeenCalledWith('Nostr keys removed'));
            expect(keymaster.removeNostr).toHaveBeenCalledTimes(1);
            expect(screen.getByText('No Nostr keys')).toBeInTheDocument();
            expect(screen.queryByText(/nsec:/)).toBeNull();
        });

        it('keeps the keys when removal is cancelled', async () => {
            const user = userEvent.setup({ delay: null });
            identity = { nostr: keys };
            await showNostr(user);
            await user.click(await screen.findByRole('button', { name: 'Remove Nostr' }));
            await user.click(within(await warning('Remove Nostr Keys')).getByRole('button', { name: 'Cancel' }));

            expect(screen.queryByRole('dialog')).toBeNull();
            expect(keymaster.removeNostr).not.toHaveBeenCalled();
            expect(screen.getByText('npub: npub1alice')).toBeInTheDocument();
        });

        it('reports keys that cannot be removed and keeps them shown', async () => {
            const user = userEvent.setup({ delay: null });
            identity = { nostr: keys };
            keymaster.removeNostr.mockRejectedValue(failure);
            await showNostr(user);
            await user.click(await screen.findByRole('button', { name: 'Remove Nostr' }));
            await user.click(within(await warning('Remove Nostr Keys')).getByRole('button', { name: 'Confirm' }));

            await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
            expect(screen.getByText('npub: npub1alice')).toBeInTheDocument();
        });

        it('shows no keys when the identity does not resolve', async () => {
            const user = userEvent.setup({ delay: null });
            keymaster.resolveDID.mockRejectedValue(failure);
            render(<IdentitiesTab />);
            await openTab(user, 'Nostr');

            expect(await screen.findByText('No Nostr keys')).toBeInTheDocument();
            expect(screen.getByRole('button', { name: 'Add Nostr' })).toBeInTheDocument();
        });
    });

    describe('while the wallet is not available', () => {
        beforeEach(() => {
            wallet.keymaster = null;
        });

        it('shows the identity with nothing loaded', async () => {
            const user = userEvent.setup({ delay: null });
            render(<IdentitiesTab />);

            expect(screen.getByText('No DID document')).toBeInTheDocument();
            await openTab(user, 'Addresses');
            expect(screen.getByText('No addresses yet')).toBeInTheDocument();
            await openTab(user, 'Avatar');
            expect(screen.getByText('No avatar set')).toBeInTheDocument();
            await openTab(user, 'Nostr');
            expect(screen.getByText('No Nostr keys')).toBeInTheDocument();
            expect(setError).not.toHaveBeenCalled();
        });

        it('does nothing, and reports nothing, for what is asked of it', async () => {
            const user = userEvent.setup({ delay: null });
            render(<IdentitiesTab />);

            await manage(user, 'Backup');
            await manage(user, 'Rotate keys');
            await manage(user, 'Rename');
            let dialog = await screen.findByRole('dialog', { name: 'Rename Identity' });
            await user.type(within(dialog).getByLabelText('New Name'), 'Alicia');
            await user.click(within(dialog).getByRole('button', { name: 'Rename' }));
            // Nothing closes the dialog without a wallet.
            await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
            await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

            await manage(user, 'Recover');
            dialog = await screen.findByRole('dialog', { name: 'Recover Identity' });
            await user.type(within(dialog).getByLabelText('DID'), 'did:cid:bob');
            await user.click(within(dialog).getByRole('button', { name: 'Recover' }));
            await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

            await openTab(user, 'Addresses');
            await user.type(screen.getByLabelText('Name'), 'bob');
            await user.type(screen.getByLabelText('Domain'), 'example.com');
            await user.click(screen.getByRole('button', { name: 'Add' }));
            await user.click(screen.getByRole('button', { name: 'Check' }));

            await openTab(user, 'Avatar');
            await user.click(screen.getByRole('radio', { name: 'DID' }));
            await user.type(screen.getByLabelText('Avatar DID'), DOG);
            await user.click(screen.getByRole('button', { name: 'Preview' }));
            expect(screen.getByText('Current Avatar')).toBeInTheDocument();

            await openTab(user, 'Nostr');
            await user.click(screen.getByRole('button', { name: 'Add Nostr' }));
            expect(screen.getByText('No Nostr keys')).toBeInTheDocument();

            expect(setError).not.toHaveBeenCalled();
            expect(setSuccess).not.toHaveBeenCalled();
            expect(refreshAll).not.toHaveBeenCalled();
            for (const method of Object.values(keymaster)) {
                expect(method).not.toHaveBeenCalled();
            }
        });
    });
});
