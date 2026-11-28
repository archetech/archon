import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import type { DmailItem } from '@didcid/keymaster/types';
import DmailTab from '../../../../packages/wallet-ui/src/components/DmailTab';
import DmailDialog from '../../../../packages/wallet-ui/src/components/DmailDialog';

// The Dmail tab files the wallet's messages into folders, shows one message at
// a time with the actions its folder allows, and composes a message as a draft
// that is created first and sent afterwards.

const { keymaster, wallet, variables, walletData, setError, setSuccess, openView } = vi.hoisted(() => {
    const keymaster = {
        fileDmail: vi.fn(), createDmail: vi.fn(), updateDmail: vi.fn(), sendDmail: vi.fn(), removeDmail: vi.fn(),
        importDmail: vi.fn(), revokeDID: vi.fn(), resolveDID: vi.fn(), refreshNotices: vi.fn(),
        getDmailMessage: vi.fn(), listDmailAttachments: vi.fn(), getDmailAttachment: vi.fn(),
        addDmailAttachment: vi.fn(), removeDmailAttachment: vi.fn(),
    };

    return {
        keymaster,
        wallet: { keymaster: keymaster as typeof keymaster | null },
        variables: {
            currentId: '',
            agentList: [] as string[] | null,
            dmailList: {} as Record<string, unknown>,
            registries: [] as string[],
        },
        walletData: { getVaultItemIcon: vi.fn(), refreshInbox: vi.fn(), handleCopyDID: vi.fn() },
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

const LUNCH = 'did:cid:lunch';
const HELLO = 'did:cid:hello';
const REPORT = 'did:cid:report';
const NOTE = 'did:cid:note';
const COPY = 'did:cid:copy';
const DRAFT = 'did:cid:draft';
const OLD = 'did:cid:old';
const SPAM = 'did:cid:spam';
const NEW = 'did:cid:new';
const STRANGER = 'did:cid:stranger';

const LUNCH_BODY = 'Shall we meet at noon?';
const CREATED = '2024-01-05T10:00:00Z';

function mail(
    sender: string,
    to: string[],
    cc: string[],
    subject: string,
    body: string,
    date: string,
    tags: string[],
    extra: Partial<DmailItem> = {},
): DmailItem {
    return {
        sender, to, cc, date, tags,
        message: { to: to.map(n => `did:cid:${n.toLowerCase()}`), cc: cc.map(n => `did:cid:${n.toLowerCase()}`), subject, body },
        ...extra,
    };
}

// Built anew for each test: the tab writes a draft's attachments back into the
// list it was given.
function mailbox(): Record<string, DmailItem> {
    const hello = mail(STRANGER, ['Alice'], [], 'Hello from afar', 'Greetings.', '2024-01-05T10:00:00Z', ['inbox']);
    hello.message.reference = REPORT;

    return {
        [LUNCH]: mail('Bob', ['Alice', 'Dave'], ['Carol'], 'Lunch plans', LUNCH_BODY, new Date().toISOString(), ['inbox', 'unread'], {
            attachments: { 'menu.pdf': { bytes: 2048 }, 'map.png': { bytes: 10 } },
        }),
        [HELLO]: hello,
        [REPORT]: mail('Alice', ['Bob'], [], 'Quarterly report', 'Numbers attached.', '2024-03-01T10:00:00Z', ['sent']),
        // Mail from the current identity to itself belongs in Sent whatever its tags say.
        [NOTE]: mail('Alice', ['Alice'], [], 'Note to self', 'Buy milk.', '2024-03-02T10:00:00Z', ['inbox']),
        [COPY]: mail('Alice', ['Bob'], ['Alice'], 'Copy for my records', 'As discussed.', '2024-03-03T10:00:00Z', []),
        [DRAFT]: mail('Alice', ['Bob'], ['Carol'], 'Unfinished thought', 'To be continued', '2024-04-01T10:00:00Z', ['draft']),
        [OLD]: mail('Bob', ['Alice'], [], 'Old news', 'Long ago.', '2023-06-01T10:00:00Z', ['inbox', 'archived']),
        [SPAM]: mail('Mallory', ['Alice'], [], 'You have won', 'Click here.', '2023-07-01T10:00:00Z', ['inbox', 'deleted']),
    };
}

beforeEach(() => {
    vi.resetAllMocks();
    wallet.keymaster = keymaster;
    variables.currentId = 'Alice';
    variables.agentList = ['Bob', 'Carol'];
    variables.dmailList = mailbox();
    variables.registries = ['hyperswarm', 'BTC:mainnet'];
    walletData.getVaultItemIcon.mockReturnValue(null);
    keymaster.resolveDID.mockResolvedValue({ didDocumentMetadata: { version: 1, created: CREATED } });
    keymaster.getDmailMessage.mockResolvedValue(null);
    keymaster.listDmailAttachments.mockResolvedValue({});
});

const folder = (user: UserEvent, name: string) => user.click(screen.getByRole('tab', { name }));

// Opens a message from the list and waits until the tab has finished reading
// its history, so that nothing is still arriving when the test goes on.
async function open(user: UserEvent, subject: string) {
    const lookups = keymaster.resolveDID.mock.calls.length;
    await user.click(screen.getByText(subject));
    await screen.findByRole('button', { name: 'Back' });
    await waitFor(() => expect(keymaster.resolveDID.mock.calls.length).toBeGreaterThan(lookups));
}

const toField = () => screen.getByLabelText('Recipient (name or DID)');
const ccField = () => screen.getByLabelText('CC (optional)');
const subjectField = () => screen.getByLabelText('Subject');
const bodyField = () => screen.getByLabelText('Message body');
const addTo = () => screen.getAllByRole('button', { name: 'Add' })[0];
const addCc = () => screen.getAllByRole('button', { name: 'Add' })[1];
// The two recipient fields are comboboxes too; the registry picker comes last.
const registryPicker = () => screen.getAllByRole('combobox')[2];
const fileInput = () => document.getElementById('attachmentUpload') as HTMLInputElement;
// A listed recipient or attachment sits in a row with its one button.
const buttonBeside = (text: string) => within(screen.getByText(text).parentElement as HTMLElement).getByRole('button');

async function write(user: UserEvent, to = 'Bob', subject = 'Greetings', body = 'How are you?') {
    await folder(user, 'Compose');
    await user.type(toField(), to);
    await user.type(subjectField(), subject);
    await user.type(bodyField(), body);
}

async function createDraft(user: UserEvent) {
    keymaster.createDmail.mockResolvedValue(NEW);
    await write(user);
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(setSuccess).toHaveBeenCalledWith(`Draft created ${NEW}`));
    await waitFor(() => expect(keymaster.listDmailAttachments).toHaveBeenCalledWith(NEW));
}

async function editDraft(user: UserEvent) {
    await folder(user, 'Drafts');
    await open(user, 'Unfinished thought');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await screen.findByText(DRAFT);
}

async function pickFromMore(user: UserEvent, name: string) {
    await user.click(screen.getByRole('button', { name: 'More' }));
    await user.click(await screen.findByRole('menuitem', { name }));
}

describe('folders', () => {
    it('opens on the inbox, newest first, and asks for the mailbox to be read', () => {
        render(<DmailTab />);

        expect(screen.getByRole('heading', { name: 'DMail' })).toBeInTheDocument();
        expect(screen.getByRole('tab', { name: 'Inbox' })).toHaveAttribute('aria-selected', 'true');
        expect(walletData.refreshInbox).toHaveBeenCalled();

        const subjects = ['Lunch plans', 'Note to self', 'Hello from afar'].map(s => screen.getByText(s));
        expect(subjects[0].compareDocumentPosition(subjects[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(subjects[1].compareDocumentPosition(subjects[2]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(screen.getByText(STRANGER)).toBeInTheDocument();
        expect(screen.queryByText('Old news')).toBeNull();
        expect(screen.queryByText('You have won')).toBeNull();
        expect(screen.queryByText('Quarterly report')).toBeNull();
    });

    it('dates a message from today by its time and an older one by its day', () => {
        const today = (variables.dmailList[LUNCH] as DmailItem).date;
        render(<DmailTab />);

        expect(screen.getByText(new Date(today).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))).toBeInTheDocument();
        expect(screen.getByText(new Date('2024-01-05T10:00:00Z').toLocaleDateString())).toBeInTheDocument();
    });

    it.each([
        ['Sent', ['Quarterly report', 'Note to self', 'Copy for my records']],
        ['Drafts', ['Unfinished thought']],
        ['Archive', ['Old news']],
        ['Trash', ['You have won']],
        ['All', [
            'Lunch plans', 'Hello from afar', 'Quarterly report', 'Note to self', 'Copy for my records',
            'Unfinished thought', 'Old news', 'You have won',
        ]],
    ])('lists in %s only the messages that belong there', async (name, expected) => {
        const user = userEvent.setup({ delay: null });
        render(<DmailTab />);

        await folder(user, name);

        const all = Object.values(variables.dmailList as Record<string, DmailItem>).map(item => item.message.subject);
        for (const subject of all) {
            if (expected.includes(subject)) {
                expect(screen.getByText(subject)).toBeInTheDocument();
            } else {
                expect(screen.queryByText(subject)).toBeNull();
            }
        }
    });

    it('keeps a self-addressed message out of Sent when nobody is signed in', async () => {
        const user = userEvent.setup({ delay: null });
        variables.currentId = '';
        render(<DmailTab />);

        await folder(user, 'Sent');

        expect(screen.getByText('Quarterly report')).toBeInTheDocument();
        expect(screen.queryByText('Note to self')).toBeNull();
    });

    it.each([
        ['Inbox', 'Your inbox is empty.'],
        ['Sent', 'No sent mail yet.'],
        ['Drafts', 'No drafts saved.'],
        ['Archive', 'No archived mail.'],
        ['Trash', 'Trash is empty.'],
        ['All', 'No messages to show.'],
    ])('says so when %s has nothing in it', async (name, text) => {
        const user = userEvent.setup({ delay: null });
        variables.dmailList = {};
        render(<DmailTab />);

        await folder(user, name);

        expect(screen.getByText(text)).toBeInTheDocument();
    });

    it('goes back to the list when another folder is picked', async () => {
        const user = userEvent.setup({ delay: null });
        render(<DmailTab />);
        await open(user, 'Hello from afar');

        await folder(user, 'All');

        expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
        expect(screen.getByText('Lunch plans')).toBeInTheDocument();
    });
});

describe('reading a message', () => {
    it('shows who it is from and to, when it was made, and what it says', async () => {
        const user = userEvent.setup({ delay: null });
        render(<DmailTab />);

        await open(user, 'Lunch plans');

        expect(screen.getByText(LUNCH)).toBeInTheDocument();
        expect(screen.getByText('did:cid:alice, did:cid:dave')).toBeInTheDocument();
        expect(screen.getByText('did:cid:carol')).toBeInTheDocument();
        expect(screen.getByText('Bob')).toBeInTheDocument();
        expect(screen.getByText('Lunch plans')).toBeInTheDocument();
        expect(screen.getAllByDisplayValue(LUNCH_BODY)[0]).toHaveAttribute('readonly');
        expect(await screen.findByText(new Date(CREATED).toLocaleString())).toBeInTheDocument();
        expect(keymaster.resolveDID).toHaveBeenCalledWith(LUNCH);
        expect(screen.queryByText('Updated:')).toBeNull();
        expect(screen.queryByText('Reference:')).toBeNull();
        // The list gives way to the message.
        expect(screen.queryByText('Hello from afar')).toBeNull();
        expect(setError).not.toHaveBeenCalled();
    });

    it('marks an unread message as read', async () => {
        const user = userEvent.setup({ delay: null });
        render(<DmailTab />);
        walletData.refreshInbox.mockClear();

        await open(user, 'Lunch plans');

        await waitFor(() => expect(keymaster.fileDmail).toHaveBeenCalledWith(LUNCH, ['inbox']));
        await waitFor(() => expect(walletData.refreshInbox).toHaveBeenCalled());
    });

    it('leaves the tags of a message that was already read', async () => {
        const user = userEvent.setup({ delay: null });
        render(<DmailTab />);

        await open(user, 'Hello from afar');

        expect(keymaster.fileDmail).not.toHaveBeenCalled();
    });

    it('returns to the list with Back', async () => {
        const user = userEvent.setup({ delay: null });
        render(<DmailTab />);
        await open(user, 'Hello from afar');

        await user.click(screen.getByRole('button', { name: 'Back' }));

        expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
        expect(screen.getByText('Lunch plans')).toBeInTheDocument();
    });

    it('shows the latest text of a message the node has', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.getDmailMessage.mockResolvedValue({ to: ['did:cid:zed'], cc: [], subject: 'Lunch plans, corrected', body: 'One o\'clock.' });
        keymaster.listDmailAttachments.mockResolvedValue({ 'table.txt': { bytes: 7 } });
        render(<DmailTab />);

        await open(user, 'Lunch plans');

        expect(await screen.findByText('Lunch plans, corrected')).toBeInTheDocument();
        expect(screen.getByText('did:cid:zed')).toBeInTheDocument();
        expect(screen.getByText('table.txt')).toBeInTheDocument();
        expect(screen.queryByText('menu.pdf')).toBeNull();
        expect(keymaster.getDmailMessage).toHaveBeenCalledWith(LUNCH);
    });

    it('falls back on the time of the last update when no creation time is recorded', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.resolveDID.mockResolvedValue({ didDocumentMetadata: { updated: '2024-02-02T08:00:00Z' } });
        render(<DmailTab />);

        await open(user, 'Hello from afar');

        expect(await screen.findByText(new Date('2024-02-02T08:00:00Z').toLocaleString())).toBeInTheDocument();
    });

    it('reports a message whose history cannot be read', async () => {
        const user = userEvent.setup({ delay: null });
        const failure = new Error('unknown DID');
        keymaster.resolveDID.mockRejectedValue(failure);
        render(<DmailTab />);

        await open(user, 'Hello from afar');

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        // What the list already held is still shown.
        expect(screen.getAllByDisplayValue('Greetings.')[0]).toBeInTheDocument();
    });

    it('offers to add a sender known only by DID as a contact', async () => {
        const user = userEvent.setup({ delay: null });
        render(<DmailTab />);
        await open(user, 'Hello from afar');

        await user.click(screen.getByRole('button', { name: 'Add contact' }));

        expect(openView).toHaveBeenCalledWith({ did: STRANGER, tab: 'aliases' });
    });

    it('does not offer to add a sender who already has a name', async () => {
        const user = userEvent.setup({ delay: null });
        render(<DmailTab />);

        await open(user, 'Lunch plans');

        expect(screen.queryByRole('button', { name: 'Add contact' })).toBeNull();
    });

    it('opens the message that a message refers to', async () => {
        const user = userEvent.setup({ delay: null });
        render(<DmailTab />);
        await open(user, 'Hello from afar');
        expect(screen.getByText(REPORT)).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Open referenced message' }));

        expect(await screen.findByText('Quarterly report')).toBeInTheDocument();
        expect(screen.getAllByDisplayValue('Numbers attached.')[0]).toBeInTheDocument();
        await waitFor(() => expect(keymaster.resolveDID).toHaveBeenCalledWith(REPORT));
        expect(setError).not.toHaveBeenCalled();
    });

    it('says so when the message referred to is not in the mailbox', async () => {
        const user = userEvent.setup({ delay: null });
        delete variables.dmailList[REPORT];
        render(<DmailTab />);
        await open(user, 'Hello from afar');

        await user.click(screen.getByRole('button', { name: 'Open referenced message' }));

        expect(setError).toHaveBeenCalledWith(`Referenced message not found: ${REPORT}`);
        expect(screen.getByText('Hello from afar')).toBeInTheDocument();
    });
});

describe('versions of a message', () => {
    const original = { to: ['did:cid:alice'], cc: [], subject: 'Lunch plans, first wording', body: 'Eleven?' };
    const latest = { to: ['did:cid:alice'], cc: [], subject: 'Lunch plans, second wording', body: 'Noon.' };

    // The document's first version is the empty message, so the versions a
    // reader is offered are one fewer and start at the document's second.
    beforeEach(() => {
        keymaster.resolveDID.mockImplementation(async (_did: string, options?: { versionSequence: number }) => (
            options
                ? { didDocumentMetadata: { created: CREATED, updated: '2024-01-06T09:00:00Z' } }
                : { didDocumentMetadata: { version: 3, created: CREATED, updated: '2024-01-07T09:00:00Z' } }
        ));
        keymaster.getDmailMessage.mockImplementation(async (_did: string, options?: { versionSequence: number }) => (
            options ? original : latest
        ));
    });

    it('shows the last version and when it was updated', async () => {
        const user = userEvent.setup({ delay: null });
        render(<DmailTab />);

        await open(user, 'Lunch plans');

        expect(await screen.findByText('Lunch plans, second wording')).toBeInTheDocument();
        expect(screen.getByRole('combobox')).toHaveTextContent('version 2');
        expect(screen.getByText(new Date('2024-01-07T09:00:00Z').toLocaleString())).toBeInTheDocument();
        expect(await screen.findByText(new Date(CREATED).toLocaleString())).toBeInTheDocument();
        expect(keymaster.resolveDID).toHaveBeenCalledWith(LUNCH, { versionSequence: 2 });
    });

    it('shows an earlier version when one is picked', async () => {
        const user = userEvent.setup({ delay: null });
        render(<DmailTab />);
        await open(user, 'Lunch plans');
        await screen.findByText('Lunch plans, second wording');
        keymaster.listDmailAttachments.mockResolvedValue({ 'first.txt': { bytes: 3 } });

        await user.click(screen.getByRole('combobox'));
        await user.click(await screen.findByRole('option', { name: 'version 1' }));

        expect(await screen.findByText('Lunch plans, first wording')).toBeInTheDocument();
        expect(screen.getByText('first.txt')).toBeInTheDocument();
        expect(screen.getByRole('combobox')).toHaveTextContent('version 1');
        expect(screen.getByText(new Date('2024-01-06T09:00:00Z').toLocaleString())).toBeInTheDocument();
        expect(keymaster.getDmailMessage).toHaveBeenCalledWith(LUNCH, { versionSequence: 2 });
        expect(keymaster.listDmailAttachments).toHaveBeenCalledWith(LUNCH, { versionSequence: 2 });
    });

    it('keeps what is shown when a version has no message', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.getDmailMessage.mockImplementation(async (_did: string, options?: unknown) => (options ? null : latest));
        render(<DmailTab />);
        await open(user, 'Lunch plans');
        await screen.findByText('Lunch plans, second wording');

        await user.click(screen.getByRole('combobox'));
        await user.click(await screen.findByRole('option', { name: 'version 1' }));

        await waitFor(() => expect(keymaster.getDmailMessage).toHaveBeenCalledWith(LUNCH, { versionSequence: 2 }));
        expect(screen.getByText('Lunch plans, second wording')).toBeInTheDocument();
        expect(setError).not.toHaveBeenCalled();
    });

    it('reports a version that cannot be read', async () => {
        const user = userEvent.setup({ delay: null });
        const failure = new Error('no such version');
        // The tab logs the failure as well as reporting it.
        const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        render(<DmailTab />);
        await open(user, 'Lunch plans');
        await screen.findByText('Lunch plans, second wording');
        keymaster.getDmailMessage.mockRejectedValue(failure);

        await user.click(screen.getByRole('combobox'));
        await user.click(await screen.findByRole('option', { name: 'version 1' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(logged).toHaveBeenCalled();
        logged.mockRestore();
    });
});

describe('attachments of a received message', () => {
    let downloads: string[];

    // jsdom has no object URLs and follows no link.
    beforeEach(() => {
        downloads = [];
        Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:attachment'), revokeObjectURL: vi.fn() });
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
            downloads.push(this.download);
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        Reflect.deleteProperty(URL, 'createObjectURL');
        Reflect.deleteProperty(URL, 'revokeObjectURL');
    });

    const download = (name: string) => buttonBeside(name);

    it('lists each attachment with its size', async () => {
        const user = userEvent.setup({ delay: null });
        render(<DmailTab />);

        await open(user, 'Lunch plans');

        expect(screen.getByText('menu.pdf')).toBeInTheDocument();
        expect(screen.getByText('2048 bytes')).toBeInTheDocument();
        expect(screen.getByText('map.png')).toBeInTheDocument();
        expect(walletData.getVaultItemIcon).toHaveBeenCalledWith('menu.pdf', { bytes: 2048 });
    });

    it('shows no attachments for a message without any', async () => {
        const user = userEvent.setup({ delay: null });
        render(<DmailTab />);

        await open(user, 'Hello from afar');

        expect(screen.queryByText('Attachments:')).toBeNull();
    });

    it('downloads an attachment under its own name', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.getDmailAttachment.mockResolvedValue(Buffer.from('menu'));
        render(<DmailTab />);
        await open(user, 'Lunch plans');

        await user.click(download('menu.pdf'));

        await waitFor(() => expect(downloads).toEqual(['menu.pdf']));
        expect(keymaster.getDmailAttachment).toHaveBeenCalledWith(LUNCH, 'menu.pdf');
        expect(URL.revokeObjectURL).toHaveBeenCalled();
        expect(setError).not.toHaveBeenCalled();
    });

    it('says so when the attachment is not there', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.getDmailAttachment.mockResolvedValue(null);
        render(<DmailTab />);
        await open(user, 'Lunch plans');

        await user.click(download('menu.pdf'));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(`Attachment menu.pdf not found in DMail ${LUNCH}`));
        expect(downloads).toEqual([]);
    });

    it('reports a failure to fetch the attachment', async () => {
        const user = userEvent.setup({ delay: null });
        const failure = new Error('vault unreachable');
        keymaster.getDmailAttachment.mockRejectedValue(failure);
        render(<DmailTab />);
        await open(user, 'Lunch plans');

        await user.click(download('map.png'));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(downloads).toEqual([]);
    });
});

describe('filing a message', () => {
    const actions = (...names: string[]) => names.map(name => screen.queryByRole('button', { name }));

    it('archives a message from the inbox', async () => {
        const user = userEvent.setup({ delay: null });
        render(<DmailTab />);
        await open(user, 'Hello from afar');
        walletData.refreshInbox.mockClear();

        await user.click(screen.getByRole('button', { name: 'Archive' }));

        await waitFor(() => expect(keymaster.fileDmail).toHaveBeenCalledWith(HELLO, ['inbox', 'archived']));
        await waitFor(() => expect(walletData.refreshInbox).toHaveBeenCalled());
        expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    });

    it('deletes a message from the inbox', async () => {
        const user = userEvent.setup({ delay: null });
        render(<DmailTab />);
        await open(user, 'Hello from afar');

        await user.click(screen.getByRole('button', { name: 'Delete' }));

        await waitFor(() => expect(keymaster.fileDmail).toHaveBeenCalledWith(HELLO, ['inbox', 'deleted']));
        expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    });

    it('offers a sent message to edit, archive or delete, and no reply', async () => {
        const user = userEvent.setup({ delay: null });
        render(<DmailTab />);
        await folder(user, 'Sent');
        await open(user, 'Quarterly report');

        expect(actions('Edit', 'Archive', 'Delete').every(Boolean)).toBe(true);
        expect(actions('Reply', 'Reply all', 'Forward', 'Unarchive', 'Restore').some(Boolean)).toBe(false);

        await user.click(screen.getByRole('button', { name: 'Archive' }));

        await waitFor(() => expect(keymaster.fileDmail).toHaveBeenCalledWith(REPORT, ['sent', 'archived']));
    });

    it('deletes a draft', async () => {
        const user = userEvent.setup({ delay: null });
        render(<DmailTab />);
        await folder(user, 'Drafts');
        await open(user, 'Unfinished thought');

        await user.click(screen.getByRole('button', { name: 'Delete' }));

        await waitFor(() => expect(keymaster.fileDmail).toHaveBeenCalledWith(DRAFT, ['draft', 'deleted']));
    });

    it('takes a message back out of the archive', async () => {
        const user = userEvent.setup({ delay: null });
        render(<DmailTab />);
        await folder(user, 'Archive');
        await open(user, 'Old news');
        expect(actions('Edit', 'Archive', 'Reply', 'Restore').some(Boolean)).toBe(false);

        await user.click(screen.getByRole('button', { name: 'Unarchive' }));

        await waitFor(() => expect(keymaster.fileDmail).toHaveBeenCalledWith(OLD, ['inbox']));
        expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    });

    it('deletes an archived message', async () => {
        const user = userEvent.setup({ delay: null });
        render(<DmailTab />);
        await folder(user, 'Archive');
        await open(user, 'Old news');

        await user.click(screen.getByRole('button', { name: 'Delete' }));

        await waitFor(() => expect(keymaster.fileDmail).toHaveBeenCalledWith(OLD, ['inbox', 'archived', 'deleted']));
    });

    it('restores a message from the trash', async () => {
        const user = userEvent.setup({ delay: null });
        render(<DmailTab />);
        await folder(user, 'Trash');
        await open(user, 'You have won');
        expect(actions('Edit', 'Archive', 'Delete', 'Reply').some(Boolean)).toBe(false);

        await user.click(screen.getByRole('button', { name: 'Restore' }));

        await waitFor(() => expect(keymaster.fileDmail).toHaveBeenCalledWith(SPAM, ['inbox']));
        expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    });

    it('offers nothing to do with a message opened from All', async () => {
        const user = userEvent.setup({ delay: null });
        render(<DmailTab />);
        await folder(user, 'All');
        await open(user, 'Old news');

        expect(actions('Edit', 'Archive', 'Delete', 'Reply', 'Reply all', 'Forward', 'Unarchive', 'Restore').some(Boolean)).toBe(false);
    });
});

describe('replying and forwarding', () => {
    it('starts a reply to the sender that refers to the message', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.createDmail.mockResolvedValue(NEW);
        render(<DmailTab />);
        await open(user, 'Lunch plans');

        await user.click(screen.getByRole('button', { name: 'Reply' }));

        expect(screen.getByRole('tab', { name: 'Compose' })).toHaveAttribute('aria-selected', 'true');
        expect(screen.getByText('Bob')).toBeInTheDocument();
        expect(screen.queryByText('Carol')).toBeNull();
        expect(subjectField()).toHaveValue('Re: Lunch plans');
        expect(bodyField()).toHaveValue(`\n\n----- Original message -----\n${LUNCH_BODY}`);

        await user.click(screen.getByRole('button', { name: 'Create' }));

        await waitFor(() => expect(keymaster.createDmail).toHaveBeenCalledWith({
            to: ['Bob'],
            cc: [],
            subject: 'Re: Lunch plans',
            body: `\n\n----- Original message -----\n${LUNCH_BODY}`,
            reference: LUNCH,
        }, { registry: 'hyperswarm' }));
    });

    it('copies a reply to all to everyone else the message went to', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.createDmail.mockResolvedValue(NEW);
        render(<DmailTab />);
        await open(user, 'Lunch plans');

        await user.click(screen.getByRole('button', { name: 'Reply all' }));
        await user.click(screen.getByRole('button', { name: 'Create' }));

        await waitFor(() => expect(keymaster.createDmail).toHaveBeenCalled());
        expect(keymaster.createDmail.mock.calls[0][0]).toMatchObject({
            to: ['Bob'],
            cc: ['Alice', 'Dave', 'Carol'],
            reference: LUNCH,
        });
    });

    it('forwards a message with the attachments it can still fetch', async () => {
        const user = userEvent.setup({ delay: null });
        const menu = Buffer.from('menu');
        keymaster.createDmail.mockResolvedValue(NEW);
        keymaster.getDmailAttachment.mockImplementation(async (_did: string, name: string) => (name === 'menu.pdf' ? menu : null));
        render(<DmailTab />);
        await open(user, 'Lunch plans');

        await user.click(screen.getByRole('button', { name: 'Forward' }));

        expect(subjectField()).toHaveValue('Fwd: Lunch plans');
        expect(bodyField()).toHaveValue(`\n\n----- Forwarded message -----\n${LUNCH_BODY}`);
        expect(screen.getByText('menu.pdf')).toBeInTheDocument();
        expect(screen.getByText('map.png')).toBeInTheDocument();
        // Nobody to send it to yet, and nothing to take an attachment off.
        expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
        expect(buttonBeside('menu.pdf')).toBeDisabled();

        await user.type(toField(), 'Carol');
        await user.click(screen.getByRole('button', { name: 'Create' }));

        await waitFor(() => expect(setSuccess).toHaveBeenCalledWith(`Draft created ${NEW}`));
        expect(keymaster.createDmail).toHaveBeenCalledWith({
            to: ['Carol'],
            cc: [],
            subject: 'Fwd: Lunch plans',
            body: `\n\n----- Forwarded message -----\n${LUNCH_BODY}`,
        }, { registry: 'hyperswarm' });
        expect(keymaster.createDmail.mock.calls[0][0].reference).toBeUndefined();
        expect(keymaster.getDmailAttachment).toHaveBeenCalledWith(LUNCH, 'menu.pdf');
        expect(keymaster.getDmailAttachment).toHaveBeenCalledWith(LUNCH, 'map.png');
        expect(keymaster.addDmailAttachment).toHaveBeenCalledTimes(1);
        expect(keymaster.addDmailAttachment).toHaveBeenCalledWith(NEW, 'menu.pdf', menu);
    });

    it('keeps the attachments of a message forwarded while a draft was open', async () => {
        const user = userEvent.setup({ delay: null });
        const menu = Buffer.from('menu');
        const map = Buffer.from('map');
        keymaster.createDmail.mockResolvedValue(NEW);
        keymaster.getDmailAttachment.mockImplementation(async (_did: string, name: string) => (name === 'menu.pdf' ? menu : map));
        render(<DmailTab />);
        await editDraft(user);
        await folder(user, 'Inbox');
        await open(user, 'Lunch plans');

        await user.click(screen.getByRole('button', { name: 'Forward' }));

        expect(await screen.findByText('menu.pdf')).toBeInTheDocument();
        expect(screen.getByText('map.png')).toBeInTheDocument();

        await user.type(toField(), 'Carol');
        await user.click(screen.getByRole('button', { name: 'Create' }));

        await waitFor(() => expect(setSuccess).toHaveBeenCalledWith(`Draft created ${NEW}`));
        expect(keymaster.addDmailAttachment).toHaveBeenCalledTimes(2);
        expect(keymaster.addDmailAttachment).toHaveBeenCalledWith(NEW, 'menu.pdf', menu);
        expect(keymaster.addDmailAttachment).toHaveBeenCalledWith(NEW, 'map.png', map);
    });

    it('starts a reply without the attachments of a forward that was left unsent', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.createDmail.mockResolvedValue(NEW);
        keymaster.getDmailAttachment.mockResolvedValue(Buffer.from('menu'));
        render(<DmailTab />);
        await open(user, 'Lunch plans');
        await user.click(screen.getByRole('button', { name: 'Forward' }));
        expect(screen.getByText('menu.pdf')).toBeInTheDocument();

        await folder(user, 'Inbox');
        await open(user, 'Hello from afar');
        await user.click(screen.getByRole('button', { name: 'Reply' }));

        expect(subjectField()).toHaveValue('Re: Hello from afar');
        expect(screen.queryByText('menu.pdf')).toBeNull();
        expect(screen.queryByText('map.png')).toBeNull();

        await user.click(screen.getByRole('button', { name: 'Create' }));

        await waitFor(() => expect(setSuccess).toHaveBeenCalledWith(`Draft created ${NEW}`));
        expect(keymaster.getDmailAttachment).not.toHaveBeenCalled();
        expect(keymaster.addDmailAttachment).not.toHaveBeenCalled();
    });

    it('copies nothing from a forward that was left unsent into a draft being edited', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.createDmail.mockResolvedValue(NEW);
        keymaster.getDmailAttachment.mockResolvedValue(Buffer.from('menu'));
        keymaster.listDmailAttachments.mockImplementation(async (did: string) => (
            did === DRAFT ? { 'menu.pdf': { bytes: 4 } } : {}
        ));
        render(<DmailTab />);
        await open(user, 'Lunch plans');
        await user.click(screen.getByRole('button', { name: 'Forward' }));

        await editDraft(user);
        await user.click(screen.getByRole('button', { name: 'Create' }));

        await waitFor(() => expect(setSuccess).toHaveBeenCalledWith(`Draft created ${NEW}`));
        expect(keymaster.getDmailAttachment).not.toHaveBeenCalledWith(LUNCH, expect.anything());
        expect(keymaster.addDmailAttachment).not.toHaveBeenCalled();
    });
});

