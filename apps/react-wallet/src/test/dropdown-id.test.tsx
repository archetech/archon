import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DropDownID from '../../../../packages/wallet-ui/src/components/DropDownID';

// The identity switcher shows the current identity's name and avatar, and where
// the wallet has more than one identity, a menu to switch to another.

const { keymaster, wallet, variables, gatekeeper, setError, resetCurrentID, handleCopyDID } = vi.hoisted(() => {
    const keymaster = { resolveDID: vi.fn(), setCurrentId: vi.fn() };

    return {
        keymaster,
        wallet: { keymaster: keymaster as typeof keymaster | null, gatekeeperUrl: '' },
        variables: {
            currentDID: '',
            currentId: '',
            idList: [] as string[],
            unresolvedIdList: [] as string[],
        },
        gatekeeper: { connect: vi.fn(), getData: vi.fn() },
        setError: vi.fn(),
        resetCurrentID: vi.fn(),
        handleCopyDID: vi.fn(),
    };
});
vi.mock('../../../../packages/wallet-ui/src/contexts/WalletProvider', () => ({ useWalletContext: () => wallet }));
vi.mock('../../../../packages/wallet-ui/src/contexts/VariablesProvider', () => ({ useVariablesContext: () => variables }));
vi.mock('../../../../packages/wallet-ui/src/contexts/SnackbarProvider', () => ({ useSnackbar: () => ({ setError }) }));
vi.mock('../../../../packages/wallet-ui/src/hooks/useWalletData', () => ({
    useWalletData: () => ({ resetCurrentID, handleCopyDID }),
}));
// The component builds its own Gatekeeper client when the module loads, and
// reads an avatar's bytes through it.
vi.mock('@didcid/clients/gatekeeper', () => ({
    default: class {
        connect = gatekeeper.connect;
        getData = gatekeeper.getData;
    },
}));

const ALICE = 'did:cid:alice';
const BOB = 'did:cid:bob';
const CAT = 'did:cid:cat';
const DOG = 'did:cid:dog';

// A document as Keymaster's resolveDID returns it, which always adds `version`
// and `isOwned` to the metadata.
function resolved(did: string, type: 'agent' | 'asset', data: unknown) {
    return {
        didDocument: { '@context': ['https://www.w3.org/ns/did/v1'], id: did, ...(type === 'asset' ? { controller: ALICE } : {}) },
        didDocumentMetadata: {
            created: '2026-01-02T03:04:05Z',
            versionId: `version-of-${did}`,
            versionSequence: '1',
            confirmed: true,
            version: 1,
            isOwned: true,
        },
        didDocumentData: data,
        didDocumentRegistration: { version: 1, type, registry: 'hyperswarm' },
        didResolutionMetadata: { retrieved: '2026-01-02T03:04:06Z' },
    };
}

const imageAsset = (did: string, type = 'image/png') =>
    resolved(did, 'asset', {
        file: { cid: `cid-of-${did}`, filename: 'image', type, bytes: 3 },
        image: { width: 16, height: 16 },
    });

// What the mocked Keymaster resolves, by DID.
let documents: Record<string, unknown>;

beforeEach(() => {
    vi.resetAllMocks();
    wallet.keymaster = keymaster;
    wallet.gatekeeperUrl = 'http://node.example';
    variables.currentDID = ALICE;
    variables.currentId = 'Alice';
    variables.idList = ['Alice'];
    variables.unresolvedIdList = [];
    documents = {
        [ALICE]: resolved(ALICE, 'agent', {}),
        [BOB]: resolved(BOB, 'agent', {}),
        [CAT]: imageAsset(CAT),
        [DOG]: imageAsset(DOG, 'image/jpeg'),
    };
    keymaster.resolveDID.mockImplementation(async (did: string) => {
        if (!(did in documents)) {
            throw new Error(`Invalid DID: ${did}`);
        }
        return documents[did];
    });
    // setCurrentId answers true once the wallet is saved.
    keymaster.setCurrentId.mockResolvedValue(true);
    gatekeeper.getData.mockImplementation(async (cid: string) => Buffer.from(cid === `cid-of-${CAT}` ? 'cat' : 'dog'));
});

const CAT_URL = `data:image/png;base64,${Buffer.from('cat').toString('base64')}`;
const DOG_URL = `data:image/jpeg;base64,${Buffer.from('dog').toString('base64')}`;

// Lets the avatar lookup that starts on mount finish, so that its state update
// does not land after the test.
const settled = () => waitFor(() => expect(keymaster.resolveDID).toHaveBeenCalledWith(variables.currentDID));

