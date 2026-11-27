import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, render, renderHook, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useWalletData } from '../../../../packages/wallet-ui/src/hooks/useWalletData';
import {
    VariablesProvider,
    useVariablesContext,
    type VariablesStore,
} from '../../../../packages/wallet-ui/src/contexts/VariablesProvider';
import { WalletNavigationProvider, type WalletView } from '../../../../packages/wallet-ui/src/contexts/WalletNavigation';
import { PlatformCapabilitiesProvider } from '../../../../packages/wallet-ui/src/contexts/PlatformCapabilities';
import type { DidCidDocument } from '@didcid/gatekeeper/types';
import type { DmailItem, IDInfo } from '@didcid/keymaster/types';

// useWalletData reads the wallet's state out of Keymaster into the shared
// variables. The real VariablesProvider is mounted so each test can check the
// state a refresh leaves behind rather than which setters it happened to call.

const { keymaster, wallet, setError } = vi.hoisted(() => {
    const keymaster = {
        listIds: vi.fn(), listAliases: vi.fn(), resolveDID: vi.fn(), testPoll: vi.fn(),
        getCurrentId: vi.fn(), listCredentials: vi.fn(), listIssued: vi.fn(), fetchIdInfo: vi.fn(),
        listRegistries: vi.fn(), listDmail: vi.fn(),
    };
    return {
        keymaster,
        wallet: { keymaster: keymaster as typeof keymaster | null },
        setError: vi.fn(),
    };
});
vi.mock('../../../../packages/wallet-ui/src/contexts/WalletProvider', () => ({ useWalletContext: () => wallet }));
vi.mock('../../../../packages/wallet-ui/src/contexts/SnackbarProvider', () => ({ useSnackbar: () => ({ setError }) }));

const ALICE = 'did:cid:alice';
const BOB = 'did:cid:bob';

// What Keymaster.resolveDID returns: the Gatekeeper's resolution, with the
// metadata augmented by a numeric version and the ownership flag.
function resolved(
    did: string,
    type: 'agent' | 'asset',
    data: unknown = {},
    registry = 'hyperswarm',
): DidCidDocument {
    return {
        didDocument: type === 'agent' ? { id: did } : { id: did, controller: ALICE },
        didDocumentMetadata: {
            created: '2026-01-01T00:00:00Z',
            versionId: `bagaaiera${did.slice(8)}`,
            versionSequence: '1',
            version: 1,
            confirmed: true,
            isOwned: true,
        } as DidCidDocument['didDocumentMetadata'],
        didResolutionMetadata: { retrieved: '2026-01-02T00:00:00Z' },
        didDocumentData: data,
        didDocumentRegistration: { version: 1, type, registry },
    };
}

function idInfo(did: string): IDInfo {
    return { did, account: 0, index: 0 };
}

const dmailItem: DmailItem = {
    message: { to: [BOB], cc: [], subject: 'Hello', body: 'Hi Bob' },
    to: ['Bob'],
    cc: [],
    sender: 'Alice',
    date: '2026-01-01T00:00:00Z',
    tags: ['inbox'],
    attachments: {},
    docs: resolved('did:cid:mail', 'asset', { dmail: {} }),
};

let store!: ReturnType<typeof vi.fn<VariablesStore>>;
let navigation!: { openView: Mock<(view: WalletView) => void>; resetView?: Mock<() => void> } | null;
let platform!: { restoreSession?: Mock<() => Promise<boolean>>; requestRefresh?: Mock<() => void> };

function wrapper({ children }: { children: ReactNode }) {
    const tree = (
        <PlatformCapabilitiesProvider {...platform}>
            <VariablesProvider store={store}>{children}</VariablesProvider>
        </PlatformCapabilitiesProvider>
    );
    return navigation ? <WalletNavigationProvider {...navigation}>{tree}</WalletNavigationProvider> : tree;
}

function renderData() {
    return renderHook(() => ({ data: useWalletData(), vars: useVariablesContext() }), { wrapper });
}

// A wallet with two identities and one alias of each kind.
const aliasDocs: Record<string, DidCidDocument> = {
    Alice: resolved(ALICE, 'agent', {}, 'BTC:mainnet'),
    bob: resolved(BOB, 'agent'),
    team: resolved('did:cid:team', 'asset', { group: { name: 'team', members: [] } }),
    profile: resolved('did:cid:schema', 'asset', { schema: { type: 'object' } }),
    photo: resolved('did:cid:photo', 'asset', { image: { cid: 'bafy', type: 'image/png' } }),
    notes: resolved('did:cid:notes', 'asset', { file: { cid: 'bafy', type: 'text/plain' } }),
    safe: resolved('did:cid:safe', 'asset', { vault: 'v' }),
    vote: resolved('did:cid:vote', 'asset', { vault: 'p' }),
    plain: resolved('did:cid:plain', 'asset', 'a string is valid asset data'),
};

