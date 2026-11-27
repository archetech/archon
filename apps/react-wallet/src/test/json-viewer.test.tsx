import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import JsonViewer from '../../../../packages/wallet-ui/src/components/JsonViewer';
import {
    WalletNavigationProvider,
    type WalletView,
} from '../../../../packages/wallet-ui/src/contexts/WalletNavigation';
import type { DidCidDocument } from '@didcid/gatekeeper/types';

// The viewer shows a DID's documents. What to show arrives as a pending view
// from the host's navigation, so the tests mount the real navigation provider
// with a host that keeps that view in state, as both wallets do.

const { keymaster, wallet, setError } = vi.hoisted(() => {
    const keymaster = { resolveDID: vi.fn(), decryptJSON: vi.fn(), checkDID: vi.fn(), repairDID: vi.fn() };
    return {
        keymaster,
        wallet: { keymaster: keymaster as typeof keymaster | null },
        setError: vi.fn(),
    };
});
vi.mock('../../../../packages/wallet-ui/src/contexts/WalletProvider', () => ({ useWalletContext: () => wallet }));
vi.mock('../../../../packages/wallet-ui/src/contexts/SnackbarProvider', () => ({ useSnackbar: () => ({ setError }) }));

const ALICE = 'did:cid:alice';
const ASSET = 'did:cid:asset';

// What Keymaster.resolveDID returns: the Gatekeeper's resolution, with a
// numeric version (absent when the node gave no versionSequence) and isOwned.
function resolved(version: number | undefined, data: unknown = { note: `content of version ${version}` }, timestamp?: unknown): DidCidDocument {
    return {
        didDocument: { id: ASSET, controller: ALICE },
        didDocumentMetadata: {
            created: '2026-01-01T00:00:00Z',
            versionId: `bagaaieraversion${version}`,
            ...(version !== undefined && { versionSequence: String(version) }),
            version,
            confirmed: true,
            isOwned: true,
            ...(timestamp !== undefined && { timestamp }),
        } as DidCidDocument['didDocumentMetadata'],
        didResolutionMetadata: { retrieved: '2026-01-02T00:00:00Z' },
        didDocumentData: data,
        didDocumentRegistration: { version: 1, type: 'asset', registry: 'hyperswarm' },
    };
}

const openView = vi.fn();
const clearPendingView = vi.fn();
let showView!: (view: WalletView | undefined) => void;

function Host({ initial, browserTab = 'viewer', browserSubTab }: {
    initial?: WalletView; browserTab?: string; browserSubTab?: string;
}) {
    const [pendingView, setPendingView] = useState<WalletView | undefined>(initial);
    showView = setPendingView;
    return (
        <WalletNavigationProvider
            openView={view => { openView(view); setPendingView(view); }}
            pendingView={pendingView}
            clearPendingView={() => { clearPendingView(); setPendingView(undefined); }}
        >
            <JsonViewer browserTab={browserTab} browserSubTab={browserSubTab} showResolveField />
        </WalletNavigationProvider>
    );
}

const didField = () => screen.getByLabelText('Resolve DID', { selector: 'input' });
// The icon buttons have no text of their own; their tooltips label the span
// that wraps each one.
const iconButton = (label: string) => within(screen.getByLabelText(label, { selector: 'span' })).getByRole('button');

beforeEach(() => {
    vi.resetAllMocks();
    wallet.keymaster = keymaster;
    keymaster.resolveDID.mockResolvedValue(resolved(1));
    keymaster.decryptJSON.mockRejectedValue(new Error('Cannot decrypt'));
});

