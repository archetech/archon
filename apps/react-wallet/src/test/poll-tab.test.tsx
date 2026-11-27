import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import PollTab from '../../../../packages/wallet-ui/src/components/PollTab';

// The Polls tab has two views. Create makes a poll, lists its voters and sends
// it to them. View / Vote opens a poll the wallet knows, casts a ballot, and
// lets the poll's owner tally, publish, rename and remove it.

const { keymaster, wallet, variables, walletData, setError, setSuccess, openView } = vi.hoisted(() => {
    const keymaster = {
        getPoll: vi.fn(), pollTemplate: vi.fn(), createPoll: vi.fn(), sendPoll: vi.fn(),
        listPollVoters: vi.fn(), addPollVoter: vi.fn(), removePollVoter: vi.fn(),
        resolveDID: vi.fn(), viewPoll: vi.fn(), votePoll: vi.fn(), updatePoll: vi.fn(), sendBallot: vi.fn(),
        publishPoll: vi.fn(), unpublishPoll: vi.fn(),
        addAlias: vi.fn(), removeAlias: vi.fn(),
    };

    return {
        keymaster,
        wallet: { keymaster: keymaster as typeof keymaster | null },
        variables: {
            currentDID: '',
            currentId: '',
            registries: [] as string[],
            aliasList: {} as Record<string, string>,
            agentList: [] as string[] | null,
            pollList: [] as string[],
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

const ME = 'did:cid:me';
const OTHER = 'did:cid:other';
const POLL = 'did:cid:lunch';
const NEW_POLL = 'did:cid:newpoll';
const BALLOT = 'did:cid:ballot';
const BOB = 'did:cid:bob';
const CAROL = 'did:cid:carol';
const OPEN_UNTIL = '2099-01-01T00:00:00.000Z';
const CLOSED_SINCE = '2001-01-01T00:00:00.000Z';
const TEMPLATE = { version: 2, name: 'template', description: '', options: ['a', 'b'], deadline: '' };
const RESULTS = {
    tally: [
        { vote: 1, option: 'pizza', count: 1 },
        { vote: 2, option: 'sushi', count: 4 },
    ],
    votes: { eligible: 6, received: 5, pending: 1 },
};

function lunch(deadline: string | undefined = OPEN_UNTIL) {
    return { name: 'lunch', description: 'Where do we eat?', options: ['pizza', 'sushi', 'tacos'], deadline };
}

beforeEach(() => {
    vi.resetAllMocks();
    wallet.keymaster = keymaster;
    variables.currentDID = ME;
    variables.currentId = 'me';
    variables.registries = ['hyperswarm', 'BTC:mainnet'];
    variables.aliasList = { lunch: POLL, taken: 'did:cid:taken', Bob: BOB };
    variables.agentList = ['Bob', 'Carol'];
    variables.pollList = ['lunch'];
    keymaster.getPoll.mockResolvedValue(lunch());
    keymaster.pollTemplate.mockResolvedValue(TEMPLATE);
    keymaster.createPoll.mockResolvedValue(NEW_POLL);
    keymaster.listPollVoters.mockResolvedValue({});
    keymaster.resolveDID.mockResolvedValue({ didDocument: { controller: OTHER } });
    keymaster.viewPoll.mockResolvedValue({ isEligible: true, hasVoted: false });
    keymaster.votePoll.mockResolvedValue(BALLOT);
});

const setup = () => userEvent.setup({ delay: null });

const nameField = () => screen.getByLabelText('Poll Name');
const descriptionField = () => screen.getByLabelText('Description');
const optionsField = () => screen.getByLabelText(/^Options/);
const deadlineField = () => screen.getByLabelText('Deadline');
const createButton = () => screen.getByRole('button', { name: 'Create' });
const sendButton = () => screen.getByRole('button', { name: 'Send' });
// The voter field's own clear control is also a button named Clear, so the
// form's button is found by its text.
const clearButton = () => screen.getByText('Clear');
// While its suggestions are open the list carries the same label, so the field
// is found by its role.
const voterField = () => screen.getByRole('combobox', { name: 'Name or DID' });
// The add-voter button holds only an icon.
const addVoterButton = () => screen.getByTestId('PersonAddIcon').closest('button') as HTMLButtonElement;
const removeVoterButton = (did: string) => within(screen.getByText(did).parentElement as HTMLElement).getByRole('button');

// A tooltip puts its title on a span around the button.
const tipButton = (title: string) => within(screen.getByLabelText(title)).getByRole('button');
const pollPicker = () => screen.getByRole('combobox');

async function fillForm(user: UserEvent, name = 'dinner', description = 'Where next?') {
    await user.type(nameField(), name);
    await user.type(descriptionField(), description);
    // user-event cannot type into a datetime-local field under jsdom.
    fireEvent.change(deadlineField(), { target: { value: '2031-05-06T07:08' } });
}

async function createPoll(user: UserEvent) {
    await fillForm(user);
    await user.click(createButton());
    await screen.findByLabelText('Name or DID');
}

// The field empties a moment after the voter is added, so a test that goes on
// to type in it waits for that first.
async function addVoter(user: UserEvent, who: string) {
    await user.type(voterField(), who);
    await user.click(addVoterButton());
    await waitFor(() => expect(voterField()).toHaveValue(''));
}

async function showPolls(user: UserEvent) {
    await user.click(screen.getByRole('tab', { name: 'View / Vote' }));
}

async function pickPoll(user: UserEvent, name = 'lunch') {
    await user.click(pollPicker());
    await user.click(await screen.findByRole('option', { name }));
}

async function openPoll(user: UserEvent, name = 'lunch') {
    await showPolls(user);
    await pickPoll(user, name);
    await waitFor(() => expect(keymaster.viewPoll).toHaveBeenCalled());
    await screen.findByText('Where do we eat?');
}

function ownPoll() {
    keymaster.resolveDID.mockResolvedValue({ didDocument: { controller: ME } });
}

describe('creating a poll', () => {
    it('offers Create only once every field is filled, and Send only once a poll exists', async () => {
        const user = setup();
        render(<PollTab />);

        expect(optionsField()).toHaveValue('yes, no, abstain');
        expect(createButton()).toBeDisabled();
        expect(sendButton()).toBeDisabled();

        await user.type(nameField(), 'dinner');
        expect(createButton()).toBeDisabled();
        await user.type(descriptionField(), 'Where next?');
        expect(createButton()).toBeDisabled();
        fireEvent.change(deadlineField(), { target: { value: '2031-05-06T07:08' } });
        expect(createButton()).toBeEnabled();

        await user.clear(optionsField());
        expect(createButton()).toBeDisabled();
        expect(sendButton()).toBeDisabled();
    });

    it('creates the poll on the chosen registry, names it and shows its DID', async () => {
        const user = setup();
        render(<PollTab />);

        await fillForm(user, 'dinner', '  Where next?  ');
        await user.clear(optionsField());
        // Empty entries between commas are dropped.
        await user.type(optionsField(), ' thai ,, ramen , ');
        await user.click(screen.getByRole('combobox'));
        await user.click(await screen.findByRole('option', { name: 'BTC:mainnet' }));
        await user.click(createButton());

        expect(await screen.findByText(NEW_POLL)).toBeInTheDocument();
        expect(keymaster.createPoll).toHaveBeenCalledWith(
            {
                ...TEMPLATE,
                name: 'dinner',
                description: 'Where next?',
                options: ['thai', 'ramen'],
                deadline: new Date('2031-05-06T07:08').toISOString(),
            },
            { registry: 'BTC:mainnet' },
        );
        expect(keymaster.addAlias).toHaveBeenCalledWith('dinner', NEW_POLL);
        expect(walletData.refreshAliases).toHaveBeenCalled();
        expect(setSuccess).toHaveBeenCalledWith(`Poll created: ${NEW_POLL}`);
        expect(setError).not.toHaveBeenCalled();

        // The poll is fixed once created: its fields lock and Create gives way
        // to the voter list.
        expect(nameField()).toBeDisabled();
        expect(descriptionField()).toBeDisabled();
        expect(optionsField()).toBeDisabled();
        expect(deadlineField()).toBeDisabled();
        expect(screen.queryByRole('button', { name: 'Create' })).toBeNull();
        expect(screen.getByText('Voters')).toBeInTheDocument();
        expect(sendButton()).toBeEnabled();
    });

    it('creates on hyperswarm unless another registry is chosen', async () => {
        const user = setup();
        render(<PollTab />);

        await createPoll(user);

        expect(keymaster.createPoll).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'dinner', options: ['yes', 'no', 'abstain'] }),
            { registry: 'hyperswarm' },
        );
    });

    it.each([
        ['a name of only spaces', { name: '   ' }, 'Poll name is required'],
        ['a name that is already an alias', { name: 'taken' }, 'Name "taken" is already in use'],
        ['a description of only spaces', { description: '   ' }, 'Description is required'],
        ['a single option', { options: 'only' }, 'Provide between 2 and 10 options'],
        ['no option between the commas', { options: ', ,' }, 'Provide between 2 and 10 options'],
        ['eleven options', { options: '1,2,3,4,5,6,7,8,9,10,11' }, 'Provide between 2 and 10 options'],
    ])('refuses %s', async (_what, given: { name?: string; description?: string; options?: string }, message) => {
        const user = setup();
        render(<PollTab />);

        await fillForm(user, given.name ?? 'dinner', given.description ?? 'Where next?');
        if (given.options) {
            await user.clear(optionsField());
            await user.type(optionsField(), given.options);
        }
        await user.click(createButton());

        await waitFor(() => expect(setError).toHaveBeenCalledWith(message));
        expect(keymaster.createPoll).not.toHaveBeenCalled();
        expect(createButton()).toBeInTheDocument();
    });

    it('accepts ten options', async () => {
        const user = setup();
        render(<PollTab />);

        await fillForm(user);
        await user.clear(optionsField());
        await user.type(optionsField(), '1,2,3,4,5,6,7,8,9,10');
        await user.click(createButton());

        await waitFor(() => expect(keymaster.createPoll).toHaveBeenCalled());
        expect(keymaster.createPoll.mock.calls[0][0].options).toHaveLength(10);
        expect(setError).not.toHaveBeenCalled();
    });

    it('reports a failure to create the poll', async () => {
        const user = setup();
        const failure = new Error('registry unavailable');
        keymaster.createPoll.mockRejectedValue(failure);
        render(<PollTab />);

        await fillForm(user);
        await user.click(createButton());

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(keymaster.addAlias).not.toHaveBeenCalled();
        expect(setSuccess).not.toHaveBeenCalled();
        expect(createButton()).toBeEnabled();
        expect(nameField()).toBeEnabled();
    });

    it('reports a failure to name the new poll', async () => {
        const user = setup();
        const failure = new Error('invalid alias');
        keymaster.addAlias.mockRejectedValue(failure);
        render(<PollTab />);

        await fillForm(user);
        await user.click(createButton());

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(walletData.refreshAliases).not.toHaveBeenCalled();
        expect(setSuccess).not.toHaveBeenCalled();
    });

    it('clears the form and forgets the poll just created', async () => {
        const user = setup();
        render(<PollTab />);
        await createPoll(user);
        expect(sessionStorage.getItem('createdPollDid')).toBe(NEW_POLL);

        await user.click(clearButton());

        expect(nameField()).toHaveValue('');
        expect(nameField()).toBeEnabled();
        expect(descriptionField()).toHaveValue('');
        expect(optionsField()).toHaveValue('yes, no, abstain');
        expect(deadlineField()).toHaveValue('');
        expect(screen.queryByText(NEW_POLL)).toBeNull();
        expect(screen.queryByText('Voters')).toBeNull();
        expect(createButton()).toBeDisabled();
        expect(sendButton()).toBeDisabled();
        expect(sessionStorage.getItem('createdPollDid')).toBeNull();
    });

    it('does nothing while the wallet has no keymaster', async () => {
        const user = setup();
        wallet.keymaster = null;
        render(<PollTab />);

        await fillForm(user);
        await user.click(createButton());

        for (const method of Object.values(keymaster)) {
            expect(method).not.toHaveBeenCalled();
        }
        expect(setError).not.toHaveBeenCalled();
        expect(createButton()).toBeInTheDocument();
    });
});

describe('the voters of a new poll', () => {
    it('adds the voter typed, trimmed, and lists the poll\'s voters', async () => {
        const user = setup();
        render(<PollTab />);
        await createPoll(user);
        expect(addVoterButton()).toBeDisabled();

        await user.type(voterField(), `${CAROL} `);
        keymaster.listPollVoters.mockResolvedValue({ [CAROL]: {}, [BOB]: {} });
        await user.click(addVoterButton());

        expect(await screen.findByText(CAROL)).toBeInTheDocument();
        expect(screen.getByText(BOB)).toBeInTheDocument();
        expect(keymaster.addPollVoter).toHaveBeenCalledWith(NEW_POLL, CAROL);
        expect(keymaster.listPollVoters).toHaveBeenCalledWith(NEW_POLL);
        await waitFor(() => expect(voterField()).toHaveValue(''));
        expect(addVoterButton()).toBeDisabled();
        expect(setError).not.toHaveBeenCalled();
    });

    it('adds the voter when Enter is pressed in the field', async () => {
        const user = setup();
        render(<PollTab />);
        await createPoll(user);

        keymaster.listPollVoters.mockResolvedValue({ [CAROL]: {} });
        await user.type(voterField(), `${CAROL}{Enter}`);

        expect(await screen.findByText(CAROL)).toBeInTheDocument();
        expect(keymaster.addPollVoter).toHaveBeenCalledWith(NEW_POLL, CAROL);
        expect(keymaster.addPollVoter).toHaveBeenCalledTimes(1);
    });

    it('offers the wallet\'s agents as voters', async () => {
        const user = setup();
        render(<PollTab />);
        await createPoll(user);

        await user.click(voterField());
        expect(await screen.findByRole('option', { name: 'Carol' })).toBeInTheDocument();
        await user.click(screen.getByRole('option', { name: 'Bob' }));
        expect(voterField()).toHaveValue('Bob');
        await user.click(addVoterButton());

        await waitFor(() => expect(keymaster.addPollVoter).toHaveBeenCalledWith(NEW_POLL, 'Bob'));
    });

    it('empties the field with its clear control', async () => {
        const user = setup();
        render(<PollTab />);
        await createPoll(user);

        await user.type(voterField(), 'Bo');
        expect(addVoterButton()).toBeEnabled();
        await user.click(screen.getByTitle('Clear'));

        expect(voterField()).toHaveValue('');
        expect(addVoterButton()).toBeDisabled();
        expect(keymaster.addPollVoter).not.toHaveBeenCalled();
    });

    it('still takes a typed voter when the wallet has no agent list', async () => {
        const user = setup();
        variables.agentList = null;
        render(<PollTab />);
        await createPoll(user);

        await user.type(voterField(), CAROL);
        expect(screen.queryByRole('option')).toBeNull();
        await user.click(addVoterButton());

        await waitFor(() => expect(keymaster.addPollVoter).toHaveBeenCalledWith(NEW_POLL, CAROL));
    });

    it('reports a failure to add a voter and keeps what was typed', async () => {
        const user = setup();
        const failure = new Error('unknown DID');
        keymaster.addPollVoter.mockRejectedValue(failure);
        render(<PollTab />);
        await createPoll(user);

        await user.type(voterField(), 'nobody');
        await user.click(addVoterButton());

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(keymaster.listPollVoters).not.toHaveBeenCalled();
        expect(voterField()).toHaveValue('nobody');
    });

    it('shows no voters when the list cannot be read', async () => {
        const user = setup();
        render(<PollTab />);
        await createPoll(user);

        keymaster.listPollVoters.mockResolvedValue({ [CAROL]: {} });
        await addVoter(user, CAROL);
        expect(await screen.findByText(CAROL)).toBeInTheDocument();

        keymaster.listPollVoters.mockRejectedValue(new Error('vault unavailable'));
        await addVoter(user, BOB);

        await waitFor(() => expect(screen.queryByText(CAROL)).toBeNull());
        expect(keymaster.addPollVoter).toHaveBeenCalledWith(NEW_POLL, BOB);
        expect(setError).not.toHaveBeenCalled();
    });

    async function withVoters(user: UserEvent) {
        keymaster.listPollVoters.mockResolvedValue({ [BOB]: {}, [CAROL]: {} });
        await addVoter(user, BOB);
        await screen.findByText(CAROL);
    }

    it('removes a voter', async () => {
        const user = setup();
        render(<PollTab />);
        await createPoll(user);
        await withVoters(user);

        keymaster.listPollVoters.mockResolvedValue({ [BOB]: {} });
        await user.click(removeVoterButton(CAROL));

        await waitFor(() => expect(screen.queryByText(CAROL)).toBeNull());
        expect(keymaster.removePollVoter).toHaveBeenCalledWith(NEW_POLL, CAROL);
        expect(screen.getByText(BOB)).toBeInTheDocument();
    });

    it('reports a failure to remove a voter and keeps the voter listed', async () => {
        const user = setup();
        const failure = new Error('not the owner');
        keymaster.removePollVoter.mockRejectedValue(failure);
        render(<PollTab />);
        await createPoll(user);
        await withVoters(user);

        await user.click(removeVoterButton(BOB));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(keymaster.removePollVoter).toHaveBeenCalledWith(NEW_POLL, BOB);
        expect(screen.getByText(BOB)).toBeInTheDocument();
        expect(keymaster.listPollVoters).toHaveBeenCalledTimes(1);
    });
});

describe('sending a new poll', () => {
    it('sends the poll to its voters, once', async () => {
        const user = setup();
        render(<PollTab />);
        await createPoll(user);

        await user.click(sendButton());

        await waitFor(() => expect(setSuccess).toHaveBeenCalledWith('Poll notice sent'));
        expect(keymaster.sendPoll).toHaveBeenCalledWith(NEW_POLL);
        expect(sendButton()).toBeDisabled();
        // A poll that was sent is not brought back when the tab is next opened.
        expect(sessionStorage.getItem('createdPollDid')).toBeNull();
    });

    it('reports a failure to send and lets it be tried again', async () => {
        const user = setup();
        const failure = new Error('no voters');
        keymaster.sendPoll.mockRejectedValue(failure);
        render(<PollTab />);
        await createPoll(user);

        await user.click(sendButton());

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(setSuccess).not.toHaveBeenCalledWith('Poll notice sent');
        expect(sendButton()).toBeEnabled();
        expect(sessionStorage.getItem('createdPollDid')).toBe(NEW_POLL);
    });
});

describe('a poll created before the tab was left', () => {
    beforeEach(() => {
        // Keeps the only reads of a poll the ones made to bring it back.
        variables.pollList = [];
        sessionStorage.setItem('createdPollDid', NEW_POLL);
    });

    it('is brought back with its voters', async () => {
        keymaster.getPoll.mockResolvedValue({
            name: 'dinner', description: 'Where next?', options: ['thai', 'ramen'], deadline: '2031-05-06T07:08:00.000Z',
        });
        keymaster.listPollVoters.mockResolvedValue({ [BOB]: {} });
        render(<PollTab />);

        expect(await screen.findByText(BOB)).toBeInTheDocument();
        expect(keymaster.getPoll).toHaveBeenCalledWith(NEW_POLL);
        expect(keymaster.listPollVoters).toHaveBeenCalledWith(NEW_POLL);
        expect(nameField()).toHaveValue('dinner');
        expect(nameField()).toBeDisabled();
        expect(descriptionField()).toHaveValue('Where next?');
        expect(optionsField()).toHaveValue('thai, ramen');
        expect(deadlineField()).not.toHaveValue('');
        expect(screen.getByText(NEW_POLL)).toBeInTheDocument();
        expect(sendButton()).toBeEnabled();
    });

    it('is brought back even when it holds none of the fields', async () => {
        keymaster.getPoll.mockResolvedValue({});
        render(<PollTab />);

        expect(await screen.findByText(NEW_POLL)).toBeInTheDocument();
        expect(nameField()).toHaveValue('');
        expect(descriptionField()).toHaveValue('');
        expect(optionsField()).toHaveValue('');
        expect(deadlineField()).toHaveValue('');
        expect(sendButton()).toBeEnabled();
    });

    it('is forgotten when it no longer exists', async () => {
        keymaster.getPoll.mockResolvedValue(null);
        render(<PollTab />);

        await waitFor(() => expect(sessionStorage.getItem('createdPollDid')).toBeNull());
        expect(nameField()).toBeEnabled();
        expect(screen.queryByText(NEW_POLL)).toBeNull();
        expect(keymaster.listPollVoters).not.toHaveBeenCalled();
    });

    it('is forgotten when it cannot be read', async () => {
        keymaster.getPoll.mockRejectedValue(new Error('unknown DID'));
        render(<PollTab />);

        await waitFor(() => expect(sessionStorage.getItem('createdPollDid')).toBeNull());
        expect(nameField()).toBeEnabled();
        expect(screen.queryByText(NEW_POLL)).toBeNull();
        expect(setError).not.toHaveBeenCalled();
    });

    it('is left alone while the wallet has no keymaster', () => {
        wallet.keymaster = null;
        render(<PollTab />);

        expect(keymaster.getPoll).not.toHaveBeenCalled();
        expect(sessionStorage.getItem('createdPollDid')).toBe(NEW_POLL);
        expect(nameField()).toBeEnabled();
    });
});

describe('the list of polls', () => {
    it('says so when the wallet knows no poll', async () => {
        const user = setup();
        variables.pollList = [];
        render(<PollTab />);

        await showPolls(user);

        expect(screen.getByText('No polls found')).toBeInTheDocument();
        expect(screen.queryByRole('combobox')).toBeNull();
        expect(keymaster.getPoll).not.toHaveBeenCalled();
    });

    it('marks each poll by whether it can be read', async () => {
        const user = setup();
        variables.aliasList = { lunch: POLL, gone: 'did:cid:gone', broken: 'did:cid:broken' };
        variables.pollList = ['lunch', 'gone', 'broken'];
        keymaster.getPoll.mockImplementation(async (did: string) => {
            if (did === POLL) {
                return lunch();
            }
            if (did === 'did:cid:gone') {
                return null;
            }
            throw new Error('unknown DID');
        });
        render(<PollTab />);

        await showPolls(user);
        await waitFor(() => expect(keymaster.getPoll).toHaveBeenCalledTimes(3));
        await user.click(pollPicker());

        const option = (name: string) => screen.getByRole('option', { name });
        expect(await within(await screen.findByRole('option', { name: 'lunch' })).findByTestId('HowToVoteIcon')).toBeInTheDocument();
        expect(within(option('gone')).getByTestId('BlockIcon')).toBeInTheDocument();
        expect(within(option('broken')).getByTestId('BlockIcon')).toBeInTheDocument();
        expect(screen.getByRole('option', { name: 'Select poll' })).toHaveAttribute('aria-disabled', 'true');
        expect(setError).not.toHaveBeenCalled();
    });

    it('reads no poll before an identity is current', async () => {
        const user = setup();
        variables.currentDID = '';
        render(<PollTab />);

        await showPolls(user);
        await user.click(pollPicker());

        expect(within(await screen.findByRole('option', { name: 'lunch' })).getByTestId('BlockIcon')).toBeInTheDocument();
        expect(keymaster.getPoll).not.toHaveBeenCalled();
    });

    it('offers nothing to do with a poll before one is picked', async () => {
        const user = setup();
        render(<PollTab />);

        await showPolls(user);

        expect(pollPicker()).toHaveTextContent('Select poll');
        expect(tipButton('Rename Poll')).toBeDisabled();
        expect(tipButton('Delete Poll')).toBeDisabled();
        expect(tipButton('Copy')).toBeDisabled();
        expect(tipButton('Resolve')).toBeDisabled();
        expect(screen.queryByText('Description')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Vote' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'View' })).toBeNull();
    });

    it('keeps what was typed for a new poll while the polls are looked at', async () => {
        const user = setup();
        render(<PollTab />);
        await user.type(nameField(), 'dinner');

        await showPolls(user);
        expect(screen.queryByLabelText('Poll Name')).toBeNull();
        await user.click(screen.getByRole('tab', { name: 'Create' }));

        expect(nameField()).toHaveValue('dinner');
    });
});

describe('opening a poll', () => {
    it('shows its description, options and deadline', async () => {
        const user = setup();
        render(<PollTab />);

        await openPoll(user);

        expect(keymaster.getPoll).toHaveBeenCalledWith(POLL);
        expect(keymaster.resolveDID).toHaveBeenCalledWith(POLL);
        expect(keymaster.viewPoll).toHaveBeenCalledWith(POLL);
        expect(pollPicker()).toHaveTextContent('lunch');
        expect(screen.getByText('Cast your vote')).toBeInTheDocument();
        expect(screen.getByText(`Deadline: ${new Date(OPEN_UNTIL).toLocaleString()}`)).toBeInTheDocument();
        expect(screen.getAllByRole('radio').map(radio => radio.closest('label')?.textContent)).toEqual(['pizza', 'sushi', 'tacos']);
        expect(screen.getByRole('radio', { name: 'pizza' })).toBeChecked();
        expect(screen.getByRole('button', { name: 'Vote' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Send Ballot' })).toBeDisabled();
        expect(tipButton('Rename Poll')).toBeEnabled();
        expect(tipButton('Delete Poll')).toBeEnabled();
        // Publishing and tallying are the owner's.
        expect(screen.queryByRole('button', { name: 'View' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
        expect(setError).not.toHaveBeenCalled();
    });

    it('opens the poll\'s DID in the viewer, and copies it', async () => {
        const user = setup();
        render(<PollTab />);
        await openPoll(user);

        await user.click(tipButton('Resolve'));
        await user.click(tipButton('Copy'));

        expect(openView).toHaveBeenCalledWith({ did: POLL, tab: 'viewer' });
        expect(walletData.handleCopyDID).toHaveBeenCalledWith(POLL);
    });

    it('asks for an updated vote from someone who has voted', async () => {
        const user = setup();
        keymaster.viewPoll.mockResolvedValue({ isEligible: true, hasVoted: true });
        render(<PollTab />);

        await openPoll(user);

        expect(await screen.findByText('Update your vote')).toBeInTheDocument();
        expect(screen.queryByText('Cast your vote')).toBeNull();
    });

    it('offers no vote to someone who is not a voter', async () => {
        const user = setup();
        keymaster.viewPoll.mockResolvedValue({ isEligible: false, hasVoted: false });
        render(<PollTab />);

        await openPoll(user);

        expect(screen.getByRole('radio', { name: 'sushi' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Vote' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Send Ballot' })).toBeNull();
        expect(screen.queryByLabelText('Spoil ballot')).toBeNull();
    });

    it('opens a poll that has no description, options, deadline or document', async () => {
        const user = setup();
        keymaster.getPoll.mockResolvedValue(null);
        keymaster.resolveDID.mockResolvedValue(null);
        render(<PollTab />);

        await showPolls(user);
        await pickPoll(user);

        expect(await screen.findByRole('button', { name: 'Vote' })).toBeInTheDocument();
        expect(screen.getByText('Cast your vote')).toBeInTheDocument();
        expect(screen.queryByText(/^Deadline:/)).toBeNull();
        expect(screen.queryByRole('radio')).toBeNull();
        expect(setError).not.toHaveBeenCalled();
    });

    it('treats a poll whose document names no controller as someone else\'s', async () => {
        const user = setup();
        keymaster.resolveDID.mockResolvedValue({});
        render(<PollTab />);

        await openPoll(user);

        expect(screen.getByRole('button', { name: 'Send Ballot' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'View' })).toBeNull();
    });

    it('reports a poll that cannot be read', async () => {
        const user = setup();
        render(<PollTab />);
        await showPolls(user);
        // The list has read the poll by now; only opening it fails.
        await waitFor(() => expect(keymaster.getPoll).toHaveBeenCalled());
        const failure = new Error('unknown poll');
        keymaster.getPoll.mockRejectedValue(failure);

        await pickPoll(user);

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(keymaster.viewPoll).not.toHaveBeenCalled();
        expect(screen.queryByRole('radio')).toBeNull();
    });

    it('opens nothing for a name the wallet has no DID for', async () => {
        const user = setup();
        variables.aliasList = {};
        render(<PollTab />);

        await showPolls(user);
        await pickPoll(user);

        expect(pollPicker()).toHaveTextContent('lunch');
        expect(keymaster.resolveDID).not.toHaveBeenCalled();
        expect(keymaster.viewPoll).not.toHaveBeenCalled();
        expect(screen.queryByText('Description')).toBeNull();
        expect(tipButton('Resolve')).toBeDisabled();
    });

    it('closes the poll when the current identity changes', async () => {
        const user = setup();
        const shown = render(<PollTab />);
        await openPoll(user);

        variables.currentId = 'someone-else';
        shown.rerender(<PollTab />);

        await waitFor(() => expect(pollPicker()).toHaveTextContent('Select poll'));
        expect(screen.queryByText('Where do we eat?')).toBeNull();
        expect(tipButton('Rename Poll')).toBeDisabled();
    });
});

describe('voting', () => {
    it('casts a ballot for the option picked and then sends it to the poll\'s owner', async () => {
        const user = setup();
        render(<PollTab />);
        await openPoll(user);

        await user.click(screen.getByRole('radio', { name: 'sushi' }));
        await user.click(screen.getByRole('button', { name: 'Vote' }));

        expect(await screen.findByText(BALLOT)).toBeInTheDocument();
        // Options are numbered from one; zero is a spoiled ballot.
        expect(keymaster.votePoll).toHaveBeenCalledWith(POLL, 2);
        expect(setSuccess).toHaveBeenCalledWith('Ballot created');
        expect(keymaster.updatePoll).not.toHaveBeenCalled();
        expect(screen.getByText('Update your vote')).toBeInTheDocument();

        const send = screen.getByRole('button', { name: 'Send Ballot' });
        expect(send).toBeEnabled();
        await user.click(send);

        await waitFor(() => expect(setSuccess).toHaveBeenCalledWith('Ballot sent'));
        expect(keymaster.sendBallot).toHaveBeenCalledWith(BALLOT, POLL);
        expect(send).toBeDisabled();
        expect(setError).not.toHaveBeenCalled();
    });

    it('votes for the first option unless another is picked', async () => {
        const user = setup();
        render(<PollTab />);
        await openPoll(user);

        await user.click(screen.getByRole('button', { name: 'Vote' }));

        await waitFor(() => expect(keymaster.votePoll).toHaveBeenCalledWith(POLL, 1));
    });

    it('casts a spoiled ballot', async () => {
        const user = setup();
        render(<PollTab />);
        await openPoll(user);

        await user.click(screen.getByRole('radio', { name: 'tacos' }));
        await user.click(screen.getByLabelText('Spoil ballot'));
        expect(screen.queryByRole('radio')).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Vote' }));

        await waitFor(() => expect(keymaster.votePoll).toHaveBeenCalledWith(POLL, 0));

        // Taking the mark off brings the choice back as it was.
        await user.click(screen.getByLabelText('Spoil ballot'));
        expect(screen.getByRole('radio', { name: 'tacos' })).toBeChecked();
    });

    it('lets a ballot be sent again after another vote', async () => {
        const user = setup();
        render(<PollTab />);
        await openPoll(user);

        await user.click(screen.getByRole('button', { name: 'Vote' }));
        await screen.findByText(BALLOT);
        await user.click(screen.getByRole('button', { name: 'Send Ballot' }));
        await waitFor(() => expect(screen.getByRole('button', { name: 'Send Ballot' })).toBeDisabled());

        keymaster.votePoll.mockResolvedValue('did:cid:ballot2');
        await user.click(screen.getByRole('radio', { name: 'tacos' }));
        await user.click(screen.getByRole('button', { name: 'Vote' }));

        expect(await screen.findByText('did:cid:ballot2')).toBeInTheDocument();
        expect(keymaster.votePoll).toHaveBeenLastCalledWith(POLL, 3);
        expect(screen.getByRole('button', { name: 'Send Ballot' })).toBeEnabled();
    });

    it('counts the owner\'s own ballot at once, with nothing to send', async () => {
        const user = setup();
        ownPoll();
        render(<PollTab />);
        await openPoll(user);
        expect(screen.queryByRole('button', { name: 'Send Ballot' })).toBeNull();

        await user.click(screen.getByRole('button', { name: 'Vote' }));

        await waitFor(() => expect(setSuccess).toHaveBeenCalledWith('Poll updated'));
        expect(keymaster.votePoll).toHaveBeenCalledWith(POLL, 1);
        expect(keymaster.updatePoll).toHaveBeenCalledWith(BALLOT);
        expect(keymaster.sendBallot).not.toHaveBeenCalled();
        expect(screen.getByText(BALLOT)).toBeInTheDocument();
    });

    it('reports a failure to count the owner\'s ballot', async () => {
        const user = setup();
        const failure = new Error('poll closed');
        ownPoll();
        keymaster.updatePoll.mockRejectedValue(failure);
        render(<PollTab />);
        await openPoll(user);

        await user.click(screen.getByRole('button', { name: 'Vote' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(setSuccess).not.toHaveBeenCalled();
    });

    it('reports a failure to vote', async () => {
        const user = setup();
        const failure = new Error('not eligible');
        keymaster.votePoll.mockRejectedValue(failure);
        render(<PollTab />);
        await openPoll(user);

        await user.click(screen.getByRole('button', { name: 'Vote' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(setSuccess).not.toHaveBeenCalled();
        expect(screen.getByText('Cast your vote')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Send Ballot' })).toBeDisabled();
    });

    it('reports a failure to send the ballot and lets it be tried again', async () => {
        const user = setup();
        const failure = new Error('owner unreachable');
        keymaster.sendBallot.mockRejectedValue(failure);
        render(<PollTab />);
        await openPoll(user);

        await user.click(screen.getByRole('button', { name: 'Vote' }));
        await screen.findByText(BALLOT);
        await user.click(screen.getByRole('button', { name: 'Send Ballot' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(setSuccess).not.toHaveBeenCalledWith('Ballot sent');
        expect(screen.getByRole('button', { name: 'Send Ballot' })).toBeEnabled();
    });
});

describe('the owner\'s tally', () => {
    it('shows the results so far, most votes first', async () => {
        const user = setup();
        ownPoll();
        render(<PollTab />);
        await openPoll(user);
        // An open poll is not yet to be published.
        expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();

        keymaster.viewPoll.mockResolvedValue({ isEligible: true, hasVoted: false, results: RESULTS });
        await user.click(screen.getByRole('button', { name: 'View' }));

        const dialog = await screen.findByRole('dialog', { name: 'Poll Results' });
        const sushi = within(dialog).getByText('sushi');
        const pizza = within(dialog).getByText('pizza');
        expect(sushi.compareDocumentPosition(pizza) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(sushi.parentElement).toHaveTextContent('sushi4');
        expect(within(dialog).getByText('Eligible voters: 6')).toBeInTheDocument();
        expect(within(dialog).getByText('Ballots received: 5')).toBeInTheDocument();
        expect(within(dialog).getByText('Pending ballots: 1')).toBeInTheDocument();

        await user.click(within(dialog).getByRole('button', { name: 'Close' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('shows nothing when the poll has no results to give', async () => {
        const user = setup();
        ownPoll();
        render(<PollTab />);
        await openPoll(user);

        await user.click(screen.getByRole('button', { name: 'View' }));

        await waitFor(() => expect(keymaster.viewPoll).toHaveBeenCalledTimes(2));
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(setError).not.toHaveBeenCalled();
    });

    it('reports a failure to read the results', async () => {
        const user = setup();
        ownPoll();
        render(<PollTab />);
        await openPoll(user);

        const failure = new Error('vault unavailable');
        keymaster.viewPoll.mockRejectedValue(failure);
        await user.click(screen.getByRole('button', { name: 'View' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(screen.queryByRole('dialog')).toBeNull();
    });
});

describe('a poll past its deadline', () => {
    beforeEach(() => {
        keymaster.getPoll.mockResolvedValue(lunch(CLOSED_SINCE));
    });

    it('takes no more votes and says its results are not published', async () => {
        const user = setup();
        render(<PollTab />);

        await openPoll(user);

        expect(await screen.findByText('Poll complete')).toBeInTheDocument();
        expect(screen.getByText('Results not published yet')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Vote' })).toBeNull();
        expect(screen.queryByRole('radio')).toBeNull();
        expect(screen.queryByRole('button', { name: 'View Results' })).toBeNull();
        // Publishing is the owner's.
        expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
    });

    it('shows the published results to a voter', async () => {
        const user = setup();
        keymaster.viewPoll.mockResolvedValue({ isEligible: true, hasVoted: true, results: { tally: RESULTS.tally } });
        render(<PollTab />);
        await openPoll(user);

        await user.click(await screen.findByRole('button', { name: 'View Results' }));

        const dialog = await screen.findByRole('dialog', { name: 'Poll Results' });
        expect(within(dialog).getByText('sushi')).toBeInTheDocument();
        // Published results need not say how many voted.
        expect(within(dialog).queryByText(/Eligible voters/)).toBeNull();
        expect(screen.queryByText('Results not published yet')).toBeNull();
    });

    it('lets its owner publish the results and take them back', async () => {
        const user = setup();
        ownPoll();
        render(<PollTab />);
        await openPoll(user);
        await screen.findByText('Poll complete');

        keymaster.viewPoll.mockResolvedValue({ isEligible: true, hasVoted: true, results: RESULTS });
        await user.click(screen.getByRole('button', { name: 'Publish' }));

        expect(await screen.findByRole('button', { name: 'Unpublish' })).toBeInTheDocument();
        expect(keymaster.publishPoll).toHaveBeenCalledWith(POLL);
        expect(keymaster.viewPoll).toHaveBeenLastCalledWith(POLL);
        expect(setSuccess).toHaveBeenCalledWith('Poll published');
        expect(screen.getByRole('button', { name: 'View Results' })).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Unpublish' }));

        expect(await screen.findByRole('button', { name: 'Publish' })).toBeInTheDocument();
        expect(keymaster.unpublishPoll).toHaveBeenCalledWith(POLL);
        expect(setSuccess).toHaveBeenCalledWith('Poll unpublished');
        expect(screen.getByText('Results not published yet')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'View Results' })).toBeNull();
        expect(setError).not.toHaveBeenCalled();
    });

    it('publishes even when the poll gives no results back', async () => {
        const user = setup();
        ownPoll();
        render(<PollTab />);
        await openPoll(user);
        await screen.findByText('Poll complete');

        await user.click(screen.getByRole('button', { name: 'Publish' }));

        expect(await screen.findByRole('button', { name: 'Unpublish' })).toBeInTheDocument();
        expect(keymaster.publishPoll).toHaveBeenCalledWith(POLL);
        expect(setSuccess).toHaveBeenCalledWith('Poll published');
        expect(setError).not.toHaveBeenCalled();
    });

    it('reports a failure to publish', async () => {
        const user = setup();
        const failure = new Error('not the owner');
        ownPoll();
        keymaster.publishPoll.mockRejectedValue(failure);
        render(<PollTab />);
        await openPoll(user);
        await screen.findByText('Poll complete');

        await user.click(screen.getByRole('button', { name: 'Publish' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(setSuccess).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: 'Publish' })).toBeInTheDocument();
        expect(screen.getByText('Results not published yet')).toBeInTheDocument();
    });

    it('reports a failure to unpublish and leaves the results published', async () => {
        const user = setup();
        const failure = new Error('not the owner');
        ownPoll();
        keymaster.viewPoll.mockResolvedValue({ isEligible: true, hasVoted: true, results: RESULTS });
        keymaster.unpublishPoll.mockRejectedValue(failure);
        render(<PollTab />);
        await openPoll(user);

        await user.click(await screen.findByRole('button', { name: 'Unpublish' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(screen.getByRole('button', { name: 'Unpublish' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'View Results' })).toBeInTheDocument();
    });
});

describe('renaming a poll', () => {
    async function rename(user: UserEvent, to: string) {
        await user.click(tipButton('Rename Poll'));
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByText('Rename \'lunch\' to:')).toBeInTheDocument();
        const field = within(dialog).getByLabelText('New Name');
        expect(field).toHaveValue('lunch');
        await user.clear(field);
        if (to) {
            await user.type(field, to);
        }
        await user.click(within(dialog).getByRole('button', { name: 'Rename' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    }

    it('gives the poll its new alias and drops the old one', async () => {
        const user = setup();
        walletData.refreshAliases.mockImplementation(async () => {
            variables.aliasList = { midday: POLL };
            variables.pollList = ['midday'];
        });
        render(<PollTab />);
        await openPoll(user);

        await rename(user, 'midday');

        await waitFor(() => expect(setSuccess).toHaveBeenCalledWith('Poll renamed'));
        expect(keymaster.addAlias).toHaveBeenCalledWith('midday', POLL);
        expect(keymaster.removeAlias).toHaveBeenCalledWith('lunch');
        expect(walletData.refreshAliases).toHaveBeenCalled();
        expect(pollPicker()).toHaveTextContent('midday');
        // The poll stays open under its new name.
        expect(screen.getByText('Where do we eat?')).toBeInTheDocument();
    });

    it('changes nothing when the name is left as it was or left empty', async () => {
        const user = setup();
        render(<PollTab />);
        await openPoll(user);

        await rename(user, 'lunch');
        await rename(user, '');

        expect(keymaster.addAlias).not.toHaveBeenCalled();
        expect(keymaster.removeAlias).not.toHaveBeenCalled();
        expect(setError).not.toHaveBeenCalled();
        expect(setSuccess).not.toHaveBeenCalled();
    });

    it('changes nothing when the rename is cancelled', async () => {
        const user = setup();
        render(<PollTab />);
        await openPoll(user);

        await user.click(tipButton('Rename Poll'));
        const dialog = await screen.findByRole('dialog');
        await user.type(within(dialog).getByLabelText('New Name'), '-two');
        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(keymaster.addAlias).not.toHaveBeenCalled();
    });

    it('reports a failure to rename and keeps the old name', async () => {
        const user = setup();
        const failure = new Error('invalid alias');
        keymaster.addAlias.mockRejectedValue(failure);
        render(<PollTab />);
        await openPoll(user);

        await rename(user, 'midday');

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(keymaster.removeAlias).not.toHaveBeenCalled();
        expect(setSuccess).not.toHaveBeenCalled();
        expect(pollPicker()).toHaveTextContent('lunch');
    });
});

describe('removing a poll', () => {
    async function askToRemove(user: UserEvent) {
        await user.click(tipButton('Delete Poll'));
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByText('Are you sure you want to remove \'lunch\'?')).toBeInTheDocument();
        return dialog;
    }

    it('drops the poll\'s alias once the removal is confirmed', async () => {
        const user = setup();
        render(<PollTab />);
        await openPoll(user);

        const dialog = await askToRemove(user);
        expect(keymaster.removeAlias).not.toHaveBeenCalled();
        await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));

        await waitFor(() => expect(setSuccess).toHaveBeenCalledWith('Removed \'lunch\''));
        expect(keymaster.removeAlias).toHaveBeenCalledWith('lunch');
        expect(walletData.refreshAliases).toHaveBeenCalled();
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(pollPicker()).toHaveTextContent('Select poll');
        expect(screen.queryByText('Where do we eat?')).toBeNull();
        expect(tipButton('Delete Poll')).toBeDisabled();
    });

    it('keeps the poll when the removal is cancelled', async () => {
        const user = setup();
        render(<PollTab />);
        await openPoll(user);

        const dialog = await askToRemove(user);
        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(keymaster.removeAlias).not.toHaveBeenCalled();
        expect(pollPicker()).toHaveTextContent('lunch');
    });

    it('reports a failure to remove, closes the question and keeps the poll open', async () => {
        const user = setup();
        const failure = new Error('wallet locked');
        keymaster.removeAlias.mockRejectedValue(failure);
        render(<PollTab />);
        await openPoll(user);

        const dialog = await askToRemove(user);
        await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(setSuccess).not.toHaveBeenCalled();
        expect(pollPicker()).toHaveTextContent('lunch');
        expect(screen.getByText('Where do we eat?')).toBeInTheDocument();
    });
});

describe('a tab left open when the wallet loses its keymaster', () => {
    function loseKeymaster(shown: { rerender: (ui: React.ReactElement) => void }) {
        wallet.keymaster = null;
        shown.rerender(<PollTab />);
        vi.clearAllMocks();
    }

    function expectNothingAsked() {
        for (const method of Object.values(keymaster)) {
            expect(method).not.toHaveBeenCalled();
        }
        expect(setError).not.toHaveBeenCalled();
        expect(setSuccess).not.toHaveBeenCalled();
    }

    it('asks nothing for a poll just created', async () => {
        const user = setup();
        const shown = render(<PollTab />);
        await createPoll(user);
        keymaster.listPollVoters.mockResolvedValue({ [BOB]: {} });
        await addVoter(user, BOB);
        await screen.findByText(BOB);
        await user.type(voterField(), CAROL);

        loseKeymaster(shown);
        await user.click(addVoterButton());
        await user.click(removeVoterButton(BOB));
        await user.click(sendButton());

        expectNothingAsked();
        expect(screen.getByText(BOB)).toBeInTheDocument();
        expect(sendButton()).toBeEnabled();
    });

    it('asks nothing for an open poll', async () => {
        const user = setup();
        const shown = render(<PollTab />);
        await openPoll(user);
        await user.click(screen.getByRole('button', { name: 'Vote' }));
        await screen.findByText(BALLOT);

        loseKeymaster(shown);
        await user.click(screen.getByRole('button', { name: 'Vote' }));
        await user.click(screen.getByRole('button', { name: 'Send Ballot' }));

        await user.click(tipButton('Delete Poll'));
        const removing = await screen.findByRole('dialog');
        await user.click(within(removing).getByRole('button', { name: 'Confirm' }));
        await user.click(within(removing).getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

        await user.click(tipButton('Rename Poll'));
        const renaming = await screen.findByRole('dialog', { name: 'Rename Poll' });
        await user.type(within(renaming).getByLabelText('New Name'), '-two');
        await user.click(within(renaming).getByRole('button', { name: 'Rename' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

        expectNothingAsked();
        expect(pollPicker()).toHaveTextContent('lunch');
    });

    it('asks nothing of a closed poll for its owner', async () => {
        const user = setup();
        ownPoll();
        keymaster.getPoll.mockResolvedValue(lunch(CLOSED_SINCE));
        const shown = render(<PollTab />);
        await openPoll(user);
        await screen.findByText('Poll complete');

        loseKeymaster(shown);
        await user.click(screen.getByRole('button', { name: 'Publish' }));
        await user.click(screen.getByRole('button', { name: 'View' }));

        expectNothingAsked();
        expect(screen.getByRole('button', { name: 'Publish' })).toBeInTheDocument();
    });

    it('opens no poll', async () => {
        const user = setup();
        wallet.keymaster = null;
        render(<PollTab />);

        await showPolls(user);
        await pickPoll(user);

        expectNothingAsked();
        expect(pollPicker()).toHaveTextContent('Select poll');
    });
});
