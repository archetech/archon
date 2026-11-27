import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import AliasedDIDs from '../../../../packages/wallet-ui/src/components/AliasedDIDs';

// The Aliases tab adds a name for a DID and lists the wallet's names, which it
// filters by name, kind and registry. A name can be renamed and removed, and
// the DID behind it resolved, transferred, moved to another registry and
// revoked.

const { keymaster, wallet, variables, navigation, platform, refreshAliases, handleCopyDID, setError } = vi.hoisted(() => {
    const keymaster = {
        resolveDID: vi.fn(), addAlias: vi.fn(), removeAlias: vi.fn(),
        revokeDID: vi.fn(), transferAsset: vi.fn(), changeRegistry: vi.fn(),
    };

    return {
        keymaster,
        wallet: { keymaster: keymaster as typeof keymaster | null },
        variables: {
            // What the two fields hold when the tab is mounted.
            alias: '',
            aliasDID: '',
            setAlias: vi.fn(),
            setAliasDID: vi.fn(),
            aliasList: {} as Record<string, string> | null,
            unresolvedList: {} as Record<string, string> | null,
            aliasRegistry: {} as Record<string, string>,
            registries: [] as string[],
            agentList: [] as string[] | null,
            vaultList: [] as string[] | null,
            groupList: [] as string[] | null,
            schemaList: [] as string[] | null,
            imageList: [] as string[] | null,
            fileList: [] as string[] | null,
            pollList: [] as string[] | null,
        },
        navigation: {
            openView: vi.fn(),
            pendingView: null as { tab: string; did?: string } | null,
        },
        platform: {
            scanAliasQr: undefined as undefined | ReturnType<typeof vi.fn>,
            requestRefresh: undefined as undefined | ReturnType<typeof vi.fn>,
        },
        refreshAliases: vi.fn(),
        handleCopyDID: vi.fn(),
        setError: vi.fn(),
    };
});
vi.mock('../../../../packages/wallet-ui/src/contexts/WalletProvider', () => ({ useWalletContext: () => wallet }));
// The Alias and DID fields are state the provider keeps, so the stand-in keeps
// it too: a field shows what was typed, and each setter still records its calls.
vi.mock('../../../../packages/wallet-ui/src/contexts/VariablesProvider', async () => {
    const { useState } = await import('react');
    return {
        useVariablesContext: () => {
            const [alias, setAlias] = useState(variables.alias);
            const [aliasDID, setAliasDID] = useState(variables.aliasDID);
            return {
                ...variables,
                alias,
                aliasDID,
                setAlias: (value: string) => {
                    variables.setAlias(value);
                    setAlias(value);
                },
                setAliasDID: (value: string) => {
                    variables.setAliasDID(value);
                    setAliasDID(value);
                },
            };
        },
    };
});
vi.mock('../../../../packages/wallet-ui/src/contexts/SnackbarProvider', () => ({ useSnackbar: () => ({ setError }) }));
vi.mock('../../../../packages/wallet-ui/src/contexts/WalletNavigation', () => ({ useWalletNavigation: () => navigation }));
vi.mock('../../../../packages/wallet-ui/src/contexts/PlatformCapabilities', () => ({ usePlatformCapabilities: () => platform }));
vi.mock('../../../../packages/wallet-ui/src/hooks/useWalletData', () => ({
    useWalletData: () => ({ refreshAliases, handleCopyDID }),
}));

const did = (name: string) => `did:cid:${name}`;
const failure = new Error('refused');

// A document as Keymaster's resolveDID returns it, which always adds `version`
// and `isOwned` to the metadata.
function resolved(id: string, data: unknown = {}) {
    return {
        didDocument: { '@context': ['https://www.w3.org/ns/did/v1'], id },
        didDocumentMetadata: {
            created: '2026-01-02T03:04:05Z',
            versionId: `version-of-${id}`,
            versionSequence: '1',
            confirmed: true,
            version: 1,
            isOwned: false,
        },
        didDocumentData: data,
        didDocumentRegistration: { version: 1, type: 'agent', registry: 'hyperswarm' },
        didResolutionMetadata: { retrieved: '2026-01-02T03:04:06Z' },
    };
}