describe('resolving a DID', () => {
    it('opens the typed DID on Enter and shows its documents', async () => {
        const user = userEvent.setup({ delay: null });
        render(<Host />);

        await user.type(didField(), `${ASSET}{Enter}`);

        expect(openView).toHaveBeenCalledWith({ did: ASSET, tab: 'viewer', subTab: undefined });
        expect(await screen.findByText(/content of version 1/)).toBeInTheDocument();
        expect(keymaster.resolveDID).toHaveBeenCalledExactlyOnceWith(ASSET);
        expect(clearPendingView).toHaveBeenCalled();
    });

    it('opens the typed DID from the resolve button, which needs a DID first', async () => {
        const user = userEvent.setup({ delay: null });
        render(<Host />);
        expect(iconButton('Resolve DID')).toBeDisabled();

        await user.type(didField(), ASSET);
        await user.click(iconButton('Resolve DID'));

        expect(await screen.findByText(/content of version 1/)).toBeInTheDocument();
    });

    it('does not open anything on Enter with an empty field', async () => {
        const user = userEvent.setup({ delay: null });
        render(<Host />);

        await user.type(didField(), '{Enter}');

        expect(openView).not.toHaveBeenCalled();
    });

    it('strips the quotes from a pasted DID', async () => {
        const user = userEvent.setup({ delay: null });
        render(<Host />);

        await user.click(didField());
        await user.paste(`"${ASSET}"`);

        expect(didField()).toHaveValue(ASSET);
    });

    it('sends a lookup from the wallet tab to the viewer', async () => {
        const user = userEvent.setup({ delay: null });
        render(<Host browserTab="wallet" />);

        await user.type(didField(), `${ASSET}{Enter}`);

        expect(openView).toHaveBeenCalledWith({ did: ASSET, tab: 'viewer', subTab: undefined });
        // That view is for another tab, so this one does not resolve it.
        expect(keymaster.resolveDID).not.toHaveBeenCalled();
    });

    it('reports a result with no metadata as an invalid DID', async () => {
        keymaster.resolveDID.mockResolvedValue({ didResolutionMetadata: { error: 'notFound' } });
        render(<Host initial={{ did: ASSET, tab: 'viewer' }} />);

        await waitFor(() => expect(setError).toHaveBeenCalledWith('Invalid DID'));
        expect(screen.queryByText(/didResolutionMetadata/)).not.toBeInTheDocument();
    });

    it('reports a failed resolution', async () => {
        const error = new Error('Invalid DID: unknown');
        keymaster.resolveDID.mockRejectedValue(error);
        render(<Host initial={{ did: ASSET, tab: 'viewer' }} />);

        await waitFor(() => expect(setError).toHaveBeenCalledWith(error));
    });

    it('does nothing without a keymaster', async () => {
        wallet.keymaster = null;
        render(<Host initial={{ did: ASSET, tab: 'viewer' }} />);

        expect(didField()).toHaveValue(ASSET);
        await waitFor(() => expect(clearPendingView).toHaveBeenCalled());
        expect(keymaster.resolveDID).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: 'Repair...' })).toBeDisabled();
    });
});

describe('pending views', () => {
    it('shows contents it is given without resolving anything', async () => {
        render(<Host initial={{ contents: { greeting: 'hello there' }, tab: 'viewer' }} />);

        expect(await screen.findByText(/hello there/)).toBeInTheDocument();
        expect(keymaster.resolveDID).not.toHaveBeenCalled();
        expect(didField()).toHaveValue('');
    });

    it('ignores a view meant for another tab or sub-tab', async () => {
        render(<Host browserSubTab="held" initial={{ did: ASSET, tab: 'credentials', subTab: 'held' }} />);
        await act(async () => showView({ did: ASSET, tab: 'viewer', subTab: 'issued' }));

        expect(clearPendingView).not.toHaveBeenCalled();
        expect(keymaster.resolveDID).not.toHaveBeenCalled();
        expect(didField()).toHaveValue('');
    });

    it('resolves a view for its own sub-tab', async () => {
        render(<Host browserTab="credentials" browserSubTab="held" initial={{ did: ASSET, tab: 'credentials', subTab: 'held' }} />);

        await waitFor(() => expect(keymaster.resolveDID).toHaveBeenCalledWith(ASSET));
    });

    it('clears what it shows when asked to', async () => {
        render(<Host initial={{ contents: { greeting: 'hello there' }, tab: 'viewer' }} />);
        await screen.findByText(/hello there/);

        await act(async () => showView({ clearState: true }));

        await waitFor(() => expect(screen.queryByText(/hello there/)).not.toBeInTheDocument());
    });

    it('clears what it shows for a view with nothing in it', async () => {
        render(<Host initial={{ contents: { greeting: 'hello there' }, tab: 'viewer' }} />);
        await screen.findByText(/hello there/);

        await act(async () => showView({ tab: 'viewer' }));

        await waitFor(() => expect(screen.queryByText(/hello there/)).not.toBeInTheDocument());
        expect(keymaster.resolveDID).not.toHaveBeenCalled();
    });
});

