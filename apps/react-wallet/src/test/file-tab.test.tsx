import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import FileTab from '../../../../packages/wallet-ui/src/components/FileTab';

// The Files tab uploads a file to the node and names the asset made for it,
// and for the file picked shows its details and versions, replaces its
// contents, renames it and downloads it.

const { keymaster, wallet, variables, walletData, setError, setSuccess, openView } = vi.hoisted(() => {
    const keymaster = {
        resolveDID: vi.fn(), createAsset: vi.fn(), mergeData: vi.fn(),
        listAliases: vi.fn(), addAlias: vi.fn(), removeAlias: vi.fn(),
    };

    return {
        keymaster,
        wallet: { keymaster: keymaster as typeof keymaster | null, gatekeeperUrl: '' },
        variables: {
            registries: [] as string[],
            aliasList: {} as Record<string, string>,
            fileList: [] as string[] | null,
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

const NODE = 'http://node.example';
const REPORT = 'did:cid:report';
const NEW_DID = 'did:cid:new';

const reportFile = { cid: 'cid-report', filename: 'my report.pdf', type: 'application/pdf', bytes: 2048 };

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

beforeEach(() => {
    vi.resetAllMocks();
    wallet.keymaster = keymaster;
    wallet.gatekeeperUrl = NODE;
    variables.registries = ['hyperswarm', 'BTC:mainnet'];
    variables.aliasList = { report: REPORT, empty: 'did:cid:empty' };
    variables.fileList = ['report', 'empty'];
    keymaster.resolveDID.mockResolvedValue(resolved(REPORT, { file: reportFile }));
    keymaster.createAsset.mockResolvedValue(NEW_DID);
    keymaster.listAliases.mockResolvedValue({ report: REPORT, empty: 'did:cid:empty' });
    // These three answer true once the wallet or the update is saved.
    keymaster.addAlias.mockResolvedValue(true);
    keymaster.removeAlias.mockResolvedValue(true);
    keymaster.mergeData.mockResolvedValue(true);
});

afterEach(() => {
    vi.restoreAllMocks();
});

// Neither picker has a label: they are told apart by order.
const registryPicker = () => screen.getAllByRole('combobox')[0];
const filePicker = () => screen.getAllByRole('combobox')[1];
const uploadInput = () => document.getElementById('fileUpload') as HTMLInputElement;
const updateInput = () => document.getElementById('fileUpdate') as HTMLInputElement;
const downloadButton = () => within(screen.getByLabelText('Download')).getByRole('button');
const renameButton = () => within(screen.getByLabelText('Rename')).getByRole('button');
// A line of the details, such as "CID: cid-report".
const detail = (label: string) => screen.getByText(label).parentElement as HTMLElement;

const pdf = (name = 'report.pdf') => new File(['file contents'], name, { type: 'application/pdf' });

async function openFile(user: UserEvent, name = 'report') {
    await user.click(filePicker());
    await user.click(await screen.findByRole('option', { name }));
    await screen.findByText('DID:');
}

// Stands in for the request that streams a file to the node. Nothing is sent:
// the test says how the request goes, as the node or the network would.
function nodeUpload() {
    const sent: { xhr?: XMLHttpRequest; body?: unknown } = {};
    const open = vi.spyOn(XMLHttpRequest.prototype, 'open').mockImplementation(() => undefined);
    const setRequestHeader = vi.spyOn(XMLHttpRequest.prototype, 'setRequestHeader').mockImplementation(() => undefined);
    vi.spyOn(XMLHttpRequest.prototype, 'send').mockImplementation(function (this: XMLHttpRequest, body?: unknown) {
        sent.xhr = this;
        sent.body = body;
    });
    const started = () => waitFor(() => expect(sent.xhr).toBeDefined());

    return {
        open,
        setRequestHeader,
        sent,
        started,
        progress(loaded: number, total: number, lengthComputable = true) {
            const upload = sent.xhr!.upload;
            act(() => {
                upload.dispatchEvent(new ProgressEvent('progress', { lengthComputable, loaded, total }));
            });
        },
        async answer(status: number, text: string) {
            await started();
            vi.spyOn(XMLHttpRequest.prototype, 'status', 'get').mockReturnValue(status);
            vi.spyOn(XMLHttpRequest.prototype, 'responseText', 'get').mockReturnValue(text);
            const xhr = sent.xhr!;
            await act(async () => {
                xhr.onload?.call(xhr, new ProgressEvent('load'));
            });
        },
        async fail() {
            await started();
            const xhr = sent.xhr!;
            await act(async () => {
                xhr.onerror?.call(xhr, new ProgressEvent('error'));
            });
        },
    };
}

// What the wallet's lists hold once the uploaded file has its alias.
function aliasAppearsAs(name: string) {
    walletData.refreshAliases.mockImplementation(async () => {
        variables.aliasList = { ...variables.aliasList, [name]: NEW_DID };
        variables.fileList = [...(variables.fileList ?? []), name];
    });
}

describe('uploading a file', () => {
    it('opens the file chooser from the Upload button', async () => {
        const user = userEvent.setup({ delay: null });
        render(<FileTab />);
        const chosen = vi.fn();
        uploadInput().addEventListener('click', chosen);

        await user.click(screen.getByRole('button', { name: 'Upload' }));

        expect(chosen).toHaveBeenCalledTimes(1);
    });

    it('streams the file to the node, makes an asset of it on hyperswarm, names it and opens it', async () => {
        const user = userEvent.setup({ delay: null });
        const upload = nodeUpload();
        const file = pdf();
        aliasAppearsAs('report.pdf');
        keymaster.resolveDID.mockResolvedValue(resolved(NEW_DID, {
            file: { cid: 'cid-new', filename: 'report.pdf', type: 'application/pdf', bytes: file.size },
        }));
        render(<FileTab />);

        await user.upload(uploadInput(), file);
        await upload.answer(200, 'cid-new');

        await waitFor(() => expect(setSuccess).toHaveBeenCalledWith('File uploaded successfully: report.pdf'));
        expect(upload.open).toHaveBeenCalledWith('POST', `${NODE}/api/v1/ipfs/stream`);
        expect(upload.setRequestHeader).toHaveBeenCalledWith('Content-Type', 'application/octet-stream');
        expect(upload.sent.body).toBe(file);
        expect(keymaster.createAsset).toHaveBeenCalledWith(
            { file: { cid: 'cid-new', filename: 'report.pdf', type: 'application/pdf', bytes: file.size } },
            { registry: 'hyperswarm' },
        );
        expect(keymaster.addAlias).toHaveBeenCalledWith('report.pdf', NEW_DID);
        expect(walletData.refreshAliases).toHaveBeenCalledTimes(1);
        await waitFor(() => expect(detail('DID:')).toHaveTextContent(`DID: ${NEW_DID}`));
        expect(keymaster.resolveDID).toHaveBeenCalledWith('report.pdf', {});
        expect(filePicker()).toHaveTextContent('report.pdf');
        expect(setError).not.toHaveBeenCalled();
    });

    it('makes the asset on the registry chosen', async () => {
        const user = userEvent.setup({ delay: null });
        const upload = nodeUpload();
        render(<FileTab />);

        await user.click(registryPicker());
        await user.click(await screen.findByRole('option', { name: 'BTC:mainnet' }));
        await user.upload(uploadInput(), pdf());
        await upload.answer(200, 'cid-new');

        await waitFor(() => expect(keymaster.createAsset).toHaveBeenCalledWith(
            expect.objectContaining({ file: expect.objectContaining({ cid: 'cid-new' }) }),
            { registry: 'BTC:mainnet' },
        ));
    });

    it('records a file of no known type as plain bytes', async () => {
        const upload = nodeUpload();
        render(<FileTab />);

        // A file with no type is not one the chooser's filter lets through, so
        // it is handed to the input directly.
        fireEvent.change(uploadInput(), { target: { files: [new File(['abc'], 'data.bin')] } });
        await upload.answer(200, 'cid-new');

        await waitFor(() => expect(keymaster.createAsset).toHaveBeenCalledWith(
            { file: { cid: 'cid-new', filename: 'data.bin', type: 'application/octet-stream', bytes: 3 } },
            { registry: 'hyperswarm' },
        ));
    });

    it('names the asset by the first 26 characters of the file name', async () => {
        const user = userEvent.setup({ delay: null });
        const upload = nodeUpload();
        render(<FileTab />);

        await user.upload(uploadInput(), pdf('a-very-long-name-for-a-quarterly-report.pdf'));
        await upload.answer(200, 'cid-new');

        await waitFor(() => expect(keymaster.addAlias).toHaveBeenCalledWith('a-very-long-name-for-a-qua', NEW_DID));
    });

    it('numbers a name that ends in a space where it is cut, when the wallet has it trimmed', async () => {
        const user = userEvent.setup({ delay: null });
        const upload = nodeUpload();
        keymaster.listAliases.mockResolvedValue({ 'my quarterly report for a': 'did:cid:one' });
        render(<FileTab />);

        await user.upload(uploadInput(), pdf('my quarterly report for a board.pdf'));
        await upload.answer(200, 'cid-new');

        await waitFor(() => expect(keymaster.addAlias).toHaveBeenCalledWith('my quarterly report for a (1)', NEW_DID));
    });

    it('numbers the name when the wallet already has it', async () => {
        const user = userEvent.setup({ delay: null });
        const upload = nodeUpload();
        keymaster.listAliases.mockResolvedValue({ 'report.pdf': 'did:cid:one', 'report.pdf (1)': 'did:cid:two' });
        render(<FileTab />);

        await user.upload(uploadInput(), pdf());
        await upload.answer(200, 'cid-new');

        await waitFor(() => expect(keymaster.addAlias).toHaveBeenCalledWith('report.pdf (2)', NEW_DID));
        expect(setSuccess).toHaveBeenCalledWith('File uploaded successfully: report.pdf (2)');
    });

    it('shows how much has been sent while the upload runs', async () => {
        const user = userEvent.setup({ delay: null });
        const upload = nodeUpload();
        render(<FileTab />);

        await user.upload(uploadInput(), pdf());
        await upload.started();
        expect(screen.queryByRole('progressbar')).toBeNull();

        // A report with no total says nothing about how far along the upload is.
        upload.progress(10, 0, false);
        expect(screen.queryByRole('progressbar')).toBeNull();

        upload.progress(512, 1536);
        expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '33');
        expect(screen.getByText('512 B / 1.5 KB (33.3%)')).toBeInTheDocument();

        upload.progress(5 * 1024 * 1024, 2 * 1024 * 1024 * 1024);
        expect(screen.getByText('5.0 MB / 2.0 GB (0.2%)')).toBeInTheDocument();

        await upload.answer(200, 'cid-new');
        await waitFor(() => expect(screen.queryByRole('progressbar')).toBeNull());
    });

    it('reports a file the node refuses', async () => {
        const user = userEvent.setup({ delay: null });
        const upload = nodeUpload();
        render(<FileTab />);

        await user.upload(uploadInput(), pdf());
        await upload.started();
        upload.progress(1, 2);
        await upload.answer(500, 'Error: no space left');

        await waitFor(() =>
            expect(setError).toHaveBeenCalledExactlyOnceWith(new Error('Upload failed: Error: no space left')));
        expect(screen.queryByRole('progressbar')).toBeNull();
        expect(keymaster.createAsset).not.toHaveBeenCalled();
        expect(setSuccess).not.toHaveBeenCalled();
    });

    it('reports an upload the network drops', async () => {
        const user = userEvent.setup({ delay: null });
        const upload = nodeUpload();
        render(<FileTab />);

        await user.upload(uploadInput(), pdf());
        await upload.started();
        upload.progress(1, 2);
        await upload.fail();

        await waitFor(() =>
            expect(setError).toHaveBeenCalledExactlyOnceWith(new Error('Upload failed: network error')));
        expect(screen.queryByRole('progressbar')).toBeNull();
        expect(keymaster.createAsset).not.toHaveBeenCalled();
    });

    it('reports an asset that cannot be made', async () => {
        const user = userEvent.setup({ delay: null });
        const upload = nodeUpload();
        const refusal = new Error('registry unavailable');
        keymaster.createAsset.mockRejectedValue(refusal);
        render(<FileTab />);

        await user.upload(uploadInput(), pdf());
        await upload.answer(200, 'cid-new');

        await waitFor(() =>
            expect(setError).toHaveBeenCalledExactlyOnceWith(refusal));
        expect(keymaster.addAlias).not.toHaveBeenCalled();
        expect(setSuccess).not.toHaveBeenCalled();
    });

    it('sends nothing when the chooser is closed with no file', () => {
        const upload = nodeUpload();
        render(<FileTab />);

        fireEvent.change(uploadInput(), { target: { files: [] } });

        expect(upload.sent.xhr).toBeUndefined();
        expect(setError).not.toHaveBeenCalled();
    });

    it('sends nothing while the wallet has no keymaster', async () => {
        const user = userEvent.setup({ delay: null });
        const upload = nodeUpload();
        wallet.keymaster = null;
        render(<FileTab />);

        await user.upload(uploadInput(), pdf());

        expect(upload.sent.xhr).toBeUndefined();
        expect(setError).not.toHaveBeenCalled();
    });
});

describe('the file picked', () => {
    it('offers the wallet\'s files', async () => {
        const user = userEvent.setup({ delay: null });
        render(<FileTab />);

        expect(filePicker()).toHaveTextContent('Select file');
        await user.click(filePicker());

        const names = (await screen.findAllByRole('option')).map(option => option.textContent);
        expect(names).toEqual(['Select file', 'report', 'empty']);
    });

    it('has no picker while the wallet\'s files are not known', () => {
        variables.fileList = null;
        render(<FileTab />);

        expect(screen.getAllByRole('combobox')).toHaveLength(1);
        expect(screen.queryByRole('button', { name: 'Update' })).toBeNull();
    });

    it('offers nothing to do with a file until one is picked', () => {
        render(<FileTab />);

        expect(screen.getByRole('button', { name: 'Update' })).toBeDisabled();
        expect(downloadButton()).toBeDisabled();
        expect(renameButton()).toBeDisabled();
        expect(screen.queryByText('DID:')).toBeNull();
    });

    it('shows its details', async () => {
        const user = userEvent.setup({ delay: null });
        render(<FileTab />);

        await openFile(user);

        expect(keymaster.resolveDID).toHaveBeenCalledWith('report', {});
        expect(detail('DID:')).toHaveTextContent(`DID: ${REPORT}`);
        expect(detail('CID:')).toHaveTextContent('CID: cid-report');
        expect(detail('Filename:')).toHaveTextContent('Filename: my report.pdf');
        expect(detail('Created:')).toHaveTextContent('Created: 2026-01-02T03:04:05Z');
        // A file never updated shows when it was created.
        expect(detail('Updated:')).toHaveTextContent('Updated: 2026-01-02T03:04:05Z');
        expect(detail('Version:')).toHaveTextContent('Version: 1');
        expect(detail('File size:')).toHaveTextContent('File size: 2048 bytes');
        expect(detail('File type:')).toHaveTextContent('File type: application/pdf');
        expect(downloadButton()).toBeEnabled();
        expect(setError).not.toHaveBeenCalled();
    });

    it('shows when it was last updated', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.resolveDID.mockResolvedValue(resolved(REPORT, { file: reportFile }, 2, '2026-02-03T04:05:06Z'));
        render(<FileTab />);

        await openFile(user);

        expect(detail('Updated:')).toHaveTextContent('Updated: 2026-02-03T04:05:06Z');
        expect(detail('Version:')).toHaveTextContent('Version: 2');
    });

    it('says so when the asset holds no file', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.resolveDID.mockResolvedValue(resolved('did:cid:empty', {}));
        render(<FileTab />);

        await user.click(filePicker());
        await user.click(await screen.findByRole('option', { name: 'empty' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith('No file data found in version 1'));
        expect(screen.queryByText('DID:')).toBeNull();
        expect(downloadButton()).toBeDisabled();
    });

    it('reports a file that cannot be resolved', async () => {
        const user = userEvent.setup({ delay: null });
        const failure = new Error('Invalid DID: unknown');
        keymaster.resolveDID.mockRejectedValue(failure);
        render(<FileTab />);

        await user.click(filePicker());
        await user.click(await screen.findByRole('option', { name: 'report' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(screen.queryByText('DID:')).toBeNull();
    });

    it('resolves nothing while the wallet has no keymaster', async () => {
        const user = userEvent.setup({ delay: null });
        wallet.keymaster = null;
        render(<FileTab />);

        await user.click(filePicker());
        await user.click(await screen.findByRole('option', { name: 'report' }));

        await waitFor(() => expect(filePicker()).toHaveTextContent('report'));
        expect(keymaster.resolveDID).not.toHaveBeenCalled();
        expect(screen.queryByText('DID:')).toBeNull();
    });
});

describe('the versions of a file', () => {
    const versions = {
        1: { ...reportFile, cid: 'cid-v1', bytes: 100 },
        2: { ...reportFile, cid: 'cid-v2', bytes: 200 },
        3: { ...reportFile, cid: 'cid-v3', bytes: 300 },
    };

    beforeEach(() => {
        keymaster.resolveDID.mockImplementation(async (_name: string, options?: { versionSequence?: number }) => {
            const version = (options?.versionSequence ?? 3) as 1 | 2 | 3;
            return resolved(REPORT, { file: versions[version] }, version);
        });
    });

    it('opens on the latest and shows an earlier one when it is picked', async () => {
        const user = userEvent.setup({ delay: null });
        render(<FileTab />);
        await openFile(user);
        expect(detail('CID:')).toHaveTextContent('cid-v3');

        await user.click(screen.getByText('version 3'));
        const offered = (await screen.findAllByRole('option')).map(option => option.textContent);
        expect(offered).toEqual(['version 1', 'version 2', 'version 3']);
        await user.click(screen.getByRole('option', { name: 'version 2' }));

        await waitFor(() => expect(detail('CID:')).toHaveTextContent('cid-v2'));
        expect(keymaster.resolveDID).toHaveBeenLastCalledWith('report', { versionSequence: 2 });
        expect(detail('Version:')).toHaveTextContent('Version: 2');
        expect(detail('File size:')).toHaveTextContent('200 bytes');

        // Looking at an earlier version does not shorten the list of versions.
        await user.click(screen.getByText('version 2'));
        expect(await screen.findAllByRole('option')).toHaveLength(3);
    });

    it('says so when a version holds no file, and reports it by its number', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.resolveDID.mockImplementation(async (_name: string, options?: { versionSequence?: number }) =>
            options?.versionSequence === 2
                ? resolved(REPORT, { note: 'not a file yet' }, 2)
                : resolved(REPORT, { file: versions[3] }, 3));
        render(<FileTab />);
        await openFile(user);

        await user.click(screen.getByText('version 3'));
        await user.click(await screen.findByRole('option', { name: 'version 2' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith('No file data found in version 2'));
    });
});

describe('updating a file', () => {
    it('opens the file chooser from the Update button', async () => {
        const user = userEvent.setup({ delay: null });
        render(<FileTab />);
        await openFile(user);
        const chosen = vi.fn();
        updateInput().addEventListener('click', chosen);

        await user.click(screen.getByRole('button', { name: 'Update' }));

        expect(chosen).toHaveBeenCalledTimes(1);
    });

    it('streams the new file to the node and puts it in the asset', async () => {
        const user = userEvent.setup({ delay: null });
        const upload = nodeUpload();
        const file = pdf('final.pdf');
        render(<FileTab />);
        await openFile(user);
        const updated = { cid: 'cid-final', filename: 'final.pdf', type: 'application/pdf', bytes: file.size };
        keymaster.resolveDID.mockResolvedValue(resolved(REPORT, { file: updated }, 2, '2026-02-03T04:05:06Z'));

        await user.upload(updateInput(), file);
        await upload.answer(200, 'cid-final');

        await waitFor(() => expect(setSuccess).toHaveBeenCalledWith('File updated successfully'));
        expect(upload.open).toHaveBeenCalledWith('POST', `${NODE}/api/v1/ipfs/stream`);
        expect(upload.sent.body).toBe(file);
        expect(keymaster.mergeData).toHaveBeenCalledWith(REPORT, { file: updated });
        await waitFor(() => expect(detail('CID:')).toHaveTextContent('cid-final'));
        expect(detail('Filename:')).toHaveTextContent('final.pdf');
        expect(detail('Version:')).toHaveTextContent('Version: 2');
        expect(keymaster.resolveDID).toHaveBeenLastCalledWith('report', {});
        expect(keymaster.createAsset).not.toHaveBeenCalled();
        expect(setError).not.toHaveBeenCalled();
    });

    it('records a new file of no known type as plain bytes', async () => {
        const user = userEvent.setup({ delay: null });
        const upload = nodeUpload();
        render(<FileTab />);
        await openFile(user);

        fireEvent.change(updateInput(), { target: { files: [new File(['abc'], 'data.bin')] } });
        await upload.answer(200, 'cid-bin');

        await waitFor(() => expect(keymaster.mergeData).toHaveBeenCalledWith(REPORT, {
            file: { cid: 'cid-bin', filename: 'data.bin', type: 'application/octet-stream', bytes: 3 },
        }));
    });

    it('reports an update the node refuses', async () => {
        const user = userEvent.setup({ delay: null });
        const upload = nodeUpload();
        render(<FileTab />);
        await openFile(user);

        await user.upload(updateInput(), pdf());
        await upload.answer(500, 'Error: no space left');

        await waitFor(() =>
            expect(setError).toHaveBeenCalledExactlyOnceWith(new Error('Upload failed: Error: no space left')));
        expect(keymaster.mergeData).not.toHaveBeenCalled();
        expect(setSuccess).not.toHaveBeenCalled();
    });

    it('reports an update the asset does not take', async () => {
        const user = userEvent.setup({ delay: null });
        const upload = nodeUpload();
        const refusal = new Error('not the owner');
        keymaster.mergeData.mockRejectedValue(refusal);
        render(<FileTab />);
        await openFile(user);

        await user.upload(updateInput(), pdf());
        await upload.answer(200, 'cid-final');

        await waitFor(() => expect(setError).toHaveBeenCalledExactlyOnceWith(refusal));
        expect(setSuccess).not.toHaveBeenCalled();
        expect(detail('CID:')).toHaveTextContent('cid-report');
    });

    it('sends nothing when the chooser is closed with no file', async () => {
        const user = userEvent.setup({ delay: null });
        const upload = nodeUpload();
        render(<FileTab />);
        await openFile(user);

        fireEvent.change(updateInput(), { target: { files: [] } });

        expect(upload.sent.xhr).toBeUndefined();
        expect(setError).not.toHaveBeenCalled();
    });

    it('sends nothing when no file is picked to update', () => {
        const upload = nodeUpload();
        render(<FileTab />);

        // The button is disabled then, so the input is reached directly.
        fireEvent.change(updateInput(), { target: { files: [pdf()] } });

        expect(upload.sent.xhr).toBeUndefined();
        expect(keymaster.mergeData).not.toHaveBeenCalled();
    });
});

describe('downloading a file', () => {
    // Stands in for the browser following a download link, and keeps the link.
    function followedLinks() {
        const links: Array<{ href: string; download: string }> = [];
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
            links.push({ href: this.href, download: this.download });
        });
        return links;
    }

    it('asks the node for the file\'s bytes under its own name and type', async () => {
        const user = userEvent.setup({ delay: null });
        const links = followedLinks();
        render(<FileTab />);
        await openFile(user);

        await user.click(downloadButton());

        expect(links).toEqual([{
            href: `${NODE}/api/v1/ipfs/stream/cid-report?filename=my%20report.pdf&type=application%2Fpdf`,
            download: 'my report.pdf',
        }]);
    });

    it('asks for plain bytes under a stock name when the asset gives neither', async () => {
        const user = userEvent.setup({ delay: null });
        const links = followedLinks();
        // An asset made by some other client need not record a name or a type.
        keymaster.resolveDID.mockResolvedValue(resolved(REPORT, { file: { cid: 'cid-bare' } }));
        render(<FileTab />);
        await openFile(user);

        await user.click(downloadButton());

        expect(links).toEqual([{
            href: `${NODE}/api/v1/ipfs/stream/cid-bare?filename=download.bin&type=application%2Foctet-stream`,
            download: 'download.bin',
        }]);
    });
});

describe('renaming a file', () => {
    async function openRename(user: UserEvent) {
        await openFile(user);
        await user.click(renameButton());
        return screen.findByRole('dialog');
    }

    it('asks for the new name, starting from the old one', async () => {
        const user = userEvent.setup({ delay: null });
        render(<FileTab />);

        const dialog = await openRename(user);

        expect(dialog).toHaveTextContent('Rename File');
        expect(dialog).toHaveTextContent("Rename 'report'");
        expect(within(dialog).getByLabelText('New Name')).toHaveValue('report');
    });

    it('moves the alias to the new name and stays on the file', async () => {
        const user = userEvent.setup({ delay: null });
        walletData.refreshAliases.mockImplementation(async () => {
            variables.aliasList = { final: REPORT, empty: 'did:cid:empty' };
            variables.fileList = ['final', 'empty'];
        });
        render(<FileTab />);
        const dialog = await openRename(user);

        const field = within(dialog).getByLabelText('New Name');
        await user.clear(field);
        await user.type(field, ' final ');
        await user.click(within(dialog).getByRole('button', { name: 'Rename' }));

        await waitFor(() => expect(setSuccess).toHaveBeenCalledWith('File renamed'));
        expect(keymaster.addAlias).toHaveBeenCalledWith('final', REPORT);
        expect(keymaster.removeAlias).toHaveBeenCalledWith('report');
        expect(keymaster.addAlias.mock.invocationCallOrder[0])
            .toBeLessThan(keymaster.removeAlias.mock.invocationCallOrder[0]);
        expect(walletData.refreshAliases).toHaveBeenCalledTimes(1);
        expect(keymaster.resolveDID).toHaveBeenLastCalledWith('final', {});
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(filePicker()).toHaveTextContent('final');
        expect(detail('DID:')).toHaveTextContent(REPORT);
        expect(setError).not.toHaveBeenCalled();
    });

    it.each([
        ['is unchanged', 'report'],
        ['is empty', ''],
    ])('changes nothing when the name %s', async (_case, name) => {
        const user = userEvent.setup({ delay: null });
        render(<FileTab />);
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
        render(<FileTab />);
        const dialog = await openRename(user);

        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(keymaster.addAlias).not.toHaveBeenCalled();
    });

    it('reports a name the wallet refuses and keeps the old one', async () => {
        const user = userEvent.setup({ delay: null });
        const failure = new Error('Invalid parameter: alias already used');
        keymaster.addAlias.mockRejectedValue(failure);
        render(<FileTab />);
        const dialog = await openRename(user);

        const field = within(dialog).getByLabelText('New Name');
        await user.clear(field);
        await user.type(field, 'empty');
        await user.click(within(dialog).getByRole('button', { name: 'Rename' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(failure));
        expect(keymaster.removeAlias).not.toHaveBeenCalled();
        expect(setSuccess).not.toHaveBeenCalled();
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(filePicker()).toHaveTextContent('report');
    });
});