beforeEach(() => {
    vi.resetAllMocks();
    wallet.keymaster = keymaster;
    variables.alias = '';
    variables.aliasDID = '';
    variables.aliasList = {
        bob: did('bob'), safe: did('safe'), team: did('team'), card: did('card'),
        photo: did('photo'), report: did('report'), vote: did('vote'),
    };
    variables.unresolvedList = { ghost: did('ghost') };
    variables.aliasRegistry = {
        bob: 'hyperswarm', safe: 'hyperswarm', team: 'BTC:mainnet', card: 'hyperswarm',
        photo: 'hyperswarm', report: 'BTC:mainnet', vote: 'hyperswarm',
    };
    variables.registries = ['local', 'hyperswarm', 'BTC:mainnet'];
    variables.agentList = ['bob'];
    variables.vaultList = ['safe'];
    variables.groupList = ['team'];
    variables.schemaList = ['card'];
    variables.imageList = ['photo'];
    variables.fileList = ['report'];
    variables.pollList = ['vote'];
    navigation.pendingView = null;
    platform.scanAliasQr = undefined;
    platform.requestRefresh = undefined;
    // Each of these answers true once the wallet or the operation is saved.
    keymaster.addAlias.mockResolvedValue(true);
    keymaster.removeAlias.mockResolvedValue(true);
    keymaster.revokeDID.mockResolvedValue(true);
    keymaster.transferAsset.mockResolvedValue(true);
    keymaster.changeRegistry.mockResolvedValue(true);
    keymaster.resolveDID.mockImplementation(async (id: string) => resolved(id.startsWith('did:') ? id : did(id)));
});

const ALL = ['bob', 'card', 'ghost', 'photo', 'report', 'safe', 'team', 'vote'];

const aliasField = () => screen.getByLabelText('Alias');
const didField = () => screen.getByLabelText('DID');
const button = (name: string) => screen.getByRole('button', { name });
// Neither filter has a label: they are told apart by order.
const kindFilter = () => screen.getAllByRole('combobox')[0];
const registryFilter = () => screen.getAllByRole('combobox')[1];
// The row of a name: its checkbox, its icon and its buttons.
const row = (name: string) => screen.getByText(name, { selector: 'p' }).parentElement!.parentElement as HTMLElement;
const rowButton = (name: string, action: string) => within(row(name)).getByRole('button', { name: action });
const rowCheckbox = (name: string) => within(row(name)).getByRole('checkbox');
// The names listed, top to bottom. The checkbox above the list is not in a row.
const listed = () => screen.getAllByRole('checkbox').slice(1)
    .map(checkbox => checkbox.closest('div')!.parentElement!.textContent);
const selectAll = () => screen.getAllByRole('checkbox')[0];
// The arrow beside the checkbox above the list, which opens the menu for the
// names selected. The filters draw the same arrow, but not as a button.
const selectionMenu = () => screen.getAllByTestId('ArrowDropDownIcon')
    .map(icon => icon.closest('button'))
    .find(found => found !== null) as HTMLButtonElement;

async function choose(user: UserEvent, filter: HTMLElement, option: string) {
    await user.click(filter);
    await user.click(await screen.findByRole('option', { name: option }));
}

async function confirm(user: UserEvent) {
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Confirm' }));
}

const dialogGone = () => waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

describe('the list of names', () => {
    it('shows every name, resolved or not, in order', () => {
        render(<AliasedDIDs />);

        expect(listed()).toEqual(ALL);
    });

    it('marks each name with the icon of its kind', () => {
        render(<AliasedDIDs />);

        const icon = (name: string) => row(name).querySelector('p svg')!.getAttribute('data-testid');
        expect(icon('bob')).toBe('PermIdentityIcon');
        expect(icon('safe')).toBe('LockIcon');
        expect(icon('team')).toBe('GroupsIcon');
        expect(icon('card')).toBe('SchemaIcon');
        expect(icon('photo')).toBe('ImageIcon');
        expect(icon('report')).toBe('ArticleIcon');
        expect(icon('vote')).toBe('PollIcon');
        expect(icon('ghost')).toBe('QuestionMarkIcon');
    });

    it('is empty while the wallet\'s names are not known', () => {
        variables.aliasList = null;
        variables.unresolvedList = null;
        render(<AliasedDIDs />);

        expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    });

    it('copies and opens the DID behind a name', async () => {
        const user = userEvent.setup({ delay: null });
        render(<AliasedDIDs />);

        await user.click(within(within(row('safe')).getByLabelText('Copy')).getByRole('button'));
        await user.click(within(within(row('safe')).getByLabelText('Resolve')).getByRole('button'));

        expect(handleCopyDID).toHaveBeenCalledWith(did('safe'));
        expect(navigation.openView).toHaveBeenCalledWith({ did: did('safe'), tab: 'viewer' });
    });
});