function givenWallet() {
    keymaster.listIds.mockResolvedValue(['Alice', 'Ghost']);
    // Out of order on purpose: the hook sorts them.
    keymaster.listAliases.mockResolvedValue({
        vote: 'did:cid:vote', team: 'did:cid:team', bob: BOB, safe: 'did:cid:safe',
        profile: 'did:cid:schema', photo: 'did:cid:photo', notes: 'did:cid:notes',
        plain: 'did:cid:plain', gone: 'did:cid:gone',
    });
    keymaster.resolveDID.mockImplementation(async (name: string) => {
        const doc = aliasDocs[name];
        if (!doc) {
            throw new Error('Invalid DID: unknown');
        }
        return doc;
    });
    keymaster.testPoll.mockImplementation(async (name: string) => name === 'vote');
    keymaster.getCurrentId.mockResolvedValue('Alice');
    keymaster.listCredentials.mockResolvedValue(['did:cid:held1']);
    keymaster.listIssued.mockResolvedValue(['did:cid:issued1']);
    keymaster.fetchIdInfo.mockResolvedValue(idInfo(ALICE));
    keymaster.listRegistries.mockResolvedValue(['hyperswarm', 'BTC:mainnet']);
    keymaster.listDmail.mockResolvedValue({ 'did:cid:mail': dmailItem });
}

beforeEach(() => {
    vi.resetAllMocks();
    wallet.keymaster = keymaster;
    store = vi.fn<VariablesStore>().mockResolvedValue(undefined);
    navigation = null;
    platform = {};
    givenWallet();
});

describe('getValidIds', () => {
    it('splits the identities by whether they still resolve', async () => {
        const { result } = renderData();

        await expect(result.current.data.getValidIds()).resolves.toEqual({ valid: ['Alice'], invalid: ['Ghost'] });
    });
});

describe('refreshAliases', () => {
    it('sorts each alias into the list for its kind', async () => {
        const { result } = renderData();

        await act(() => result.current.data.refreshAliases('Alice'));

        const vars = result.current.vars;
        expect(vars.groupList).toEqual(['team']);
        expect(vars.schemaList).toEqual(['profile']);
        expect(vars.imageList).toEqual(['photo']);
        expect(vars.fileList).toEqual(['notes']);
        expect(vars.vaultList).toEqual(['safe']);
        expect(vars.pollList).toEqual(['vote']);
        // Identities and agent aliases together, once each, in order.
        expect(vars.agentList).toEqual(['Alice', 'bob']);
        expect(keymaster.testPoll).toHaveBeenCalledTimes(2);
    });

    it('records resolved aliases in name order and unresolved ones apart', async () => {
        const { result } = renderData();

        await act(() => result.current.data.refreshAliases('Alice'));

        const vars = result.current.vars;
        expect(Object.keys(vars.aliasList)).toEqual(['bob', 'notes', 'photo', 'plain', 'profile', 'safe', 'team', 'vote']);
        expect(vars.aliasList.plain).toBe('did:cid:plain');
        expect(vars.unresolvedList).toEqual({ gone: 'did:cid:gone' });
        expect(vars.aliasRegistry).toEqual({
            bob: 'hyperswarm', notes: 'hyperswarm', photo: 'hyperswarm', plain: 'hyperswarm',
            profile: 'hyperswarm', safe: 'hyperswarm', team: 'hyperswarm', vote: 'hyperswarm',
        });
    });

    it('records the identities, the ones that no longer resolve and whether the current one is valid', async () => {
        const { result } = renderData();

        await act(() => result.current.data.refreshAliases('Alice'));
        expect(result.current.vars.idList).toEqual(['Alice']);
        expect(result.current.vars.unresolvedIdList).toEqual(['Ghost']);
        expect(result.current.vars.validId).toBe(true);

        await act(() => result.current.data.refreshAliases('Ghost'));
        expect(result.current.vars.validId).toBe(false);
    });

    it('falls back to the current identity when none is given', async () => {
        const { result } = renderData();
        await act(() => result.current.vars.setCurrentId('Alice'));

        await act(() => result.current.data.refreshAliases());

        expect(result.current.vars.validId).toBe(true);
    });

    it('keeps a credential subject and schema that still exist', async () => {
        const { result } = renderData();
        act(() => {
            result.current.vars.setCredentialSubject('bob');
            result.current.vars.setCredentialSchema('profile');
            result.current.vars.setCredentialString('{"draft":true}');
        });

        await act(() => result.current.data.refreshAliases('Alice'));

        expect(result.current.vars.credentialSubject).toBe('bob');
        expect(result.current.vars.credentialSchema).toBe('profile');
        expect(result.current.vars.credentialString).toBe('{"draft":true}');
    });

    it('clears a credential subject and schema that are gone', async () => {
        const { result } = renderData();
        act(() => {
            result.current.vars.setCredentialSubject('Carol');
            result.current.vars.setCredentialSchema('removed-schema');
            result.current.vars.setCredentialString('{"draft":true}');
        });

        await act(() => result.current.data.refreshAliases('Alice'));

        expect(result.current.vars.credentialSubject).toBe('');
        expect(result.current.vars.credentialSchema).toBe('');
        expect(result.current.vars.credentialString).toBe('');
    });
});