describe('versions', () => {
    it('hides the version navigator for a single version, or none reported', async () => {
        keymaster.resolveDID.mockResolvedValue(resolved(undefined, { note: 'unversioned' }));
        render(<Host initial={{ did: ASSET, tab: 'viewer' }} />);

        await screen.findByText(/unversioned/);
        expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    });

    it('opens on the latest version and resolves the one picked', async () => {
        keymaster.resolveDID.mockImplementation(async (_did: string, options?: { versionSequence?: number }) =>
            resolved(options?.versionSequence ?? 3));
        const user = userEvent.setup({ delay: null });
        render(<Host initial={{ did: ASSET, tab: 'viewer' }} />);

        await screen.findByText(/content of version 3/);
        expect(screen.getByRole('combobox')).toHaveTextContent('version 3');

        await user.click(screen.getByRole('combobox'));
        await user.click(await screen.findByRole('option', { name: 'version 1' }));

        expect(keymaster.resolveDID).toHaveBeenLastCalledWith(ASSET, { versionSequence: 1 });
        expect(await screen.findByText(/content of version 1/)).toBeInTheDocument();
        expect(screen.getByRole('combobox')).toHaveTextContent('version 1');
    });

    it('reports a version that fails to resolve', async () => {
        const error = new Error('version 2 not found');
        keymaster.resolveDID
            .mockResolvedValueOnce(resolved(3))
            .mockRejectedValueOnce(error);
        const user = userEvent.setup({ delay: null });
        render(<Host initial={{ did: ASSET, tab: 'viewer' }} />);
        await screen.findByText(/content of version 3/);

        await user.click(screen.getByRole('combobox'));
        await user.click(await screen.findByRole('option', { name: 'version 2' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(error));
    });
});

describe('values in the document', () => {
    it('opens a DID value when it is clicked', async () => {
        const user = userEvent.setup({ delay: null });
        render(<Host initial={{ did: ASSET, tab: 'viewer' }} />);
        await waitFor(() => expect(screen.getByText(new RegExp(ALICE))).toHaveStyle({ textDecoration: 'underline' }));
        openView.mockClear();

        await user.click(screen.getByText(new RegExp(ALICE)));

        expect(openView).toHaveBeenCalledWith({ did: ALICE, tab: 'viewer', subTab: undefined });
        await waitFor(() => expect(keymaster.resolveDID).toHaveBeenLastCalledWith(ALICE));
    });

    it('links the block and transaction of a testnet4 anchor to the explorer', async () => {
        keymaster.resolveDID.mockResolvedValue(resolved(1, {}, {
            chain: 'BTC:testnet4',
            opid: 'bagaaieraop',
            lowerBound: { time: 1767225600, timeISO: '2026-01-01T00:00:00Z', blockid: 'blockhash1', height: 100 },
            upperBound: { time: 1767229200, timeISO: '2026-01-01T01:00:00Z', blockid: 'blockhash2', height: 101, txid: 'txhash1' },
        }));
        render(<Host initial={{ did: ASSET, tab: 'viewer' }} />);

        // The viewer's custom rendering reaches the tree a render after the
        // plain values first appear, so wait for the links themselves.
        const links = await screen.findAllByRole('link');
        const hrefs = links.map(link => link.getAttribute('href'));
        expect(hrefs).toEqual([
            'https://mempool.space/testnet4/block/blockhash1',
            'https://mempool.space/testnet4/block/blockhash2',
            'https://mempool.space/testnet4/tx/txhash1',
        ]);
    });

    it('does not link anchors on other chains', async () => {
        keymaster.resolveDID.mockResolvedValue(resolved(1, {}, {
            chain: 'BTC:mainnet',
            upperBound: { time: 1767229200, timeISO: '2026-01-01T01:00:00Z', blockid: 'blockhash2', height: 101, txid: 'txhash1' },
        }));
        render(<Host initial={{ did: ASSET, tab: 'viewer' }} />);

        // Wait for the custom rendering to reach the DID value, so the absence
        // of links is not just a render that has not happened yet.
        await waitFor(() => expect(screen.getByText(new RegExp(ALICE))).toHaveStyle({ textDecoration: 'underline' }));
        expect(screen.getByText(/blockhash2/)).toBeInTheDocument();
        expect(screen.queryByRole('link')).not.toBeInTheDocument();
    });
});

describe('encrypted documents', () => {
    const encrypted = resolved(1, { encrypted: { sender: ALICE, cipher_hash: 'hash', cipher_sender: 'x', cipher_receiver: 'y' } });

    it('offers to decrypt one this wallet can read, and shows the plaintext', async () => {
        keymaster.resolveDID.mockResolvedValue(encrypted);
        keymaster.decryptJSON.mockResolvedValue({ secret: 'plaintext value' });
        const user = userEvent.setup({ delay: null });
        render(<Host initial={{ did: ASSET, tab: 'viewer' }} />);

        await waitFor(() => expect(iconButton('Decrypt')).toBeEnabled());
        expect(keymaster.decryptJSON).toHaveBeenCalledWith(ASSET);
        await user.click(iconButton('Decrypt'));

        expect(await screen.findByText(/plaintext value/)).toBeInTheDocument();
    });

    it('does not offer to decrypt one this wallet cannot read', async () => {
        keymaster.resolveDID.mockResolvedValue(encrypted);
        render(<Host initial={{ did: ASSET, tab: 'viewer' }} />);

        await waitFor(() => expect(keymaster.decryptJSON).toHaveBeenCalled());
        expect(iconButton('Decrypt')).toBeDisabled();
    });

    it('does not offer to decrypt one that holds no JSON object', async () => {
        keymaster.resolveDID.mockResolvedValue(encrypted);
        keymaster.decryptJSON.mockResolvedValue('just text');
        render(<Host initial={{ did: ASSET, tab: 'viewer' }} />);

        await waitFor(() => expect(keymaster.decryptJSON).toHaveBeenCalled());
        expect(iconButton('Decrypt')).toBeDisabled();
    });

    it('does not try to decrypt a document that is not encrypted', async () => {
        render(<Host initial={{ did: ASSET, tab: 'viewer' }} />);

        await screen.findByText(/content of version 1/);
        expect(keymaster.decryptJSON).not.toHaveBeenCalled();
        expect(iconButton('Decrypt')).toBeDisabled();
    });
});

describe('repair', () => {
    it('opens the repair dialog for the DID shown and closes it again', async () => {
        keymaster.checkDID.mockResolvedValue({ did: ASSET, confirmed: true, canRepair: false, issues: [], changes: null });
        const user = userEvent.setup({ delay: null });
        render(<Host initial={{ did: ASSET, tab: 'viewer' }} />);
        await screen.findByText(/content of version 1/);
        await user.clear(didField());

        await user.click(screen.getByRole('button', { name: 'Repair...' }));

        await waitFor(() => expect(keymaster.checkDID).toHaveBeenCalledWith(ASSET));
        const dialog = await screen.findByRole('dialog');
        await user.click(within(dialog).getByRole('button', { name: 'Close' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    it('is not offered before there is a DID', () => {
        render(<Host />);

        expect(screen.getByRole('button', { name: 'Repair...' })).toBeDisabled();
    });
});