describe('filtering the list', () => {
    it('keeps the names that contain what is searched for, whatever its case', async () => {
        const user = userEvent.setup({ delay: null });
        render(<AliasedDIDs />);

        await user.type(screen.getByLabelText('Search'), 'PO');

        expect(listed()).toEqual(['report']);
    });

    it('shows every name again when the search is cleared', async () => {
        const user = userEvent.setup({ delay: null });
        render(<AliasedDIDs />);
        expect(screen.queryByTestId('ClearIcon')).toBeNull();

        await user.type(screen.getByLabelText('Search'), 'bo');
        expect(listed()).toEqual(['bob']);
        await user.click(screen.getByTestId('ClearIcon').closest('button')!);

        expect(screen.getByLabelText('Search')).toHaveValue('');
        expect(listed()).toEqual(ALL);
    });

    it.each([
        ['Agents', ['bob']],
        ['Groups', ['team']],
        ['Images', ['photo']],
        ['Polls', ['vote']],
        ['Schemas', ['card']],
        ['Vaults', ['safe']],
        ['Unknown', ['ghost']],
    ])('keeps only the %s when that kind is chosen', async (kind, names) => {
        const user = userEvent.setup({ delay: null });
        render(<AliasedDIDs />);

        await choose(user, kindFilter(), kind);

        expect(listed()).toEqual(names);
    });

    it('shows every kind again when Type: All is chosen', async () => {
        const user = userEvent.setup({ delay: null });
        render(<AliasedDIDs />);

        await choose(user, kindFilter(), 'Agents');
        await choose(user, kindFilter(), 'Type: All');

        expect(listed()).toEqual(ALL);
    });

    it('offers the registries the names are on, and the names on none', async () => {
        const user = userEvent.setup({ delay: null });
        render(<AliasedDIDs />);

        await user.click(registryFilter());

        const offered = (await screen.findAllByRole('option')).map(option => option.textContent);
        expect(offered).toEqual(['Registry: All', 'BTC:mainnet', 'hyperswarm', 'Unresolved']);
    });

    it('keeps only the names on the registry chosen', async () => {
        const user = userEvent.setup({ delay: null });
        render(<AliasedDIDs />);

        await choose(user, registryFilter(), 'BTC:mainnet');

        expect(listed()).toEqual(['report', 'team']);
    });

    it('keeps only the names that did not resolve when Unresolved is chosen', async () => {
        const user = userEvent.setup({ delay: null });
        render(<AliasedDIDs />);

        await choose(user, registryFilter(), 'Unresolved');

        expect(listed()).toEqual(['ghost']);
    });

    it('applies the search, the kind and the registry together', async () => {
        const user = userEvent.setup({ delay: null });
        variables.agentList = ['bob', 'team'];
        variables.groupList = [];
        render(<AliasedDIDs />);

        await choose(user, kindFilter(), 'Agents');
        expect(listed()).toEqual(['bob', 'team']);
        await choose(user, registryFilter(), 'BTC:mainnet');
        expect(listed()).toEqual(['team']);
        await user.type(screen.getByLabelText('Search'), 'bo');

        expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    });

    it('goes back to every registry when the one chosen has no names left', async () => {
        const user = userEvent.setup({ delay: null });
        const { rerender } = render(<AliasedDIDs />);
        await choose(user, registryFilter(), 'BTC:mainnet');
        expect(listed()).toEqual(['report', 'team']);

        variables.aliasRegistry = { ...variables.aliasRegistry, team: 'hyperswarm', report: 'hyperswarm' };
        rerender(<AliasedDIDs />);

        await waitFor(() => expect(registryFilter()).toHaveTextContent('Registry: All'));
        expect(listed()).toEqual(ALL);
    });
});