describe('refreshCurrentDID', () => {
    it('sets the current DID and its manifest', async () => {
        const manifest = { 'did:cid:cred': { issuer: BOB } };
        keymaster.resolveDID.mockResolvedValue(resolved(ALICE, 'agent', { manifest }));
        const { result } = renderData();

        await act(() => result.current.data.refreshCurrentDID('Alice'));

        expect(keymaster.resolveDID).toHaveBeenCalledWith('Alice');
        expect(result.current.vars.currentDID).toBe(ALICE);
        expect(result.current.vars.manifest).toEqual(manifest);
    });

    it('reports a document with no id', async () => {
        keymaster.resolveDID.mockResolvedValue({ ...resolved(ALICE, 'agent'), didDocument: {} });
        const { result } = renderData();

        await act(() => result.current.data.refreshCurrentDID('Alice'));

        expect(setError).toHaveBeenCalledWith('Failed to set current DID and manifest');
        expect(result.current.vars.currentDID).toBe('');
    });

    it('reports a failed resolution', async () => {
        const error = new Error('Invalid DID: unknown');
        keymaster.resolveDID.mockRejectedValue(error);
        const { result } = renderData();

        await act(() => result.current.data.refreshCurrentDID('Alice'));

        expect(setError).toHaveBeenCalledWith(error);
    });
});

describe('refreshCurrentID', () => {
    it('loads the current identity and clears the credential drafts', async () => {
        const { result } = renderData();
        act(() => {
            result.current.vars.setCredentialDID('did:cid:draft');
            result.current.vars.setSelectedIssued('did:cid:issued1');
            result.current.vars.setIssuedStringOriginal('{}');
            result.current.vars.setIssuedEdit(true);
        });

        let ok: boolean | undefined;
        await act(async () => {
            ok = await result.current.data.refreshCurrentID();
        });

        expect(ok).toBe(true);
        const vars = result.current.vars;
        expect(vars.currentId).toBe('Alice');
        expect(store).toHaveBeenCalledWith('currentId', 'Alice');
        expect(vars.currentDID).toBe(ALICE);
        expect(vars.heldList).toEqual(['did:cid:held1']);
        expect(vars.issuedList).toEqual(['did:cid:issued1']);
        expect(vars.groupList).toEqual(['team']);
        expect(vars.validId).toBe(true);
        expect(vars.credentialDID).toBe('');
        expect(vars.selectedIssued).toBe('');
        expect(vars.issuedStringOriginal).toBe('');
        expect(vars.issuedEdit).toBe(false);
    });

    it('wipes the previous identity when there is no current one', async () => {
        const { result } = renderData();
        await act(() => result.current.data.refreshCurrentID());
        await act(() => result.current.vars.setRegistry('BTC:mainnet'));
        keymaster.getCurrentId.mockResolvedValue(undefined);

        await act(() => result.current.data.refreshCurrentID());

        const vars = result.current.vars;
        expect(vars.currentId).toBe('');
        expect(vars.currentDID).toBe('');
        expect(vars.registry).toBe('hyperswarm');
        expect(vars.manifest).toEqual({});
        expect(vars.aliasList).toEqual({});
        expect(vars.schemaList).toEqual([]);
        expect(vars.agentList).toEqual([]);
        expect(vars.heldList).toEqual([]);
        expect(vars.issuedList).toEqual([]);
        expect(vars.vaultList).toEqual([]);
        expect(vars.pollList).toEqual([]);
    });

    it('reports a failure and returns false', async () => {
        const error = new Error('Wallet not found');
        keymaster.getCurrentId.mockRejectedValue(error);
        const { result } = renderData();

        let ok: boolean | undefined;
        await act(async () => {
            ok = await result.current.data.refreshCurrentID();
        });

        expect(ok).toBe(false);
        expect(setError).toHaveBeenCalledWith(error);
    });
});