describe('the current identity', () => {
    it('shows nothing while the wallet has no current identity', () => {
        variables.currentId = '';
        variables.currentDID = '';
        const { container } = render(<DropDownID />);

        expect(container).toHaveTextContent('');
        expect(screen.queryByRole('button')).toBeNull();
        expect(keymaster.resolveDID).not.toHaveBeenCalled();
    });

    it('shows the name with no menu when it is the only identity', async () => {
        render(<DropDownID />);

        expect(screen.getByText('Alice')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Alice' })).toBeNull();
        await settled();
    });

    it('shortens a name longer than ten characters', async () => {
        variables.currentId = 'Bartholomew';
        variables.idList = ['Bartholomew'];
        render(<DropDownID />);

        expect(screen.getByText('Bartholome...')).toBeInTheDocument();
        await settled();
    });

    it('shows a name of exactly ten characters whole', async () => {
        variables.currentId = 'Bartholome';
        variables.idList = ['Bartholome', 'Alice'];
        render(<DropDownID />);

        expect(screen.getByRole('button', { name: 'Bartholome' })).toBeInTheDocument();
        await settled();
    });

    it('copies the current DID', async () => {
        const user = userEvent.setup({ delay: null });
        render(<DropDownID />);
        await settled();

        await user.click(within(screen.getByLabelText('Copy')).getByRole('button'));

        expect(handleCopyDID).toHaveBeenCalledWith(ALICE);
    });
});

describe('switching identity', () => {
    beforeEach(() => {
        variables.idList = ['Carol', 'Alice'];
        variables.unresolvedIdList = ['Bob', 'Alice'];
    });

    it('lists every identity once, by name, with those that do not resolve among them', async () => {
        const user = userEvent.setup({ delay: null });
        render(<DropDownID />);
        await settled();

        expect(screen.queryByRole('menu')).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Alice' }));

        const items = within(await screen.findByRole('menu')).getAllByRole('menuitem');
        expect(items.map(item => item.textContent)).toEqual(['Alice', 'Bob', 'Carol']);
    });

    it('switches to the identity picked and closes the menu', async () => {
        const user = userEvent.setup({ delay: null });
        render(<DropDownID />);
        await settled();

        await user.click(screen.getByRole('button', { name: 'Alice' }));
        await user.click(await screen.findByRole('menuitem', { name: 'Carol' }));

        await waitFor(() => expect(resetCurrentID).toHaveBeenCalledTimes(1));
        expect(keymaster.setCurrentId).toHaveBeenCalledWith('Carol');
        await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
        expect(setError).not.toHaveBeenCalled();
    });

    it('closes the menu without switching when it is dismissed', async () => {
        const user = userEvent.setup({ delay: null });
        render(<DropDownID />);
        await settled();

        await user.click(screen.getByRole('button', { name: 'Alice' }));
        await screen.findByRole('menu');
        await user.keyboard('{Escape}');

        await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
        expect(keymaster.setCurrentId).not.toHaveBeenCalled();
    });

    it('reports a switch that fails', async () => {
        const user = userEvent.setup({ delay: null });
        const failure = new Error('Unknown ID');
        keymaster.setCurrentId.mockRejectedValue(failure);
        render(<DropDownID />);
        await settled();

        await user.click(screen.getByRole('button', { name: 'Alice' }));
        await user.click(await screen.findByRole('menuitem', { name: 'Bob' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(resetCurrentID).not.toHaveBeenCalled();
    });

    it('does nothing while the wallet has no keymaster', async () => {
        const user = userEvent.setup({ delay: null });
        wallet.keymaster = null;
        render(<DropDownID />);

        await user.click(screen.getByRole('button', { name: 'Alice' }));
        await user.click(await screen.findByRole('menuitem', { name: 'Carol' }));

        await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
        expect(keymaster.setCurrentId).not.toHaveBeenCalled();
        expect(resetCurrentID).not.toHaveBeenCalled();
        expect(keymaster.resolveDID).not.toHaveBeenCalled();
    });
});

describe('the node the avatar is read from', () => {
    it('is the wallet\'s Gatekeeper', async () => {
        render(<DropDownID />);
        await settled();

        expect(gatekeeper.connect).toHaveBeenCalledWith({ url: 'http://node.example' });
    });

    it('is connected to once its address is known', async () => {
        wallet.gatekeeperUrl = '';
        const { rerender } = render(<DropDownID />);
        await settled();
        expect(gatekeeper.connect).not.toHaveBeenCalled();

        wallet.gatekeeperUrl = 'http://late.example';
        rerender(<DropDownID />);

        await waitFor(() => expect(gatekeeper.connect).toHaveBeenCalledWith({ url: 'http://late.example' }));
        expect(gatekeeper.connect).toHaveBeenCalledTimes(1);
    });
});

describe('the avatar', () => {
    it('is the image the identity names as its avatar', async () => {
        documents[ALICE] = resolved(ALICE, 'agent', { avatar: ` ${CAT} ` });
        render(<DropDownID />);

        const avatar = await screen.findByRole('img', { name: 'Alice avatar' });
        expect(avatar).toHaveAttribute('src', CAT_URL);
        expect(keymaster.resolveDID).toHaveBeenCalledWith(CAT);
        expect(gatekeeper.getData).toHaveBeenCalledWith(`cid-of-${CAT}`);
        expect(setError).not.toHaveBeenCalled();
    });

    it('is not shown for an identity that names none', async () => {
        render(<DropDownID />);
        await settled();

        expect(screen.queryByRole('img')).toBeNull();
        expect(keymaster.resolveDID).toHaveBeenCalledTimes(1);
        expect(gatekeeper.getData).not.toHaveBeenCalled();
    });

    it('is not shown when the avatar named is not text', async () => {
        documents[ALICE] = resolved(ALICE, 'agent', { avatar: { did: CAT } });
        render(<DropDownID />);
        await settled();

        expect(screen.queryByRole('img')).toBeNull();
        expect(keymaster.resolveDID).toHaveBeenCalledTimes(1);
    });

    it('is not shown when the asset named is not an image', async () => {
        documents[CAT] = resolved(CAT, 'asset', {
            file: { cid: 'cid-of-notes', filename: 'notes.txt', type: 'text/plain', bytes: 5 },
        });
        documents[ALICE] = resolved(ALICE, 'agent', { avatar: CAT });
        render(<DropDownID />);

        await waitFor(() => expect(keymaster.resolveDID).toHaveBeenCalledWith(CAT));
        expect(screen.queryByRole('img')).toBeNull();
        expect(gatekeeper.getData).not.toHaveBeenCalled();
    });

    it('is not shown, and nothing is reported, when it cannot be read', async () => {
        documents[ALICE] = resolved(ALICE, 'agent', { avatar: CAT });
        gatekeeper.getData.mockRejectedValue(new Error('not found'));
        render(<DropDownID />);

        await waitFor(() => expect(gatekeeper.getData).toHaveBeenCalled());
        expect(screen.queryByRole('img')).toBeNull();
        expect(setError).not.toHaveBeenCalled();
    });

    it('is read again when the wallet says the avatar changed', async () => {
        documents[ALICE] = resolved(ALICE, 'agent', { avatar: CAT });
        render(<DropDownID />);
        expect(await screen.findByRole('img')).toHaveAttribute('src', CAT_URL);

        documents[ALICE] = resolved(ALICE, 'agent', { avatar: DOG });
        act(() => {
            window.dispatchEvent(new Event('archon:avatar-changed'));
        });

        await waitFor(() => expect(screen.getByRole('img')).toHaveAttribute('src', DOG_URL));
    });

    it('is taken away when the identity drops it', async () => {
        documents[ALICE] = resolved(ALICE, 'agent', { avatar: CAT });
        render(<DropDownID />);
        await screen.findByRole('img');

        documents[ALICE] = resolved(ALICE, 'agent', {});
        act(() => {
            window.dispatchEvent(new Event('archon:avatar-changed'));
        });

        await waitFor(() => expect(screen.queryByRole('img')).toBeNull());
    });

    it('stops listening for avatar changes once it is gone', async () => {
        const { unmount } = render(<DropDownID />);
        await settled();
        unmount();

        window.dispatchEvent(new Event('archon:avatar-changed'));

        expect(keymaster.resolveDID).toHaveBeenCalledTimes(1);
    });

    it('is the new identity\'s after a switch, even if the old one\'s arrives late', async () => {
        documents[ALICE] = resolved(ALICE, 'agent', { avatar: CAT });
        documents[BOB] = resolved(BOB, 'agent', { avatar: DOG });
        variables.idList = ['Alice', 'Bob'];
        // Alice's avatar is held back until Bob's is on screen.
        let releaseCat!: (bytes: Buffer) => void;
        gatekeeper.getData.mockImplementation((cid: string) =>
            cid === `cid-of-${CAT}`
                ? new Promise<Buffer>(resolve => { releaseCat = resolve; })
                : Promise.resolve(Buffer.from('dog')));
        const { rerender } = render(<DropDownID />);
        await waitFor(() => expect(gatekeeper.getData).toHaveBeenCalledWith(`cid-of-${CAT}`));

        variables.currentId = 'Bob';
        variables.currentDID = BOB;
        rerender(<DropDownID />);
        const avatar = await screen.findByRole('img', { name: 'Bob avatar' });
        expect(avatar).toHaveAttribute('src', DOG_URL);

        await act(async () => {
            releaseCat(Buffer.from('cat'));
        });

        expect(screen.getByRole('img')).toHaveAttribute('src', DOG_URL);
    });
});
