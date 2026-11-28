import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import KeymasterUI from '../../../../packages/keymaster-ui/src/KeymasterUI.jsx';

// The standalone clients' Held list offers each credential's actions from the
// identity's manifest, as Keymaster's publishCredential writes it: the
// credential itself, its credentialSubject cut down to { id } unless revealed.

const ALICE = 'did:cid:alice';
const HELD = 'did:cid:held';

const fns: Record<string, any> = {};
// The component reads a great deal on mount that has nothing to do with credentials.
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

const hidden = { type: ['VerifiableCredential'], credentialSubject: { id: ALICE } };
const revealed = { type: ['VerifiableCredential'], credentialSubject: { id: ALICE, grade: 'A' } };

function withManifest(manifest?: Record<string, unknown>) {
    for (const key of Object.keys(fns)) {
        delete fns[key];
    }
    Object.assign(fns, {
        getCurrentId: vi.fn(async () => 'Alice'),
        listIds: vi.fn(async () => ['Alice']),
        listAliases: vi.fn(async () => ({})),
        listRegistries: vi.fn(async () => ['hyperswarm']),
        getVersion: vi.fn(async () => ({ version: '0', commit: 'test' })),
        listCredentials: vi.fn(async () => [HELD]),
        resolveDID: vi.fn(async (id: string) => ({
            didDocument: { id: id === 'Alice' ? ALICE : id, service: [] },
            didDocumentData: id === 'Alice' && manifest ? { manifest } : {},
            didDocumentMetadata: { version: 1 },
            didDocumentRegistration: {},
        })),
    });
}

beforeEach(() => withManifest());

async function heldRow() {
    render(<Panel keymaster={keymaster} title="Test" />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('tab', { name: 'Credentials' }));
    await user.click(await screen.findByRole('tab', { name: 'Held' }));

    return (await screen.findByText(HELD)).closest('tr') as HTMLElement;
}

const action = (row: HTMLElement, name: string) => within(row).getByRole('button', { name });

describe('a held credential in the standalone clients', () => {
    it('can be published or revealed while it is not published', async () => {
        const row = await heldRow();

        expect(action(row, 'Publish')).toBeEnabled();
        expect(action(row, 'Reveal')).toBeEnabled();
        expect(action(row, 'Unpublish')).toBeDisabled();
        expect(action(row, 'Remove')).toBeEnabled();
    });

    it('can be revealed or unpublished once published without its contents', async () => {
        withManifest({ [HELD]: hidden });
        const row = await heldRow();

        expect(action(row, 'Publish')).toBeDisabled();
        expect(action(row, 'Reveal')).toBeEnabled();
        expect(action(row, 'Unpublish')).toBeEnabled();
        expect(action(row, 'Remove')).toBeDisabled();
    });

    it('can only be unpublished once revealed', async () => {
        withManifest({ [HELD]: revealed });
        const row = await heldRow();

        expect(action(row, 'Publish')).toBeDisabled();
        expect(action(row, 'Reveal')).toBeDisabled();
        expect(action(row, 'Unpublish')).toBeEnabled();
        expect(action(row, 'Remove')).toBeDisabled();
    });
});
