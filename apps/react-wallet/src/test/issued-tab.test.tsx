import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import IssuedTab from '../../../../packages/wallet-ui/src/components/IssuedTab';

// The Issued tab lists the credentials the identity issued, each to show,
// edit, send to its subject or revoke.

const { keymaster, wallet, variables, setError, setSuccess, openView } = vi.hoisted(() => {
    const keymaster = {
        getCredential: vi.fn(), updateCredential: vi.fn(), revokeCredential: vi.fn(),
        resolveDID: vi.fn(), sendCredentialDidComm: vi.fn(),
    };

    return {
        keymaster,
        wallet: { keymaster: keymaster as typeof keymaster | null },
        variables: {
            issuedEdit: false,
            issuedList: [] as string[] | null,
            issuedString: '',
            issuedStringOriginal: '',
            selectedIssued: '',
        },
        setError: vi.fn(),
        setSuccess: vi.fn(),
        openView: vi.fn(),
    };
});
vi.mock('../../../../packages/wallet-ui/src/contexts/WalletProvider', () => ({ useWalletContext: () => wallet }));
// The tab keeps what it shows in the wallet's shared state, so the stand-in
// has to hold what the tab sets and draw the tab again, as the provider does.
vi.mock('../../../../packages/wallet-ui/src/contexts/VariablesProvider', async () => {
    const { useReducer } = await import('react');

    return {
        useVariablesContext: () => {
            const [, redraw] = useReducer((count: number) => count + 1, 0);
            const set = <K extends keyof typeof variables>(key: K) => (value: (typeof variables)[K]) => {
                variables[key] = value;
                redraw();
            };

            return {
                ...variables,
                setIssuedEdit: set('issuedEdit'),
                setIssuedList: set('issuedList'),
                setIssuedString: set('issuedString'),
                setIssuedStringOriginal: set('issuedStringOriginal'),
                setSelectedIssued: set('selectedIssued'),
            };
        },
    };
});
vi.mock('../../../../packages/wallet-ui/src/contexts/SnackbarProvider', () => ({
    useSnackbar: () => ({ setError, setSuccess }),
}));
vi.mock('../../../../packages/wallet-ui/src/contexts/WalletNavigation', () => ({ useWalletNavigation: () => ({ openView }) }));
vi.mock('../../../../packages/wallet-ui/src/hooks/useWalletData', () => ({ useWalletData: () => ({ handleCopyDID: vi.fn() }) }));
// The viewer is its own component with its own tests; the tab only places it.
vi.mock('../../../../packages/wallet-ui/src/components/JsonViewer', () => ({
    default: ({ browserTab, browserSubTab }: { browserTab: string; browserSubTab: string }) => (
        <div data-testid="viewer">{browserTab}/{browserSubTab}</div>
    ),
}));

const DEGREE = 'did:cid:degree';
const LICENCE = 'did:cid:licence';
const BOB = 'did:cid:bob';
const credential = { type: ['VerifiableCredential'], credentialSubject: { id: BOB, grade: 'B' } };
const amended = { type: ['VerifiableCredential'], credentialSubject: { id: BOB, grade: 'A' } };

beforeEach(() => {
    vi.resetAllMocks();
    wallet.keymaster = keymaster;
    variables.issuedEdit = false;
    variables.issuedList = [DEGREE, LICENCE];
    variables.issuedString = '';
    variables.issuedStringOriginal = '';
    variables.selectedIssued = '';
    keymaster.getCredential.mockResolvedValue(credential);
    keymaster.resolveDID.mockResolvedValue({ didDocument: { id: BOB } });
});

// Each credential has the same row of buttons, in the order of the list.
const button = (name: string, row = 0) => screen.getAllByRole('button', { name })[row];
const editor = () => screen.getByRole('textbox');

async function decrypt(user: UserEvent, row = 0) {
    await user.click(button('Decrypt', row));
    return screen.findByRole('textbox');
}