describe('adding a name', () => {
    it('offers each button only once it has something to work on', async () => {
        const user = userEvent.setup({ delay: null });
        render(<AliasedDIDs />);

        expect(button('Resolve')).toBeDisabled();
        expect(button('Add')).toBeDisabled();
        expect(button('Clear')).toBeDisabled();

        await user.type(aliasField(), 'carol');
        expect(button('Resolve')).toBeEnabled();
        expect(button('Add')).toBeDisabled();
        expect(button('Clear')).toBeEnabled();

        await user.type(didField(), did('carol'));
        expect(button('Add')).toBeEnabled();
    });

    it('adds the name for the DID, empties the fields and refreshes the wallet\'s other views', async () => {
        const user = userEvent.setup({ delay: null });
        platform.requestRefresh = vi.fn();
        render(<AliasedDIDs />);

        await user.type(aliasField(), 'carol');
        await user.type(didField(), did('carol'));
        await user.click(button('Add'));

        await waitFor(() => expect(platform.requestRefresh).toHaveBeenCalledTimes(1));
        expect(keymaster.addAlias).toHaveBeenCalledWith('carol', did('carol'));
        expect(refreshAliases).toHaveBeenCalledTimes(1);
        expect(aliasField()).toHaveValue('');
        expect(didField()).toHaveValue('');
        expect(setError).not.toHaveBeenCalled();
    });

    it('adds the name on a host with no other views to refresh', async () => {
        const user = userEvent.setup({ delay: null });
        render(<AliasedDIDs />);

        await user.type(aliasField(), 'carol');
        await user.type(didField(), did('carol'));
        await user.click(button('Add'));

        await waitFor(() => expect(refreshAliases).toHaveBeenCalledTimes(1));
        expect(setError).not.toHaveBeenCalled();
    });

    it('reports a name the wallet refuses and keeps what was typed', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.addAlias.mockRejectedValue(failure);
        render(<AliasedDIDs />);

        await user.type(aliasField(), 'bob');
        await user.type(didField(), did('carol'));
        await user.click(button('Add'));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(refreshAliases).not.toHaveBeenCalled();
        expect(aliasField()).toHaveValue('bob');
        expect(didField()).toHaveValue(did('carol'));
    });

    it('takes the spaces off a DID that is pasted in', async () => {
        const user = userEvent.setup({ delay: null });
        render(<AliasedDIDs />);

        await user.click(didField());
        await user.paste(`  ${did('carol')}\n`);

        expect(didField()).toHaveValue(did('carol'));
    });

    it('empties both fields on Clear', async () => {
        const user = userEvent.setup({ delay: null });
        variables.alias = 'carol';
        variables.aliasDID = did('carol');
        render(<AliasedDIDs />);

        await user.click(button('Clear'));

        expect(aliasField()).toHaveValue('');
        expect(didField()).toHaveValue('');
        expect(button('Clear')).toBeDisabled();
    });

    it('starts with the DID another view asked this tab to show', () => {
        navigation.pendingView = { tab: 'aliases', did: did('carol') };
        render(<AliasedDIDs />);

        expect(didField()).toHaveValue(did('carol'));
    });

    it.each([
        ['is for another tab', { tab: 'viewer', did: did('carol') }],
        ['names no DID', { tab: 'aliases' }],
    ])('leaves the DID alone when the view asked for %s', (_case, pendingView) => {
        navigation.pendingView = pendingView;
        render(<AliasedDIDs />);

        expect(didField()).toHaveValue('');
        expect(variables.setAliasDID).not.toHaveBeenCalled();
    });
});

describe('resolving what is typed', () => {
    it('opens the DID typed and takes the name its document gives', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.resolveDID.mockResolvedValue(resolved(did('carol'), { name: 'Carol' }));
        render(<AliasedDIDs />);

        await user.type(didField(), did('carol'));
        await user.click(button('Resolve'));

        await waitFor(() => expect(navigation.openView).toHaveBeenCalledWith({ did: did('carol'), tab: 'viewer' }));
        expect(keymaster.resolveDID).toHaveBeenCalledWith(did('carol'));
        expect(aliasField()).toHaveValue('Carol');
        expect(setError).not.toHaveBeenCalled();
    });

    it('leaves the name empty when the document gives none', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.resolveDID.mockResolvedValue(resolved(did('carol'), { name: 7 }));
        render(<AliasedDIDs />);

        await user.type(didField(), did('carol'));
        await user.click(button('Resolve'));

        await waitFor(() => expect(navigation.openView).toHaveBeenCalledTimes(1));
        expect(aliasField()).toHaveValue('');
    });

    it('resolves a name typed alone, without the spaces around it, and fills in its DID', async () => {
        const user = userEvent.setup({ delay: null });
        render(<AliasedDIDs />);

        await user.type(aliasField(), ' bob ');
        await user.click(button('Resolve'));

        await waitFor(() => expect(navigation.openView).toHaveBeenCalledWith({ did: did('bob'), tab: 'viewer' }));
        expect(keymaster.resolveDID).toHaveBeenCalledWith('bob');
        expect(didField()).toHaveValue(did('bob'));
        expect(aliasField()).toHaveValue(' bob ');
    });

    it('resolves the DID when both are typed and keeps the name typed', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.resolveDID.mockResolvedValue(resolved(did('carol'), { name: 'Carol' }));
        render(<AliasedDIDs />);

        await user.type(aliasField(), 'friend');
        await user.type(didField(), did('carol'));
        await user.click(button('Resolve'));

        await waitFor(() => expect(navigation.openView).toHaveBeenCalledTimes(1));
        expect(keymaster.resolveDID).toHaveBeenCalledWith(did('carol'));
        expect(aliasField()).toHaveValue('friend');
    });

    it('says so when the document resolved has no DID', async () => {
        const user = userEvent.setup({ delay: null });
        // A revoked DID resolves to an empty document.
        keymaster.resolveDID.mockResolvedValue({ ...resolved(did('carol')), didDocument: {} });
        render(<AliasedDIDs />);

        await user.type(didField(), did('carol'));
        await user.click(button('Resolve'));

        await waitFor(() => expect(setError).toHaveBeenCalledWith('Resolved document is missing a DID'));
        expect(navigation.openView).not.toHaveBeenCalled();
    });

    it('reports a DID that cannot be resolved', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.resolveDID.mockRejectedValue(failure);
        render(<AliasedDIDs />);

        await user.type(didField(), did('nobody'));
        await user.click(button('Resolve'));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(navigation.openView).not.toHaveBeenCalled();
    });
});

