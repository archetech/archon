import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import GroupsTab from '../../../../packages/wallet-ui/src/components/GroupsTab';

// The Groups tab creates a group, and for the group picked lists its members
// and adds or removes one.

const { keymaster, wallet, variables, walletData, setError, setSuccess, openView } = vi.hoisted(() => {
    const keymaster = {
        createGroup: vi.fn(), getGroup: vi.fn(), addGroupMember: vi.fn(), removeGroupMember: vi.fn(),
        addAlias: vi.fn(), removeAlias: vi.fn(),
    };

    return {
        keymaster,
        wallet: { keymaster: keymaster as typeof keymaster | null },
        variables: {
            registries: [] as string[],
            aliasList: {} as Record<string, string>,
            groupList: [] as string[] | null,
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
vi.mock('../../../../packages/wallet-ui/src/contexts/PlatformCapabilities', () => ({ usePlatformCapabilities: () => ({}) }));
vi.mock('../../../../packages/wallet-ui/src/hooks/useWalletData', () => ({ useWalletData: () => walletData }));

const GROUP = 'did:cid:group';
const BOB = 'did:cid:bob';
const CAROL = 'did:cid:carol';

beforeEach(() => {
    vi.resetAllMocks();
    wallet.keymaster = keymaster;
    variables.registries = ['hyperswarm', 'BTC:mainnet'];
    variables.aliasList = { team: GROUP, taken: 'did:cid:other', Bob: BOB };
    variables.groupList = ['team'];
    keymaster.getGroup.mockResolvedValue({ name: 'team', members: [BOB, CAROL] });
});

// Neither picker has a label: they are told apart by order.
const registryPicker = () => screen.getAllByRole('combobox')[0];
const groupPicker = () => screen.getAllByRole('combobox')[1];
const renameButton = () => within(screen.getByLabelText('Rename')).getByRole('button');

async function openGroup(user: UserEvent, name = 'team') {
    await user.click(groupPicker());
    await user.click(await screen.findByRole('option', { name }));
    await screen.findByLabelText('DID');
}

describe('creating a group', () => {
    it('offers Create only once a name is typed', async () => {
        const user = userEvent.setup();
        render(<GroupsTab />);

        const create = screen.getByRole('button', { name: 'Create' });
        expect(create).toBeDisabled();

        await user.type(screen.getByLabelText('Group Name'), 'devs');
        expect(create).toBeEnabled();
    });

    it('creates the group on the chosen registry, names it and opens it', async () => {
        const user = userEvent.setup();
        keymaster.createGroup.mockResolvedValue('did:cid:devs');
        keymaster.getGroup.mockResolvedValue({ name: 'devs', members: [] });
        walletData.refreshAliases.mockImplementation(async () => {
            variables.aliasList = { ...variables.aliasList, devs: 'did:cid:devs' };
            variables.groupList = ['team', 'devs'];
        });
        render(<GroupsTab />);

        await user.type(screen.getByLabelText('Group Name'), ' devs  ');
        await user.click(registryPicker());
        await user.click(await screen.findByRole('option', { name: 'BTC:mainnet' }));
        await user.click(screen.getByRole('button', { name: 'Create' }));

        expect(await screen.findByLabelText('DID')).toBeInTheDocument();
        expect(keymaster.createGroup).toHaveBeenCalledWith('devs', { registry: 'BTC:mainnet' });
        expect(keymaster.addAlias).toHaveBeenCalledWith('devs', 'did:cid:devs');
        expect(walletData.refreshAliases).toHaveBeenCalled();
        expect(keymaster.getGroup).toHaveBeenCalledWith('devs');
        expect(openView).toHaveBeenCalledWith({ tab: 'groups' });
        expect(screen.getByLabelText('Group Name')).toHaveValue('');
        expect(groupPicker()).toHaveTextContent('devs');
        expect(setError).not.toHaveBeenCalled();
    });

    it('creates on hyperswarm unless another registry is chosen', async () => {
        const user = userEvent.setup();
        keymaster.createGroup.mockResolvedValue('did:cid:devs');
        render(<GroupsTab />);

        await user.type(screen.getByLabelText('Group Name'), 'devs');
        await user.click(screen.getByRole('button', { name: 'Create' }));

        await waitFor(() => expect(keymaster.createGroup).toHaveBeenCalledWith('devs', { registry: 'hyperswarm' }));
    });

    it('refuses a name that is already an alias', async () => {
        const user = userEvent.setup();
        render(<GroupsTab />);

        await user.type(screen.getByLabelText('Group Name'), 'taken');
        await user.click(screen.getByRole('button', { name: 'Create' }));

        expect(setError).toHaveBeenCalledWith('taken already in use');
        expect(keymaster.createGroup).not.toHaveBeenCalled();
    });

    it('reports a failure to create the group', async () => {
        const user = userEvent.setup();
        const failure = new Error('registry unavailable');
        keymaster.createGroup.mockRejectedValue(failure);
        render(<GroupsTab />);

        await user.type(screen.getByLabelText('Group Name'), 'devs');
        await user.click(screen.getByRole('button', { name: 'Create' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(keymaster.addAlias).not.toHaveBeenCalled();
        expect(screen.queryByLabelText('DID')).toBeNull();
    });

    it('does nothing while the wallet has no keymaster', async () => {
        const user = userEvent.setup();
        wallet.keymaster = null;
        render(<GroupsTab />);

        await user.type(screen.getByLabelText('Group Name'), 'devs');
        await user.click(screen.getByRole('button', { name: 'Create' }));

        expect(keymaster.createGroup).not.toHaveBeenCalled();
        expect(setError).not.toHaveBeenCalled();
    });
});

describe('picking a group', () => {
    it('shows no group picker before the group list is loaded', () => {
        variables.groupList = null;
        render(<GroupsTab />);

        expect(screen.getAllByRole('combobox')).toHaveLength(1);
        expect(screen.queryByLabelText('Rename')).toBeNull();
    });

    it('lists the members of the group picked, by alias where the wallet has one', async () => {
        const user = userEvent.setup();
        render(<GroupsTab />);
        expect(screen.queryByLabelText('DID')).toBeNull();

        await openGroup(user);

        expect(keymaster.getGroup).toHaveBeenCalledWith('team');
        expect(screen.getByText('Bob')).toBeInTheDocument();
        expect(screen.queryByText(BOB)).toBeNull();
        expect(screen.getByText(CAROL)).toBeInTheDocument();
        expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(2);
        expect(groupPicker()).toHaveTextContent('team');
        expect(renameButton()).toBeEnabled();
    });

    it('reports a group that cannot be read', async () => {
        const user = userEvent.setup();
        const failure = new Error('unknown group');
        keymaster.getGroup.mockRejectedValue(failure);
        render(<GroupsTab />);

        await user.click(groupPicker());
        await user.click(await screen.findByRole('option', { name: 'team' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(screen.queryByLabelText('DID')).toBeNull();
        expect(openView).not.toHaveBeenCalled();
    });
});

describe('group members', () => {
    it('offers Resolve and Add only once a DID is typed', async () => {
        const user = userEvent.setup();
        render(<GroupsTab />);
        await openGroup(user);

        expect(screen.getByRole('button', { name: 'Resolve' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();

        await user.type(screen.getByLabelText('DID'), 'did:cid:dave');
        expect(screen.getByRole('button', { name: 'Resolve' })).toBeEnabled();
        expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled();
    });

    it('opens the typed DID in the viewer', async () => {
        const user = userEvent.setup();
        render(<GroupsTab />);
        await openGroup(user);

        await user.type(screen.getByLabelText('DID'), 'did:cid:dave');
        await user.click(screen.getByRole('button', { name: 'Resolve' }));

        expect(openView).toHaveBeenCalledWith({ did: 'did:cid:dave', tab: 'viewer' });
        expect(keymaster.addGroupMember).not.toHaveBeenCalled();
    });

    it('adds a member to the selected group', async () => {
        const user = userEvent.setup();
        render(<GroupsTab />);
        await openGroup(user);

        await user.type(screen.getByLabelText('DID'), 'did:cid:dave');
        keymaster.getGroup.mockResolvedValue({ name: 'team', members: [BOB, CAROL, 'did:cid:dave'] });
        await user.click(screen.getByRole('button', { name: 'Add' }));

        expect(await screen.findByText('did:cid:dave')).toBeInTheDocument();
        expect(keymaster.addGroupMember).toHaveBeenCalledWith('team', 'did:cid:dave');
        expect(screen.getByLabelText('DID')).toHaveValue('');
        expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
        expect(setError).not.toHaveBeenCalled();
    });

    it('reports a failure to add a member and keeps what was typed', async () => {
        const user = userEvent.setup();
        const failure = new Error('unknown DID');
        keymaster.addGroupMember.mockRejectedValue(failure);
        render(<GroupsTab />);
        await openGroup(user);

        await user.type(screen.getByLabelText('DID'), 'nobody');
        await user.click(screen.getByRole('button', { name: 'Add' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(keymaster.getGroup).toHaveBeenCalledTimes(1);
        expect(screen.getByLabelText('DID')).toHaveValue('nobody');
    });

    it('removes a member once the removal is confirmed', async () => {
        const user = userEvent.setup();
        render(<GroupsTab />);
        await openGroup(user);

        await user.click(screen.getAllByRole('button', { name: 'Delete' })[1]);
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByText('Remove member from team?')).toBeInTheDocument();
        expect(keymaster.removeGroupMember).not.toHaveBeenCalled();

        keymaster.getGroup.mockResolvedValue({ name: 'team', members: [BOB] });
        await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));

        await waitFor(() => expect(screen.queryByText(CAROL)).toBeNull());
        expect(keymaster.removeGroupMember).toHaveBeenCalledWith('team', CAROL);
        expect(screen.getByText('Bob')).toBeInTheDocument();
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('keeps the member when the removal is cancelled', async () => {
        const user = userEvent.setup();
        render(<GroupsTab />);
        await openGroup(user);

        await user.click(screen.getAllByRole('button', { name: 'Delete' })[0]);
        await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));

        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(keymaster.removeGroupMember).not.toHaveBeenCalled();
        expect(screen.getByText('Bob')).toBeInTheDocument();
    });

    it('reports a failure to remove a member and closes the question', async () => {
        const user = userEvent.setup();
        const failure = new Error('not the owner');
        keymaster.removeGroupMember.mockRejectedValue(failure);
        render(<GroupsTab />);
        await openGroup(user);

        await user.click(screen.getAllByRole('button', { name: 'Delete' })[0]);
        await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Confirm' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(keymaster.removeGroupMember).toHaveBeenCalledWith('team', BOB);
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(screen.getByText('Bob')).toBeInTheDocument();
    });
});

describe('renaming a group', () => {
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

    it('cannot be asked for before a group is picked', () => {
        render(<GroupsTab />);

        expect(renameButton()).toBeDisabled();
    });

    it('gives the group its new alias and drops the old one', async () => {
        const user = userEvent.setup();
        walletData.refreshAliases.mockImplementation(async () => {
            variables.aliasList = { crew: GROUP, taken: 'did:cid:other', Bob: BOB };
            variables.groupList = ['crew'];
        });
        render(<GroupsTab />);
        await openGroup(user);

        await rename(user, 'crew');

        await waitFor(() => expect(setSuccess).toHaveBeenCalledWith('Group renamed'));
        expect(keymaster.addAlias).toHaveBeenCalledWith('crew', GROUP);
        expect(keymaster.removeAlias).toHaveBeenCalledWith('team');
        expect(walletData.refreshAliases).toHaveBeenCalled();
        expect(groupPicker()).toHaveTextContent('crew');
        // The group stays open under its new name.
        expect(screen.getByText('Bob')).toBeInTheDocument();
    });

    it('refuses a name that is already an alias', async () => {
        const user = userEvent.setup();
        render(<GroupsTab />);
        await openGroup(user);

        await rename(user, 'taken');

        expect(setError).toHaveBeenCalledWith('taken already in use');
        expect(keymaster.addAlias).not.toHaveBeenCalled();
        expect(keymaster.removeAlias).not.toHaveBeenCalled();
    });

    it('changes nothing when the name is left as it was or left empty', async () => {
        const user = userEvent.setup();
        render(<GroupsTab />);
        await openGroup(user);

        await rename(user, 'team');
        await rename(user, '');

        expect(keymaster.addAlias).not.toHaveBeenCalled();
        expect(keymaster.removeAlias).not.toHaveBeenCalled();
        expect(setError).not.toHaveBeenCalled();
        expect(setSuccess).not.toHaveBeenCalled();
    });

    it('changes nothing when the rename is cancelled', async () => {
        const user = userEvent.setup();
        render(<GroupsTab />);
        await openGroup(user);

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
        render(<GroupsTab />);
        await openGroup(user);

        await rename(user, 'crew');

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(keymaster.removeAlias).not.toHaveBeenCalled();
        expect(setSuccess).not.toHaveBeenCalled();
        expect(groupPicker()).toHaveTextContent('team');
    });
});

describe('a group left open when the wallet loses its keymaster', () => {
    it('asks nothing of the keymaster and reports nothing', async () => {
        const user = userEvent.setup();
        const shown = render(<GroupsTab />);
        await openGroup(user);
        await user.type(screen.getByLabelText('DID'), 'did:cid:dave');

        wallet.keymaster = null;
        shown.rerender(<GroupsTab />);
        vi.clearAllMocks();

        await user.click(screen.getByRole('button', { name: 'Add' }));

        await user.click(screen.getAllByRole('button', { name: 'Delete' })[0]);
        const removing = await screen.findByRole('dialog');
        await user.click(within(removing).getByRole('button', { name: 'Confirm' }));
        await user.click(within(removing).getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

        await user.click(renameButton());
        const renaming = await screen.findByRole('dialog', { name: 'Rename Group' });
        await user.type(within(renaming).getByLabelText('New Name'), '-two');
        await user.click(within(renaming).getByRole('button', { name: 'Rename' }));
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Rename Group' })).toBeNull());

        for (const method of Object.values(keymaster)) {
            expect(method).not.toHaveBeenCalled();
        }
        expect(setError).not.toHaveBeenCalled();
        expect(setSuccess).not.toHaveBeenCalled();
    });
});
