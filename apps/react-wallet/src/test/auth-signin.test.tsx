import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import AuthTab from '../../../../packages/wallet-ui/src/components/AuthTab';

// Signing in under the Auth tab: answering a challenge that arrives by a link
// or is typed, and making a challenge and checking the answer to it.

const { keymaster, wallet, navigation, platform, variables, axiosPost, setError, setSuccess } = vi.hoisted(() => {
    const keymaster = {
        resolveAsset: vi.fn(), createResponse: vi.fn(), decryptJSON: vi.fn(), verifyResponse: vi.fn(),
        createChallenge: vi.fn(), lookupDID: vi.fn(),
    };

    return {
        keymaster,
        wallet: { keymaster: keymaster as typeof keymaster | null },
        navigation: {
            pendingChallenge: null as string | null, setPendingChallenge: vi.fn(),
            pendingGrant: null as string | null, setPendingGrant: vi.fn(),
            dispatchDeepLink: vi.fn(), openView: vi.fn(),
        },
        platform: {} as { scanQr?: () => Promise<string | null> },
        variables: { currentId: 'Alice', currentDID: 'did:cid:alice', schemaList: [] as string[], agentList: [] as string[] },
        axiosPost: vi.fn(),
        setError: vi.fn(),
        setSuccess: vi.fn(),
    };
});
vi.mock('axios', () => ({ default: { post: axiosPost } }));
vi.mock('../../../../packages/wallet-ui/src/contexts/WalletProvider', () => ({ useWalletContext: () => wallet }));
vi.mock('../../../../packages/wallet-ui/src/contexts/VariablesProvider', () => ({ useVariablesContext: () => variables }));
vi.mock('../../../../packages/wallet-ui/src/contexts/SnackbarProvider', () => ({ useSnackbar: () => ({ setError, setSuccess }) }));
vi.mock('../../../../packages/wallet-ui/src/contexts/WalletNavigation', () => ({ useWalletNavigation: () => navigation }));
vi.mock('../../../../packages/wallet-ui/src/contexts/PlatformCapabilities', () => ({ usePlatformCapabilities: () => platform }));

const CHALLENGE = 'did:cid:challenge';
const RESPONSE = 'did:cid:response';
const CALLBACK = 'https://service.example/callback';

// What resolveAsset returns for a challenge: the asset's data, which
// createChallenge writes as { challenge }.
const challengeAsset = (challenge: Record<string, unknown> = { callback: CALLBACK }) => ({ challenge });

// What decryptJSON returns for a response createResponse made.
const responseContents = (requested = 0, fulfilled = 0, credentials: { vc: string; vp: string }[] = []) => ({
    response: { challenge: CHALLENGE, credentials, requested, fulfilled, match: requested === fulfilled },
});

beforeEach(() => {
    vi.resetAllMocks();
    wallet.keymaster = keymaster;
    navigation.pendingChallenge = null;
    navigation.pendingGrant = null;
    platform.scanQr = undefined;
    variables.schemaList = ['MembershipSchema', 'AgeSchema'];
    variables.agentList = ['Bob', 'Carol'];
    keymaster.resolveAsset.mockResolvedValue(challengeAsset());
    keymaster.createResponse.mockResolvedValue(RESPONSE);
    keymaster.decryptJSON.mockResolvedValue(responseContents());
    keymaster.lookupDID.mockImplementation(async (name: string) => `did:cid:${name.toLowerCase()}`);
    axiosPost.mockResolvedValue({ data: { authenticated: true } });
});

const input = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

// Signing in has two menus labelled More: the challenge's, then the response's.
async function chooseFromMenu(user: UserEvent, which: 0 | 1, item: string) {
    await user.click(screen.getAllByRole('button', { name: 'More' })[which]);
    await user.click(await screen.findByRole('menuitem', { name: item }));
}

async function menuItemDisabled(user: UserEvent, which: 0 | 1, item: string): Promise<boolean> {
    await user.click(screen.getAllByRole('button', { name: 'More' })[which]);
    const disabled = (await screen.findByRole('menuitem', { name: item })).getAttribute('aria-disabled') === 'true';
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    return disabled;
}