describe('scanning a QR code', () => {
    const scanButton = () => within(screen.getByLabelText('Scan QR')).getByRole('button');

    it('fills in the name and the DID the code carries', async () => {
        const user = userEvent.setup({ delay: null });
        platform.scanAliasQr = vi.fn().mockResolvedValue({ alias: 'carol', did: did('carol') });
        render(<AliasedDIDs />);

        await user.click(scanButton());

        await waitFor(() => expect(aliasField()).toHaveValue('carol'));
        expect(didField()).toHaveValue(did('carol'));
        expect(setError).not.toHaveBeenCalled();
    });

    it('says so when the code carries no name', async () => {
        const user = userEvent.setup({ delay: null });
        platform.scanAliasQr = vi.fn().mockResolvedValue(null);
        render(<AliasedDIDs />);

        await user.click(scanButton());

        await waitFor(() => expect(setError).toHaveBeenCalledWith('No alias link found in QR code'));
        expect(aliasField()).toHaveValue('');
        expect(didField()).toHaveValue('');
    });
});

describe('renaming a name', () => {
    async function openRename(user: UserEvent, name = 'bob') {
        await user.click(rowButton(name, 'Rename'));
        return screen.findByRole('dialog');
    }

    async function renameTo(user: UserEvent, name: string) {
        const dialog = await openRename(user);
        const field = within(dialog).getByLabelText('New Name');
        await user.clear(field);
        if (name) {
            await user.type(field, name);
        }
        await user.click(within(dialog).getByRole('button', { name: 'Rename' }));
        await dialogGone();
    }

    it('asks for the new name, starting from the old one', async () => {
        const user = userEvent.setup({ delay: null });
        render(<AliasedDIDs />);

        const dialog = await openRename(user);

        expect(dialog).toHaveTextContent('Rename DID');
        expect(dialog).toHaveTextContent("Rename 'bob' to:");
        expect(within(dialog).getByLabelText('New Name')).toHaveValue('bob');
    });

    it('adds the new name for the same DID, then removes the old one', async () => {
        const user = userEvent.setup({ delay: null });
        render(<AliasedDIDs />);

        await renameTo(user, ' robert ');

        await waitFor(() => expect(refreshAliases).toHaveBeenCalledTimes(1));
        expect(keymaster.addAlias).toHaveBeenCalledWith('robert', did('bob'));
        expect(keymaster.removeAlias).toHaveBeenCalledWith('bob');
        expect(keymaster.addAlias.mock.invocationCallOrder[0])
            .toBeLessThan(keymaster.removeAlias.mock.invocationCallOrder[0]);
        expect(setError).not.toHaveBeenCalled();
    });

    it.each([
        ['is unchanged', 'bob'],
        ['is empty', ''],
    ])('changes nothing when the name %s', async (_case, name) => {
        const user = userEvent.setup({ delay: null });
        render(<AliasedDIDs />);

        await renameTo(user, name);

        expect(keymaster.addAlias).not.toHaveBeenCalled();
        expect(keymaster.removeAlias).not.toHaveBeenCalled();
        expect(refreshAliases).not.toHaveBeenCalled();
    });

    it('changes nothing on Cancel', async () => {
        const user = userEvent.setup({ delay: null });
        render(<AliasedDIDs />);
        const dialog = await openRename(user);

        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

        await dialogGone();
        expect(keymaster.addAlias).not.toHaveBeenCalled();
    });

    it('reports a name the wallet refuses and keeps the old one', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.addAlias.mockRejectedValue(failure);
        render(<AliasedDIDs />);

        await renameTo(user, 'safe');

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(keymaster.removeAlias).not.toHaveBeenCalled();
        expect(refreshAliases).not.toHaveBeenCalled();
    });
});