// Replaced in one step: the editor is only drawn while it holds some text.
function retype(text: string) {
    fireEvent.change(editor(), { target: { value: text } });
}

describe('the credentials issued', () => {
    it('lists each credential with its actions', () => {
        render(<IssuedTab />);

        expect(screen.getByText(DEGREE)).toBeInTheDocument();
        expect(screen.getByText(LICENCE)).toBeInTheDocument();
        for (const name of ['Resolve', 'Decrypt', 'Update', 'Send', 'Revoke']) {
            expect(screen.getAllByRole('button', { name })).toHaveLength(2);
        }
        expect(button('Update', 0)).toBeDisabled();
        expect(button('Update', 1)).toBeDisabled();
        expect(screen.queryByTestId('viewer')).toBeNull();
        expect(screen.queryByRole('textbox')).toBeNull();
    });

    it('lists nothing before the issued list is loaded', () => {
        variables.issuedList = null;
        render(<IssuedTab />);

        expect(screen.queryByRole('button', { name: 'Decrypt' })).toBeNull();
    });

    it('opens a credential in the viewer', async () => {
        const user = userEvent.setup({ delay: null });
        render(<IssuedTab />);

        await user.click(button('Resolve', 1));

        expect(openView).toHaveBeenCalledWith({ did: LICENCE, tab: 'credentials', subTab: 'issued' });
        expect(await screen.findByTestId('viewer')).toHaveTextContent('credentials/issued');
        expect(screen.queryByRole('textbox')).toBeNull();
        expect(keymaster.getCredential).not.toHaveBeenCalled();
    });

    it('goes back from the editor to the viewer when a credential is resolved', async () => {
        const user = userEvent.setup({ delay: null });
        render(<IssuedTab />);
        await decrypt(user);

        await user.click(button('Resolve', 0));

        expect(await screen.findByTestId('viewer')).toBeInTheDocument();
        expect(screen.queryByRole('textbox')).toBeNull();
    });
});

describe('editing an issued credential', () => {
    it('shows the decrypted credential to edit', async () => {
        const user = userEvent.setup({ delay: null });
        render(<IssuedTab />);

        const field = await decrypt(user);

        expect(keymaster.getCredential).toHaveBeenCalledWith(DEGREE);
        expect(field).toHaveValue(JSON.stringify(credential, null, 4));
        expect(screen.queryByTestId('viewer')).toBeNull();
    });

    it('reports a credential that cannot be decrypted', async () => {
        const user = userEvent.setup({ delay: null });
        const failure = new Error('not the issuer');
        keymaster.getCredential.mockRejectedValue(failure);
        render(<IssuedTab />);

        await user.click(button('Decrypt'));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(screen.queryByRole('textbox')).toBeNull();
    });

    it('offers Update only for the credential being edited, once it is changed', async () => {
        const user = userEvent.setup({ delay: null });
        render(<IssuedTab />);

        await decrypt(user, 1);
        expect(button('Update', 1)).toBeDisabled();

        await user.type(editor(), ' ');
        expect(button('Update', 1)).toBeEnabled();
        expect(button('Update', 0)).toBeDisabled();

        // Back to what was decrypted, there is nothing to update.
        await user.type(editor(), '{Backspace}');
        expect(button('Update', 1)).toBeDisabled();
    });

    it('updates the credential and shows it as it now is', async () => {
        const user = userEvent.setup({ delay: null });
        render(<IssuedTab />);
        await decrypt(user);

        retype(JSON.stringify(amended));
        keymaster.getCredential.mockResolvedValue(amended);
        await user.click(button('Update'));

        await waitFor(() => expect(editor()).toHaveValue(JSON.stringify(amended, null, 4)));
        expect(keymaster.updateCredential).toHaveBeenCalledWith(DEGREE, amended);
        expect(button('Update')).toBeDisabled();
        expect(setError).not.toHaveBeenCalled();
    });

    it('reports text that is not JSON and updates nothing', async () => {
        const user = userEvent.setup({ delay: null });
        render(<IssuedTab />);
        await decrypt(user);

        retype('not json');
        await user.click(button('Update'));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(expect.any(SyntaxError)));
        expect(keymaster.updateCredential).not.toHaveBeenCalled();
        expect(editor()).toHaveValue('not json');
    });

    it('reports a failure to update and keeps the edit', async () => {
        const user = userEvent.setup({ delay: null });
        const failure = new Error('invalid credential');
        keymaster.updateCredential.mockRejectedValue(failure);
        render(<IssuedTab />);
        await decrypt(user);

        retype(JSON.stringify(amended));
        await user.click(button('Update'));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(keymaster.getCredential).toHaveBeenCalledTimes(1);
        expect(editor()).toHaveValue(JSON.stringify(amended));
        expect(button('Update')).toBeEnabled();
    });
});

