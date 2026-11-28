import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import VaultTab from '../../../../packages/wallet-ui/src/components/VaultTab';

// The Vaults tab creates a vault, and for the vault picked shows its members
// and items. Only the vault's owner may change either.

const { keymaster, wallet, variables, walletData, setError, setSuccess, openView } = vi.hoisted(() => {
    const keymaster = {
        resolveDID: vi.fn(), createVault: vi.fn(), listVaultMembers: vi.fn(), listVaultItems: vi.fn(),
        addVaultMember: vi.fn(), removeVaultMember: vi.fn(), addVaultItem: vi.fn(), removeVaultItem: vi.fn(),
        getVaultItem: vi.fn(), addAlias: vi.fn(), removeAlias: vi.fn(),
    };

    return {
        keymaster,
        wallet: { keymaster: keymaster as typeof keymaster | null },
        variables: {
            currentDID: '',
            registries: [] as string[],
            agentList: [] as string[] | null,
            aliasList: {} as Record<string, string>,
            vaultList: [] as string[] | null,
        },
        walletData: { getVaultItemIcon: vi.fn(), refreshAliases: vi.fn(), handleCopyDID: vi.fn() },
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
vi.mock('../../../../packages/wallet-ui/src/contexts/PlatformCapabilities', () => ({ usePlatformCapabilities: () => ({}) }));
vi.mock('../../../../packages/wallet-ui/src/hooks/useWalletData', () => ({ useWalletData: () => walletData }));

const ALICE = 'did:cid:alice';
const BOB = 'did:cid:bob';
const VAULT = 'did:cid:vault';

const items = {
    'notes.txt': { type: 'text/plain', bytes: 12 },
    'login: example.org': { type: 'application/json', bytes: 80 },
    dmail: { type: 'application/json', bytes: 300 },
};

const json = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf-8');

beforeEach(() => {
    vi.resetAllMocks();
    wallet.keymaster = keymaster;
    variables.currentDID = ALICE;
    variables.registries = ['hyperswarm', 'BTC:mainnet'];
    variables.agentList = ['Bob', 'Carol'];
    variables.aliasList = { team: VAULT, taken: 'did:cid:other' };
    variables.vaultList = ['team'];
    walletData.getVaultItemIcon.mockReturnValue(null);
    keymaster.resolveDID.mockResolvedValue({ didDocument: { controller: ALICE } });
    keymaster.listVaultMembers.mockResolvedValue({ [BOB]: {} });
    keymaster.listVaultItems.mockResolvedValue(items);
});

// The registry picker, the vault picker and the member field are all
// comboboxes, and the first two have no label: they are told apart by order.
const registryPicker = () => screen.getAllByRole('combobox')[0];
const vaultPicker = () => screen.getAllByRole('combobox')[1];

async function openVault(user: UserEvent, name = 'team') {
    await user.click(vaultPicker());
    await user.click(await screen.findByRole('option', { name }));
    await screen.findByRole('heading', { name: 'Members' });
}

// A row is the nearest ancestor that also holds the row's buttons.
function rowOf(text: string): HTMLElement {
    let node = screen.getByText(text).parentElement;
    while (node && within(node).queryAllByRole('button').length === 0) {
        node = node.parentElement;
    }
    if (!node) {
        throw new Error(`no row for ${text}`);
    }
    return node;
}

const itemRow = (name: string) => rowOf(name);
const renameButton = () => within(screen.getByLabelText('Rename')).getByRole('button');
const fileInput = () => document.getElementById('vaultItemUpload') as HTMLInputElement;

describe('creating a vault', () => {
    it('offers Create only once a name is typed', async () => {
        const user = userEvent.setup();
        render(<VaultTab />);

        const create = screen.getByRole('button', { name: 'Create' });
        expect(create).toBeDisabled();

        await user.type(screen.getByLabelText('Vault Name'), 'docs');
        expect(create).toBeEnabled();
    });

    it('does not offer Create until a registry the node offers is chosen', async () => {
        const user = userEvent.setup();
        variables.registries = ['BTC:mainnet'];
        render(<VaultTab />);

        await user.type(screen.getByLabelText('Vault Name'), 'docs');
        expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();

        await user.click(registryPicker());
        await user.click(await screen.findByRole('option', { name: 'BTC:mainnet' }));
        expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled();
    });

    it('does not offer Create for a name of only spaces', async () => {
        const user = userEvent.setup();
        render(<VaultTab />);

        await user.type(screen.getByLabelText('Vault Name'), '   ');
        expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    });

    it('creates the vault on the chosen registry and opens it', async () => {
        const user = userEvent.setup();
        walletData.refreshAliases.mockImplementation(async () => {
            variables.aliasList = { ...variables.aliasList, docs: 'did:cid:docs' };
            variables.vaultList = ['team', 'docs'];
        });
        keymaster.listVaultMembers.mockResolvedValue({});
        keymaster.listVaultItems.mockResolvedValue({});
        render(<VaultTab />);

        await user.type(screen.getByLabelText('Vault Name'), '  docs ');
        await user.click(registryPicker());
        await user.click(await screen.findByRole('option', { name: 'BTC:mainnet' }));
        await user.click(screen.getByRole('button', { name: 'Create' }));

        expect(await screen.findByRole('heading', { name: 'Members' })).toBeInTheDocument();
        expect(keymaster.createVault).toHaveBeenCalledWith({ registry: 'BTC:mainnet', alias: 'docs' });
        expect(walletData.refreshAliases).toHaveBeenCalled();
        expect(keymaster.listVaultMembers).toHaveBeenCalledWith('docs');
        expect(keymaster.listVaultItems).toHaveBeenCalledWith('docs');
        expect(screen.getByLabelText('Vault Name')).toHaveValue('');
        expect(vaultPicker()).toHaveTextContent('docs');
        expect(setError).not.toHaveBeenCalled();
    });

    it('refuses a name that is already an alias', async () => {
        const user = userEvent.setup();
        render(<VaultTab />);

        await user.type(screen.getByLabelText('Vault Name'), 'taken');
        await user.click(screen.getByRole('button', { name: 'Create' }));

        expect(setError).toHaveBeenCalledWith('taken already in use');
        expect(keymaster.createVault).not.toHaveBeenCalled();
    });

    it('reports a failure to create the vault', async () => {
        const user = userEvent.setup();
        const failure = new Error('registry unavailable');
        keymaster.createVault.mockRejectedValue(failure);
        render(<VaultTab />);

        await user.type(screen.getByLabelText('Vault Name'), 'docs');
        await user.click(screen.getByRole('button', { name: 'Create' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(walletData.refreshAliases).not.toHaveBeenCalled();
        expect(screen.queryByRole('heading', { name: 'Members' })).toBeNull();
    });

    it('does nothing while the wallet has no keymaster', async () => {
        const user = userEvent.setup();
        wallet.keymaster = null;
        render(<VaultTab />);

        await user.type(screen.getByLabelText('Vault Name'), 'docs');
        await user.click(screen.getByRole('button', { name: 'Create' }));

        expect(keymaster.createVault).not.toHaveBeenCalled();
        expect(setError).not.toHaveBeenCalled();
    });
});

describe('picking a vault', () => {
    it('shows no vault picker before the vault list is loaded', () => {
        variables.vaultList = null;
        variables.agentList = null;
        render(<VaultTab />);

        expect(screen.getAllByRole('combobox')).toHaveLength(1);
        expect(screen.queryByLabelText('Rename')).toBeNull();
    });

    it('lists the members and items of the vault picked', async () => {
        const user = userEvent.setup();
        render(<VaultTab />);
        expect(screen.queryByRole('heading', { name: 'Members' })).toBeNull();

        await openVault(user);

        expect(keymaster.resolveDID).toHaveBeenCalledWith('team');
        expect(keymaster.listVaultMembers).toHaveBeenCalledWith('team');
        expect(keymaster.listVaultItems).toHaveBeenCalledWith('team');
        expect(screen.getByText(BOB)).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: 'Items' })).toBeInTheDocument();

        // A file is downloaded; a login or a dmail is revealed.
        const file = itemRow('notes.txt');
        expect(within(file).getByText('12 bytes')).toBeInTheDocument();
        expect(within(file).getByRole('button', { name: 'Download' })).toBeInTheDocument();
        expect(within(file).queryByRole('button', { name: 'Reveal' })).toBeNull();

        // A login is listed by its service, without the "login:" prefix.
        expect(screen.queryByText(/login:/)).toBeNull();
        const login = itemRow('example.org');
        expect(within(login).getByText('80 bytes')).toBeInTheDocument();
        expect(within(login).getByRole('button', { name: 'Reveal' })).toBeInTheDocument();
        expect(within(login).queryByRole('button', { name: 'Download' })).toBeNull();
        expect(within(itemRow('dmail')).getByRole('button', { name: 'Reveal' })).toBeInTheDocument();

        expect(walletData.getVaultItemIcon).toHaveBeenCalledWith('notes.txt', items['notes.txt']);
    });

    it('lets the owner change the vault', async () => {
        const user = userEvent.setup();
        render(<VaultTab />);
        await openVault(user);

        expect(screen.getByLabelText('Name or DID')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Upload' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Add login' })).toBeInTheDocument();
        expect(screen.getByLabelText('Remove member')).toBeInTheDocument();
        expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(3);
    });

    it('offers someone who is only a member nothing that changes the vault', async () => {
        const user = userEvent.setup();
        keymaster.resolveDID.mockResolvedValue({ didDocument: { controller: BOB } });
        render(<VaultTab />);
        await openVault(user);

        expect(screen.getByText(BOB)).toBeInTheDocument();
        expect(screen.queryByLabelText('Name or DID')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Upload' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Add login' })).toBeNull();
        expect(screen.queryByLabelText('Remove member')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
        // Reading is still offered.
        expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument();
    });

    it('withdraws the owner\'s controls when the owner can no longer be confirmed', async () => {
        const user = userEvent.setup();
        // The vault is read once when it is picked and its owner is checked
        // again afterwards; the second read fails here.
        keymaster.resolveDID
            .mockResolvedValueOnce({ didDocument: { controller: ALICE } })
            .mockRejectedValueOnce(new Error('node unreachable'));
        render(<VaultTab />);
        await openVault(user);

        await waitFor(() => expect(screen.queryByRole('button', { name: 'Upload' })).toBeNull());
        expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
        expect(screen.getByText(BOB)).toBeInTheDocument();
    });

    it('reports a vault that cannot be read and shows nothing of it', async () => {
        const user = userEvent.setup();
        const failure = new Error('not a member');
        keymaster.listVaultMembers.mockRejectedValue(failure);
        render(<VaultTab />);

        await user.click(vaultPicker());
        await user.click(await screen.findByRole('option', { name: 'team' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(screen.queryByRole('heading', { name: 'Members' })).toBeNull();
        expect(screen.queryByRole('heading', { name: 'Items' })).toBeNull();
        expect(renameButton()).toBeDisabled();
    });
});

describe('vault members', () => {
    it('adds a member to the selected vault', async () => {
        const user = userEvent.setup();
        keymaster.addVaultMember.mockResolvedValue(true);
        render(<VaultTab />);
        await openVault(user);

        await user.type(screen.getByLabelText('Name or DID'), 'did:cid:carol');
        keymaster.listVaultMembers.mockResolvedValue({ [BOB]: {}, 'did:cid:carol': {} });
        await user.click(screen.getByRole('button', { name: 'Add' }));

        expect(await screen.findByText('did:cid:carol')).toBeInTheDocument();
        expect(keymaster.addVaultMember).toHaveBeenCalledWith('team', 'did:cid:carol');
        expect(screen.getByLabelText('Name or DID')).toHaveValue('');
        expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
        expect(setError).not.toHaveBeenCalled();
    });

    it('adds a member picked from the wallet\'s known agents', async () => {
        const user = userEvent.setup();
        keymaster.addVaultMember.mockResolvedValue(true);
        render(<VaultTab />);
        await openVault(user);

        await user.click(screen.getByLabelText('Name or DID'));
        await user.click(await screen.findByRole('option', { name: 'Carol' }));
        await user.click(screen.getByRole('button', { name: 'Add' }));

        await waitFor(() => expect(keymaster.addVaultMember).toHaveBeenCalledWith('team', 'Carol'));
    });

    it('disables Add again when the member field is cleared', async () => {
        const user = userEvent.setup();
        render(<VaultTab />);
        await openVault(user);

        await user.click(screen.getByLabelText('Name or DID'));
        await user.click(await screen.findByRole('option', { name: 'Bob' }));
        expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled();

        await user.clear(screen.getByLabelText('Name or DID'));
        expect(screen.getByLabelText('Name or DID')).toHaveValue('');
        expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    });

    it('explains that the owner cannot be added as a member', async () => {
        const user = userEvent.setup();
        keymaster.addVaultMember.mockResolvedValue(false);
        render(<VaultTab />);
        await openVault(user);

        await user.type(screen.getByLabelText('Name or DID'), ALICE);
        await user.click(screen.getByRole('button', { name: 'Add' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(expect.stringMatching(/Cannot add vault owner as a member/)));
        expect(keymaster.listVaultMembers).toHaveBeenCalledTimes(1);
    });

    it('reports a failure to add a member', async () => {
        const user = userEvent.setup();
        const failure = new Error('unknown DID');
        keymaster.addVaultMember.mockRejectedValue(failure);
        render(<VaultTab />);
        await openVault(user);

        await user.type(screen.getByLabelText('Name or DID'), 'nobody');
        await user.click(screen.getByRole('button', { name: 'Add' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
    });

    it('removes a member once the removal is confirmed', async () => {
        const user = userEvent.setup();
        render(<VaultTab />);
        await openVault(user);

        await user.click(within(screen.getByLabelText('Remove member')).getByRole('button'));
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByText('Remove Vault Member')).toBeInTheDocument();
        expect(within(dialog).getByText('Remove member from team?')).toBeInTheDocument();
        expect(keymaster.removeVaultMember).not.toHaveBeenCalled();

        keymaster.listVaultMembers.mockResolvedValue({});
        await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));

        await waitFor(() => expect(screen.queryByText(BOB)).toBeNull());
        expect(keymaster.removeVaultMember).toHaveBeenCalledWith('team', BOB);
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('keeps the member when the removal is cancelled', async () => {
        const user = userEvent.setup();
        render(<VaultTab />);
        await openVault(user);

        await user.click(within(screen.getByLabelText('Remove member')).getByRole('button'));
        await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));

        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(keymaster.removeVaultMember).not.toHaveBeenCalled();
        expect(screen.getByText(BOB)).toBeInTheDocument();
    });

    it('reports a failure to remove a member', async () => {
        const user = userEvent.setup();
        const failure = new Error('not the owner');
        keymaster.removeVaultMember.mockRejectedValue(failure);
        render(<VaultTab />);
        await openVault(user);

        await user.click(within(screen.getByLabelText('Remove member')).getByRole('button'));
        await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Confirm' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(screen.getByText(BOB)).toBeInTheDocument();
    });
});

describe('removing a vault item', () => {
    it('removes the item once the removal is confirmed', async () => {
        const user = userEvent.setup();
        render(<VaultTab />);
        await openVault(user);

        await user.click(within(itemRow('notes.txt')).getByRole('button', { name: 'Remove' }));
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByText('Remove Vault Item')).toBeInTheDocument();
        expect(within(dialog).getByText('Remove item notes.txt from team?')).toBeInTheDocument();

        keymaster.listVaultItems.mockResolvedValue({ dmail: items.dmail });
        await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));

        await waitFor(() => expect(screen.queryByText('notes.txt')).toBeNull());
        expect(keymaster.removeVaultItem).toHaveBeenCalledWith('team', 'notes.txt');
    });

    it('removes a login by its full item name', async () => {
        const user = userEvent.setup();
        render(<VaultTab />);
        await openVault(user);

        await user.click(within(itemRow('example.org')).getByRole('button', { name: 'Remove' }));
        await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Confirm' }));

        await waitFor(() => expect(keymaster.removeVaultItem).toHaveBeenCalledWith('team', 'login: example.org'));
    });

    it('reports a failure to remove an item', async () => {
        const user = userEvent.setup();
        const failure = new Error('not the owner');
        keymaster.removeVaultItem.mockRejectedValue(failure);
        render(<VaultTab />);
        await openVault(user);

        await user.click(within(itemRow('notes.txt')).getByRole('button', { name: 'Remove' }));
        await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Confirm' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(screen.getByText('notes.txt')).toBeInTheDocument();
    });
});

describe('downloading a vault item', () => {
    const createObjectURL = vi.fn();
    const revokeObjectURL = vi.fn();
    let clicked: { download: string; href: string }[];

    beforeEach(() => {
        clicked = [];
        // jsdom has neither of these, and following a link's click would be a
        // navigation, which it does not implement either.
        Object.assign(URL, { createObjectURL, revokeObjectURL });
        createObjectURL.mockReturnValue('blob:vault-item');
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
            clicked.push({ download: this.download, href: this.href });
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        Reflect.deleteProperty(URL, 'createObjectURL');
        Reflect.deleteProperty(URL, 'revokeObjectURL');
    });

    it('saves the item\'s bytes under the item\'s name', async () => {
        const user = userEvent.setup();
        keymaster.getVaultItem.mockResolvedValue(Buffer.from('hello vault!'));
        render(<VaultTab />);
        await openVault(user);

        await user.click(screen.getByRole('button', { name: 'Download' }));

        await waitFor(() => expect(clicked).toStrictEqual([{ download: 'notes.txt', href: 'blob:vault-item' }]));
        expect(keymaster.getVaultItem).toHaveBeenCalledWith('team', 'notes.txt');
        const blob = createObjectURL.mock.calls[0][0] as Blob;
        expect(blob.size).toBe(12);
        expect(revokeObjectURL).toHaveBeenCalledWith('blob:vault-item');
        // The link was only there to be clicked.
        expect(document.querySelector('a[download]')).toBeNull();
        expect(setError).not.toHaveBeenCalled();
    });

    it('says so when the item is no longer in the vault', async () => {
        const user = userEvent.setup();
        keymaster.getVaultItem.mockResolvedValue(null);
        render(<VaultTab />);
        await openVault(user);

        await user.click(screen.getByRole('button', { name: 'Download' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith('Item notes.txt not found in vault team'));
        expect(clicked).toHaveLength(0);
    });

    it('reports a failure to fetch the item', async () => {
        const user = userEvent.setup();
        const failure = new Error('cannot decrypt');
        keymaster.getVaultItem.mockRejectedValue(failure);
        render(<VaultTab />);
        await openVault(user);

        await user.click(screen.getByRole('button', { name: 'Download' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(clicked).toHaveLength(0);
    });
});

describe('revealing a vault item', () => {
    it('shows a login\'s service, username and password', async () => {
        const user = userEvent.setup();
        keymaster.getVaultItem.mockResolvedValue(json({ login: { service: 'example.org', username: 'alice', password: 'hunter2' } }));
        render(<VaultTab />);
        await openVault(user);

        await user.click(within(itemRow('example.org')).getByRole('button', { name: 'Reveal' }));

        const dialog = await screen.findByRole('dialog');
        expect(keymaster.getVaultItem).toHaveBeenCalledWith('team', 'login: example.org');
        await waitFor(() => expect(within(dialog).getByLabelText('Service')).toHaveValue('example.org'));
        expect(within(dialog).getByLabelText('Username')).toHaveValue('alice');
        expect(within(dialog).getByLabelText('Password')).toHaveValue('hunter2');
        expect(within(dialog).getByLabelText('Service')).toHaveAttribute('readonly');

        // OK only closes a login that is being read: nothing is stored.
        await user.click(within(dialog).getByRole('button', { name: 'OK' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(keymaster.addVaultItem).not.toHaveBeenCalled();
    });

    it('takes a login\'s service from the item name when the login does not say', async () => {
        const user = userEvent.setup();
        keymaster.getVaultItem.mockResolvedValue(json({ login: {} }));
        render(<VaultTab />);
        await openVault(user);

        await user.click(within(itemRow('example.org')).getByRole('button', { name: 'Reveal' }));

        const dialog = await screen.findByRole('dialog');
        await waitFor(() => expect(within(dialog).getByLabelText('Service')).toHaveValue('example.org'));
        expect(within(dialog).getByLabelText('Username')).toHaveValue('');
        expect(within(dialog).getByLabelText('Password')).toHaveValue('');

        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('shows a dmail', async () => {
        const user = userEvent.setup();
        keymaster.getVaultItem.mockResolvedValue(json({
            dmail: { to: ['did:cid:bob'], cc: ['did:cid:carol'], subject: 'Minutes', body: 'We met.' },
        }));
        render(<VaultTab />);
        await openVault(user);

        await user.click(within(itemRow('dmail')).getByRole('button', { name: 'Reveal' }));

        const dialog = await screen.findByRole('dialog');
        expect(keymaster.getVaultItem).toHaveBeenCalledWith('team', 'dmail');
        await waitFor(() => expect(within(dialog).getByLabelText('Subject')).toHaveValue('Minutes'));
        expect(within(dialog).getByLabelText('To')).toHaveValue('did:cid:bob');
        expect(within(dialog).getByLabelText('cc')).toHaveValue('did:cid:carol');
        expect(within(dialog).getByLabelText('Body')).toHaveValue('We met.');

        await user.click(within(dialog).getByRole('button', { name: 'Close' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('says so when the item is neither a login nor a dmail', async () => {
        const user = userEvent.setup();
        keymaster.getVaultItem.mockResolvedValue(json({ credential: {} }));
        render(<VaultTab />);
        await openVault(user);

        await user.click(within(itemRow('dmail')).getByRole('button', { name: 'Reveal' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith('Unknown item type dmail'));
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('says so when the item is no longer in the vault', async () => {
        const user = userEvent.setup();
        keymaster.getVaultItem.mockResolvedValue(null);
        render(<VaultTab />);
        await openVault(user);

        await user.click(within(itemRow('dmail')).getByRole('button', { name: 'Reveal' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith('Item dmail not found in vault team'));
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('reports an item whose contents cannot be read', async () => {
        const user = userEvent.setup();
        keymaster.getVaultItem.mockResolvedValue(Buffer.from('not json'));
        render(<VaultTab />);
        await openVault(user);

        await user.click(within(itemRow('dmail')).getByRole('button', { name: 'Reveal' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(expect.any(SyntaxError)));
        expect(screen.queryByRole('dialog')).toBeNull();
    });
});

describe('adding a login', () => {
    async function fillLogin(user: UserEvent, service: string, username: string, password: string) {
        await user.click(screen.getByRole('button', { name: 'Add login' }));
        const dialog = await screen.findByRole('dialog');
        await user.type(within(dialog).getByLabelText('Service'), service);
        await user.type(within(dialog).getByLabelText('Username'), username);
        await user.type(within(dialog).getByLabelText('Password'), password);
        return dialog;
    }

    it('stores the login as an item named after its service', async () => {
        const user = userEvent.setup();
        keymaster.addVaultItem.mockResolvedValue(true);
        render(<VaultTab />);
        await openVault(user);

        const dialog = await fillLogin(user, ' example.com ', ' alice ', 'hunter2');
        await user.click(within(dialog).getByRole('button', { name: 'OK' }));

        await waitFor(() => expect(setSuccess).toHaveBeenCalledWith('Login added successfully: example.com'));
        const [vault, name, buffer] = keymaster.addVaultItem.mock.calls[0];
        expect(vault).toBe('team');
        expect(name).toBe('login: example.com');
        expect(JSON.parse(buffer.toString('utf-8'))).toStrictEqual({
            login: { service: 'example.com', username: 'alice', password: 'hunter2' },
        });
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        // The vault is read again so that the new item is listed.
        expect(keymaster.listVaultItems).toHaveBeenCalledTimes(2);
    });

    it('offers OK only when service, username and password are all given', async () => {
        const user = userEvent.setup();
        render(<VaultTab />);
        await openVault(user);

        await user.click(screen.getByRole('button', { name: 'Add login' }));
        const dialog = await screen.findByRole('dialog');
        const ok = within(dialog).getByRole('button', { name: 'OK' });
        expect(ok).toBeDisabled();

        await user.type(within(dialog).getByLabelText('Service'), 'example.com');
        await user.type(within(dialog).getByLabelText('Username'), 'alice');
        expect(ok).toBeDisabled();
        await user.type(within(dialog).getByLabelText('Password'), 'hunter2');
        expect(ok).toBeEnabled();
    });

    it('refuses a login whose fields are only spaces', async () => {
        const user = userEvent.setup();
        render(<VaultTab />);
        await openVault(user);

        const dialog = await fillLogin(user, 'example.com', 'alice', '   ');
        await user.click(within(dialog).getByRole('button', { name: 'OK' }));

        expect(setError).toHaveBeenCalledWith('Service, username, and password are required');
        expect(keymaster.addVaultItem).not.toHaveBeenCalled();
    });

    it('says so when the vault does not take the login', async () => {
        const user = userEvent.setup();
        keymaster.addVaultItem.mockResolvedValue(false);
        render(<VaultTab />);
        await openVault(user);

        const dialog = await fillLogin(user, 'example.com', 'alice', 'hunter2');
        await user.click(within(dialog).getByRole('button', { name: 'OK' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith('Error adding login: example.com'));
        expect(setSuccess).not.toHaveBeenCalled();
        expect(keymaster.listVaultItems).toHaveBeenCalledTimes(1);
    });

    it('reports a failure to store the login', async () => {
        const user = userEvent.setup();
        const failure = new Error('item too large');
        keymaster.addVaultItem.mockRejectedValue(failure);
        render(<VaultTab />);
        await openVault(user);

        const dialog = await fillLogin(user, 'example.com', 'alice', 'hunter2');
        await user.click(within(dialog).getByRole('button', { name: 'OK' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(setSuccess).not.toHaveBeenCalled();
    });

    it('stores nothing when the login is cancelled', async () => {
        const user = userEvent.setup();
        render(<VaultTab />);
        await openVault(user);

        const dialog = await fillLogin(user, 'example.com', 'alice', 'hunter2');
        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(keymaster.addVaultItem).not.toHaveBeenCalled();
    });
});

describe('uploading a file', () => {
    const file = () => new File(['file contents'], 'report.pdf', { type: 'application/pdf' });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    // Stands in for a read that ends some way a real file does not make it end.
    function readingEndsWith(end: (reader: FileReader) => void) {
        vi.spyOn(FileReader.prototype, 'readAsArrayBuffer').mockImplementation(function (this: FileReader) {
            end(this);
        });
    }

    it('opens the file chooser from the Upload button', async () => {
        const user = userEvent.setup();
        render(<VaultTab />);
        await openVault(user);
        const chosen = vi.fn();
        fileInput().addEventListener('click', chosen);

        await user.click(screen.getByRole('button', { name: 'Upload' }));

        expect(chosen).toHaveBeenCalledTimes(1);
    });

    it('stores the chosen file under its own name', async () => {
        const user = userEvent.setup();
        keymaster.addVaultItem.mockResolvedValue(true);
        render(<VaultTab />);
        await openVault(user);

        await user.upload(fileInput(), file());

        await waitFor(() => expect(setSuccess).toHaveBeenCalledWith('Item uploaded successfully: report.pdf'));
        const [vault, name, buffer] = keymaster.addVaultItem.mock.calls[0];
        expect(vault).toBe('team');
        expect(name).toBe('report.pdf');
        expect(Buffer.from(buffer).toString('utf-8')).toBe('file contents');
        await waitFor(() => expect(keymaster.listVaultItems).toHaveBeenCalledTimes(2));
        expect(setError).not.toHaveBeenCalled();
    });

    it('says so when the vault does not take the file', async () => {
        const user = userEvent.setup();
        keymaster.addVaultItem.mockResolvedValue(false);
        render(<VaultTab />);
        await openVault(user);

        await user.upload(fileInput(), file());

        await waitFor(() => expect(setError).toHaveBeenCalledWith('Error uploading file: report.pdf'));
        expect(setSuccess).not.toHaveBeenCalled();
    });

    it('reports a failure to store the file', async () => {
        const user = userEvent.setup();
        const refusal = new Error('item too large');
        keymaster.addVaultItem.mockRejectedValue(refusal);
        render(<VaultTab />);
        await openVault(user);

        await user.upload(fileInput(), file());

        await waitFor(() => expect(setError).toHaveBeenCalledExactlyOnceWith(refusal));
        expect(setSuccess).not.toHaveBeenCalled();
    });

    it('reports why a file cannot be read', async () => {
        const user = userEvent.setup();
        const unreadable = new DOMException('The file could not be read', 'NotReadableError');
        readingEndsWith(reader => {
            Object.defineProperty(reader, 'error', { value: unreadable });
            reader.onerror?.call(reader, new ProgressEvent('error') as ProgressEvent<FileReader>);
        });
        render(<VaultTab />);
        await openVault(user);

        await user.upload(fileInput(), file());

        await waitFor(() => expect(setError).toHaveBeenCalledExactlyOnceWith(unreadable));
        expect(keymaster.addVaultItem).not.toHaveBeenCalled();
    });

    it('says a file cannot be read when the reader does not say why', async () => {
        const user = userEvent.setup();
        readingEndsWith(reader => {
            Object.defineProperty(reader, 'error', { value: null });
            reader.onerror?.call(reader, new ProgressEvent('error') as ProgressEvent<FileReader>);
        });
        render(<VaultTab />);
        await openVault(user);

        await user.upload(fileInput(), file());

        await waitFor(() => expect(setError).toHaveBeenCalledExactlyOnceWith('Unable to read the file'));
        expect(keymaster.addVaultItem).not.toHaveBeenCalled();
    });

    it('reports a read that yields nothing', async () => {
        const user = userEvent.setup();
        readingEndsWith(reader => reader.onload?.call(reader, { target: { result: null } } as ProgressEvent<FileReader>));
        render(<VaultTab />);
        await openVault(user);

        await user.upload(fileInput(), file());

        await waitFor(() => expect(setError).toHaveBeenCalledWith('Unexpected file reader result'));
        expect(keymaster.addVaultItem).not.toHaveBeenCalled();
    });

    it('reports a read that yields something other than bytes', async () => {
        const user = userEvent.setup();
        readingEndsWith(reader => reader.onload?.call(reader, { target: { result: 'text' } } as ProgressEvent<FileReader>));
        render(<VaultTab />);
        await openVault(user);

        await user.upload(fileInput(), file());

        await waitFor(() => expect(setError).toHaveBeenCalledWith('Unexpected file reader result type'));
        expect(keymaster.addVaultItem).not.toHaveBeenCalled();
    });

    it('reports a file that cannot be handed to the reader', async () => {
        const user = userEvent.setup();
        const busy = new Error('reader busy');
        vi.spyOn(FileReader.prototype, 'readAsArrayBuffer').mockImplementation(() => {
            throw busy;
        });
        render(<VaultTab />);
        await openVault(user);

        await user.upload(fileInput(), file());

        await waitFor(() => expect(setError).toHaveBeenCalledExactlyOnceWith(busy));
        expect(keymaster.addVaultItem).not.toHaveBeenCalled();
    });

    it('stores nothing when the file chooser is closed without a file', async () => {
        const user = userEvent.setup();
        render(<VaultTab />);
        await openVault(user);

        fireEvent.change(fileInput(), { target: { files: [] } });

        expect(keymaster.addVaultItem).not.toHaveBeenCalled();
        expect(setError).not.toHaveBeenCalled();
    });
});

describe('renaming a vault', () => {
    async function rename(user: UserEvent, to: string) {
        await user.click(renameButton());
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByText('Rename \'team\' to:')).toBeInTheDocument();
        const field = within(dialog).getByLabelText('New Name');
        expect(field).toHaveValue('team');
        await user.clear(field);
        if (to) {
            await user.type(field, to);
        }
        await user.click(within(dialog).getByRole('button', { name: 'Rename' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    }

    it('cannot be asked for before a vault is picked', () => {
        render(<VaultTab />);

        expect(renameButton()).toBeDisabled();
    });

    it('gives the vault its new alias and drops the old one', async () => {
        const user = userEvent.setup();
        walletData.refreshAliases.mockImplementation(async () => {
            variables.aliasList = { crew: VAULT, taken: 'did:cid:other' };
            variables.vaultList = ['crew'];
        });
        render(<VaultTab />);
        await openVault(user);

        await rename(user, 'crew');

        await waitFor(() => expect(setSuccess).toHaveBeenCalledWith('Vault renamed'));
        expect(keymaster.addAlias).toHaveBeenCalledWith('crew', VAULT);
        expect(keymaster.removeAlias).toHaveBeenCalledWith('team');
        expect(walletData.refreshAliases).toHaveBeenCalled();
        expect(vaultPicker()).toHaveTextContent('crew');
        // The vault stays open under its new name.
        expect(screen.getByText(BOB)).toBeInTheDocument();
    });

    it('refuses a name that is already an alias', async () => {
        const user = userEvent.setup();
        render(<VaultTab />);
        await openVault(user);

        await rename(user, 'taken');

        expect(setError).toHaveBeenCalledWith('taken already in use');
        expect(keymaster.addAlias).not.toHaveBeenCalled();
        expect(keymaster.removeAlias).not.toHaveBeenCalled();
    });

    it('changes nothing when the name is left as it was or left empty', async () => {
        const user = userEvent.setup();
        render(<VaultTab />);
        await openVault(user);

        await rename(user, 'team');
        await rename(user, '');

        expect(keymaster.addAlias).not.toHaveBeenCalled();
        expect(keymaster.removeAlias).not.toHaveBeenCalled();
        expect(setError).not.toHaveBeenCalled();
        expect(setSuccess).not.toHaveBeenCalled();
    });

    it('changes nothing when the rename is cancelled', async () => {
        const user = userEvent.setup();
        render(<VaultTab />);
        await openVault(user);

        await user.click(renameButton());
        const dialog = await screen.findByRole('dialog');
        await user.type(within(dialog).getByLabelText('New Name'), '-two');
        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(keymaster.addAlias).not.toHaveBeenCalled();
    });

    it('reports a failure to rename', async () => {
        const user = userEvent.setup();
        const failure = new Error('invalid alias');
        keymaster.addAlias.mockRejectedValue(failure);
        render(<VaultTab />);
        await openVault(user);

        await rename(user, 'crew');

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(keymaster.removeAlias).not.toHaveBeenCalled();
        expect(setSuccess).not.toHaveBeenCalled();
        expect(vaultPicker()).toHaveTextContent('team');
    });
});

describe('a vault left open when the wallet loses its keymaster', () => {
    it('asks nothing of the keymaster and reports nothing', async () => {
        const user = userEvent.setup();
        const shown = render(<VaultTab />);
        await openVault(user);
        await user.type(screen.getByLabelText('Name or DID'), 'did:cid:carol');

        wallet.keymaster = null;
        shown.rerender(<VaultTab />);
        vi.clearAllMocks();

        await user.click(screen.getByRole('button', { name: 'Add' }));
        await user.click(screen.getByRole('button', { name: 'Download' }));
        await user.click(within(itemRow('dmail')).getByRole('button', { name: 'Reveal' }));
        await user.upload(fileInput(), new File(['x'], 'x.txt'));

        await user.click(within(screen.getByLabelText('Remove member')).getByRole('button'));
        await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Confirm' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

        await user.click(within(itemRow('notes.txt')).getByRole('button', { name: 'Remove' }));
        await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Confirm' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

        await user.click(renameButton());
        const renaming = await screen.findByRole('dialog');
        await user.type(within(renaming).getByLabelText('New Name'), '-two');
        await user.click(within(renaming).getByRole('button', { name: 'Rename' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

        await user.click(screen.getByRole('button', { name: 'Add login' }));
        const login = await screen.findByRole('dialog');
        await user.type(within(login).getByLabelText('Service'), 'example.com');
        await user.type(within(login).getByLabelText('Username'), 'alice');
        await user.type(within(login).getByLabelText('Password'), 'hunter2');
        await user.click(within(login).getByRole('button', { name: 'OK' }));

        for (const method of Object.values(keymaster)) {
            expect(method).not.toHaveBeenCalled();
        }
        expect(setError).not.toHaveBeenCalled();
        expect(setSuccess).not.toHaveBeenCalled();
    });
});
