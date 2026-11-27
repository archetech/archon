import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import {
    BASIC_MESSAGE_TYPE, DISCOVER_FEATURES_DISCLOSE_TYPE, TRUST_PING_RESPONSE_TYPE, TRUST_PING_TYPE,
    basicMessage, encodeOutOfBandInvitation, issueCredentialMessage, outOfBandInvitation, trustPing,
} from '@didcid/keymaster/didcomm-protocols';
import DidCommTab from '../../../../packages/wallet-ui/src/components/DidCommTab';

// The DIDComm tab reads this identity's mailbox, sends messages and pings,
// makes and reads out-of-band invitations, and publishes the endpoint others
// deliver to.

const { keymaster, wallet, variables, platform, setError, setSuccess } = vi.hoisted(() => {
    const keymaster = {
        resolveDID: vi.fn(), receiveDidComm: vi.fn(), sendDidComm: vi.fn(), ackDidComm: vi.fn(),
        acceptCredentialDidComm: vi.fn(), publishDidComm: vi.fn(), unpublishDidComm: vi.fn(),
    };

    return {
        keymaster,
        wallet: { keymaster: keymaster as typeof keymaster | null },
        variables: { currentId: 'Alice', currentDID: 'did:cid:alice', agentList: ['Bob'] as string[] | null },
        platform: {} as { scanQr?: () => Promise<string | null>; loadRefreshInterval?: () => Promise<number> },
        setError: vi.fn(),
        setSuccess: vi.fn(),
    };
});
vi.mock('../../../../packages/wallet-ui/src/contexts/WalletProvider', () => ({ useWalletContext: () => wallet }));
vi.mock('../../../../packages/wallet-ui/src/contexts/VariablesProvider', () => ({ useVariablesContext: () => variables }));
vi.mock('../../../../packages/wallet-ui/src/contexts/SnackbarProvider', () => ({ useSnackbar: () => ({ setError, setSuccess }) }));
vi.mock('../../../../packages/wallet-ui/src/contexts/PlatformCapabilities', () => ({ usePlatformCapabilities: () => platform }));

const ALICE = 'did:cid:alice';
const BOB = 'did:cid:bob';

type Service = { id: string; type: string; serviceEndpoint: string | { uri: string; accept?: string[]; routingKeys?: string[] } };

// What Keymaster.resolveDID returns for an agent: the Gatekeeper's document,
// with the version and ownership it adds to the metadata.
function agentDoc(did: string, { service, keyAgreement }: { service?: Service[]; keyAgreement?: boolean } = {}) {
    return {
        didDocument: {
            '@context': ['https://www.w3.org/ns/did/v1'],
            id: did,
            verificationMethod: [{ id: '#key-1', controller: did, type: 'EcdsaSecp256k1VerificationKey2019' }],
            authentication: ['#key-1'],
            ...(keyAgreement ? { keyAgreement: [`${did}#key-agreement-1`] } : {}),
            ...(service ? { service } : {}),
        },
        didDocumentMetadata: { created: '2026-01-01T00:00:00Z', versionSequence: '1', version: 1, isOwned: true },
        didDocumentData: {},
        didDocumentRegistration: { version: 1, type: 'agent', registry: 'hyperswarm' },
        didResolutionMetadata: {},
    };
}

// The service publishDidComm writes: always the object form.
const relay = (routingKeys: string[] = []): Service => ({
    id: `${ALICE}#didcomm`,
    type: 'DIDCommMessaging',
    serviceEndpoint: { uri: 'https://relay.example/didcomm', accept: ['didcomm/v2'], routingKeys },
});

// What receiveDidComm returns for each message it could unpack.
function received(id: string, message: Record<string, unknown>, sender?: string) {
    return {
        id,
        message,
        metadata: {
            encrypted: true,
            authenticated: Boolean(sender),
            nonRepudiation: false,
            sender: sender ? `${sender}#key-agreement-1` : undefined,
            signer: undefined,
        },
    };
}

const created = 1767225600;

beforeEach(() => {
    vi.resetAllMocks();
    wallet.keymaster = keymaster;
    variables.currentId = 'Alice';
    variables.currentDID = ALICE;
    variables.agentList = ['Bob'];
    platform.scanQr = undefined;
    platform.loadRefreshInterval = async () => 0;
    keymaster.resolveDID.mockImplementation(async (did: string) => agentDoc(did === 'Bob' ? BOB : did));
    keymaster.receiveDidComm.mockResolvedValue([]);
    keymaster.sendDidComm.mockResolvedValue(['message-id']);
    keymaster.ackDidComm.mockImplementation(async (ids: string[]) => ids.length);
    keymaster.publishDidComm.mockResolvedValue(true);
    keymaster.unpublishDidComm.mockResolvedValue(true);
});

async function renderTab(): Promise<UserEvent> {
    const user = userEvent.setup({ delay: null });
    render(<DidCommTab />);
    await screen.findByRole('heading', { name: 'DIDComm' });
    return user;
}

async function openTab(name: string): Promise<UserEvent> {
    const user = await renderTab();
    await user.click(screen.getByRole('tab', { name }));
    return user;
}

// A message's block is the nearest ancestor that holds the divider closing it.
function messageOf(text: string | HTMLElement): HTMLElement {
    let node = (typeof text === 'string' ? screen.getByText(text) : text).parentElement;
    while (node && !node.querySelector('hr')) {
        node = node.parentElement;
    }
    return node!;
}

