import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import ImageTab from '../../../../packages/wallet-ui/src/components/ImageTab';

// The Images tab makes an image asset from a file and names it, and for the
// image picked shows the picture, its details and versions, replaces it and
// renames it.

const { keymaster, wallet, variables, walletData, gatekeeper, setError, setSuccess, openView } = vi.hoisted(() => {
    const keymaster = {
        resolveDID: vi.fn(), createImage: vi.fn(), updateImage: vi.fn(),
        listAliases: vi.fn(), addAlias: vi.fn(), removeAlias: vi.fn(),
    };

    return {
        keymaster,
        wallet: { keymaster: keymaster as typeof keymaster | null, gatekeeperUrl: '' },
        variables: {
            registries: [] as string[],
            aliasList: {} as Record<string, string>,
            imageList: [] as string[] | null,
        },
        walletData: { refreshAliases: vi.fn(), handleCopyDID: vi.fn() },
        gatekeeper: { connect: vi.fn(), getData: vi.fn() },
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
// The component builds its own Gatekeeper client when the module loads, and
// reads an image's bytes through it.
vi.mock('@didcid/clients/gatekeeper', () => ({
    default: class {
        connect = gatekeeper.connect;
        getData = gatekeeper.getData;
    },
}));

const NODE = 'http://node.example';
const CAT = 'did:cid:cat';
const NEW_DID = 'did:cid:new';

// The asset Keymaster makes of an image: where its bytes are, and its size.
const imageData = (cid: string, type = 'image/png') => ({
    file: { cid, filename: 'image', type, bytes: 3 },
    image: { width: 640, height: 480 },
});

// A document as Keymaster's resolveDID returns it, which always adds `version`
// and `isOwned` to the metadata.
function resolved(did: string, data: unknown, version = 1, updated?: string) {
    return {
        didDocument: { '@context': ['https://www.w3.org/ns/did/v1'], id: did, controller: 'did:cid:alice' },
        didDocumentMetadata: {
            created: '2026-01-02T03:04:05Z',
            ...(updated ? { updated } : {}),
            versionId: `version-${version}-of-${did}`,
            versionSequence: String(version),
            confirmed: true,
            version,
            isOwned: true,
        },
        didDocumentData: data,
        didDocumentRegistration: { version: 1, type: 'asset', registry: 'hyperswarm' },
        didResolutionMetadata: { retrieved: '2026-01-02T03:04:06Z' },
    };
}

// The address an <img> gets for bytes the mocked Gatekeeper serves: each CID's
// bytes are its own name.
const dataUrl = (cid: string, type = 'image/png') => `data:${type};base64,${Buffer.from(cid).toString('base64')}`;

beforeEach(() => {
    vi.resetAllMocks();
    wallet.keymaster = keymaster;
    wallet.gatekeeperUrl = NODE;
    variables.registries = ['hyperswarm', 'BTC:mainnet'];
    variables.aliasList = { cat: CAT, notes: 'did:cid:notes' };
    variables.imageList = ['cat', 'notes'];
    keymaster.resolveDID.mockResolvedValue(resolved(CAT, imageData('cid-cat')));
    keymaster.createImage.mockResolvedValue(NEW_DID);
    keymaster.listAliases.mockResolvedValue({ cat: CAT, notes: 'did:cid:notes' });
    // These three answer true once the wallet or the update is saved.
    keymaster.updateImage.mockResolvedValue(true);
    keymaster.addAlias.mockResolvedValue(true);
    keymaster.removeAlias.mockResolvedValue(true);
    gatekeeper.getData.mockImplementation(async (cid: string) => Buffer.from(cid));
});

afterEach(() => {
    vi.restoreAllMocks();
});

// Neither picker has a label: they are told apart by order.
const registryPicker = () => screen.getAllByRole('combobox')[0];
const imagePicker = () => screen.getAllByRole('combobox')[1];
const uploadInput = () => document.getElementById('imageUpload') as HTMLInputElement;
const updateInput = () => document.getElementById('imageUpdate') as HTMLInputElement;
const renameButton = () => within(screen.getByLabelText('Rename Image')).getByRole('button');
// A line of the details, such as "CID: cid-cat".
const detail = (label: string) => screen.getByText(label).parentElement as HTMLElement;

const png = (name = 'photo.png') => new File(['image bytes'], name, { type: 'image/png' });

async function openImage(user: UserEvent, name = 'cat') {
    await user.click(imagePicker());
    await user.click(await screen.findByRole('option', { name }));
    await screen.findByRole('img');
}

// What the wallet's lists hold once the uploaded image has its alias.
function aliasAppearsAs(name: string) {
    walletData.refreshAliases.mockImplementation(async () => {
        variables.aliasList = { ...variables.aliasList, [name]: NEW_DID };
        variables.imageList = [...(variables.imageList ?? []), name];
    });
}

// Stands in for a read that ends some way a real file does not make it end.
function readingEndsWith(end: (reader: FileReader) => void) {
    vi.spyOn(FileReader.prototype, 'readAsArrayBuffer').mockImplementation(function (this: FileReader) {
        end(this);
    });
}

describe('the node images are read from', () => {
    it('is the wallet\'s Gatekeeper', () => {
        render(<ImageTab />);

        expect(gatekeeper.connect).toHaveBeenCalledWith({ url: NODE });
    });
});

describe('uploading an image', () => {
    it('opens the file chooser from the Upload button', async () => {
        const user = userEvent.setup({ delay: null });
        render(<ImageTab />);
        const chosen = vi.fn();
        uploadInput().addEventListener('click', chosen);

        await user.click(screen.getByRole('button', { name: 'Upload' }));

        expect(chosen).toHaveBeenCalledTimes(1);
    });

    it('does not offer Upload until a registry the node offers is chosen', async () => {
        const user = userEvent.setup({ delay: null });
        variables.registries = ['BTC:mainnet'];
        render(<ImageTab />);

        expect(registryPicker()).not.toHaveTextContent('hyperswarm');
        expect(screen.getByRole('button', { name: 'Upload' })).toBeDisabled();

        await user.click(registryPicker());
        await user.click(await screen.findByRole('option', { name: 'BTC:mainnet' }));
        expect(screen.getByRole('button', { name: 'Upload' })).toBeEnabled();
    });

    it('makes an image asset of the file on hyperswarm, names it and opens it', async () => {
        const user = userEvent.setup({ delay: null });
        aliasAppearsAs('photo.png');
        keymaster.resolveDID.mockResolvedValue(resolved(NEW_DID, imageData('cid-new')));
        render(<ImageTab />);

        await user.upload(uploadInput(), png());

        await waitFor(() => expect(setSuccess).toHaveBeenCalledWith(`Image uploaded successfully! DID: ${NEW_DID}`));
        expect(keymaster.createImage).toHaveBeenCalledTimes(1);
        const [bytes, options] = keymaster.createImage.mock.calls[0];
        expect(Buffer.isBuffer(bytes)).toBe(true);
        expect(bytes.toString()).toBe('image bytes');
        expect(options).toEqual({ registry: 'hyperswarm' });
        expect(keymaster.addAlias).toHaveBeenCalledWith('photo.png', NEW_DID);
        expect(walletData.refreshAliases).toHaveBeenCalledTimes(1);
        expect(await screen.findByRole('img')).toHaveAttribute('src', dataUrl('cid-new'));
        expect(keymaster.resolveDID).toHaveBeenCalledWith('photo.png', {});
        expect(imagePicker()).toHaveTextContent('photo.png');
        expect(setError).not.toHaveBeenCalled();
    });

    it('makes the asset on the registry chosen', async () => {
        const user = userEvent.setup({ delay: null });
        render(<ImageTab />);

        await user.click(registryPicker());
        await user.click(await screen.findByRole('option', { name: 'BTC:mainnet' }));
        await user.upload(uploadInput(), png());

        await waitFor(() =>
            expect(keymaster.createImage).toHaveBeenCalledWith(expect.anything(), { registry: 'BTC:mainnet' }));
    });

    it('names the asset by the first 26 characters of the file name', async () => {
        const user = userEvent.setup({ delay: null });
        render(<ImageTab />);

        await user.upload(uploadInput(), png('a-very-long-name-for-a-holiday-photo.png'));

        await waitFor(() => expect(keymaster.addAlias).toHaveBeenCalledWith('a-very-long-name-for-a-hol', NEW_DID));
    });

    it('numbers a name that ends in a space where it is cut, when the wallet has it trimmed', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.listAliases.mockResolvedValue({ 'my holiday photo from the': 'did:cid:one' });
        render(<ImageTab />);

        await user.upload(uploadInput(), png('my holiday photo from the beach.png'));

        await waitFor(() => expect(keymaster.addAlias).toHaveBeenCalledWith('my holiday photo from the (1)', NEW_DID));
    });

    it('numbers the name when the wallet already has it', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.listAliases.mockResolvedValue({ 'photo.png': 'did:cid:one', 'photo.png (1)': 'did:cid:two' });
        render(<ImageTab />);

        await user.upload(uploadInput(), png());

        await waitFor(() => expect(keymaster.addAlias).toHaveBeenCalledWith('photo.png (2)', NEW_DID));
    });

    it('reports a file Keymaster does not take for an image', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.createImage.mockRejectedValue(new Error('Invalid parameter: buffer'));
        render(<ImageTab />);

        await user.upload(uploadInput(), png());

        await waitFor(() =>
            expect(setError).toHaveBeenCalledWith('Error processing image: Error: Invalid parameter: buffer'));
        expect(keymaster.addAlias).not.toHaveBeenCalled();
        expect(setSuccess).not.toHaveBeenCalled();
    });

    it('makes nothing when the chooser is closed with no file', () => {
        const read = vi.spyOn(FileReader.prototype, 'readAsArrayBuffer');
        render(<ImageTab />);

        fireEvent.change(uploadInput(), { target: { files: [] } });

        expect(read).not.toHaveBeenCalled();
        expect(setError).not.toHaveBeenCalled();
    });

    it('makes nothing while the wallet has no keymaster', async () => {
        const user = userEvent.setup({ delay: null });
        const read = vi.spyOn(FileReader.prototype, 'readAsArrayBuffer');
        wallet.keymaster = null;
        render(<ImageTab />);

        await user.upload(uploadInput(), png());

        expect(read).not.toHaveBeenCalled();
        expect(keymaster.createImage).not.toHaveBeenCalled();
    });
});

