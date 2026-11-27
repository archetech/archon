import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import IssueTab from '../../../../packages/wallet-ui/src/components/IssueTab';

// The Issue tab binds a credential for a subject to a schema, fills it in
// through the credential form and issues it.

const { keymaster, wallet, variables, setError, openView } = vi.hoisted(() => {
    const keymaster = { bindCredential: vi.fn(), getSchema: vi.fn(), issueCredential: vi.fn() };

    return {
        keymaster,
        wallet: { keymaster: keymaster as typeof keymaster | null },
        variables: {
            registries: [] as string[],
            registry: '',
            agentList: [] as string[] | null,
            schemaList: [] as string[],
            credentialDID: '',
            credentialSchema: '',
            credentialString: '',
            credentialSubject: '',
            issuedList: [] as string[],
        },
        setError: vi.fn(),
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
            type Variables = typeof variables;
            const set = <K extends keyof Variables>(key: K) =>
                (value: Variables[K] | ((previous: Variables[K]) => Variables[K])) => {
                    variables[key] = typeof value === 'function' ? value(variables[key]) : value;
                    redraw();
                };

            return {
                ...variables,
                setRegistry: set('registry'),
                setCredentialDID: set('credentialDID'),
                setCredentialSchema: set('credentialSchema'),
                setCredentialString: set('credentialString'),
                setCredentialSubject: set('credentialSubject'),
                setIssuedList: set('issuedList'),
            };
        },
    };
});
vi.mock('../../../../packages/wallet-ui/src/contexts/SnackbarProvider', () => ({ useSnackbar: () => ({ setError }) }));
vi.mock('../../../../packages/wallet-ui/src/contexts/WalletNavigation', () => ({ useWalletNavigation: () => ({ openView }) }));
vi.mock('../../../../packages/wallet-ui/src/hooks/useWalletData', () => ({ useWalletData: () => ({ handleCopyDID: vi.fn() }) }));

const BOB = 'did:cid:bob';
const SCHEMA = 'did:cid:degree-schema';
const ISSUED = 'did:cid:issued';
const bound = {
    type: ['VerifiableCredential'],
    credentialSchema: { id: SCHEMA, type: 'JsonSchema' },
    credentialSubject: { id: BOB, grade: 'TBD' },
};
const schema = { properties: { grade: { type: 'string' }, year: { type: 'integer' } }, required: ['grade'] };

beforeEach(() => {
    vi.resetAllMocks();
    wallet.keymaster = keymaster;
    variables.registries = ['hyperswarm', 'BTC:mainnet'];
    variables.registry = 'hyperswarm';
    variables.agentList = ['Bob', 'Carol'];
    variables.schemaList = ['degree', 'licence'];
    variables.credentialDID = '';
    variables.credentialSchema = '';
    variables.credentialString = '';
    variables.credentialSubject = '';
    variables.issuedList = ['did:cid:earlier'];
    keymaster.bindCredential.mockResolvedValue(bound);
    // Keymaster reads the schema anew each time, so each answer is a new object.
    keymaster.getSchema.mockImplementation(async () => structuredClone(schema));
    keymaster.issueCredential.mockResolvedValue(ISSUED);
});

const subjectField = () => screen.getByLabelText('Subject (name, DID, or URI)');
// The schema picker has no label: it follows the subject, itself a combobox.
const schemaPicker = () => screen.getAllByRole('combobox')[1];
// Nor has the registry picker, the last thing in the form.
const registryPicker = () => {
    const pickers = screen.getAllByRole('combobox');
    return pickers[pickers.length - 1];
};
const editButton = () => screen.getByRole('button', { name: 'Edit Credential' });
const issueButton = () => screen.getByRole('button', { name: 'Issue' });

async function pick(user: UserEvent, picker: HTMLElement, option: string) {
    await user.click(picker);
    await user.click(await screen.findByRole('option', { name: option }));
}

// Binds a credential for Bob to the degree schema and waits for its form.
async function openForm(user: UserEvent) {
    await user.type(subjectField(), 'Bob');
    await pick(user, schemaPicker(), 'degree');
    await user.click(editButton());
    return screen.findByLabelText(/^grade \(string\)/);
}