describe('the DIDComm inbox', () => {
    it('reads the mailbox without removing anything from it', async () => {
        await renderTab();

        await waitFor(() => expect(keymaster.receiveDidComm).toHaveBeenCalledWith({ name: 'Alice', ack: false }));
        expect(screen.getByRole('tab', { name: 'Inbox' }).getAttribute('aria-selected')).toBe('true');
    });

    it('asks for an endpoint when nothing is published and the mailbox is empty', async () => {
        await renderTab();

        expect(await screen.findByText('No messages')).toBeTruthy();
        expect(screen.getByText('Publish an endpoint so others have somewhere to deliver messages.')).toBeTruthy();
    });

    it('says the mailbox is empty when an endpoint is published', async () => {
        keymaster.resolveDID.mockResolvedValue(agentDoc(ALICE, { service: [relay()], keyAgreement: true }));
        await renderTab();

        expect(await screen.findByText('Nothing in the mailbox for this identity.')).toBeTruthy();
    });

    it('shows a message from an authenticated sender, and replies to that sender', async () => {
        keymaster.receiveDidComm.mockResolvedValue([
            received('m1', { ...basicMessage('Hello Alice'), id: 'msg-1', from: BOB, created_time: created }, BOB),
        ]);
        const user = await renderTab();

        const message = messageOf(await screen.findByText('Hello Alice'));
        expect(within(message).getByText('Message')).toBeTruthy();
        expect(within(message).getByText('Authenticated')).toBeTruthy();
        expect(within(message).getByText(`From: ${BOB}`)).toBeTruthy();
        // created_time is in seconds.
        expect(within(message).getByText(new Date(created * 1000).toLocaleString())).toBeTruthy();
        expect(within(message).queryByRole('button', { name: 'Respond' })).toBeNull();

        await user.click(within(message).getByRole('button', { name: 'Reply' }));
        expect(screen.getByRole('tab', { name: 'Compose' }).getAttribute('aria-selected')).toBe('true');
        expect((screen.getByLabelText(/^To \(DID or alias\)/) as HTMLInputElement).value).toBe(BOB);
    });

    it('marks what an anonymous message claims about its sender as unverified, and offers no reply', async () => {
        keymaster.receiveDidComm.mockResolvedValue([
            received('m1', { ...basicMessage('Guess who'), id: 'msg-1', from: 'did:cid:claimed' }),
            received('m2', { ...basicMessage('Nobody'), id: 'msg-2' }),
        ]);
        await renderTab();

        const claimed = messageOf(await screen.findByText('Guess who'));
        expect(within(claimed).getByText('Anonymous')).toBeTruthy();
        expect(within(claimed).getByText('From: did:cid:claimed (unverified)')).toBeTruthy();
        expect(within(claimed).queryByRole('button', { name: 'Reply' })).toBeNull();

        expect(within(messageOf('Nobody')).getByText('From: unknown')).toBeTruthy();
    });

    it('answers an authenticated trust ping to its sender', async () => {
        keymaster.receiveDidComm.mockResolvedValue([
            received('m1', { ...trustPing(), id: 'ping-1', from: BOB }, BOB),
        ]);
        const user = await renderTab();

        const ping = messageOf(await screen.findByText('Trust ping'));
        expect(within(ping).getByText(/"response_requested": true/)).toBeTruthy();
        await user.click(within(ping).getByRole('button', { name: 'Respond' }));

        await waitFor(() => expect(setSuccess).toHaveBeenCalledWith('Ping response sent'));
        expect(keymaster.sendDidComm).toHaveBeenCalledWith(
            { type: TRUST_PING_RESPONSE_TYPE, thid: 'ping-1', body: {} }, BOB, { name: 'Alice' },
        );
    });

    it('reports a ping response that fails to send', async () => {
        keymaster.receiveDidComm.mockResolvedValue([received('m1', { ...trustPing(), id: 'ping-1' }, BOB)]);
        keymaster.sendDidComm.mockRejectedValue(new Error('recipient unreachable'));
        const user = await renderTab();

        await user.click(await screen.findByRole('button', { name: 'Respond' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(expect.objectContaining({ message: 'recipient unreachable' })));
        expect(setSuccess).not.toHaveBeenCalled();
    });

    it('cannot answer a ping that has no id to answer', async () => {
        // Keymaster gives every message it packs an id; another agent may not.
        keymaster.receiveDidComm.mockResolvedValue([received('m1', { ...trustPing(), from: BOB }, BOB)]);
        const user = await renderTab();

        await user.click(await screen.findByRole('button', { name: 'Respond' }));

        expect(setError).toHaveBeenCalledWith('This ping has no authenticated sender to respond to');
        expect(keymaster.sendDidComm).not.toHaveBeenCalled();
    });

    it('offers no response to an anonymous ping', async () => {
        keymaster.receiveDidComm.mockResolvedValue([received('m1', { ...trustPing(), id: 'ping-1' })]);
        await renderTab();

        expect(within(messageOf(await screen.findByText('Trust ping'))).queryByRole('button', { name: 'Respond' })).toBeNull();
    });

    it('shows the body of a message of a kind it does not know, under its type', async () => {
        keymaster.receiveDidComm.mockResolvedValue([
            received('m1', { type: DISCOVER_FEATURES_DISCLOSE_TYPE, id: 'd-1', from: BOB, body: { disclosures: [] } }, BOB),
            received('m2', { id: 'x-1' }, BOB),
        ]);
        await renderTab();

        const disclosure = messageOf(await screen.findByText(DISCOVER_FEATURES_DISCLOSE_TYPE));
        expect(within(disclosure).getByText(/"disclosures": \[\]/)).toBeTruthy();
        expect(within(disclosure).queryByRole('button', { name: 'Reply' })).toBeNull();
        expect(within(disclosure).queryByRole('button', { name: 'Accept' })).toBeNull();

        expect(within(messageOf('Unknown')).getByText('{}')).toBeTruthy();
    });

    describe('a credential', () => {
        const vc = {
            '@context': ['https://www.w3.org/ns/credentials/v2'],
            id: 'did:cid:credential',
            type: ['VerifiableCredential', 'MembershipCredential'],
            issuer: BOB,
            validFrom: '2026-01-01T00:00:00Z',
            validUntil: '2027-01-01T00:00:00Z',
            credentialSubject: { id: ALICE, member: 'yes' },
        };
        const offered = { ...issueCredentialMessage(vc, { credentialDid: 'did:cid:credential' }), id: 'cred-1', from: BOB };

        it('shows what the credential asserts and who issued it', async () => {
            keymaster.receiveDidComm.mockResolvedValue([received('m1', offered, BOB)]);
            await renderTab();

            const credential = messageOf(await screen.findByText('MembershipCredential'));
            expect(within(credential).getByText('Credential')).toBeTruthy();
            expect(within(credential).getByText(`Issued by ${BOB}`)).toBeTruthy();
            expect(within(credential).getByText(`Valid until ${new Date(vc.validUntil).toLocaleString()}`)).toBeTruthy();
            expect(within(credential).getByText(/"member": "yes"/)).toBeTruthy();
        });

        it('names a credential of no particular type, and an issuer it does not give', async () => {
            const plain = { ...vc, type: ['VerifiableCredential'], issuer: undefined, validUntil: undefined, credentialSubject: undefined };
            keymaster.receiveDidComm.mockResolvedValue([
                received('m1', { ...issueCredentialMessage(plain), id: 'cred-1', from: BOB }, BOB),
            ]);
            await renderTab();

            const credential = messageOf(await screen.findByText('Verifiable credential'));
            expect(within(credential).getByText('Issued by unknown')).toBeTruthy();
            expect(within(credential).queryByText(/Valid until/)).toBeNull();
            expect(within(credential).getByText('{}')).toBeTruthy();
        });

        it('says so when the message carries no credential', async () => {
            const { attachments: _attachments, ...empty } = offered;
            keymaster.receiveDidComm.mockResolvedValue([received('m1', empty, BOB)]);
            await renderTab();

            expect(await screen.findByText('This credential message carries no credential.')).toBeTruthy();
        });

        it('adds an accepted credential to the wallet and dismisses its message', async () => {
            keymaster.receiveDidComm.mockResolvedValueOnce([received('m1', offered, BOB)]).mockResolvedValue([]);
            keymaster.acceptCredentialDidComm.mockResolvedValue(true);
            const user = await renderTab();

            await user.click(within(messageOf(await screen.findByText('MembershipCredential'))).getByRole('button', { name: 'Accept' }));

            await waitFor(() => expect(setSuccess).toHaveBeenCalledWith('Message dismissed'));
            expect(keymaster.acceptCredentialDidComm).toHaveBeenCalledWith(offered);
            expect(setSuccess).toHaveBeenCalledWith('Credential added to your wallet');
            expect(keymaster.ackDidComm).toHaveBeenCalledWith(['m1'], { name: 'Alice' });
            expect(await screen.findByText('No messages')).toBeTruthy();
        });

        it('keeps a credential the wallet cannot hold, and says why', async () => {
            keymaster.receiveDidComm.mockResolvedValue([received('m1', offered, BOB)]);
            keymaster.acceptCredentialDidComm.mockResolvedValue(false);
            const user = await renderTab();

            await user.click(await screen.findByRole('button', { name: 'Accept' }));

            await waitFor(() => expect(setError).toHaveBeenCalledWith('This credential has no DID this wallet can resolve, so it cannot be held'));
            expect(setSuccess).not.toHaveBeenCalled();
            expect(keymaster.ackDidComm).not.toHaveBeenCalled();
            expect(screen.getByText('MembershipCredential')).toBeTruthy();
        });

        it('reports a credential it fails to accept', async () => {
            keymaster.receiveDidComm.mockResolvedValue([received('m1', offered, BOB)]);
            keymaster.acceptCredentialDidComm.mockRejectedValue(new Error('not the holder'));
            const user = await renderTab();

            await user.click(await screen.findByRole('button', { name: 'Accept' }));

            await waitFor(() => expect(setError).toHaveBeenCalledWith(expect.objectContaining({ message: 'not the holder' })));
            expect(keymaster.ackDidComm).not.toHaveBeenCalled();
        });
    });

    it('dismisses one message and reads the mailbox again', async () => {
        keymaster.receiveDidComm
            .mockResolvedValueOnce([
                received('m1', { ...basicMessage('first'), id: 'a', from: BOB }, BOB),
                received('m2', { ...basicMessage('second'), id: 'b', from: BOB }, BOB),
            ])
            .mockResolvedValue([received('m2', { ...basicMessage('second'), id: 'b', from: BOB }, BOB)]);
        const user = await renderTab();

        await user.click(within(messageOf(await screen.findByText('first'))).getByRole('button', { name: 'Dismiss' }));

        await waitFor(() => expect(screen.queryByText('first')).toBeNull());
        expect(keymaster.ackDidComm).toHaveBeenCalledWith(['m1'], { name: 'Alice' });
        expect(setSuccess).toHaveBeenCalledWith('Message dismissed');
        expect(screen.getByText('second')).toBeTruthy();
    });

    it('dismisses every message at once', async () => {
        keymaster.receiveDidComm
            .mockResolvedValueOnce([
                received('m1', { ...basicMessage('first'), id: 'a' }),
                received('m2', { ...basicMessage('second'), id: 'b' }),
            ])
            .mockResolvedValue([]);
        const user = await renderTab();
        await screen.findByText('first');

        await user.click(screen.getByRole('button', { name: 'Manage' }));
        await user.click(await screen.findByRole('menuitem', { name: 'Dismiss all' }));

        await waitFor(() => expect(setSuccess).toHaveBeenCalledWith('2 messages dismissed'));
        expect(keymaster.ackDidComm).toHaveBeenCalledWith(['m1', 'm2'], { name: 'Alice' });
        expect(await screen.findByText('No messages')).toBeTruthy();
    });

    it('offers no Dismiss all for an empty mailbox', async () => {
        await renderTab();
        await screen.findByText('No messages');

        expect(screen.queryByRole('button', { name: 'Manage' })).toBeNull();
    });

    it('reports a dismissal that fails, and leaves the message', async () => {
        keymaster.receiveDidComm.mockResolvedValue([received('m1', { ...basicMessage('stays'), id: 'a' })]);
        keymaster.ackDidComm.mockRejectedValue(new Error('DIDComm ack failed: 500'));
        const user = await renderTab();

        await user.click(await screen.findByRole('button', { name: 'Dismiss' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(expect.objectContaining({ message: 'DIDComm ack failed: 500' })));
        expect(screen.getByText('stays')).toBeTruthy();
    });

    it('stays quiet when the first read fails, and reports a refresh that fails', async () => {
        keymaster.receiveDidComm.mockRejectedValue(new Error('DIDComm fetch failed: 502'));
        const user = await renderTab();

        expect(await screen.findByText('No messages')).toBeTruthy();
        expect(setError).not.toHaveBeenCalled();

        await user.click(screen.getByRole('button', { name: 'Refresh' }));
        await waitFor(() => expect(setError).toHaveBeenCalledWith(expect.objectContaining({ message: 'DIDComm fetch failed: 502' })));
    });

    it('does not start a second read while one is still going', async () => {
        let release!: (value: unknown) => void;
        keymaster.receiveDidComm.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
        const user = await renderTab();
        await waitFor(() => expect(keymaster.receiveDidComm).toHaveBeenCalledTimes(1));

        await user.click(screen.getByRole('button', { name: 'Refresh' }));
        expect(keymaster.receiveDidComm).toHaveBeenCalledTimes(1);

        await act(async () => { release([received('m1', { ...basicMessage('slow'), id: 'a' })]); });
        expect(screen.getByText('slow')).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Refresh' }));
        expect(keymaster.receiveDidComm).toHaveBeenCalledTimes(2);
    });

    it('shows what a refresh finds', async () => {
        const user = await renderTab();
        await screen.findByText('No messages');

        keymaster.receiveDidComm.mockResolvedValue([received('m1', { ...basicMessage('just arrived'), id: 'a' })]);
        await user.click(screen.getByRole('button', { name: 'Refresh' }));

        expect(await screen.findByText('just arrived')).toBeTruthy();
    });

    it('reads nothing with no identity', async () => {
        variables.currentId = '';
        variables.currentDID = '';
        await renderTab();

        expect(await screen.findByText('No messages')).toBeTruthy();
        expect(keymaster.receiveDidComm).not.toHaveBeenCalled();
        expect(keymaster.resolveDID).not.toHaveBeenCalled();
    });

    it('reads nothing with no keymaster', async () => {
        wallet.keymaster = null;
        await renderTab();

        expect(await screen.findByText('No messages')).toBeTruthy();
        expect(keymaster.receiveDidComm).not.toHaveBeenCalled();
    });

    describe('polling', () => {
        it('reads the mailbox again at the interval set in Settings, and stops when the screen goes', async () => {
            // A millisecond, so the polls come in real time without fake timers.
            platform.loadRefreshInterval = async () => 0.001;
            const shown = render(<DidCommTab />);

            await waitFor(() => expect(keymaster.receiveDidComm.mock.calls.length).toBeGreaterThan(3));
            expect(keymaster.receiveDidComm).toHaveBeenLastCalledWith({ name: 'Alice', ack: false });
            shown.unmount();
            const calls = keymaster.receiveDidComm.mock.calls.length;
            await new Promise(resolve => setTimeout(resolve, 20));
            expect(keymaster.receiveDidComm.mock.calls.length).toBe(calls);
        });

        it('does not report a poll that fails', async () => {
            platform.loadRefreshInterval = async () => 0.001;
            keymaster.receiveDidComm.mockRejectedValue(new Error('offline'));
            render(<DidCommTab />);

            await waitFor(() => expect(keymaster.receiveDidComm.mock.calls.length).toBeGreaterThan(3));
            expect(setError).not.toHaveBeenCalled();
        });

        it('starts polling when the interval is changed in Settings', async () => {
            let seconds = 0;
            platform.loadRefreshInterval = async () => seconds;
            render(<DidCommTab />);
            await screen.findByText('No messages');
            await new Promise(resolve => setTimeout(resolve, 20));
            expect(keymaster.receiveDidComm).toHaveBeenCalledTimes(1);

            seconds = 0.001;
            act(() => { window.dispatchEvent(new Event('archon:refresh-interval-change')); });

            await waitFor(() => expect(keymaster.receiveDidComm.mock.calls.length).toBeGreaterThan(3));
        });

        it('does not poll where the host cannot say an interval', async () => {
            platform.loadRefreshInterval = undefined;
            render(<DidCommTab />);
            await screen.findByText('No messages');
            await new Promise(resolve => setTimeout(resolve, 20));

            expect(keymaster.receiveDidComm).toHaveBeenCalledTimes(1);
        });
    });

    it('drops one identity\'s mail when the identity changes, even if its read finishes late', async () => {
        let release!: (value: unknown) => void;
        keymaster.receiveDidComm.mockImplementation(async ({ name }: { name: string }) => (name === 'Alice'
            ? new Promise(resolve => { release = resolve; })
            : [received('b1', { ...basicMessage('for Bob'), id: 'b' })]));
        const shown = render(<DidCommTab />);
        await screen.findByRole('heading', { name: 'DIDComm' });
        await waitFor(() => expect(keymaster.receiveDidComm).toHaveBeenCalledWith({ name: 'Alice', ack: false }));

        variables.currentId = 'Bob';
        variables.currentDID = BOB;
        shown.rerender(<DidCommTab />);
        expect(await screen.findByText('for Bob')).toBeTruthy();

        await act(async () => { release([received('a1', { ...basicMessage('for Alice'), id: 'a' })]); });
        expect(screen.queryByText('for Alice')).toBeNull();
        expect(screen.getByText('for Bob')).toBeTruthy();
    });
});

describe('composing a DIDComm message', () => {
    it('asks for a recipient', async () => {
        const user = await openTab('Compose');
        await user.click(screen.getByRole('button', { name: 'Send' }));

        expect(setError).toHaveBeenCalledWith('Enter a recipient DID or alias');
        expect(keymaster.sendDidComm).not.toHaveBeenCalled();
    });

    it('asks for a message', async () => {
        const user = await openTab('Compose');
        await user.type(screen.getByLabelText(/^To \(DID or alias\)/), BOB);
        await user.type(screen.getByRole('textbox', { name: /^Message/ }), '   ');
        await user.click(screen.getByRole('button', { name: 'Send' }));

        expect(setError).toHaveBeenCalledWith('Enter a message to send');
        expect(keymaster.sendDidComm).not.toHaveBeenCalled();
    });

    it('sends a message signed by the current identity, and clears it', async () => {
        const user = await openTab('Compose');
        expect(screen.getByText('The recipient can verify this came from the current identity.')).toBeTruthy();
        await user.type(screen.getByLabelText(/^To \(DID or alias\)/), ` ${BOB} `);
        await user.type(screen.getByRole('textbox', { name: /^Message/ }), 'hello');
        await user.click(screen.getByRole('button', { name: 'Send' }));

        await waitFor(() => expect(setSuccess).toHaveBeenCalledWith('Message sent'));
        expect(keymaster.sendDidComm).toHaveBeenCalledWith(
            { type: BASIC_MESSAGE_TYPE, body: { content: 'hello' } }, BOB, { name: 'Alice', anoncrypt: false },
        );
        expect((screen.getByRole('textbox', { name: /^Message/ }) as HTMLInputElement).value).toBe('');
    });

    it('sends anonymously when asked', async () => {
        const user = await openTab('Compose');
        await user.click(screen.getByRole('checkbox', { name: 'Send anonymously' }));
        expect(screen.getByText('The recipient cannot tell who sent this, and cannot reply to it.')).toBeTruthy();
        await user.type(screen.getByLabelText(/^To \(DID or alias\)/), BOB);
        await user.type(screen.getByRole('textbox', { name: /^Message/ }), 'hello');
        await user.click(screen.getByRole('button', { name: 'Send' }));

        await waitFor(() => expect(keymaster.sendDidComm).toHaveBeenCalled());
        expect(keymaster.sendDidComm.mock.calls[0][2]).toStrictEqual({ name: 'Alice', anoncrypt: true });
    });

    it('sends a trust ping, which needs no message', async () => {
        const user = await openTab('Compose');
        await user.type(screen.getByLabelText(/^To \(DID or alias\)/), BOB);
        await user.click(screen.getByRole('combobox', { name: 'Type' }));
        await user.click(await screen.findByRole('option', { name: 'Trust ping' }));
        expect(screen.queryByRole('textbox', { name: /^Message/ })).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Send' }));

        await waitFor(() => expect(setSuccess).toHaveBeenCalledWith('Ping sent'));
        expect(keymaster.sendDidComm).toHaveBeenCalledWith(
            { type: TRUST_PING_TYPE, body: { response_requested: true } }, BOB, { name: 'Alice', anoncrypt: false },
        );
    });

    it('offers the wallet\'s agents as recipients', async () => {
        const user = await openTab('Compose');
        await user.click(screen.getByLabelText(/^To \(DID or alias\)/));
        await user.click(await screen.findByRole('option', { name: 'Bob' }));
        await user.type(screen.getByRole('textbox', { name: /^Message/ }), 'hi');
        await user.click(screen.getByRole('button', { name: 'Send' }));

        await waitFor(() => expect(keymaster.sendDidComm).toHaveBeenCalled());
        expect(keymaster.resolveDID).toHaveBeenCalledWith('Bob');
        expect(keymaster.sendDidComm.mock.calls[0][1]).toBe(BOB);
    });

    it('reports an alias it cannot resolve, and sends nothing', async () => {
        keymaster.resolveDID.mockImplementation(async (did: string) => {
            if (did === 'Nobody') {
                throw new Error('Invalid parameter: unknown id');
            }
            return agentDoc(did);
        });
        const user = await openTab('Compose');
        await user.type(screen.getByLabelText(/^To \(DID or alias\)/), 'Nobody');
        await user.type(screen.getByRole('textbox', { name: /^Message/ }), 'hello');
        await user.click(screen.getByRole('button', { name: 'Send' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Invalid parameter: unknown id' })));
        expect(keymaster.sendDidComm).not.toHaveBeenCalled();
    });

    it('keeps the message when it fails to send, and lets the user try again', async () => {
        let fail!: (error: Error) => void;
        keymaster.sendDidComm.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
        const user = await openTab('Compose');
        await user.type(screen.getByLabelText(/^To \(DID or alias\)/), BOB);
        await user.type(screen.getByRole('textbox', { name: /^Message/ }), 'hello');
        await user.click(screen.getByRole('button', { name: 'Send' }));

        await waitFor(() => expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true));
        await act(async () => { fail(new Error('no DIDComm endpoint')); });

        expect(setError).toHaveBeenCalledWith(expect.objectContaining({ message: 'no DIDComm endpoint' }));
        expect(setSuccess).not.toHaveBeenCalled();
        expect((screen.getByRole('textbox', { name: /^Message/ }) as HTMLInputElement).value).toBe('hello');
        expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false);
    });
});

describe('DIDComm invitations', () => {
    const invitation = (body: Record<string, unknown> = {}) => encodeOutOfBandInvitation(outOfBandInvitation(BOB, body));

    it('makes an invitation that names the current identity, and copies its link', async () => {
        const user = await openTab('Invite');
        expect(screen.getByText('Create an invitation to show a QR code and a link.')).toBeTruthy();

        await user.click(screen.getByRole('button', { name: 'Create' }));

        const url = encodeOutOfBandInvitation(outOfBandInvitation(ALICE));
        expect(screen.getByText(url)).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Regenerate' })).toBeTruthy();

        // userEvent.setup puts its own clipboard in place, so it is spied on after.
        const writeText = vi.spyOn(navigator.clipboard, 'writeText');
        await user.click(screen.getByRole('button', { name: 'Copy link' }));
        expect(writeText).toHaveBeenCalledWith(url);
        expect(setSuccess).toHaveBeenCalledWith('Invitation copied');
    });

    it('says to copy the link by hand when the clipboard is refused', async () => {
        const user = await openTab('Invite');
        await user.click(screen.getByRole('button', { name: 'Create' }));
        vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));

        await user.click(screen.getByRole('button', { name: 'Copy link' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith('Could not copy — select the link and copy it manually'));
    });

    it('makes no invitation with no identity', async () => {
        variables.currentId = '';
        variables.currentDID = '';
        const user = await openTab('Invite');
        await user.click(screen.getByRole('button', { name: 'Create' }));

        expect(setError).toHaveBeenCalledWith('Select an identity first');
        expect(screen.queryByRole('button', { name: 'Copy link' })).toBeNull();
    });

    it('drops the invitation when the identity changes', async () => {
        const user = userEvent.setup({ delay: null });
        const shown = render(<DidCommTab />);
        await user.click(await screen.findByRole('tab', { name: 'Invite' }));
        await user.click(screen.getByRole('button', { name: 'Create' }));
        await user.type(screen.getByLabelText('Invitation URL'), invitation());
        await user.click(screen.getByRole('button', { name: 'Accept' }));
        expect(screen.getByText('Invitation from')).toBeTruthy();

        variables.currentId = 'Bob';
        variables.currentDID = BOB;
        shown.rerender(<DidCommTab />);

        await waitFor(() => expect(screen.queryByRole('button', { name: 'Copy link' })).toBeNull());
        expect(screen.queryByText('Invitation from')).toBeNull();
        expect((screen.getByLabelText('Invitation URL') as HTMLInputElement).value).toBe('');
    });

    it('reads a pasted invitation, and starts a message to whoever it names', async () => {
        const user = await openTab('Invite');
        await user.type(screen.getByLabelText('Invitation URL'), invitation({ goal: 'Chat about the project' }));
        await user.click(screen.getByRole('button', { name: 'Accept' }));

        expect(screen.getByText(BOB)).toBeTruthy();
        expect(screen.getByText('Purpose: Chat about the project')).toBeTruthy();

        await user.click(screen.getByRole('button', { name: 'Message them' }));
        expect(screen.getByRole('tab', { name: 'Compose' }).getAttribute('aria-selected')).toBe('true');
        expect((screen.getByLabelText(/^To \(DID or alias\)/) as HTMLInputElement).value).toBe(BOB);
    });

    it('shows no purpose that is not text', async () => {
        const user = await openTab('Invite');
        await user.type(screen.getByLabelText('Invitation URL'), invitation({ goal: { not: 'text' } }));
        await user.click(screen.getByRole('button', { name: 'Accept' }));

        expect(screen.getByText(BOB)).toBeTruthy();
        expect(screen.queryByText(/Purpose:/)).toBeNull();
    });

    it.each([
        ['nothing', '', 'Paste an invitation URL first'],
        ['something that is not an invitation', 'https://didcomm.org?_oob=!!!', 'Could not read that invitation'],
        ['an invitation that names no inviter', encodeOutOfBandInvitation({ type: 'x', body: {} }), 'That invitation names no inviter'],
        ['an invitation whose inviter is not text', encodeOutOfBandInvitation({ type: 'x', from: { id: BOB } }), 'That invitation names no inviter'],
        ['an invitation whose inviter is blank', encodeOutOfBandInvitation({ type: 'x', from: '   ' }), 'That invitation names no inviter'],
    ])('refuses %s', async (_case, pasted, error) => {
        const user = await openTab('Invite');
        if (pasted) {
            await user.click(screen.getByLabelText('Invitation URL'));
            await user.paste(pasted);
        }
        await user.click(screen.getByRole('button', { name: 'Accept' }));

        expect(setError).toHaveBeenCalledWith(error);
        expect(screen.queryByRole('button', { name: 'Message them' })).toBeNull();
    });

    it('drops the last inviter when the next invitation cannot be read', async () => {
        const user = await openTab('Invite');
        await user.type(screen.getByLabelText('Invitation URL'), invitation());
        await user.click(screen.getByRole('button', { name: 'Accept' }));
        expect(screen.getByRole('button', { name: 'Message them' })).toBeTruthy();

        await user.clear(screen.getByLabelText('Invitation URL'));
        await user.type(screen.getByLabelText('Invitation URL'), 'not an invitation');
        await user.click(screen.getByRole('button', { name: 'Accept' }));

        expect(setError).toHaveBeenCalledWith('Could not read that invitation');
        expect(screen.queryByRole('button', { name: 'Message them' })).toBeNull();
    });

    it('offers no scan where there is no camera', async () => {
        await openTab('Invite');

        expect(screen.queryByRole('button', { name: 'Scan' })).toBeNull();
    });

    it('reads a scanned invitation', async () => {
        const url = invitation({ goal: 'Say hi' });
        platform.scanQr = vi.fn().mockResolvedValue(url);
        const user = await openTab('Invite');
        await user.click(screen.getByRole('button', { name: 'Scan' }));

        expect(await screen.findByText('Purpose: Say hi')).toBeTruthy();
        expect((screen.getByLabelText('Invitation URL') as HTMLInputElement).value).toBe(url);
    });

    it('reports a scan that finds nothing', async () => {
        platform.scanQr = vi.fn().mockResolvedValue(null);
        const user = await openTab('Invite');
        await user.click(screen.getByRole('button', { name: 'Scan' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith('Failed to scan QR code'));
        expect(screen.queryByText('Invitation from')).toBeNull();
    });
});

describe('the DIDComm endpoint', () => {
    it('says nothing is published, and publishes the node\'s own relay when no endpoint is given', async () => {
        keymaster.resolveDID
            .mockResolvedValueOnce(agentDoc(ALICE))
            .mockResolvedValue(agentDoc(ALICE, { service: [relay()], keyAgreement: true }));
        const user = await openTab('Endpoint');
        expect(screen.getByText('No DIDComm endpoint published')).toBeTruthy();

        await user.click(screen.getByRole('button', { name: 'Publish' }));

        await waitFor(() => expect(setSuccess).toHaveBeenCalledWith('DIDComm endpoint published'));
        expect(keymaster.publishDidComm).toHaveBeenCalledWith(undefined, 'Alice', undefined);
        expect(await screen.findByText('https://relay.example/didcomm')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Update' })).toBeTruthy();
    });

    it('publishes an endpoint and routing keys that are given, and clears the fields', async () => {
        const user = await openTab('Endpoint');
        await user.type(screen.getByLabelText('Endpoint URL (optional)'), ' https://mediator.example/didcomm ');
        await user.type(screen.getByLabelText('Routing keys (optional, comma separated)'), 'did:cid:m#ka-1, did:cid:m#ka-2, ,');
        await user.click(screen.getByRole('button', { name: 'Publish' }));

        await waitFor(() => expect(setSuccess).toHaveBeenCalledWith('DIDComm endpoint published'));
        expect(keymaster.publishDidComm).toHaveBeenCalledWith(
            'https://mediator.example/didcomm', 'Alice', ['did:cid:m#ka-1', 'did:cid:m#ka-2'],
        );
        expect((screen.getByLabelText('Endpoint URL (optional)') as HTMLInputElement).value).toBe('');
        expect((screen.getByLabelText('Routing keys (optional, comma separated)') as HTMLInputElement).value).toBe('');
    });

    it('reports a publish that fails, and keeps what was typed', async () => {
        keymaster.publishDidComm.mockRejectedValue(new Error('update failed'));
        const user = await openTab('Endpoint');
        await user.type(screen.getByLabelText('Endpoint URL (optional)'), 'https://relay.example');
        await user.click(screen.getByRole('button', { name: 'Publish' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(expect.objectContaining({ message: 'update failed' })));
        expect(setSuccess).not.toHaveBeenCalled();
        expect((screen.getByLabelText('Endpoint URL (optional)') as HTMLInputElement).value).toBe('https://relay.example');
    });

    it('shows the published endpoint, its routing keys and the key agreement', async () => {
        keymaster.resolveDID.mockResolvedValue(agentDoc(ALICE, { service: [relay(['did:cid:m#ka-1'])], keyAgreement: true }));
        await openTab('Endpoint');

        expect(screen.getByRole('heading', { name: 'Published' })).toBeTruthy();
        expect(screen.getByText('https://relay.example/didcomm')).toBeTruthy();
        expect(screen.getByText('Routing keys')).toBeTruthy();
        expect(screen.getByText('did:cid:m#ka-1')).toBeTruthy();
        expect(screen.getByText('Key agreement').parentElement!.textContent).toContain('Published');
        expect(screen.getByRole('button', { name: 'Update' })).toBeTruthy();
    });

    it('reads an endpoint published in the plain string form', async () => {
        keymaster.resolveDID.mockResolvedValue(agentDoc(ALICE, {
            service: [{ id: `${ALICE}#didcomm`, type: 'DIDCommMessaging', serviceEndpoint: 'https://plain.example/didcomm' }],
            keyAgreement: true,
        }));
        await openTab('Endpoint');

        expect(screen.getByText('https://plain.example/didcomm')).toBeTruthy();
        expect(screen.queryByText('Routing keys')).toBeNull();
    });

    it('reads an object endpoint that names no routing keys', async () => {
        keymaster.resolveDID.mockResolvedValue(agentDoc(ALICE, {
            service: [{ id: `${ALICE}#didcomm`, type: 'DIDCommMessaging', serviceEndpoint: { uri: 'https://bare.example' } }],
            keyAgreement: true,
        }));
        await openTab('Endpoint');

        expect(screen.getByText('https://bare.example')).toBeTruthy();
        expect(screen.queryByText('Routing keys')).toBeNull();
    });

    it('marks a key published with nowhere to deliver', async () => {
        keymaster.resolveDID.mockResolvedValue(agentDoc(ALICE, { keyAgreement: true }));
        await openTab('Endpoint');

        expect(screen.getByText('Key only')).toBeTruthy();
        expect(screen.getByText('Others can encrypt to this identity but have nowhere to deliver.')).toBeTruthy();
    });

    it('marks an endpoint published without a key agreement key', async () => {
        keymaster.resolveDID.mockResolvedValue(agentDoc(ALICE, { service: [relay()] }));
        await openTab('Endpoint');

        expect(screen.getByText('Key agreement').parentElement!.textContent).toContain('Missing');
    });

    it('ignores services that are not DIDComm', async () => {
        keymaster.resolveDID.mockResolvedValue(agentDoc(ALICE, {
            service: [{ id: `${ALICE}#email`, type: 'Email', serviceEndpoint: 'mailto:alice@example.org' }],
        }));
        await openTab('Endpoint');

        expect(screen.getByText('No DIDComm endpoint published')).toBeTruthy();
    });

    it('unpublishes', async () => {
        keymaster.resolveDID
            .mockResolvedValueOnce(agentDoc(ALICE, { service: [relay()], keyAgreement: true }))
            .mockResolvedValue(agentDoc(ALICE));
        const user = await openTab('Endpoint');

        await user.click(screen.getByRole('button', { name: 'Manage' }));
        await user.click(await screen.findByRole('menuitem', { name: 'Unpublish' }));

        await waitFor(() => expect(setSuccess).toHaveBeenCalledWith('DIDComm endpoint unpublished'));
        expect(keymaster.unpublishDidComm).toHaveBeenCalledWith('Alice');
        expect(await screen.findByText('No DIDComm endpoint published')).toBeTruthy();
    });

    it('reports an unpublish that fails', async () => {
        keymaster.resolveDID.mockResolvedValue(agentDoc(ALICE, { service: [relay()], keyAgreement: true }));
        keymaster.unpublishDidComm.mockRejectedValue(new Error('update failed'));
        const user = await openTab('Endpoint');

        await user.click(screen.getByRole('button', { name: 'Manage' }));
        await user.click(await screen.findByRole('menuitem', { name: 'Unpublish' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(expect.objectContaining({ message: 'update failed' })));
        expect(screen.getByText('https://relay.example/didcomm')).toBeTruthy();
    });

    it('reports an identity it cannot resolve, and shows nothing published', async () => {
        keymaster.resolveDID.mockRejectedValue(new Error('Invalid DID: unknown'));
        await openTab('Endpoint');

        expect(setError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Invalid DID: unknown' }));
        expect(screen.getByText('No DIDComm endpoint published')).toBeTruthy();
    });
});