describe('the image picked', () => {
    it('offers the wallet\'s images', async () => {
        const user = userEvent.setup({ delay: null });
        render(<ImageTab />);

        expect(imagePicker()).toHaveTextContent('Select image');
        await user.click(imagePicker());

        const names = (await screen.findAllByRole('option')).map(option => option.textContent);
        expect(names).toEqual(['Select image', 'cat', 'notes']);
    });

    it('has no picker while the wallet\'s images are not known', () => {
        variables.imageList = null;
        render(<ImageTab />);

        expect(screen.getAllByRole('combobox')).toHaveLength(1);
        expect(screen.queryByRole('button', { name: 'Update' })).toBeNull();
    });

    it('offers nothing to do with an image until one is picked', () => {
        render(<ImageTab />);

        expect(screen.getByRole('button', { name: 'Update' })).toBeDisabled();
        expect(renameButton()).toBeDisabled();
        expect(screen.queryByRole('img')).toBeNull();
    });

    it('shows the picture and its details', async () => {
        const user = userEvent.setup({ delay: null });
        render(<ImageTab />);

        await openImage(user);

        expect(keymaster.resolveDID).toHaveBeenCalledWith('cat', {});
        expect(gatekeeper.getData).toHaveBeenCalledWith('cid-cat');
        expect(screen.getByRole('img', { name: 'cid-cat' })).toHaveAttribute('src', dataUrl('cid-cat'));
        expect(detail('DID:')).toHaveTextContent(`DID: ${CAT}`);
        expect(detail('CID:')).toHaveTextContent('CID: cid-cat');
        expect(detail('Created:')).toHaveTextContent('Created: 2026-01-02T03:04:05Z');
        // An image never updated shows when it was created.
        expect(detail('Updated:')).toHaveTextContent('Updated: 2026-01-02T03:04:05Z');
        expect(detail('Version:')).toHaveTextContent('Version: 1');
        expect(detail('File size:')).toHaveTextContent('File size: 3 bytes');
        expect(detail('Image size:')).toHaveTextContent('Image size: 640 x 480 pixels');
        expect(detail('Image type:')).toHaveTextContent('Image type: image/png');
        expect(setError).not.toHaveBeenCalled();
    });

    it('shows when it was last updated', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.resolveDID.mockResolvedValue(
            resolved(CAT, imageData('cid-cat', 'image/jpeg'), 2, '2026-02-03T04:05:06Z'));
        render(<ImageTab />);

        await openImage(user);

        expect(screen.getByRole('img')).toHaveAttribute('src', dataUrl('cid-cat', 'image/jpeg'));
        expect(detail('Updated:')).toHaveTextContent('Updated: 2026-02-03T04:05:06Z');
        expect(detail('Version:')).toHaveTextContent('Version: 2');
    });

    it.each([
        ['nothing', {}],
        ['a file that is no image', { file: { cid: 'cid-notes', filename: 'notes.txt', type: 'text/plain', bytes: 5 } }],
        ['a size and no file', { image: { width: 1, height: 1 } }],
    ])('says so when the asset holds %s', async (_case, data) => {
        const user = userEvent.setup({ delay: null });
        keymaster.resolveDID.mockResolvedValue(resolved('did:cid:notes', data));
        render(<ImageTab />);

        await user.click(imagePicker());
        await user.click(await screen.findByRole('option', { name: 'notes' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith('No image data found in version 1'));
        expect(gatekeeper.getData).not.toHaveBeenCalled();
        expect(screen.queryByRole('img')).toBeNull();
    });

    it('reports an image that cannot be resolved', async () => {
        const user = userEvent.setup({ delay: null });
        const failure = new Error('Invalid DID: unknown');
        keymaster.resolveDID.mockRejectedValue(failure);
        render(<ImageTab />);

        await user.click(imagePicker());
        await user.click(await screen.findByRole('option', { name: 'cat' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(screen.queryByRole('img')).toBeNull();
    });

    it('reports bytes the node does not have', async () => {
        const user = userEvent.setup({ delay: null });
        const failure = new Error('Content not found');
        gatekeeper.getData.mockRejectedValue(failure);
        render(<ImageTab />);

        await user.click(imagePicker());
        await user.click(await screen.findByRole('option', { name: 'cat' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(screen.queryByRole('img')).toBeNull();
    });

    it('resolves nothing while the wallet has no keymaster', async () => {
        const user = userEvent.setup({ delay: null });
        wallet.keymaster = null;
        render(<ImageTab />);

        await user.click(imagePicker());
        await user.click(await screen.findByRole('option', { name: 'cat' }));

        await waitFor(() => expect(imagePicker()).toHaveTextContent('cat'));
        expect(keymaster.resolveDID).not.toHaveBeenCalled();
        expect(screen.queryByRole('img')).toBeNull();
    });
});

describe('the versions of an image', () => {
    beforeEach(() => {
        keymaster.resolveDID.mockImplementation(async (_name: string, options?: { versionSequence?: number }) => {
            const version = options?.versionSequence ?? 3;
            return resolved(CAT, imageData(`cid-v${version}`), version);
        });
    });

    it('opens on the latest and shows an earlier one when it is picked', async () => {
        const user = userEvent.setup({ delay: null });
        render(<ImageTab />);
        await openImage(user);
        expect(screen.getByRole('img')).toHaveAttribute('src', dataUrl('cid-v3'));

        await user.click(screen.getByText('version 3'));
        const offered = (await screen.findAllByRole('option')).map(option => option.textContent);
        expect(offered).toEqual(['version 1', 'version 2', 'version 3']);
        await user.click(screen.getByRole('option', { name: 'version 2' }));

        await waitFor(() => expect(screen.getByRole('img')).toHaveAttribute('src', dataUrl('cid-v2')));
        expect(keymaster.resolveDID).toHaveBeenLastCalledWith('cat', { versionSequence: 2 });
        expect(detail('Version:')).toHaveTextContent('Version: 2');

        // Looking at an earlier version does not shorten the list of versions.
        await user.click(screen.getByText('version 2'));
        expect(await screen.findAllByRole('option')).toHaveLength(3);
    });

    it('says so when a version holds no image, and reports it by its number', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.resolveDID.mockImplementation(async (_name: string, options?: { versionSequence?: number }) =>
            options?.versionSequence === 2
                ? resolved(CAT, { note: 'not an image yet' }, 2)
                : resolved(CAT, imageData('cid-v3'), 3));
        render(<ImageTab />);
        await openImage(user);

        await user.click(screen.getByText('version 3'));
        await user.click(await screen.findByRole('option', { name: 'version 2' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith('No image data found in version 2'));
    });
});

describe('updating an image', () => {
    it('opens the file chooser from the Update button', async () => {
        const user = userEvent.setup({ delay: null });
        render(<ImageTab />);
        await openImage(user);
        const chosen = vi.fn();
        updateInput().addEventListener('click', chosen);

        await user.click(screen.getByRole('button', { name: 'Update' }));

        expect(chosen).toHaveBeenCalledTimes(1);
    });

    it('puts the new picture in the asset and shows it', async () => {
        const user = userEvent.setup({ delay: null });
        render(<ImageTab />);
        await openImage(user);
        keymaster.resolveDID.mockResolvedValue(resolved(CAT, imageData('cid-kitten'), 2, '2026-02-03T04:05:06Z'));

        await user.upload(updateInput(), png());

        await waitFor(() => expect(setSuccess).toHaveBeenCalledWith('Image updated successfully'));
        expect(keymaster.updateImage).toHaveBeenCalledTimes(1);
        const [name, bytes] = keymaster.updateImage.mock.calls[0];
        expect(name).toBe('cat');
        expect(Buffer.isBuffer(bytes)).toBe(true);
        expect(bytes.toString()).toBe('image bytes');
        await waitFor(() => expect(screen.getByRole('img')).toHaveAttribute('src', dataUrl('cid-kitten')));
        expect(detail('Version:')).toHaveTextContent('Version: 2');
        expect(keymaster.resolveDID).toHaveBeenLastCalledWith('cat', {});
        expect(keymaster.createImage).not.toHaveBeenCalled();
        expect(setError).not.toHaveBeenCalled();
    });

    it('reports a file Keymaster does not take for an image', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.updateImage.mockRejectedValue(new Error('Invalid parameter: buffer'));
        render(<ImageTab />);
        await openImage(user);

        await user.upload(updateInput(), png());

        await waitFor(() =>
            expect(setError).toHaveBeenCalledWith('Error processing image: Error: Invalid parameter: buffer'));
        expect(setSuccess).not.toHaveBeenCalled();
        expect(screen.getByRole('img')).toHaveAttribute('src', dataUrl('cid-cat'));
    });

    it('changes nothing when the chooser is closed with no file', async () => {
        const user = userEvent.setup({ delay: null });
        render(<ImageTab />);
        await openImage(user);
        const read = vi.spyOn(FileReader.prototype, 'readAsArrayBuffer');

        fireEvent.change(updateInput(), { target: { files: [] } });

        expect(read).not.toHaveBeenCalled();
        expect(setError).not.toHaveBeenCalled();
    });

    it('changes nothing when no image is picked to update', () => {
        const read = vi.spyOn(FileReader.prototype, 'readAsArrayBuffer');
        render(<ImageTab />);

        // The button is disabled then, so the input is reached directly.
        fireEvent.change(updateInput(), { target: { files: [png()] } });

        expect(read).not.toHaveBeenCalled();
        expect(keymaster.updateImage).not.toHaveBeenCalled();
    });
});

// Uploading and updating read the chosen file the same way.
describe.each([
    {
        action: 'uploading',
        input: uploadInput,
        prepare: async () => undefined,
    },
    {
        action: 'updating',
        input: updateInput,
        prepare: openImage,
    },
])('a file that cannot be read when $action', ({ input, prepare }) => {
    const nothingMade = () => {
        expect(keymaster.createImage).not.toHaveBeenCalled();
        expect(keymaster.updateImage).not.toHaveBeenCalled();
        expect(setSuccess).not.toHaveBeenCalled();
    };

    it('is reported', async () => {
        const user = userEvent.setup({ delay: null });
        render(<ImageTab />);
        await prepare(user);
        readingEndsWith(reader => reader.onerror?.call(reader, new ProgressEvent('error') as ProgressEvent<FileReader>));

        await user.upload(input(), png());

        await waitFor(() => expect(setError).toHaveBeenCalledWith(expect.stringMatching(/^Error reading file: /)));
        nothingMade();
    });

    it('is reported when the read yields nothing', async () => {
        const user = userEvent.setup({ delay: null });
        render(<ImageTab />);
        await prepare(user);
        readingEndsWith(reader => reader.onload?.call(reader, { target: { result: null } } as ProgressEvent<FileReader>));

        await user.upload(input(), png());

        await waitFor(() => expect(setError).toHaveBeenCalledWith('Unexpected file reader result'));
        nothingMade();
    });

    it('is reported when the read yields something other than bytes', async () => {
        const user = userEvent.setup({ delay: null });
        render(<ImageTab />);
        await prepare(user);
        readingEndsWith(reader => reader.onload?.call(reader, { target: { result: 'text' } } as ProgressEvent<FileReader>));

        await user.upload(input(), png());

        await waitFor(() => expect(setError).toHaveBeenCalledWith('Unexpected file reader result type'));
        nothingMade();
    });

    it('is reported when it cannot be handed to the reader', async () => {
        const user = userEvent.setup({ delay: null });
        render(<ImageTab />);
        await prepare(user);
        vi.spyOn(FileReader.prototype, 'readAsArrayBuffer').mockImplementation(() => {
            throw new Error('not a file');
        });

        await user.upload(input(), png());

        await waitFor(() => expect(setError).toHaveBeenCalledWith('Error uploading image: Error: not a file'));
        nothingMade();
    });
});

describe('renaming an image', () => {
    async function openRename(user: UserEvent) {
        await openImage(user);
        await user.click(renameButton());
        return screen.findByRole('dialog');
    }

    it('asks for the new name, starting from the old one', async () => {
        const user = userEvent.setup({ delay: null });
        render(<ImageTab />);

        const dialog = await openRename(user);

        expect(dialog).toHaveTextContent('Rename Image');
        expect(dialog).toHaveTextContent("Rename 'cat'");
        expect(within(dialog).getByLabelText('New Name')).toHaveValue('cat');
    });

    it('moves the alias to the new name and stays on the image', async () => {
        const user = userEvent.setup({ delay: null });
        walletData.refreshAliases.mockImplementation(async () => {
            variables.aliasList = { kitten: CAT, notes: 'did:cid:notes' };
            variables.imageList = ['kitten', 'notes'];
        });
        render(<ImageTab />);
        const dialog = await openRename(user);

        const field = within(dialog).getByLabelText('New Name');
        await user.clear(field);
        await user.type(field, ' kitten ');
        await user.click(within(dialog).getByRole('button', { name: 'Rename' }));

        await waitFor(() => expect(setSuccess).toHaveBeenCalledWith('Image renamed'));
        expect(keymaster.addAlias).toHaveBeenCalledWith('kitten', CAT);
        expect(keymaster.removeAlias).toHaveBeenCalledWith('cat');
        expect(keymaster.addAlias.mock.invocationCallOrder[0])
            .toBeLessThan(keymaster.removeAlias.mock.invocationCallOrder[0]);
        expect(walletData.refreshAliases).toHaveBeenCalledTimes(1);
        expect(keymaster.resolveDID).toHaveBeenLastCalledWith('kitten', {});
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(imagePicker()).toHaveTextContent('kitten');
        expect(screen.getByRole('img')).toHaveAttribute('src', dataUrl('cid-cat'));
        expect(setError).not.toHaveBeenCalled();
    });

    it.each([
        ['is unchanged', 'cat'],
        ['is empty', ''],
    ])('changes nothing when the name %s', async (_case, name) => {
        const user = userEvent.setup({ delay: null });
        render(<ImageTab />);
        const dialog = await openRename(user);

        const field = within(dialog).getByLabelText('New Name');
        await user.clear(field);
        if (name) {
            await user.type(field, name);
        }
        await user.click(within(dialog).getByRole('button', { name: 'Rename' }));

        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(keymaster.addAlias).not.toHaveBeenCalled();
        expect(keymaster.removeAlias).not.toHaveBeenCalled();
        expect(setSuccess).not.toHaveBeenCalled();
    });

    it('changes nothing on Cancel', async () => {
        const user = userEvent.setup({ delay: null });
        render(<ImageTab />);
        const dialog = await openRename(user);

        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(keymaster.addAlias).not.toHaveBeenCalled();
    });

    it('reports a name the wallet refuses and keeps the old one', async () => {
        const user = userEvent.setup({ delay: null });
        const failure = new Error('Invalid parameter: alias already used');
        keymaster.addAlias.mockRejectedValue(failure);
        render(<ImageTab />);
        const dialog = await openRename(user);

        const field = within(dialog).getByLabelText('New Name');
        await user.clear(field);
        await user.type(field, 'notes');
        await user.click(within(dialog).getByRole('button', { name: 'Rename' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(keymaster.removeAlias).not.toHaveBeenCalled();
        expect(setSuccess).not.toHaveBeenCalled();
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(imagePicker()).toHaveTextContent('cat');
    });
});