describe('refreshHeld and refreshIssued', () => {
    it('load the held and issued credentials', async () => {
        const { result } = renderData();
        act(() => result.current.vars.setIssuedString('stale'));

        await act(() => result.current.data.refreshHeld());
        await act(() => result.current.data.refreshIssued());

        expect(result.current.vars.heldList).toEqual(['did:cid:held1']);
        expect(result.current.vars.issuedList).toEqual(['did:cid:issued1']);
        expect(result.current.vars.issuedString).toBe('');
    });

    it('report their failures', async () => {
        const heldError = new Error('held failed');
        const issuedError = new Error('issued failed');
        keymaster.listCredentials.mockRejectedValue(heldError);
        keymaster.listIssued.mockRejectedValue(issuedError);
        const { result } = renderData();

        await act(() => result.current.data.refreshHeld());
        await act(() => result.current.data.refreshIssued());

        expect(setError).toHaveBeenCalledWith(heldError);
        expect(setError).toHaveBeenCalledWith(issuedError);
    });
});

describe('updateManifest', () => {
    it('reads the manifest from the current identity', async () => {
        const manifest = { 'did:cid:cred': { issuer: BOB } };
        keymaster.resolveDID.mockResolvedValue(resolved(ALICE, 'agent', { manifest }));
        const { result } = renderData();

        await act(() => result.current.data.updateManifest());

        expect(keymaster.resolveDID).toHaveBeenCalledWith(ALICE);
        expect(result.current.vars.manifest).toEqual(manifest);
    });

    it('reports a failure', async () => {
        const error = new Error('No current ID');
        keymaster.fetchIdInfo.mockRejectedValue(error);
        const { result } = renderData();

        await act(() => result.current.data.updateManifest());

        expect(setError).toHaveBeenCalledWith(error);
    });
});

describe('refreshAll', () => {
    it('loads the registries and then the current identity', async () => {
        const { result } = renderData();

        await act(() => result.current.data.refreshAll());

        expect(result.current.vars.registries).toEqual(['hyperswarm', 'BTC:mainnet']);
        expect(result.current.vars.currentId).toBe('Alice');
    });

    it('lets a host that restored its session skip reading the current identity', async () => {
        platform = { restoreSession: vi.fn<() => Promise<boolean>>().mockResolvedValue(true) };
        const { result } = renderData();

        await act(() => result.current.data.refreshAll());

        expect(platform.restoreSession).toHaveBeenCalledOnce();
        expect(keymaster.getCurrentId).not.toHaveBeenCalled();
    });

    it('reads the current identity when the host had nothing to restore', async () => {
        platform = { restoreSession: vi.fn<() => Promise<boolean>>().mockResolvedValue(false) };
        const { result } = renderData();

        await act(() => result.current.data.refreshAll());

        expect(keymaster.getCurrentId).toHaveBeenCalledOnce();
    });

    it('carries on past a registry failure and reports a restore failure', async () => {
        const registryError = new Error('node unreachable');
        const restoreError = new Error('storage unavailable');
        keymaster.listRegistries.mockRejectedValue(registryError);
        platform = { restoreSession: vi.fn<() => Promise<boolean>>().mockRejectedValue(restoreError) };
        const { result } = renderData();

        await act(() => result.current.data.refreshAll());

        expect(setError).toHaveBeenCalledWith(registryError);
        expect(setError).toHaveBeenCalledWith(restoreError);
        expect(platform.restoreSession).toHaveBeenCalledOnce();
    });
});

describe('refreshInbox', () => {
    it('loads the dmail and keeps the same object when nothing changed', async () => {
        const { result } = renderData();

        await act(() => result.current.data.refreshInbox());
        const first = result.current.vars.dmailList;
        expect(first).toEqual({ 'did:cid:mail': dmailItem });

        keymaster.listDmail.mockResolvedValue(structuredClone({ 'did:cid:mail': dmailItem }));
        await act(() => result.current.data.refreshInbox());
        expect(result.current.vars.dmailList).toBe(first);

        keymaster.listDmail.mockResolvedValue({});
        await act(() => result.current.data.refreshInbox());
        expect(result.current.vars.dmailList).toEqual({});
    });

    it('reports a failure', async () => {
        const error = new Error('No current ID');
        keymaster.listDmail.mockRejectedValue(error);
        const { result } = renderData();

        await act(() => result.current.data.refreshInbox());

        expect(setError).toHaveBeenCalledWith(error);
    });
});

