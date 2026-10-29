import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DidCommTab from '../../../../packages/wallet-ui/src/components/DidCommTab';

const { keymaster, setError, setSuccess } = vi.hoisted(() => ({
    keymaster: { resolveDID: vi.fn(), receiveDidComm: vi.fn(), sendDidComm: vi.fn() },
    setError: vi.fn(),
    setSuccess: vi.fn(),
}));
vi.mock('../../../../packages/wallet-ui/src/contexts/WalletProvider', () => ({ useWalletContext: () => ({ keymaster }) }));
vi.mock('../../../../packages/wallet-ui/src/contexts/VariablesProvider', () => ({
    useVariablesContext: () => ({ currentId: 'Alice', currentDID: 'did:cid:alice', agentList: ['Bob'] }),
}));
vi.mock('../../../../packages/wallet-ui/src/contexts/SnackbarProvider', () => ({ useSnackbar: () => ({ setError, setSuccess }) }));
vi.mock('../../../../packages/wallet-ui/src/contexts/PlatformCapabilities', () => ({
    usePlatformCapabilities: () => ({ loadRefreshInterval: async () => 0 }),
}));

// A did:peer:4 as the DIF demo identifies itself; the gatekeeper below has no
// driver for it, which sendDidComm does not need.
const peerDid = 'did:peer:4zQmd8CpeFPci817KDsbSAKWcXAE2mjvCQSasRewvbSF54Bd:z2M1k7h4psgp4CmJcnQn2Ljp7Pz7ktsd7oBhMU3dWY5s4fhFNj17';

beforeEach(() => {
    vi.resetAllMocks();
    keymaster.resolveDID.mockImplementation(async (did: string) => {
        if (did.startsWith('did:peer:')) {
            throw new Error('unsupported DID method');
        }
        return { didDocument: { id: did === 'Bob' ? 'did:cid:bob' : did } };
    });
    keymaster.receiveDidComm.mockResolvedValue([]);
    keymaster.sendDidComm.mockResolvedValue(['sent']);
});

async function compose(recipient: string) {
    const user = userEvent.setup();
    render(<DidCommTab />);
    await user.click(await screen.findByRole('tab', { name: 'Compose' }));
    await user.type(screen.getByLabelText(/^To \(DID or alias\)/), recipient);
    await user.type(screen.getByRole('textbox', { name: /^Message/ }), 'hello');
    await user.click(screen.getByRole('button', { name: 'Send' }));
}

describe('DIDComm compose', () => {
    it('sends to a DID without resolving it through the gatekeeper', async () => {
        await compose(peerDid);
        await waitFor(() => expect(keymaster.sendDidComm).toHaveBeenCalled());
        expect(keymaster.sendDidComm.mock.calls[0][1]).toBe(peerDid);
        expect(keymaster.resolveDID).not.toHaveBeenCalledWith(peerDid);
        expect(setError).not.toHaveBeenCalled();
    });

    it('resolves an alias to its DID before sending', async () => {
        await compose('Bob');
        await waitFor(() => expect(keymaster.sendDidComm).toHaveBeenCalled());
        expect(keymaster.resolveDID).toHaveBeenCalledWith('Bob');
        expect(keymaster.sendDidComm.mock.calls[0][1]).toBe('did:cid:bob');
    });
});
