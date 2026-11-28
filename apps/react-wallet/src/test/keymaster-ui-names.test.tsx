import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import KeymasterUI from '../../../../packages/keymaster-ui/src/KeymasterUI.jsx';

// Keymaster trims a name before it stores it, so the standalone clients check,
// create and name a poll or an upload with the name as it will be stored.

const ALICE = 'did:cid:alice';
const CREATED = 'did:cid:created';
const TAKEN = 'did:cid:taken';

// The first 26 characters of this name end in a space.
const CUT = 'a'.repeat(25);
const LONG_NAME = `${CUT} tail`;

const fns: Record<string, any> = {};
// The component reads a great deal on mount that has nothing to do with names.
const keymaster = new Proxy(fns, {
    get(target, key: string) {
        if (key === 'then') {
            return undefined;
        }
        target[key] ??= vi.fn(async () => []);
        return target[key];
    },
});

const Panel = KeymasterUI as any;

function withAliases(aliases: Record<string, string>) {
    for (const key of Object.keys(fns)) {
        delete fns[key];
    }
    Object.assign(fns, {
        getCurrentId: vi.fn(async () => 'Alice'),
        listIds: vi.fn(async () => ['Alice']),
        listAliases: vi.fn(async () => aliases),
        listRegistries: vi.fn(async () => ['hyperswarm']),
        getVersion: vi.fn(async () => ({ version: '0', commit: 'test' })),
        pollTemplate: vi.fn(async () => ({ version: 2, name: 'poll-name', description: '', options: [], deadline: '' })),
        createPoll: vi.fn(async () => CREATED),
        createImage: vi.fn(async () => CREATED),
        createAsset: vi.fn(async () => CREATED),
        addAlias: vi.fn(async () => true),
        resolveDID: vi.fn(async (id: string) => ({
            didDocument: { id: id === 'Alice' ? ALICE : id, service: [] },
            didDocumentData: {},
            didDocumentMetadata: { version: 1 },
            didDocumentRegistration: {},
        })),
    });
}

beforeEach(() => withAliases({}));

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

async function createPoll(name: string) {
    render(<Panel keymaster={keymaster} title="Test" />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('tab', { name: 'Polls' }));
    fireEvent.change(await screen.findByLabelText('Poll name'), { target: { value: name } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Where to eat' } });
    fireEvent.change(screen.getByLabelText('Options (comma or newline separated)'), { target: { value: 'here, there' } });
    fireEvent.change(screen.getByLabelText('Deadline'), { target: { value: '2030-01-01T12:00' } });
    await user.click(screen.getByRole('button', { name: 'Create' }));
}

async function chooseRegistry(user: ReturnType<typeof userEvent.setup>) {
    const registry = (await screen.findAllByRole('combobox')).find(box => box.textContent === 'Select registry');
    await user.click(registry as HTMLElement);
    await user.click(await screen.findByRole('option', { name: 'hyperswarm' }));
}

describe('a poll in the standalone clients', () => {
    it('is refused before anything is created when its name with spaces round it is taken', async () => {
        withAliases({ lunch: TAKEN });

        await createPoll(' lunch ');

        expect(await screen.findByText('Name "lunch" is already in use')).toBeInTheDocument();
        expect(fns.createPoll).not.toHaveBeenCalled();
        expect(fns.addAlias).not.toHaveBeenCalled();
    });

    it('is created and named with its trimmed name', async () => {
        await createPoll(' lunch ');

        expect(await screen.findByText(`Poll created: ${CREATED}`)).toBeInTheDocument();
        expect(fns.createPoll).toHaveBeenCalledWith(expect.objectContaining({ name: 'lunch' }), expect.anything());
        expect(fns.addAlias).toHaveBeenCalledWith('lunch', CREATED);
    });
});

describe('an upload in the standalone clients', () => {
    it('numbers an image whose cut name ends in a space when the wallet has the trimmed name', async () => {
        withAliases({ [CUT]: TAKEN });
        const { container } = render(<Panel keymaster={keymaster} title="Test" />);
        const user = userEvent.setup();

        await user.click(await screen.findByRole('tab', { name: 'Assets' }));
        await user.click(await screen.findByRole('tab', { name: 'Images' }));
        await chooseRegistry(user);
        await user.upload(
            container.querySelector('#imageUpload') as HTMLInputElement,
            new File([new Uint8Array([137, 80, 78, 71])], `${LONG_NAME}.png`, { type: 'image/png' }),
        );

        await vi.waitFor(() => expect(fns.addAlias).toHaveBeenCalledWith(`${CUT} (1)`, CREATED));
    });

    it('numbers an avatar whose cut name ends in a space when the wallet has the trimmed name', async () => {
        withAliases({ [CUT]: TAKEN });
        const { container } = render(<Panel keymaster={keymaster} title="Test" />);
        const user = userEvent.setup();

        await user.click(await screen.findByRole('tab', { name: 'Avatar' }));
        await user.click(await screen.findByLabelText('Upload Image'));
        await chooseRegistry(user);
        await user.upload(
            container.querySelector('#avatarUpload') as HTMLInputElement,
            new File([new Uint8Array([137, 80, 78, 71])], `${LONG_NAME}.png`, { type: 'image/png' }),
        );

        await vi.waitFor(() => expect(fns.addAlias).toHaveBeenCalledWith(`${CUT} (1)`, CREATED));
    });

    it('numbers a file whose cut name ends in a space when the wallet has the trimmed name', async () => {
        withAliases({ [CUT]: TAKEN });
        // The client streams a file to the node before it creates the asset.
        class Upload {
            status = 200;
            responseText = 'bafkfile';
            upload = {};
            onload: (() => void) | null = null;
            open() {}
            setRequestHeader() {}
            send() {
                queueMicrotask(() => this.onload?.());
            }
        }
        vi.stubGlobal('XMLHttpRequest', Upload);
        const { container } = render(<Panel keymaster={keymaster} title="Test" />);
        const user = userEvent.setup();

        await user.click(await screen.findByRole('tab', { name: 'Assets' }));
        await user.click(await screen.findByRole('tab', { name: 'Files' }));
        await chooseRegistry(user);
        await user.upload(
            container.querySelector('#fileUpload') as HTMLInputElement,
            new File(['notes'], `${LONG_NAME}.txt`, { type: 'text/plain' }),
        );

        expect(await screen.findByText(`File uploaded successfully: ${CUT} (1)`)).toBeInTheDocument();
        expect(fns.addAlias).toHaveBeenCalledWith(`${CUT} (1)`, CREATED);
    });
});