describe('a challenge that arrives by a link', () => {
    function arrive(did = CHALLENGE) {
        navigation.pendingChallenge = did;
        return render(<AuthTab />);
    }

    it('shows that it is working on the challenge', async () => {
        keymaster.createResponse.mockReturnValue(new Promise(() => {}));
        arrive();

        expect(await screen.findByText('Processing challenge...')).toBeTruthy();
        expect(screen.queryByLabelText('Challenge')).toBeNull();
        expect(navigation.setPendingChallenge).toHaveBeenCalledWith(null);
    });

    it('shows what answering it gives, and where the answer goes', async () => {
        keymaster.resolveAsset.mockResolvedValue(challengeAsset({ callback: CALLBACK, description: 'Connect your agent to example.org' }));
        arrive();

        expect(await screen.findByText(/Login Request/)).toBeTruthy();
        expect(screen.getByText('Connect your agent to example.org')).toBeTruthy();
        expect(screen.getByText('Destination')).toBeTruthy();
        expect(screen.getByText(CALLBACK)).toBeTruthy();
        expect(screen.getByText('Identity verification only (no credentials requested)')).toBeTruthy();
        expect(screen.getByText(RESPONSE)).toBeTruthy();
        expect(keymaster.createResponse).toHaveBeenCalledWith(CHALLENGE, { retries: 10 });
        expect(keymaster.decryptJSON).toHaveBeenCalledWith(RESPONSE);
    });

    it('shows no more than 500 characters of the description, and nothing that is not text', async () => {
        keymaster.resolveAsset.mockResolvedValue(challengeAsset({ callback: CALLBACK, description: 'x'.repeat(600) }));
        const shown = arrive();
        expect(await screen.findByText('x'.repeat(500))).toBeTruthy();
        shown.unmount();

        keymaster.resolveAsset.mockResolvedValue(challengeAsset({ callback: CALLBACK, description: { text: 'not text' } }));
        arrive('did:cid:other');
        expect(await screen.findByText(/Login Request/)).toBeTruthy();
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('says how many of the credentials asked for were matched', async () => {
        keymaster.decryptJSON.mockResolvedValue(responseContents(2, 2, [
            { vc: 'did:cid:vc1', vp: 'did:cid:vp1' }, { vc: 'did:cid:vc2', vp: 'did:cid:vp2' },
        ]));
        const shown = arrive();
        expect(await screen.findByText('2 of 2 credential(s) matched')).toBeTruthy();
        shown.unmount();

        keymaster.decryptJSON.mockResolvedValue(responseContents(2, 1, [{ vc: 'did:cid:vc1', vp: 'did:cid:vp1' }]));
        arrive('did:cid:other');
        expect(await screen.findByText('1 of 2 credential(s) matched')).toBeTruthy();
    });

    it('sends the response to the challenge\'s callback', async () => {
        const user = userEvent.setup({ delay: null });
        arrive();
        await user.click(await screen.findByRole('button', { name: 'Login' }));

        expect(axiosPost).toHaveBeenCalledWith(CALLBACK, { response: RESPONSE });
        expect(setSuccess).toHaveBeenCalledWith('Response sent successfully');
        expect(screen.getByText('Response sent')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Login' })).toBeNull();

        await user.click(button('Done'));
        expect(screen.queryByText(/Login Request/)).toBeNull();
        expect(input('Response').value).toBe(RESPONSE);
        // The callback has had its answer, so there is nothing left to send.
        expect(button('Send').disabled).toBe(true);
    });

    it('lets the user try again when the callback refuses the response', async () => {
        const user = userEvent.setup({ delay: null });
        axiosPost.mockRejectedValueOnce(new Error('Request failed with status code 401'));
        arrive();
        await user.click(await screen.findByRole('button', { name: 'Login' }));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Request failed with status code 401' })));
        expect(setSuccess).not.toHaveBeenCalled();
        expect(button('Login').disabled).toBe(false);

        await user.click(button('Login'));
        expect(axiosPost).toHaveBeenCalledTimes(2);
        expect(await screen.findByText('Response sent')).toBeTruthy();
    });

    it('offers no sign-in for a challenge with no callback, and leaves the response to send by hand', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.resolveAsset.mockResolvedValue(challengeAsset({}));
        arrive();

        expect(await screen.findByText(/Login Request/)).toBeTruthy();
        expect(screen.queryByText('Destination')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Login' })).toBeNull();

        await user.click(button('Cancel'));
        expect(input('Challenge').value).toBe(CHALLENGE);
        expect(input('Response').value).toBe(RESPONSE);
        expect(button('Send').disabled).toBe(true);
        expect(axiosPost).not.toHaveBeenCalled();
    });

    it('reports a challenge it cannot answer, and goes back to the form', async () => {
        keymaster.createResponse.mockRejectedValue(new Error('Invalid parameter: challengeDID'));
        arrive();

        await waitFor(() => expect(setError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Invalid parameter: challengeDID' })));
        expect(screen.queryByText('Processing challenge...')).toBeNull();
        expect(input('Challenge').value).toBe(CHALLENGE);
        expect(input('Response').value).toBe('');
    });

    it('answers a challenge that arrived before the wallet was ready, once it is', async () => {
        wallet.keymaster = null;
        const shown = arrive();
        expect(input('Challenge').value).toBe(CHALLENGE);
        expect(keymaster.createResponse).not.toHaveBeenCalled();

        wallet.keymaster = keymaster;
        navigation.pendingChallenge = null;
        await act(async () => { shown.rerender(<AuthTab />); });

        expect(await screen.findByText(/Login Request/)).toBeTruthy();
        expect(keymaster.createResponse).toHaveBeenCalledWith(CHALLENGE, { retries: 10 });
    });
});

describe('answering a challenge by hand', () => {
    async function respondTo(challenge = CHALLENGE): Promise<UserEvent> {
        const user = userEvent.setup({ delay: null });
        render(<AuthTab />);
        await user.type(input('Challenge'), ` ${challenge} `);
        await user.click(button('Respond'));
        return user;
    }

    it('offers nothing to do until there is a challenge or a response', async () => {
        const user = userEvent.setup({ delay: null });
        render(<AuthTab />);

        expect(button('Respond').disabled).toBe(true);
        expect(button('Send').disabled).toBe(true);
        expect(button('Verify').disabled).toBe(true);
        expect(await menuItemDisabled(user, 0, 'Resolve challenge')).toBe(true);
        expect(await menuItemDisabled(user, 0, 'Clear')).toBe(true);
        expect(await menuItemDisabled(user, 1, 'Decrypt response')).toBe(true);
        expect(await menuItemDisabled(user, 1, 'Clear')).toBe(true);
    });

    it('makes a response, and sends it to the challenge\'s callback', async () => {
        keymaster.resolveAsset.mockResolvedValue(challengeAsset({ callback: CALLBACK, description: 'Sign in to example.org' }));
        const user = await respondTo();

        await waitFor(() => expect(input('Response').value).toBe(RESPONSE));
        // The typed challenge loses its spaces.
        expect(keymaster.createResponse).toHaveBeenCalledWith(CHALLENGE, { retries: 10 });
        expect(screen.getByText('Sign in to example.org')).toBeTruthy();
        expect(button('Send').disabled).toBe(false);

        await user.click(button('Send'));
        expect(axiosPost).toHaveBeenCalledWith(CALLBACK, { response: RESPONSE });
        expect(button('Send').disabled).toBe(true);
        // The description goes with the callback it was shown for.
        expect(screen.queryByText('Sign in to example.org')).toBeNull();
    });

    it('reports a response the callback refuses', async () => {
        axiosPost.mockRejectedValue(new Error('Network Error'));
        const user = await respondTo();
        await waitFor(() => expect(button('Send').disabled).toBe(false));

        await user.click(button('Send'));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Network Error' })));
    });

    it('offers no send for a challenge with no callback', async () => {
        keymaster.resolveAsset.mockResolvedValue(challengeAsset({ description: 'nowhere to go' }));
        await respondTo();

        await waitFor(() => expect(input('Response').value).toBe(RESPONSE));
        expect(button('Send').disabled).toBe(true);
        // A description is shown only with somewhere to send the answer.
        expect(screen.queryByText('nowhere to go')).toBeNull();
    });

    it('reports a challenge it cannot answer', async () => {
        keymaster.createResponse.mockRejectedValue(new Error('Invalid parameter: challengeDID'));
        await respondTo();

        await waitFor(() => expect(setError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Invalid parameter: challengeDID' })));
        expect(input('Response').value).toBe('');
        expect(button('Send').disabled).toBe(true);
    });

    it('clears the challenge and the response', async () => {
        const user = await respondTo();
        await waitFor(() => expect(input('Response').value).toBe(RESPONSE));

        await chooseFromMenu(user, 0, 'Clear');
        expect(input('Challenge').value).toBe('');
        expect(button('Respond').disabled).toBe(true);

        await chooseFromMenu(user, 1, 'Clear');
        expect(input('Response').value).toBe('');
        expect(button('Verify').disabled).toBe(true);
    });

    it('shows a challenge in the viewer, once', async () => {
        const user = userEvent.setup({ delay: null });
        render(<AuthTab />);
        await user.type(input('Challenge'), CHALLENGE);

        await chooseFromMenu(user, 0, 'Resolve challenge');

        await waitFor(() => expect(navigation.openView).toHaveBeenCalledWith({ did: CHALLENGE, tab: 'viewer', contents: challengeAsset() }));
        expect(keymaster.resolveAsset).toHaveBeenCalledWith(CHALLENGE);
        expect(await menuItemDisabled(user, 0, 'Resolve challenge')).toBe(true);
    });

    it('reports a challenge it cannot resolve', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.resolveAsset.mockRejectedValue(new Error('Invalid DID: unknown'));
        render(<AuthTab />);
        await user.type(input('Challenge'), CHALLENGE);

        await chooseFromMenu(user, 0, 'Resolve challenge');

        await waitFor(() => expect(setError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Invalid DID: unknown' })));
        expect(navigation.openView).not.toHaveBeenCalled();
    });

    it('shows a decrypted response in the viewer, once', async () => {
        const user = userEvent.setup({ delay: null });
        render(<AuthTab />);
        await user.type(input('Response'), RESPONSE);

        await chooseFromMenu(user, 1, 'Decrypt response');

        await waitFor(() => expect(navigation.openView).toHaveBeenCalledWith({ did: RESPONSE, tab: 'viewer', contents: responseContents() }));
        expect(keymaster.decryptJSON).toHaveBeenCalledWith(RESPONSE);
        expect(await menuItemDisabled(user, 1, 'Decrypt response')).toBe(true);
    });

    it('reports a response it cannot decrypt', async () => {
        const user = userEvent.setup({ delay: null });
        keymaster.decryptJSON.mockRejectedValue(new Error('Cannot decrypt'));
        render(<AuthTab />);
        await user.type(input('Response'), RESPONSE);

        await chooseFromMenu(user, 1, 'Decrypt response');

        await waitFor(() => expect(setError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Cannot decrypt' })));
        expect(navigation.openView).not.toHaveBeenCalled();
    });
});

describe('verifying a response', () => {
    // What verifyResponse returns: the response, with the presentations it
    // accepted and who made it.
    const verified = (match: boolean) => ({
        ...responseContents(1, match ? 1 : 0).response, vps: [], responder: 'did:cid:bob', match,
    });

    async function verify(): Promise<void> {
        const user = userEvent.setup({ delay: null });
        render(<AuthTab />);
        await user.type(input('Response'), RESPONSE);
        await user.click(button('Verify'));
    }

    it('says a response that matches its challenge is valid', async () => {
        keymaster.verifyResponse.mockResolvedValue(verified(true));
        await verify();

        await waitFor(() => expect(setSuccess).toHaveBeenCalledWith('Response is VALID'));
        expect(keymaster.verifyResponse).toHaveBeenCalledWith(RESPONSE);
    });

    it('says a response that does not match is not valid', async () => {
        keymaster.verifyResponse.mockResolvedValue(verified(false));
        await verify();

        await waitFor(() => expect(setError).toHaveBeenCalledWith('Response is NOT VALID'));
        expect(setSuccess).not.toHaveBeenCalled();
    });

    it('reports a response it cannot verify', async () => {
        keymaster.verifyResponse.mockRejectedValue(new Error('Invalid parameter: responseDID not a valid challenge response'));
        await verify();

        await waitFor(() => expect(setError).toHaveBeenCalledWith(expect.objectContaining({
            message: 'Invalid parameter: responseDID not a valid challenge response',
        })));
    });
});

describe('making a challenge', () => {
    async function openDialog(): Promise<UserEvent> {
        const user = userEvent.setup({ delay: null });
        render(<AuthTab />);
        await user.click(button('New challenge'));
        await screen.findByRole('dialog', { name: 'New Challenge' });
        return user;
    }

    // The dialog's two pickers have no label: the schema comes first.
    const picker = (index: 0 | 1) => within(screen.getByRole('dialog')).getAllByRole('combobox')[index];

    async function pick(user: UserEvent, index: 0 | 1, option: string) {
        await user.click(picker(index));
        await user.click(await screen.findByRole('option', { name: option }));
    }

    it('makes an open challenge and shows it', async () => {
        keymaster.createChallenge.mockResolvedValue('did:cid:new-challenge');
        keymaster.resolveAsset.mockResolvedValue(challengeAsset({}));
        const user = await openDialog();
        expect((within(screen.getByRole('dialog')).getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(true);

        await user.click(button('Create'));

        await waitFor(() => expect(input('Challenge').value).toBe('did:cid:new-challenge'));
        expect(keymaster.createChallenge).toHaveBeenCalledWith({});
        expect(navigation.openView).toHaveBeenCalledWith({ did: 'did:cid:new-challenge', tab: 'viewer', contents: challengeAsset({}) });
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('asks for the credentials chosen, from the issuers chosen', async () => {
        keymaster.createChallenge.mockResolvedValue('did:cid:new-challenge');
        const user = await openDialog();

        await pick(user, 0, 'MembershipSchema');
        await pick(user, 1, 'Bob');
        await user.click(button('Add'));
        expect(screen.getByText('MembershipSchema (Bob)')).toBeTruthy();

        await pick(user, 0, 'AgeSchema');
        await user.click(button('Add'));
        expect(screen.getByText('AgeSchema')).toBeTruthy();

        await user.click(button('Create'));

        await waitFor(() => expect(keymaster.createChallenge).toHaveBeenCalledWith({
            credentials: [
                { schema: 'did:cid:membershipschema', issuers: ['did:cid:bob'] },
                { schema: 'did:cid:ageschema' },
            ],
        }));
    });

    it('takes back a credential removed from the list', async () => {
        keymaster.createChallenge.mockResolvedValue('did:cid:new-challenge');
        const user = await openDialog();
        await pick(user, 0, 'MembershipSchema');
        await user.click(button('Add'));
        await pick(user, 0, 'AgeSchema');
        await user.click(button('Add'));

        const chip = screen.getByText('MembershipSchema').closest('.MuiChip-root') as HTMLElement;
        await user.click(chip.querySelector('.MuiChip-deleteIcon')!);
        expect(screen.queryByText('MembershipSchema')).toBeNull();

        await user.click(button('Create'));
        await waitFor(() => expect(keymaster.createChallenge).toHaveBeenCalledWith({ credentials: [{ schema: 'did:cid:ageschema' }] }));
    });

    it('starts again empty when reopened', async () => {
        const user = await openDialog();
        await pick(user, 0, 'MembershipSchema');
        await user.click(button('Add'));
        await user.click(button('Cancel'));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

        await user.click(button('New challenge'));
        await screen.findByRole('dialog', { name: 'New Challenge' });
        expect(screen.queryByText('MembershipSchema')).toBeNull();
        expect(keymaster.createChallenge).not.toHaveBeenCalled();
    });

    it('reports a challenge it cannot make, and keeps the dialog open', async () => {
        keymaster.lookupDID.mockRejectedValue(new Error('Invalid parameter: unknown id'));
        const user = await openDialog();
        await pick(user, 0, 'MembershipSchema');
        await user.click(button('Add'));

        await user.click(button('Create'));

        await waitFor(() => expect(setError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Invalid parameter: unknown id' })));
        expect(keymaster.createChallenge).not.toHaveBeenCalled();
        expect(screen.getByRole('dialog', { name: 'New Challenge' })).toBeTruthy();
    });
});

describe('scanning a challenge', () => {
    it('offers no scan where there is no camera', () => {
        render(<AuthTab />);

        expect(screen.queryByLabelText('Scan QR')).toBeNull();
    });

    it('hands what it scans to the wallet\'s link handling', async () => {
        const user = userEvent.setup({ delay: null });
        platform.scanQr = vi.fn().mockResolvedValue(`archon://auth?challenge=${CHALLENGE}`);
        render(<AuthTab />);

        await user.click(within(screen.getByLabelText('Scan QR')).getByRole('button'));

        await waitFor(() => expect(navigation.dispatchDeepLink).toHaveBeenCalledWith(`archon://auth?challenge=${CHALLENGE}`));
        expect(setError).not.toHaveBeenCalled();
    });

    it('reports a scan that finds nothing', async () => {
        const user = userEvent.setup({ delay: null });
        platform.scanQr = vi.fn().mockResolvedValue(null);
        render(<AuthTab />);

        await user.click(within(screen.getByLabelText('Scan QR')).getByRole('button'));

        await waitFor(() => expect(setError).toHaveBeenCalledWith('Failed to scan QR code'));
        expect(navigation.dispatchDeepLink).not.toHaveBeenCalled();
    });
});