describe('composing a message', () => {
    it('offers Create only once there is a recipient, a subject and a body', async () => {
        const user = userEvent.setup({ delay: null });
        render(<DmailTab />);
        await folder(user, 'Compose');
        const create = screen.getByRole('button', { name: 'Create' });

        expect(create).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Add attachment' })).toHaveAttribute('aria-disabled', 'true');

        await user.type(toField(), 'Bob');
        expect(create).toBeDisabled();
        await user.type(subjectField(), 'Greetings');
        expect(create).toBeDisabled();
        await user.type(bodyField(), 'How are you?');
        expect(create).toBeEnabled();
    });

    it('adds a recipient once, without the spaces around it, and takes one off again', async () => {
        const user = userEvent.setup({ delay: null });
        render(<DmailTab />);
        await folder(user, 'Compose');
        expect(addTo()).toBeDisabled();

        await user.type(toField(), '  Alice Smith ');
        await user.click(addTo());

        expect(screen.getByText('Alice Smith')).toBeInTheDocument();
        expect(toField()).toHaveValue('');
        expect(addTo()).toBeDisabled();

        await user.type(toField(), 'Alice Smith');
        await user.click(addTo());
        expect(screen.getAllByText('Alice Smith')).toHaveLength(1);

        await user.click(buttonBeside('Alice Smith'));
        expect(screen.queryByText('Alice Smith')).toBeNull();
    });

    it('adds and removes a copy recipient the same way', async () => {
        const user = userEvent.setup({ delay: null });
        render(<DmailTab />);
        await folder(user, 'Compose');
        expect(addCc()).toBeDisabled();

        await user.type(ccField(), ' Carol ');
        await user.click(addCc());
        await user.type(ccField(), 'Carol');
        await user.click(addCc());

        expect(screen.getAllByText('Carol')).toHaveLength(1);
        expect(ccField()).toHaveValue('');

        await user.click(buttonBeside('Carol'));
        expect(screen.queryByText('Carol')).toBeNull();
    });

    it('does not offer a spaces-only recipient to add', async () => {
        const user = userEvent.setup({ delay: null });
        render(<DmailTab />);
        await folder(user, 'Compose');

        await user.type(toField(), '   ');

        expect(addTo()).toBeDisabled();
    });

    it('creates a draft for the listed and the typed recipients', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.createDmail.mockResolvedValue(NEW);
        render(<DmailTab />);
        await folder(user, 'Compose');
        await user.type(toField(), 'Bob');
        await user.click(addTo());
        await user.type(toField(), ' did:cid:dave ');
        await user.type(ccField(), 'Carol');
        await user.click(addCc());
        await user.type(subjectField(), 'Greetings');
        await user.type(bodyField(), 'How are you?');

        await user.click(screen.getByRole('button', { name: 'Create' }));

        await waitFor(() => expect(setSuccess).toHaveBeenCalledWith(`Draft created ${NEW}`));
        expect(keymaster.createDmail).toHaveBeenCalledWith({
            to: ['did:cid:dave', 'Bob'],
            cc: ['Carol'],
            subject: 'Greetings',
            body: 'How are you?',
        }, { registry: 'hyperswarm' });
        expect(await screen.findByText(NEW)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
        expect(screen.getByRole('button', { name: 'Save draft' })).toBeEnabled();
        expect(keymaster.getDmailAttachment).not.toHaveBeenCalled();
        expect(setError).not.toHaveBeenCalled();
    });

    it('creates the draft on the registry picked', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.createDmail.mockResolvedValue(NEW);
        render(<DmailTab />);
        await write(user);

        await user.click(registryPicker());
        await user.click(await screen.findByRole('option', { name: 'BTC:mainnet' }));
        await user.click(screen.getByRole('button', { name: 'Create' }));

        await waitFor(() => expect(keymaster.createDmail).toHaveBeenCalledWith(
            expect.objectContaining({ to: ['Bob'] }),
            { registry: 'BTC:mainnet' },
        ));
    });

    it('reports a draft that cannot be created', async () => {
        const user = userEvent.setup({ delay: null });
        const failure = new Error('unknown recipient');
        keymaster.createDmail.mockRejectedValue(failure);
        render(<DmailTab />);
        await write(user);

        await user.click(screen.getByRole('button', { name: 'Create' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(setSuccess).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    });

    it('keeps what was written when the folder is left and come back to', async () => {
        const user = userEvent.setup({ delay: null });
        render(<DmailTab />);
        await write(user);

        await folder(user, 'Inbox');
        await folder(user, 'Compose');

        expect(subjectField()).toHaveValue('Greetings');
        expect(bodyField()).toHaveValue('How are you?');
    });
});

describe('a message that expires', () => {
    const expires = () => screen.getByLabelText('Expires');
    const ephemeral = () => screen.getByRole('checkbox', { name: 'Ephemeral' });

    it('is created valid until the time chosen', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.createDmail.mockResolvedValue(NEW);
        render(<DmailTab />);
        await write(user);
        expect(expires()).toBeDisabled();

        await user.click(ephemeral());
        expect(expires()).toBeEnabled();
        fireEvent.change(expires(), { target: { value: '2099-01-01T12:00' } });
        await user.click(screen.getByRole('button', { name: 'Create' }));

        await waitFor(() => expect(keymaster.createDmail).toHaveBeenCalledWith(
            expect.objectContaining({ subject: 'Greetings' }),
            { registry: 'hyperswarm', validUntil: new Date('2099-01-01T12:00').toISOString() },
        ));
    });

    it('needs a time to expire at', async () => {
        const user = userEvent.setup({ delay: null });
        render(<DmailTab />);
        await write(user);

        await user.click(ephemeral());
        await user.click(screen.getByRole('button', { name: 'Create' }));

        expect(setError).toHaveBeenCalledWith('Choose a future expiration date');
        expect(keymaster.createDmail).not.toHaveBeenCalled();
    });

    it('refuses a time that has passed', async () => {
        const user = userEvent.setup({ delay: null });
        render(<DmailTab />);
        await write(user);

        await user.click(ephemeral());
        fireEvent.change(expires(), { target: { value: '2001-01-01T12:00' } });
        await user.click(screen.getByRole('button', { name: 'Create' }));

        expect(setError).toHaveBeenCalledWith('Choose a future expiration date');
        expect(keymaster.createDmail).not.toHaveBeenCalled();
    });

    it('is offered only on hyperswarm', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.createDmail.mockResolvedValue(NEW);
        render(<DmailTab />);
        await write(user);
        await user.click(ephemeral());
        fireEvent.change(expires(), { target: { value: '2099-01-01T12:00' } });

        await user.click(registryPicker());
        await user.click(await screen.findByRole('option', { name: 'BTC:mainnet' }));

        await waitFor(() => expect(ephemeral()).not.toBeChecked());
        expect(ephemeral()).toBeDisabled();
        expect(expires()).toBeDisabled();
        expect(expires()).toHaveValue('');

        await user.click(screen.getByRole('button', { name: 'Create' }));

        await waitFor(() => expect(keymaster.createDmail).toHaveBeenCalledWith(expect.anything(), { registry: 'BTC:mainnet' }));
    });
});