describe('binding a credential', () => {
    it('offers Edit Credential only with both a subject and a schema', async () => {
        const user = userEvent.setup({ delay: null });
        render(<IssueTab />);

        expect(schemaPicker()).toHaveTextContent('Select schema');
        expect(editButton()).toBeDisabled();

        await user.type(subjectField(), 'Bob');
        expect(editButton()).toBeDisabled();

        await pick(user, schemaPicker(), 'degree');
        expect(editButton()).toBeEnabled();

        // A subject of nothing but spaces is no subject.
        await user.clear(subjectField());
        await user.type(subjectField(), '  ');
        expect(editButton()).toBeDisabled();
    });

    it('suggests the identities the wallet knows as subjects', async () => {
        const user = userEvent.setup({ delay: null });
        render(<IssueTab />);

        await user.click(subjectField());
        await user.click(await screen.findByRole('option', { name: 'Carol' }));

        expect(subjectField()).toHaveValue('Carol');
        expect(variables.credentialSubject).toBe('Carol');
    });

    it('takes a subject typed in before the identities are loaded', async () => {
        const user = userEvent.setup({ delay: null });
        variables.agentList = null;
        render(<IssueTab />);

        await user.type(subjectField(), ` ${BOB} `);

        expect(variables.credentialSubject).toBe(BOB);
        expect(screen.queryByRole('option')).toBeNull();
    });

    it('binds the subject to the schema and shows the form of that schema', async () => {
        const user = userEvent.setup({ delay: null });
        render(<IssueTab />);

        const grade = await openForm(user);

        expect(keymaster.bindCredential).toHaveBeenCalledWith('Bob', { schema: 'degree' });
        expect(keymaster.getSchema).toHaveBeenCalledWith(SCHEMA);
        expect(grade).toBeRequired();
        expect(screen.getByLabelText(/^year \(integer\)/)).toBeInTheDocument();
        expect(registryPicker()).toHaveTextContent('hyperswarm');
        expect(setError).not.toHaveBeenCalled();
    });

    it('shows no form before a credential is bound', () => {
        render(<IssueTab />);

        expect(screen.queryByRole('button', { name: 'Issue' })).toBeNull();
        expect(keymaster.getSchema).not.toHaveBeenCalled();
    });

    it('reports a failure to bind', async () => {
        const user = userEvent.setup({ delay: null });
        const failure = new Error('unknown subject');
        keymaster.bindCredential.mockRejectedValue(failure);
        render(<IssueTab />);

        await user.type(subjectField(), 'Bob');
        await pick(user, schemaPicker(), 'degree');
        await user.click(editButton());

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(keymaster.getSchema).not.toHaveBeenCalled();
        expect(screen.queryByRole('button', { name: 'Issue' })).toBeNull();
    });

    it('reports a bound credential that names no schema', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.bindCredential.mockResolvedValue({ type: ['VerifiableCredential'], credentialSubject: { id: BOB } });
        render(<IssueTab />);

        await user.type(subjectField(), 'Bob');
        await pick(user, schemaPicker(), 'degree');
        await user.click(editButton());

        await waitFor(() => expect(setError).toHaveBeenCalledWith('Invalid credential object'));
        expect(keymaster.getSchema).not.toHaveBeenCalled();
        expect(screen.queryByRole('button', { name: 'Issue' })).toBeNull();
    });

    it('reports a schema that cannot be read', async () => {
        const user = userEvent.setup({ delay: null });
        const failure = new Error('unknown schema');
        keymaster.getSchema.mockRejectedValue(failure);
        render(<IssueTab />);

        await user.type(subjectField(), 'Bob');
        await pick(user, schemaPicker(), 'degree');
        await user.click(editButton());

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(screen.queryByRole('button', { name: 'Issue' })).toBeNull();
    });
});