describe('transferring an asset', () => {
    async function openTransfer(user: UserEvent, name = 'photo') {
        await user.click(rowButton(name, 'Transfer'));
        return screen.findByRole('dialog');
    }

    it('asks who the new controller is, then hands the asset over', async () => {
        const user = userEvent.setup({ delay: null });
        render(<AliasedDIDs />);
        const dialog = await openTransfer(user);

        expect(dialog).toHaveTextContent('Transfer Asset');
        expect(dialog).toHaveTextContent("Transfer ownership of 'photo' to name or DID.");
        expect(within(dialog).getByLabelText('New Controller')).toHaveValue('');
        await user.type(within(dialog).getByLabelText('New Controller'), ' bob ');
        await user.click(within(dialog).getByRole('button', { name: 'Transfer' }));

        await waitFor(() => expect(refreshAliases).toHaveBeenCalledTimes(1));
        expect(keymaster.transferAsset).toHaveBeenCalledWith('photo', 'bob');
        await dialogGone();
        expect(setError).not.toHaveBeenCalled();
    });

    it('transfers nothing when no controller is named', async () => {
        const user = userEvent.setup({ delay: null });
        render(<AliasedDIDs />);
        const dialog = await openTransfer(user);

        await user.click(within(dialog).getByRole('button', { name: 'Transfer' }));

        await dialogGone();
        expect(keymaster.transferAsset).not.toHaveBeenCalled();
    });

    it('transfers nothing on Cancel', async () => {
        const user = userEvent.setup({ delay: null });
        render(<AliasedDIDs />);
        const dialog = await openTransfer(user);

        await user.type(within(dialog).getByLabelText('New Controller'), 'bob');
        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

        await dialogGone();
        expect(keymaster.transferAsset).not.toHaveBeenCalled();
    });

    it('reports a transfer that fails', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.transferAsset.mockRejectedValue(failure);
        render(<AliasedDIDs />);
        const dialog = await openTransfer(user, 'bob');

        await user.type(within(dialog).getByLabelText('New Controller'), 'safe');
        await user.click(within(dialog).getByRole('button', { name: 'Transfer' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(refreshAliases).not.toHaveBeenCalled();
    });
});

describe('moving a DID to another registry', () => {
    async function openMigrate(user: UserEvent, name = 'photo') {
        await user.click(rowButton(name, 'Migrate'));
        return screen.findByRole('dialog');
    }

    it('offers the node\'s registries, the first one chosen', async () => {
        const user = userEvent.setup({ delay: null });
        render(<AliasedDIDs />);

        const dialog = await openMigrate(user);

        expect(dialog).toHaveTextContent('Migrate DID');
        expect(dialog).toHaveTextContent("Select registry for 'photo'");
        expect(within(dialog).getByRole('combobox')).toHaveTextContent('local');
        await user.click(within(dialog).getByRole('combobox'));
        const offered = (await screen.findAllByRole('option')).map(option => option.textContent);
        expect(offered).toEqual(['local', 'hyperswarm', 'BTC:mainnet']);
    });

    it('moves the DID to the registry chosen', async () => {
        const user = userEvent.setup({ delay: null });
        render(<AliasedDIDs />);
        const dialog = await openMigrate(user);

        await user.click(within(dialog).getByRole('combobox'));
        await user.click(await screen.findByRole('option', { name: 'BTC:mainnet' }));
        await user.click(within(dialog).getByRole('button', { name: 'Migrate' }));

        await waitFor(() => expect(refreshAliases).toHaveBeenCalledTimes(1));
        expect(keymaster.changeRegistry).toHaveBeenCalledWith('photo', 'BTC:mainnet');
        await dialogGone();
        expect(setError).not.toHaveBeenCalled();
    });

    it('moves nothing on Cancel', async () => {
        const user = userEvent.setup({ delay: null });
        render(<AliasedDIDs />);
        const dialog = await openMigrate(user);

        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

        await dialogGone();
        expect(keymaster.changeRegistry).not.toHaveBeenCalled();
    });

    it('reports a move that fails', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.changeRegistry.mockRejectedValue(failure);
        render(<AliasedDIDs />);
        const dialog = await openMigrate(user);

        await user.click(within(dialog).getByRole('button', { name: 'Migrate' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(keymaster.changeRegistry).toHaveBeenCalledWith('photo', 'local');
        expect(refreshAliases).not.toHaveBeenCalled();
    });
});

describe('revoking a DID', () => {
    it('asks first, then revokes it', async () => {
        const user = userEvent.setup({ delay: null });
        render(<AliasedDIDs />);

        await user.click(rowButton('photo', 'Revoke'));
        const dialog = await screen.findByRole('dialog');
        expect(dialog).toHaveTextContent('Revoke DID');
        expect(dialog).toHaveTextContent("Are you sure you want to revoke 'photo'? This operation cannot be undone.");
        expect(keymaster.revokeDID).not.toHaveBeenCalled();
        await confirm(user);

        await waitFor(() => expect(refreshAliases).toHaveBeenCalledTimes(1));
        expect(keymaster.revokeDID).toHaveBeenCalledWith('photo');
        await dialogGone();
        expect(setError).not.toHaveBeenCalled();
    });

    it('revokes nothing on Cancel', async () => {
        const user = userEvent.setup({ delay: null });
        render(<AliasedDIDs />);

        await user.click(rowButton('photo', 'Revoke'));
        await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));

        await dialogGone();
        expect(keymaster.revokeDID).not.toHaveBeenCalled();
    });

    it('reports a revocation that fails and closes the question', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.revokeDID.mockRejectedValue(failure);
        render(<AliasedDIDs />);

        await user.click(rowButton('photo', 'Revoke'));
        await confirm(user);

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        await dialogGone();
        expect(refreshAliases).not.toHaveBeenCalled();
    });
});

describe('removing a name', () => {
    it('asks first, then removes it', async () => {
        const user = userEvent.setup({ delay: null });
        render(<AliasedDIDs />);

        await user.click(rowButton('photo', 'Delete'));
        const dialog = await screen.findByRole('dialog');
        expect(dialog).toHaveTextContent('Remove DID');
        expect(dialog).toHaveTextContent("Are you sure you want to remove 'photo'?");
        expect(keymaster.removeAlias).not.toHaveBeenCalled();
        await confirm(user);

        await waitFor(() => expect(refreshAliases).toHaveBeenCalledTimes(1));
        expect(keymaster.removeAlias).toHaveBeenCalledWith('photo');
        await dialogGone();
        expect(setError).not.toHaveBeenCalled();
    });

    it('removes nothing on Cancel', async () => {
        const user = userEvent.setup({ delay: null });
        render(<AliasedDIDs />);

        await user.click(rowButton('photo', 'Delete'));
        await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));

        await dialogGone();
        expect(keymaster.removeAlias).not.toHaveBeenCalled();
    });

    it('reports a removal that fails and closes the question', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.removeAlias.mockRejectedValue(failure);
        render(<AliasedDIDs />);

        await user.click(rowButton('photo', 'Delete'));
        await confirm(user);

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        await dialogGone();
        expect(refreshAliases).not.toHaveBeenCalled();
    });
});