describe('sending a draft', () => {
    it('sends the draft and reads the mailbox again', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.sendDmail.mockResolvedValue(true);
        render(<DmailTab />);
        await createDraft(user);
        walletData.refreshInbox.mockClear();

        await user.click(screen.getByRole('button', { name: 'Send' }));

        await waitFor(() => expect(setSuccess).toHaveBeenCalledWith('DMail sent'));
        expect(keymaster.sendDmail).toHaveBeenCalledWith(NEW);
        await waitFor(() => expect(walletData.refreshInbox).toHaveBeenCalled());
        expect(setError).not.toHaveBeenCalled();
    });

    it('says so when the draft is not sent', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.sendDmail.mockResolvedValue(false);
        render(<DmailTab />);
        await createDraft(user);

        await user.click(screen.getByRole('button', { name: 'Send' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith('DMail send failed'));
        expect(setSuccess).not.toHaveBeenCalledWith('DMail sent');
    });

    it('reports a failure to send', async () => {
        const user = userEvent.setup({ delay: null });
        const failure = new Error('recipient unreachable');
        keymaster.sendDmail.mockRejectedValue(failure);
        render(<DmailTab />);
        await createDraft(user);

        await user.click(screen.getByRole('button', { name: 'Send' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
    });
});

describe('editing a draft', () => {
    it('fills the form from the draft', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.listDmailAttachments.mockResolvedValue({ 'notes.txt': { bytes: 5 } });
        render(<DmailTab />);

        await editDraft(user);

        expect(screen.getByRole('tab', { name: 'Compose' })).toHaveAttribute('aria-selected', 'true');
        expect(screen.getByText('Bob')).toBeInTheDocument();
        expect(screen.getByText('Carol')).toBeInTheDocument();
        expect(subjectField()).toHaveValue('Unfinished thought');
        expect(bodyField()).toHaveValue('To be continued');
        expect(await screen.findByText('notes.txt')).toBeInTheDocument();
        expect(buttonBeside('notes.txt')).toBeEnabled();
        expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
    });

    it('saves the draft as it now reads', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.updateDmail.mockResolvedValue(true);
        render(<DmailTab />);
        await editDraft(user);

        await user.type(bodyField(), '...');
        await user.click(screen.getByRole('button', { name: 'Save draft' }));

        await waitFor(() => expect(setSuccess).toHaveBeenCalledWith('Dmail updated'));
        expect(keymaster.updateDmail).toHaveBeenCalledWith(DRAFT, {
            to: ['Bob'],
            cc: ['Carol'],
            subject: 'Unfinished thought',
            body: 'To be continued...',
        });
    });

    it('keeps the reference of a draft that answers a message', async () => {
        const user = userEvent.setup({ delay: null });
        (variables.dmailList[DRAFT] as DmailItem).message.reference = LUNCH;
        keymaster.updateDmail.mockResolvedValue(true);
        render(<DmailTab />);
        await editDraft(user);

        await user.click(screen.getByRole('button', { name: 'Save draft' }));

        await waitFor(() => expect(keymaster.updateDmail).toHaveBeenCalledWith(DRAFT, expect.objectContaining({ reference: LUNCH })));
    });

    it('says so when the draft is not saved', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.updateDmail.mockResolvedValue(false);
        render(<DmailTab />);
        await editDraft(user);

        await user.click(screen.getByRole('button', { name: 'Save draft' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith('Failed to update dmail'));
        expect(setSuccess).not.toHaveBeenCalled();
    });

    it('reports a failure to save', async () => {
        const user = userEvent.setup({ delay: null });
        const failure = new Error('not the owner');
        keymaster.updateDmail.mockRejectedValue(failure);
        render(<DmailTab />);
        await editDraft(user);

        await user.click(screen.getByRole('button', { name: 'Save draft' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
    });

    it('does not save a draft with nobody to send it to', async () => {
        const user = userEvent.setup({ delay: null });
        render(<DmailTab />);
        await editDraft(user);

        await user.click(buttonBeside('Bob'));
        await user.click(screen.getByRole('button', { name: 'Save draft' }));

        expect(setError).toHaveBeenCalledWith('Add at least one recipient');
        expect(keymaster.updateDmail).not.toHaveBeenCalled();
    });

    it('does not save a draft without a subject', async () => {
        const user = userEvent.setup({ delay: null });
        render(<DmailTab />);
        await editDraft(user);

        await user.clear(subjectField());
        await user.click(screen.getByRole('button', { name: 'Save draft' }));

        expect(setError).toHaveBeenCalledWith('Please enter a subject for the Dmail');
        expect(keymaster.updateDmail).not.toHaveBeenCalled();
    });

    it('does not save a draft without a body', async () => {
        const user = userEvent.setup({ delay: null });
        render(<DmailTab />);
        await editDraft(user);

        await user.clear(bodyField());
        await user.click(screen.getByRole('button', { name: 'Save draft' }));

        expect(setError).toHaveBeenCalledWith('Please enter a body for the Dmail');
        expect(keymaster.updateDmail).not.toHaveBeenCalled();
    });

    it('reports attachments that cannot be listed', async () => {
        const user = userEvent.setup({ delay: null });
        const failure = new Error('vault unreachable');
        render(<DmailTab />);
        await folder(user, 'Drafts');
        await open(user, 'Unfinished thought');
        keymaster.listDmailAttachments.mockRejectedValue(failure);

        await user.click(screen.getByRole('button', { name: 'Edit' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
    });
});

describe('the More menu', () => {
    it('offers nothing while the form is empty', async () => {
        const user = userEvent.setup({ delay: null });
        render(<DmailTab />);
        await folder(user, 'Compose');

        await user.click(screen.getByRole('button', { name: 'More' }));

        expect(await screen.findByRole('menuitem', { name: 'Clear' })).toHaveAttribute('aria-disabled', 'true');
        expect(screen.getByRole('menuitem', { name: 'Revoke' })).toHaveAttribute('aria-disabled', 'true');
    });

    it('clears the form', async () => {
        const user = userEvent.setup({ delay: null });
        render(<DmailTab />);
        await createDraft(user);
        await user.type(ccField(), 'Carol');
        await user.click(addCc());

        await pickFromMore(user, 'Clear');

        expect(toField()).toHaveValue('');
        expect(subjectField()).toHaveValue('');
        expect(bodyField()).toHaveValue('');
        expect(screen.queryByText('Carol')).toBeNull();
        expect(screen.queryByText(NEW)).toBeNull();
        expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    });

    it('revokes the draft once that is confirmed', async () => {
        const user = userEvent.setup({ delay: null });
        render(<DmailTab />);
        await createDraft(user);
        walletData.refreshInbox.mockClear();

        await pickFromMore(user, 'Revoke');
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByText('Are you sure you want to revoke this DMail?')).toBeInTheDocument();
        await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));

        await waitFor(() => expect(setSuccess).toHaveBeenCalledWith('DMail revoked'));
        expect(keymaster.removeDmail).toHaveBeenCalledWith(NEW);
        expect(keymaster.revokeDID).toHaveBeenCalledWith(NEW);
        expect(walletData.refreshInbox).toHaveBeenCalled();
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(subjectField()).toHaveValue('');
        expect(screen.queryByText(NEW)).toBeNull();
    });

    it('revokes nothing when that is cancelled', async () => {
        const user = userEvent.setup({ delay: null });
        render(<DmailTab />);
        await createDraft(user);

        await pickFromMore(user, 'Revoke');
        await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));

        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(keymaster.removeDmail).not.toHaveBeenCalled();
        expect(keymaster.revokeDID).not.toHaveBeenCalled();
        expect(screen.getByText(NEW)).toBeInTheDocument();
    });

    it('reports a draft that cannot be revoked and keeps it', async () => {
        const user = userEvent.setup({ delay: null });
        const failure = new Error('not the owner');
        keymaster.revokeDID.mockRejectedValue(failure);
        render(<DmailTab />);
        await createDraft(user);

        await pickFromMore(user, 'Revoke');
        await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Confirm' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(setSuccess).not.toHaveBeenCalledWith('DMail revoked');
        expect(screen.getByText(NEW)).toBeInTheDocument();
    });
});

describe('attachments of a draft', () => {
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

    it('opens the file chooser from the Add attachment button', async () => {
        const user = userEvent.setup({ delay: null });
        render(<DmailTab />);
        await createDraft(user);
        const chosen = vi.fn();
        fileInput().addEventListener('click', chosen);

        await user.click(screen.getByRole('button', { name: 'Add attachment' }));

        expect(chosen).toHaveBeenCalledTimes(1);
    });

    it('attaches the chosen file under its own name', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.addDmailAttachment.mockResolvedValue(true);
        render(<DmailTab />);
        await createDraft(user);
        keymaster.listDmailAttachments.mockResolvedValue({ 'report.pdf': { bytes: 13 } });

        await user.upload(fileInput(), file());

        await waitFor(() => expect(setSuccess).toHaveBeenCalledWith('Attachment uploaded successfully: report.pdf'));
        const [did, name, buffer] = keymaster.addDmailAttachment.mock.calls[0];
        expect(did).toBe(NEW);
        expect(name).toBe('report.pdf');
        expect(Buffer.from(buffer).toString('utf-8')).toBe('file contents');
        expect(await screen.findByText('report.pdf')).toBeInTheDocument();
        expect(setError).not.toHaveBeenCalled();
    });

    it('says so when the draft does not take the file', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.addDmailAttachment.mockResolvedValue(false);
        render(<DmailTab />);
        await createDraft(user);

        await user.upload(fileInput(), file());

        await waitFor(() => expect(setError).toHaveBeenCalledWith('Error uploading file: report.pdf'));
    });

    it('reports a failure to attach the file', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.addDmailAttachment.mockRejectedValue(new Error('file too large'));
        render(<DmailTab />);
        await createDraft(user);

        await user.upload(fileInput(), file());

        await waitFor(() => expect(setError).toHaveBeenCalledWith('Error uploading file: Error: file too large'));
    });

    it('reports a file that cannot be read', async () => {
        const user = userEvent.setup({ delay: null });
        readingEndsWith(reader => reader.onerror?.call(reader, new ProgressEvent('error') as ProgressEvent<FileReader>));
        render(<DmailTab />);
        await createDraft(user);

        await user.upload(fileInput(), file());

        await waitFor(() => expect(setError).toHaveBeenCalledWith(expect.stringMatching(/^Error uploading file: /)));
        expect(keymaster.addDmailAttachment).not.toHaveBeenCalled();
    });

    it('reports a read that yields nothing', async () => {
        const user = userEvent.setup({ delay: null });
        readingEndsWith(reader => reader.onload?.call(reader, { target: { result: null } } as ProgressEvent<FileReader>));
        render(<DmailTab />);
        await createDraft(user);

        await user.upload(fileInput(), file());

        await waitFor(() => expect(setError).toHaveBeenCalledWith('Unexpected file reader result'));
        expect(keymaster.addDmailAttachment).not.toHaveBeenCalled();
    });

    it('reports a read that yields something other than bytes', async () => {
        const user = userEvent.setup({ delay: null });
        readingEndsWith(reader => reader.onload?.call(reader, { target: { result: 'text' } } as ProgressEvent<FileReader>));
        render(<DmailTab />);
        await createDraft(user);

        await user.upload(fileInput(), file());

        await waitFor(() => expect(setError).toHaveBeenCalledWith('Unexpected file reader result type'));
        expect(keymaster.addDmailAttachment).not.toHaveBeenCalled();
    });

    it('reports a file that cannot be handed to the reader', async () => {
        const user = userEvent.setup({ delay: null });
        vi.spyOn(FileReader.prototype, 'readAsArrayBuffer').mockImplementation(() => {
            throw new Error('reader busy');
        });
        render(<DmailTab />);
        await createDraft(user);

        await user.upload(fileInput(), file());

        await waitFor(() => expect(setError).toHaveBeenCalledWith('Error uploading file: Error: reader busy'));
    });

    it('attaches nothing when the file chooser is closed without a file', async () => {
        const user = userEvent.setup({ delay: null });
        render(<DmailTab />);
        await createDraft(user);

        fireEvent.change(fileInput(), { target: { files: [] } });

        expect(keymaster.addDmailAttachment).not.toHaveBeenCalled();
        expect(setError).not.toHaveBeenCalled();
    });

    it('takes an attachment off the draft', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.listDmailAttachments.mockResolvedValue({ 'notes.txt': { bytes: 5 } });
        render(<DmailTab />);
        await editDraft(user);
        await screen.findByText('notes.txt');
        // A node that has no attachments left may answer with nothing at all.
        keymaster.listDmailAttachments.mockResolvedValue(null);

        await user.click(buttonBeside('notes.txt'));

        await waitFor(() => expect(screen.queryByText('notes.txt')).toBeNull());
        expect(keymaster.removeDmailAttachment).toHaveBeenCalledWith(DRAFT, 'notes.txt');
        expect(setError).not.toHaveBeenCalled();
    });

    it('reports an attachment that cannot be taken off', async () => {
        const user = userEvent.setup({ delay: null });
        const failure = new Error('not the owner');
        keymaster.listDmailAttachments.mockResolvedValue({ 'notes.txt': { bytes: 5 } });
        keymaster.removeDmailAttachment.mockRejectedValue(failure);
        render(<DmailTab />);
        await editDraft(user);
        await screen.findByText('notes.txt');

        await user.click(buttonBeside('notes.txt'));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(screen.getByText('notes.txt')).toBeInTheDocument();
    });
});

