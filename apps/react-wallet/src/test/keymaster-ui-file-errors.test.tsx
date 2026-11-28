import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import KeymasterUI from '../../../../packages/keymaster-ui/src/KeymasterUI.jsx';

// The standalone clients report a file that cannot be read, and an upload
// Keymaster refuses, with what went wrong.

const ALICE = 'did:cid:alice';

const fns: Record<string, any> = {};
// The component reads a great deal on mount that has nothing to do with images.
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

beforeEach(() => {
    for (const key of Object.keys(fns)) {
        delete fns[key];
    }
    Object.assign(fns, {
        getCurrentId: vi.fn(async () => 'Alice'),
        listIds: vi.fn(async () => ['Alice']),
        listAliases: vi.fn(async () => ({})),
        listRegistries: vi.fn(async () => ['hyperswarm']),
        getVersion: vi.fn(async () => ({ version: '0', commit: 'test' })),
        resolveDID: vi.fn(async (id: string) => ({
            didDocument: { id: id === 'Alice' ? ALICE : id, service: [] },
            didDocumentData: {},
            didDocumentMetadata: { version: 1 },
            didDocumentRegistration: {},
        })),
    });
});

afterEach(() => {
    vi.restoreAllMocks();
});

const png = () => new File([new Uint8Array([137, 80, 78, 71])], 'photo.png', { type: 'image/png' });

async function uploadImage() {
    const { container } = render(<Panel keymaster={keymaster} title="Test" />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('tab', { name: 'Assets' }));
    await user.click(await screen.findByRole('tab', { name: 'Images' }));
    const registry = (await screen.findAllByRole('combobox')).find(box => box.textContent === 'Select registry');
    await user.click(registry as HTMLElement);
    await user.click(await screen.findByRole('option', { name: 'hyperswarm' }));
    expect(screen.getByRole('button', { name: 'Upload Image...' })).toBeEnabled();

    await user.upload(container.querySelector('#imageUpload') as HTMLInputElement, png());
}

function failRead(error: DOMException | null) {
    vi.spyOn(FileReader.prototype, 'readAsArrayBuffer').mockImplementation(function (this: FileReader) {
        Object.defineProperty(this, 'error', { value: error });
        this.onerror?.(new ProgressEvent('error') as ProgressEvent<FileReader>);
    });
}

describe('an image upload in the standalone clients', () => {
    it('reports why a file cannot be read', async () => {
        failRead(new DOMException('The file could not be read', 'NotReadableError'));

        await uploadImage();

        expect(await screen.findByText('The file could not be read')).toBeInTheDocument();
        expect(screen.queryByText(/ProgressEvent/)).toBeNull();
        expect(fns.createImage).toBeUndefined();
    });

    it('says a file cannot be read when the reader does not say why', async () => {
        failRead(null);

        await uploadImage();

        expect(await screen.findByText('Unable to read the file')).toBeInTheDocument();
    });

    it('reports what Keymaster says when it refuses the image', async () => {
        fns.createImage = vi.fn().mockRejectedValue(new Error('Image too large'));

        await uploadImage();

        expect(await screen.findByText('Image too large')).toBeInTheDocument();
    });
});