describe('selecting names', () => {
    const selected = () => ALL.filter(name => (rowCheckbox(name) as HTMLInputElement).checked);

    it('selects one name at a time', async () => {
        const user = userEvent.setup({ delay: null });
        render(<AliasedDIDs />);

        await user.click(rowCheckbox('card'));
        await user.click(rowCheckbox('safe'));
        expect(selected()).toEqual(['card', 'safe']);
        expect(selectAll()).toHaveAttribute('data-indeterminate', 'true');

        await user.click(rowCheckbox('card'));
        expect(selected()).toEqual(['safe']);
    });

    it('selects every name between two when the second is shift-clicked', async () => {
        const user = userEvent.setup({ delay: null });
        render(<AliasedDIDs />);

        await user.click(rowCheckbox('card'));
        await user.keyboard('{Shift>}');
        await user.click(rowCheckbox('report'));
        await user.keyboard('{/Shift}');

        expect(selected()).toEqual(['card', 'ghost', 'photo', 'report']);
    });

    it('deselects every name between two when the second is shift-clicked off', async () => {
        const user = userEvent.setup({ delay: null });
        render(<AliasedDIDs />);
        await user.click(selectAll());
        expect(selected()).toEqual(ALL);

        await user.click(rowCheckbox('team'));
        await user.keyboard('{Shift>}');
        await user.click(rowCheckbox('photo'));
        await user.keyboard('{/Shift}');

        expect(selected()).toEqual(['bob', 'card', 'ghost', 'vote']);
    });

    it('selects every name listed from the checkbox above the list, and none from it again', async () => {
        const user = userEvent.setup({ delay: null });
        render(<AliasedDIDs />);

        await user.click(selectAll());
        expect(selected()).toEqual(ALL);
        expect(selectAll()).toBeChecked();

        await user.click(selectAll());
        expect(selected()).toEqual([]);
    });

    it('deselects every name listed from the checkbox above the list when only some are selected', async () => {
        const user = userEvent.setup({ delay: null });
        render(<AliasedDIDs />);
        await user.click(rowCheckbox('card'));

        await user.click(selectAll());

        expect(selected()).toEqual([]);
    });

    it('selects only the names the filters let through', async () => {
        const user = userEvent.setup({ delay: null });
        render(<AliasedDIDs />);
        await choose(user, registryFilter(), 'BTC:mainnet');

        await user.click(selectAll());
        await choose(user, registryFilter(), 'Registry: All');

        expect(selected()).toEqual(['report', 'team']);
    });
});