describe('resetCurrentID', () => {
    it('clears the stored identity, resets the other view and asks the host to refresh', async () => {
        navigation = { openView: vi.fn<(view: WalletView) => void>(), resetView: vi.fn<() => void>() };
        platform = { requestRefresh: vi.fn<() => void>() };
        const { result } = renderData();

        await act(() => result.current.data.resetCurrentID());

        expect(store).toHaveBeenNthCalledWith(1, 'currentId', '');
        expect(navigation.resetView).toHaveBeenCalledOnce();
        expect(keymaster.getCurrentId).toHaveBeenCalledOnce();
        expect(result.current.vars.currentId).toBe('Alice');
        expect(platform.requestRefresh).toHaveBeenCalledOnce();
    });

    it('works in a host with no other view and nothing to notify', async () => {
        const { result } = renderData();

        await act(() => result.current.data.resetCurrentID());

        expect(store).toHaveBeenCalledWith('currentId', '');
        expect(result.current.vars.currentId).toBe('Alice');
    });
});

describe('handleCopyDID', () => {
    let writeText!: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        writeText = vi.fn();
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    });

    it('copies the DID', async () => {
        writeText.mockResolvedValue(undefined);
        const { result } = renderData();

        await act(async () => result.current.data.handleCopyDID(ALICE));

        expect(writeText).toHaveBeenCalledWith(ALICE);
        expect(setError).not.toHaveBeenCalled();
    });

    it('reports a refused copy by its message', async () => {
        writeText.mockRejectedValue(new Error('Clipboard access denied'));
        const { result } = renderData();

        await act(async () => result.current.data.handleCopyDID(ALICE));

        expect(setError).toHaveBeenCalledWith('Clipboard access denied');
    });

    it('reports a refusal that is not an Error as text', async () => {
        writeText.mockRejectedValue('denied');
        const { result } = renderData();

        await act(async () => result.current.data.handleCopyDID(ALICE));

        expect(setError).toHaveBeenCalledWith('denied');
    });
});

describe('getVaultItemIcon', () => {
    it.each([
        ['an item with no type', 'notes', {}, 'AttachFileIcon'],
        ['a missing item', 'notes', undefined, 'AttachFileIcon'],
        ['an image', 'photo.png', { type: 'image/png' }, 'ImageIcon'],
        ['a PDF', 'paper.pdf', { type: 'application/pdf' }, 'PictureAsPdfIcon'],
        ['a login', 'login: example.org', { type: 'application/json' }, 'LoginIcon'],
        ['the dmail item', 'dmail', { type: 'application/json' }, 'EmailIcon'],
        ['other JSON', 'credential', { type: 'application/json' }, 'TokenIcon'],
        ['any other type', 'notes.txt', { type: 'text/plain' }, 'AttachFileIcon'],
    ])('shows the right icon for %s', (_label, name, item, testId) => {
        const { result } = renderData();

        render(<>{result.current.data.getVaultItemIcon(name, item)}</>);

        expect(screen.getByTestId(testId)).toBeInTheDocument();
    });
});

describe('arraysEqual', () => {
    it('compares arrays element by element', () => {
        const { result } = renderData();
        const { arraysEqual } = result.current.data;

        expect(arraysEqual(['a', 'b'], ['a', 'b'])).toBe(true);
        expect(arraysEqual(['a', 'b'], ['b', 'a'])).toBe(false);
        expect(arraysEqual(['a'], ['a', 'b'])).toBe(false);
        expect(arraysEqual([], [])).toBe(true);
    });
});

describe('without a keymaster', () => {
    it('does nothing and reports nothing', async () => {
        wallet.keymaster = null;
        const { result } = renderData();
        const { data } = result.current;

        await expect(data.getValidIds()).resolves.toEqual({ valid: [], invalid: [] });
        await act(async () => {
            await data.refreshAliases();
            await data.refreshCurrentDID(ALICE);
            await data.refreshCurrentID();
            await data.refreshCurrentIDInternal('Alice');
            await data.refreshHeld();
            await data.refreshIssued();
            await data.updateManifest();
            await data.refreshAll();
            await data.refreshInbox();
        });

        for (const method of Object.values(keymaster)) {
            expect(method).not.toHaveBeenCalled();
        }
        expect(setError).not.toHaveBeenCalled();
        expect(result.current.vars.currentId).toBe('');
    });
});