describe('refreshing and importing', () => {
    it('fetches new notices and reads the mailbox again', async () => {
        const user = userEvent.setup({ delay: null });
        render(<DmailTab />);
        walletData.refreshInbox.mockClear();

        await user.click(screen.getByRole('button', { name: 'Refresh' }));

        await waitFor(() => expect(setSuccess).toHaveBeenCalledWith('Refreshed'));
        expect(keymaster.refreshNotices).toHaveBeenCalledTimes(1);
        expect(walletData.refreshInbox).toHaveBeenCalledTimes(1);
    });

    it('reports a refresh that fails', async () => {
        const user = userEvent.setup({ delay: null });
        const failure = new Error('node offline');
        keymaster.refreshNotices.mockRejectedValue(failure);
        render(<DmailTab />);

        await user.click(screen.getByRole('button', { name: 'Refresh' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(setSuccess).not.toHaveBeenCalled();
    });

    async function importDid(user: UserEvent, did: string) {
        await user.click(screen.getByRole('button', { name: 'Import DMail' }));
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByText('Paste the DMail DID to import')).toBeInTheDocument();
        if (did) {
            await user.type(within(dialog).getByLabelText('DID'), did);
        }
        await user.click(within(dialog).getByRole('button', { name: 'Import' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    }

    it('imports a message by its DID', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.importDmail.mockResolvedValue(true);
        render(<DmailTab />);
        walletData.refreshInbox.mockClear();

        await importDid(user, '  did:cid:imported ');

        await waitFor(() => expect(setSuccess).toHaveBeenCalledWith('DMail import successful'));
        expect(keymaster.importDmail).toHaveBeenCalledWith('did:cid:imported');
        await waitFor(() => expect(walletData.refreshInbox).toHaveBeenCalled());
    });

    it('says so when the message is not imported', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.importDmail.mockResolvedValue(false);
        render(<DmailTab />);

        await importDid(user, 'did:cid:imported');

        await waitFor(() => expect(setError).toHaveBeenCalledWith('DMail import failed'));
        expect(setSuccess).not.toHaveBeenCalled();
    });

    it('reports an import that fails', async () => {
        const user = userEvent.setup({ delay: null });
        const failure = new Error('not a dmail');
        keymaster.importDmail.mockRejectedValue(failure);
        render(<DmailTab />);

        await importDid(user, 'did:cid:imported');

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
    });

    it('imports nothing when no DID is given', async () => {
        const user = userEvent.setup({ delay: null });
        render(<DmailTab />);

        await importDid(user, '');

        expect(keymaster.importDmail).not.toHaveBeenCalled();
        expect(setError).not.toHaveBeenCalled();
    });

    it('imports nothing when the dialog is cancelled', async () => {
        const user = userEvent.setup({ delay: null });
        render(<DmailTab />);

        await user.click(screen.getByRole('button', { name: 'Import DMail' }));
        const dialog = await screen.findByRole('dialog');
        await user.type(within(dialog).getByLabelText('DID'), 'did:cid:imported');
        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(keymaster.importDmail).not.toHaveBeenCalled();
    });
});

describe('searching', () => {
    const search = () => screen.getByPlaceholderText('Search…');
    const shown = () => ['Lunch plans', 'Hello from afar', 'Note to self'].filter(subject => screen.queryByText(subject));

    it.each([
        ['a word of the subject', 'LUNCH', ['Lunch plans']],
        ['a word of the body', 'greetings', ['Hello from afar']],
        ['the sender', 'stranger', ['Hello from afar']],
        ['a recipient', 'dave', ['Lunch plans']],
        ['someone it was copied to', 'carol', ['Lunch plans']],
        ['nothing in the folder', 'zebra', []],
    ])('finds messages by %s', async (_what, term, expected) => {
        const user = userEvent.setup({ delay: null });
        render(<DmailTab />);

        await user.type(search(), `${term}{Enter}`);

        expect(shown()).toEqual(expected);
        if (expected.length === 0) {
            expect(screen.getByText('Your inbox is empty.')).toBeInTheDocument();
        }
    });

    it('shows the whole folder again when the search is emptied', async () => {
        const user = userEvent.setup({ delay: null });
        render(<DmailTab />);
        await user.type(search(), 'lunch');

        await user.clear(search());

        expect(shown()).toHaveLength(3);
    });

    async function advanced(user: UserEvent, fill: (dialog: HTMLElement) => Promise<void> | void) {
        await user.click(screen.getByRole('button', { name: 'Advanced search' }));
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByRole('heading', { name: 'Advanced Search' })).toBeInTheDocument();
        await fill(dialog);
        await user.click(within(dialog).getByRole('button', { name: 'Search' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    }

    it.each([
        ['From', 'BOB', ['Lunch plans']],
        ['To / CC', 'Carol', ['Lunch plans']],
        ['Subject', 'hello', ['Hello from afar']],
        ['Body', 'MILK', ['Note to self']],
    ])('narrows the folder by the %s field', async (label, value, expected) => {
        const user = userEvent.setup({ delay: null });
        render(<DmailTab />);

        await advanced(user, async dialog => {
            await user.type(within(dialog).getByLabelText(label), value);
        });

        expect(shown()).toEqual(expected);
    });

    it('narrows the folder to messages with attachments', async () => {
        const user = userEvent.setup({ delay: null });
        // A message may carry an empty set of attachments as well as none.
        (variables.dmailList[NOTE] as DmailItem).attachments = {};
        render(<DmailTab />);

        await advanced(user, async dialog => {
            await user.click(within(dialog).getByRole('checkbox', { name: 'Has attachments' }));
        });

        expect(shown()).toEqual(['Lunch plans']);
    });

    it('narrows the folder to messages since a day', async () => {
        const user = userEvent.setup({ delay: null });
        variables.dmailList['did:cid:undated'] = mail('Bob', ['Alice'], [], 'No date', 'When?', 'not a date', ['inbox']);
        render(<DmailTab />);
        expect(screen.getByText('No date')).toBeInTheDocument();

        await advanced(user, dialog => {
            fireEvent.change(within(dialog).getByLabelText('Date from'), { target: { value: '2024-03-01' } });
        });

        expect(shown()).toEqual(['Lunch plans', 'Note to self']);
        expect(screen.queryByText('No date')).toBeNull();
    });

    it('narrows the folder to messages up to a day', async () => {
        const user = userEvent.setup({ delay: null });
        render(<DmailTab />);

        await advanced(user, dialog => {
            // Two days after the message, so the cutoff falls after it in every time zone.
            fireEvent.change(within(dialog).getByLabelText('Date to'), { target: { value: '2024-01-07' } });
        });

        expect(shown()).toEqual(['Hello from afar']);
    });

    it('applies the simple and the advanced search together', async () => {
        const user = userEvent.setup({ delay: null });
        render(<DmailTab />);
        await advanced(user, async dialog => {
            await user.type(within(dialog).getByLabelText('To / CC'), 'alice');
        });
        expect(shown()).toHaveLength(3);

        await user.type(search(), 'milk');

        expect(shown()).toEqual(['Note to self']);
    });

    it('leaves the folder as it was when the advanced search is cancelled', async () => {
        const user = userEvent.setup({ delay: null });
        render(<DmailTab />);

        await user.click(screen.getByRole('button', { name: 'Advanced search' }));
        const dialog = await screen.findByRole('dialog');
        await user.type(within(dialog).getByLabelText('From'), 'nobody');
        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(shown()).toHaveLength(3);
    });
});

describe('without a wallet', () => {
    it('reads and changes nothing', async () => {
        const user = userEvent.setup({ delay: null });
        wallet.keymaster = null;
        render(<DmailTab />);

        await user.click(screen.getByRole('button', { name: 'Refresh' }));
        await user.click(screen.getByText('Lunch plans'));
        await user.click(await screen.findByRole('button', { name: 'Archive' }));
        await write(user);
        await user.click(screen.getByRole('button', { name: 'Create' }));

        for (const method of Object.values(keymaster)) {
            expect(method).not.toHaveBeenCalled();
        }
        expect(setSuccess).not.toHaveBeenCalled();
        expect(setError).not.toHaveBeenCalled();
    });
});

// The read-only view of one message, which the Vaults tab opens for a dmail
// item kept in a vault.
describe('DmailDialog', () => {
    const dmail = { to: ['Bob', 'Dave'], cc: ['Carol'], subject: 'Lunch plans', body: LUNCH_BODY };

    it('shows the message and lets none of it be changed', () => {
        render(<DmailDialog open onClose={vi.fn()} dmail={dmail} />);

        const dialog = screen.getByRole('dialog');
        expect(within(dialog).getByLabelText('To')).toHaveValue('Bob, Dave');
        expect(within(dialog).getByLabelText('cc')).toHaveValue('Carol');
        expect(within(dialog).getByLabelText('Subject')).toHaveValue('Lunch plans');
        expect(within(dialog).getByLabelText('Body')).toHaveValue(LUNCH_BODY);
        for (const label of ['To', 'cc', 'Subject', 'Body']) {
            expect(within(dialog).getByLabelText(label)).toHaveAttribute('readonly');
        }
    });

    it('shows empty fields for a message without recipients or text', () => {
        render(<DmailDialog open onClose={vi.fn()} dmail={null} />);

        const dialog = screen.getByRole('dialog');
        for (const label of ['To', 'cc', 'Subject', 'Body']) {
            expect(within(dialog).getByLabelText(label)).toHaveValue('');
        }
    });

    it('shows nothing while it is closed', () => {
        render(<DmailDialog open={false} onClose={vi.fn()} dmail={dmail} />);

        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('closes from its Close button', async () => {
        const user = userEvent.setup({ delay: null });
        const onClose = vi.fn();
        render(<DmailDialog open onClose={onClose} dmail={dmail} />);

        await user.click(screen.getByRole('button', { name: 'Close' }));

        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