describe('removing the names selected', () => {
    async function openMenu(user: UserEvent) {
        await user.click(selectionMenu());
        return within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Delete' });
    }

    it('is not offered while no name is selected', async () => {
        const user = userEvent.setup({ delay: null });
        render(<AliasedDIDs />);

        expect(await openMenu(user)).toHaveAttribute('aria-disabled', 'true');

        await user.keyboard('{Escape}');
        await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    });

    it('asks first, saying how many, then removes each and clears the selection', async () => {
        const user = userEvent.setup({ delay: null });
        render(<AliasedDIDs />);
        await user.click(rowCheckbox('card'));
        await user.click(rowCheckbox('safe'));

        await user.click(await openMenu(user));
        const dialog = await screen.findByRole('dialog');
        expect(dialog).toHaveTextContent('Remove selected DIDs');
        expect(dialog).toHaveTextContent('Delete 2 selected item(s)? This cannot be undone.');
        expect(keymaster.removeAlias).not.toHaveBeenCalled();
        await confirm(user);

        await waitFor(() => expect(refreshAliases).toHaveBeenCalledTimes(1));
        expect(keymaster.removeAlias.mock.calls).toEqual([['card'], ['safe']]);
        await dialogGone();
        expect(screen.getAllByRole('checkbox').slice(1).every(box => !(box as HTMLInputElement).checked)).toBe(true);
        expect(setError).not.toHaveBeenCalled();
    });

    it('removes nothing on Cancel and keeps the selection', async () => {
        const user = userEvent.setup({ delay: null });
        render(<AliasedDIDs />);
        await user.click(rowCheckbox('card'));

        await user.click(await openMenu(user));
        await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));

        await dialogGone();
        expect(keymaster.removeAlias).not.toHaveBeenCalled();
        expect(rowCheckbox('card')).toBeChecked();
    });

    it('reports a list that cannot be read again afterwards', async () => {
        const user = userEvent.setup({ delay: null });
        refreshAliases.mockRejectedValue(failure);
        render(<AliasedDIDs />);
        await user.click(rowCheckbox('card'));

        await user.click(await openMenu(user));
        await confirm(user);

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(keymaster.removeAlias).toHaveBeenCalledWith('card');
        await dialogGone();
    });
});

describe('a wallet that loses its keymaster', () => {
    it('adds, resolves and changes nothing', async () => {
        const user = userEvent.setup({ delay: null });
        variables.alias = 'carol';
        variables.aliasDID = did('carol');
        const { rerender } = render(<AliasedDIDs />);
        await user.click(rowCheckbox('card'));
        wallet.keymaster = null;
        rerender(<AliasedDIDs />);

        await user.click(button('Add'));
        await user.click(button('Resolve'));

        await user.click(rowButton('bob', 'Rename'));
        let dialog = await screen.findByRole('dialog');
        await user.type(within(dialog).getByLabelText('New Name'), 'by');
        await user.click(within(dialog).getByRole('button', { name: 'Rename' }));
        await dialogGone();

        await user.click(rowButton('photo', 'Transfer'));
        dialog = await screen.findByRole('dialog');
        await user.type(within(dialog).getByLabelText('New Controller'), 'bob');
        await user.click(within(dialog).getByRole('button', { name: 'Transfer' }));
        await dialogGone();

        await user.click(rowButton('photo', 'Migrate'));
        await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Migrate' }));
        await dialogGone();

        await user.click(rowButton('photo', 'Revoke'));
        await confirm(user);
        // Without a keymaster the question is left open, so it is closed by hand.
        await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
        await dialogGone();

        await user.click(rowButton('photo', 'Delete'));
        await confirm(user);
        await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
        await dialogGone();

        await user.click(selectionMenu());
        await user.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Delete' }));
        await confirm(user);
        await dialogGone();

        for (const method of Object.values(keymaster)) {
            expect(method).not.toHaveBeenCalled();
        }
        expect(refreshAliases).not.toHaveBeenCalled();
        expect(navigation.openView).not.toHaveBeenCalled();
        expect(setError).not.toHaveBeenCalled();
        expect(aliasField()).toHaveValue('carol');
    });
});