describe('revoking an issued credential', () => {
    async function revoke(user: UserEvent, row: number, answer: 'Confirm' | 'Cancel') {
        await user.click(button('Revoke', row));
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByText('Are you sure you want to revoke the credential?')).toBeInTheDocument();
        expect(keymaster.revokeCredential).not.toHaveBeenCalled();
        await user.click(within(dialog).getByRole('button', { name: answer }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    }

    it('revokes the credential and drops it from the list', async () => {
        const user = userEvent.setup({ delay: null });
        render(<IssuedTab />);

        await revoke(user, 1, 'Confirm');

        expect(keymaster.revokeCredential).toHaveBeenCalledWith(LICENCE);
        expect(screen.queryByText(LICENCE)).toBeNull();
        expect(screen.getByText(DEGREE)).toBeInTheDocument();
        expect(setError).not.toHaveBeenCalled();
    });

    it('closes the editor when the credential being edited is revoked', async () => {
        const user = userEvent.setup({ delay: null });
        render(<IssuedTab />);
        await decrypt(user);

        await revoke(user, 0, 'Confirm');

        expect(keymaster.revokeCredential).toHaveBeenCalledWith(DEGREE);
        expect(screen.queryByText(DEGREE)).toBeNull();
        expect(screen.queryByRole('textbox')).toBeNull();
        expect(screen.queryByTestId('viewer')).toBeNull();
        expect(openView).toHaveBeenCalledWith({ tab: 'credentials', subTab: 'issued' });
    });

    it('leaves the editor open when another credential is revoked', async () => {
        const user = userEvent.setup({ delay: null });
        render(<IssuedTab />);
        await decrypt(user);

        await revoke(user, 1, 'Confirm');

        expect(screen.queryByText(LICENCE)).toBeNull();
        expect(editor()).toHaveValue(JSON.stringify(credential, null, 4));
        expect(openView).not.toHaveBeenCalled();
    });

    it('keeps the credential when the revocation is cancelled', async () => {
        const user = userEvent.setup({ delay: null });
        render(<IssuedTab />);

        await revoke(user, 0, 'Cancel');

        expect(keymaster.revokeCredential).not.toHaveBeenCalled();
        expect(screen.getByText(DEGREE)).toBeInTheDocument();
    });

    it('reports a failure to revoke, keeps the credential and closes the question', async () => {
        const user = userEvent.setup({ delay: null });
        const failure = new Error('not the issuer');
        keymaster.revokeCredential.mockRejectedValue(failure);
        render(<IssuedTab />);

        await revoke(user, 0, 'Confirm');

        expect(setError).toHaveBeenCalledWith(failure);
        expect(screen.getByText(DEGREE)).toBeInTheDocument();
    });
});

describe('sending an issued credential over DIDComm', () => {
    async function send(user: UserEvent, row: number, recipient: string) {
        await user.click(button('Send', row));
        const dialog = await screen.findByRole('dialog', { name: 'Send credential over DIDComm' });
        if (recipient) {
            await user.type(within(dialog).getByLabelText('Recipient (DID or alias)'), recipient);
        }
        await user.click(within(dialog).getByRole('button', { name: 'Send' }));
        return dialog;
    }

    it('sends the credential to the DID the recipient resolves to', async () => {
        const user = userEvent.setup({ delay: null });
        render(<IssuedTab />);

        await send(user, 1, ' Bob ');

        await waitFor(() => expect(setSuccess).toHaveBeenCalledWith('Credential sent'));
        expect(keymaster.resolveDID).toHaveBeenCalledWith('Bob');
        expect(keymaster.sendCredentialDidComm).toHaveBeenCalledWith(LICENCE, BOB);
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(setError).not.toHaveBeenCalled();
    });

    it('asks for a recipient when none is given', async () => {
        const user = userEvent.setup({ delay: null });
        render(<IssuedTab />);

        const dialog = await send(user, 0, '');

        expect(setError).toHaveBeenCalledWith('Enter a recipient DID or alias');
        expect(keymaster.resolveDID).not.toHaveBeenCalled();
        expect(dialog).toBeInTheDocument();
    });

    it('reports a recipient that resolves to no DID', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.resolveDID.mockResolvedValue({});
        render(<IssuedTab />);

        const dialog = await send(user, 0, 'nobody');

        await waitFor(() => expect(setError).toHaveBeenCalledWith('Could not resolve nobody'));
        expect(keymaster.sendCredentialDidComm).not.toHaveBeenCalled();
        expect(setSuccess).not.toHaveBeenCalled();
        expect(dialog).toBeInTheDocument();
    });

    it('reports a recipient that is not known', async () => {
        const user = userEvent.setup({ delay: null });
        const failure = new Error('unknown alias');
        keymaster.resolveDID.mockRejectedValue(failure);
        render(<IssuedTab />);

        await send(user, 0, 'nobody');

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(keymaster.sendCredentialDidComm).not.toHaveBeenCalled();
    });

    it('reports a failure to send and leaves the question open', async () => {
        const user = userEvent.setup({ delay: null });
        const failure = new Error('no DIDComm endpoint');
        keymaster.sendCredentialDidComm.mockRejectedValue(failure);
        render(<IssuedTab />);

        const dialog = await send(user, 0, 'Bob');

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(keymaster.sendCredentialDidComm).toHaveBeenCalledWith(DEGREE, BOB);
        expect(setSuccess).not.toHaveBeenCalled();
        expect(dialog).toBeInTheDocument();
    });

    it('sends nothing when the question is cancelled', async () => {
        const user = userEvent.setup({ delay: null });
        render(<IssuedTab />);

        await user.click(button('Send'));
        const dialog = await screen.findByRole('dialog');
        await user.type(within(dialog).getByLabelText('Recipient (DID or alias)'), 'Bob');
        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(keymaster.resolveDID).not.toHaveBeenCalled();
    });
});

describe('a wallet that loses its keymaster', () => {
    it('asks nothing of it and reports nothing', async () => {
        const user = userEvent.setup({ delay: null });
        const shown = render(<IssuedTab />);
        await decrypt(user);
        retype(JSON.stringify(amended));

        wallet.keymaster = null;
        shown.rerender(<IssuedTab />);
        vi.clearAllMocks();

        await user.click(button('Update'));
        await user.click(button('Decrypt', 1));

        await user.click(button('Revoke'));
        const revoking = await screen.findByRole('dialog');
        await user.click(within(revoking).getByRole('button', { name: 'Confirm' }));
        await user.click(within(revoking).getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

        await user.click(button('Send'));
        const sending = await screen.findByRole('dialog');
        await user.type(within(sending).getByLabelText('Recipient (DID or alias)'), 'Bob');
        await user.click(within(sending).getByRole('button', { name: 'Send' }));

        for (const method of Object.values(keymaster)) {
            expect(method).not.toHaveBeenCalled();
        }
        expect(screen.getByText(DEGREE)).toBeInTheDocument();
        expect(setError).not.toHaveBeenCalled();
        expect(setSuccess).not.toHaveBeenCalled();
    });
});