describe('issuing the credential', () => {
    it('offers Issue only once the required fields are filled', async () => {
        const user = userEvent.setup({ delay: null });
        render(<IssueTab />);
        const grade = await openForm(user);

        expect(issueButton()).toBeDisabled();

        await user.type(grade, 'A');
        expect(issueButton()).toBeEnabled();
    });

    it('withdraws Issue when a required field is cleared', async () => {
        const user = userEvent.setup({ delay: null });
        render(<IssueTab />);
        const grade = await openForm(user);

        await user.type(grade, 'A');
        expect(issueButton()).toBeEnabled();

        await user.clear(grade);
        expect(screen.getByText('This field is required')).toBeInTheDocument();
        expect(issueButton()).toBeDisabled();
    });

    it('reads the schema once while the form is filled in', async () => {
        const user = userEvent.setup({ delay: null });
        render(<IssueTab />);
        const grade = await openForm(user);

        await user.type(grade, 'A');
        await user.type(screen.getByLabelText(/^year \(integer\)/), '2024');

        expect(keymaster.getSchema).toHaveBeenCalledTimes(1);
    });

    it('reads the schema again when the credential is bound again', async () => {
        const user = userEvent.setup({ delay: null });
        render(<IssueTab />);
        const grade = await openForm(user);
        await user.type(grade, 'A');

        await user.click(editButton());

        await waitFor(() => expect(keymaster.getSchema).toHaveBeenCalledTimes(2));
        // The form's values are written into the credential bound again.
        await waitFor(() => expect(JSON.parse(variables.credentialString).credentialSubject).toEqual({ id: BOB, grade: 'A' }));
        expect(issueButton()).toBeEnabled();
    });

    it('issues what the form holds on the registry shown and lists it as issued', async () => {
        const user = userEvent.setup({ delay: null });
        render(<IssueTab />);
        const grade = await openForm(user);

        await user.type(grade, 'A');
        await user.type(screen.getByLabelText(/^year \(integer\)/), '2024');
        await user.click(issueButton());

        expect(await screen.findByText(ISSUED)).toBeInTheDocument();
        expect(keymaster.issueCredential).toHaveBeenCalledWith(
            { ...bound, credentialSubject: { id: BOB, grade: 'A', year: 2024 } },
            { registry: 'hyperswarm' },
        );
        expect(variables.issuedList).toEqual(['did:cid:earlier', ISSUED]);
        expect(setError).not.toHaveBeenCalled();
    });

    it('issues on another registry when one is picked', async () => {
        const user = userEvent.setup({ delay: null });
        render(<IssueTab />);
        const grade = await openForm(user);

        await user.type(grade, 'A');
        await pick(user, registryPicker(), 'BTC:mainnet');
        await user.click(issueButton());

        await waitFor(() => expect(keymaster.issueCredential).toHaveBeenCalledWith(
            expect.objectContaining({ credentialSubject: { id: BOB, grade: 'A' } }),
            { registry: 'BTC:mainnet' },
        ));
    });

    it('reports a failure to issue and lists nothing new', async () => {
        const user = userEvent.setup({ delay: null });
        const failure = new Error('registry unavailable');
        keymaster.issueCredential.mockRejectedValue(failure);
        render(<IssueTab />);
        const grade = await openForm(user);

        await user.type(grade, 'A');
        await user.click(issueButton());

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(variables.issuedList).toEqual(['did:cid:earlier']);
        expect(screen.queryByText(ISSUED)).toBeNull();
    });

    it('forgets the credential issued when another is bound', async () => {
        const user = userEvent.setup({ delay: null });
        render(<IssueTab />);
        const grade = await openForm(user);
        await user.type(grade, 'A');
        await user.click(issueButton());
        await screen.findByText(ISSUED);

        await user.click(editButton());

        await waitFor(() => expect(screen.queryByText(ISSUED)).toBeNull());
        expect(keymaster.bindCredential).toHaveBeenCalledTimes(2);
    });
});

describe('a wallet with no keymaster', () => {
    it('binds nothing', async () => {
        const user = userEvent.setup({ delay: null });
        wallet.keymaster = null;
        render(<IssueTab />);

        await user.type(subjectField(), 'Bob');
        await pick(user, schemaPicker(), 'degree');
        await user.click(editButton());

        expect(keymaster.bindCredential).not.toHaveBeenCalled();
        expect(setError).not.toHaveBeenCalled();
    });

    it('reads no schema for a credential already bound', () => {
        wallet.keymaster = null;
        variables.credentialString = JSON.stringify(bound);
        render(<IssueTab />);

        expect(keymaster.getSchema).not.toHaveBeenCalled();
        expect(screen.queryByRole('button', { name: 'Issue' })).toBeNull();
        expect(setError).not.toHaveBeenCalled();
    });

    it('issues nothing once the keymaster is lost', async () => {
        const user = userEvent.setup({ delay: null });
        const shown = render(<IssueTab />);
        const grade = await openForm(user);
        await user.type(grade, 'A');

        wallet.keymaster = null;
        shown.rerender(<IssueTab />);
        await user.click(issueButton());

        expect(keymaster.issueCredential).not.toHaveBeenCalled();
        expect(variables.issuedList).toEqual(['did:cid:earlier']);
        expect(setError).not.toHaveBeenCalled();
    });
});
