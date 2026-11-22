import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App, { tagWord } from '../App';
import { ApiError, createApi } from '../api';
import type { Api, Me, Publication, Responses } from '../api';

const ALICE = 'did:cid:bagaaieraalicealicealicealicealicealicealicealicealicealice';
const BOB = 'did:cid:bagaaierabobbobbobbobbobbobbobbobbobbobbobbobbobbobbobbobbo';

const post = (did: string, author: string, text: string, more: Partial<Publication> = {}): Publication => ({
    state: 'published',
    did,
    current: 0,
    versions: [{ opid: `op-${did}`, type: 'create', outcome: 'attributed', position: { block: 1, time: '2026-11-21T12:00:00Z' } }],
    memeplex: { kind: 'post', author, text },
    ...more,
});

// How many publications the indexer gives at once.
const PAGE = 50;

// The services, as far as the pages can tell.
function services(start: { me?: Me; timeline?: Publication[] } = {}) {
    const state = {
        me: start.me as Me | undefined,
        timeline: start.timeline ?? [],
        published: [] as Record<string, unknown>[],
        edited: [] as { did: string; object: Record<string, unknown> }[],
        responses: { boosts: [], ratings: { ratings: [] }, tags: [] } as Responses,
    };
    const api: Api = {
        me: vi.fn(async () => state.me),
        challenge: vi.fn(async () => ({ challenge: 'did:cid:challenge', link: 'archon://auth?challenge=did%3Acid%3Achallenge' })),
        login: vi.fn(async () => ({ waiting: true as const })),
        logout: vi.fn(async () => { state.me = undefined; }),
        publish: vi.fn(async object => { state.published.push(object); return `did:cid:new${state.published.length}`; }),
        edit: vi.fn(async (did: string, object: Record<string, unknown>) => { state.edited.push({ did, object }); }),
        withdraw: vi.fn(async did => { state.timeline = state.timeline.map(each => (each.did === did ? { ...each, state: 'withdrawn' as const } : each)); }),
        timeline: vi.fn(async (authors, offset = 0) => {
            const all = state.timeline.filter(each => authors.includes(each.memeplex!.author));

            return { total: all.length, publications: all.slice(offset, offset + PAGE) };
        }),
        thread: vi.fn(async () => []),
        responses: vi.fn(async () => state.responses),
        publication: vi.fn(async () => undefined),
    };

    return { api, state };
}

const granted: Me = { did: ALICE, grant: 'did:cid:grant', registry: 'BTC:mainnet' };
const under = (publication: Publication, grant: string): Publication => ({ ...publication, memeplex: { ...publication.memeplex!, grant } });

describe('signing in', () => {
    it('shows the challenge as a code and a link, and signs in when the user confirms who answered', async () => {
        const { api, state } = services();
        const login = vi.mocked(api.login);
        render(<App api={api} pollMs={10} />);
        const user = userEvent.setup();

        await user.click(await screen.findByRole('button', { name: 'Sign in with your wallet' }));
        expect((await screen.findByRole('link', { name: 'Open in your wallet' })).getAttribute('href')).toBe('archon://auth?challenge=did%3Acid%3Achallenge');
        expect(screen.getByLabelText('Sign-in challenge')).toBeTruthy();
        await waitFor(() => expect(login).toHaveBeenCalledWith());

        // A wallet answers, and the page says who before it goes on.
        login.mockResolvedValue({ answered: ALICE });
        expect(await screen.findByText(ALICE)).toBeTruthy();
        expect(screen.getByText(/Anyone can answer a sign-in challenge/)).toBeTruthy();
        expect(screen.queryByRole('heading', { name: /Timeline/ })).toBeNull();

        login.mockImplementation(async body => {
            if (body?.confirm === ALICE) {
                state.me = granted;
                return { did: ALICE };
            }
            return { answered: ALICE };
        });
        await user.click(screen.getByRole('button', { name: 'This is me' }));

        expect(await screen.findByRole('heading', { name: /Timeline/ })).toBeTruthy();
        expect(login).toHaveBeenCalledWith({ confirm: ALICE });
    });

    it('does not bring back an identity the user refused, from an answer about the old challenge', async () => {
        const { api } = services();
        vi.mocked(api.login).mockResolvedValue({ answered: BOB });
        let next!: (challenge: { challenge: string; link: string }) => void;
        render(<App api={api} pollMs={10} />);
        const user = userEvent.setup();

        await user.click(await screen.findByRole('button', { name: 'Sign in with your wallet' }));
        await screen.findByText(BOB);
        vi.mocked(api.challenge).mockReturnValue(new Promise(answer => { next = answer; }));
        await user.click(screen.getByRole('button', { name: 'That is not me' }));
        await new Promise(wait => setTimeout(wait, 60));
        expect(screen.queryByText(BOB)).toBeNull();

        vi.mocked(api.login).mockResolvedValue({ waiting: true });
        next({ challenge: 'did:cid:second', link: 'archon://auth?challenge=did%3Acid%3Asecond' });
        expect((await screen.findByRole('link', { name: 'Open in your wallet' })).getAttribute('href')).toBe('archon://auth?challenge=did%3Acid%3Asecond');
    });

    it('asks for another challenge when the user says the answer is not theirs', async () => {
        const { api } = services();
        vi.mocked(api.login).mockResolvedValue({ answered: BOB });
        render(<App api={api} pollMs={10} />);
        const user = userEvent.setup();

        await user.click(await screen.findByRole('button', { name: 'Sign in with your wallet' }));
        await user.click(await screen.findByRole('button', { name: 'That is not me' }));

        await waitFor(() => expect(api.challenge).toHaveBeenCalledTimes(2));
        expect(api.login).not.toHaveBeenCalledWith({ confirm: BOB });
    });

    it('takes a response pasted from a wallet', async () => {
        const { api, state } = services();
        render(<App api={api} pollMs={60_000} />);
        const user = userEvent.setup();

        await user.click(await screen.findByRole('button', { name: 'Sign in with your wallet' }));
        await user.click(await screen.findByText('My wallet gave me a response to paste'));
        await user.type(screen.getByLabelText('Response'), 'did:cid:response');
        vi.mocked(api.login).mockImplementation(async () => { state.me = granted; return { did: ALICE }; });
        await user.click(screen.getByRole('button', { name: 'Sign in' }));

        expect(api.login).toHaveBeenCalledWith({ response: 'did:cid:response' });
        expect(await screen.findByRole('heading', { name: /Timeline/ })).toBeTruthy();
    });

    it('says why a sign-in failed and lets the user start over', async () => {
        const { api } = services();
        vi.mocked(api.login).mockRejectedValue(new ApiError(409, 'more than one identity answered this challenge; ask for another'));
        render(<App api={api} pollMs={10} />);

        await userEvent.setup().click(await screen.findByRole('button', { name: 'Sign in with your wallet' }));

        expect((await screen.findByRole('alert')).textContent).toMatch(/more than one identity answered/);
        expect(screen.getByRole('button', { name: 'Sign in with your wallet' })).toBeTruthy();
    });
});

describe('the grant', () => {
    it('shows the grant link to a user with no grant, and no way to publish', async () => {
        const { api } = services({ me: { did: ALICE, pending: [], link: 'archon://grant?request=abc' } });
        render(<App api={api} />);

        expect((await screen.findByLabelText('Or copy the grant link') as HTMLInputElement).value).toBe('archon://grant?request=abc');
        expect(screen.getByLabelText('Grant request')).toBeTruthy();
        expect(screen.queryByLabelText('Post')).toBeNull();
    });

    it('says a grant is waiting to be anchored, and checks again when asked', async () => {
        const { api, state } = services({ me: { did: ALICE, pending: ['did:cid:grant'], link: 'archon://grant?request=abc' } });
        render(<App api={api} />);

        expect(await screen.findByText(/waiting to be anchored on its chain/)).toBeTruthy();
        state.me = granted;
        await userEvent.setup().click(screen.getByRole('button', { name: 'Check again' }));

        expect(await screen.findByLabelText('Post')).toBeTruthy();
        expect(screen.queryByText(/Let Memepool publish for you/)).toBeNull();
    });
});

describe('reading and publishing', () => {
    it('shows the user\'s posts and those of the authors they follow, and nobody else\'s', async () => {
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        const { api } = services({
            me: granted,
            timeline: [post('did:cid:1', ALICE, 'Mine.'), post('did:cid:2', BOB, 'Bob\'s.'), post('did:cid:3', 'did:cid:carol', 'Carol\'s.')],
        });
        render(<App api={api} />);

        expect(await screen.findByText('Mine.')).toBeTruthy();
        expect(screen.getByText('Bob\'s.')).toBeTruthy();
        expect(screen.queryByText('Carol\'s.')).toBeNull();
        expect(api.timeline).toHaveBeenCalledWith([ALICE, BOB], 0);
    });

    it('publishes a post, and shows it as waiting until the indexer has it', async () => {
        const { api, state } = services({ me: granted });
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.type(await screen.findByLabelText('Post'), 'Every post is a DID.');
        await user.click(screen.getByRole('button', { name: 'Publish' }));

        expect(state.published).toStrictEqual([{ kind: 'post', text: 'Every post is a DID.' }]);
        expect(await screen.findByText('Waiting to be anchored')).toBeTruthy();
        expect((screen.getByLabelText('Post') as HTMLTextAreaElement).value).toBe('');

        state.timeline = [post('did:cid:new1', ALICE, 'Every post is a DID.')];
        await user.click(screen.getByRole('button', { name: 'Refresh' }));

        await waitFor(() => expect(screen.queryByText('Waiting to be anchored')).toBeNull());
        expect(screen.getByText('Every post is a DID.')).toBeTruthy();
    });

    it('says why a post was refused and keeps what was written', async () => {
        const { api } = services({ me: granted });
        vi.mocked(api.publish).mockRejectedValue(new ApiError(400, 'not a valid post: schema'));
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.type(await screen.findByLabelText('Post'), 'Too long.');
        await user.click(screen.getByRole('button', { name: 'Publish' }));

        expect((await screen.findByRole('alert')).textContent).toBe('not a valid post: schema');
        expect((screen.getByLabelText('Post') as HTMLTextAreaElement).value).toBe('Too long.');
    });

    it('opens a thread and replies to the version of the post that is shown', async () => {
        const root = post('did:cid:1', BOB, 'A post.');
        const reply = post('did:cid:9', ALICE, 'A reply.');
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        const { api, state } = services({ me: granted, timeline: [root] });
        vi.mocked(api.thread).mockResolvedValue([{ publication: reply, depth: 1 }]);
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await screen.findByRole('button', { name: 'Open' }));
        expect(await screen.findByText('A reply.')).toBeTruthy();
        expect(api.thread).toHaveBeenCalledWith('did:cid:1');

        await user.type(screen.getByLabelText('Reply'), 'Another.');
        await user.click(screen.getByRole('button', { name: 'Publish' }));

        expect(state.published).toStrictEqual([{ kind: 'reply', target: 'did:cid:1', targetVersion: 'op-did:cid:1', text: 'Another.' }]);
        expect(await screen.findByText('Waiting to be anchored')).toBeTruthy();

        await user.click(screen.getByRole('button', { name: 'Back' }));
        expect(await screen.findByRole('heading', { name: /Timeline/ })).toBeTruthy();
        // A reply waits in its thread, not in the timeline.
        expect(screen.queryByText('Another.')).toBeNull();
    });

    it('lets the user withdraw their own post, and not another author\'s', async () => {
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        const { api } = services({
            me: { ...granted, others: ['did:cid:second'] },
            timeline: [
                under(post('did:cid:1', ALICE, 'Mine.'), 'did:cid:grant'),
                post('did:cid:2', BOB, 'Bob\'s.'),
                under(post('did:cid:3', ALICE, 'Under my other grant.'), 'did:cid:second'),
                under(post('did:cid:4', ALICE, 'Through another client.'), 'did:cid:elsewhere'),
            ],
        });
        render(<App api={api} />);
        const user = userEvent.setup();

        const mine = (await screen.findByText('Mine.')).closest('article')!;
        expect(within(screen.getByText('Under my other grant.').closest('article')!).getByRole('button', { name: 'Withdraw' })).toBeTruthy();
        expect(within(screen.getByText('Through another client.').closest('article')!).queryByRole('button', { name: 'Withdraw' })).toBeNull();
        const theirs = screen.getByText('Bob\'s.').closest('article')!;
        expect(within(theirs).queryByRole('button', { name: 'Withdraw' })).toBeNull();

        await user.click(within(mine).getByRole('button', { name: 'Withdraw' }));

        expect(api.withdraw).toHaveBeenCalledWith('did:cid:1');
        expect(await screen.findByText('Withdrawn')).toBeTruthy();
    });

    it('keeps follows in this browser', async () => {
        const { api } = services({ me: granted, timeline: [post('did:cid:2', BOB, 'Bob\'s.')] });
        render(<App api={api} />);
        const user = userEvent.setup();

        await screen.findByRole('heading', { name: /Timeline/ });
        expect(screen.queryByText('Bob\'s.')).toBeNull();

        await user.type(screen.getByLabelText('Follow an author'), BOB);
        await user.click(screen.getByRole('button', { name: 'Follow' }));

        expect(await screen.findByText('Bob\'s.')).toBeTruthy();
        expect(JSON.parse(localStorage.getItem('memepool.follows')!)).toStrictEqual([BOB]);

        await user.click(screen.getByRole('button', { name: 'Unfollow' }));
        await waitFor(() => expect(screen.queryByText('Bob\'s.')).toBeNull());
        expect(JSON.parse(localStorage.getItem('memepool.follows')!)).toStrictEqual([]);
    });

    it('reads older publications a page at a time', async () => {
        const { api } = services({ me: granted, timeline: Array.from({ length: 60 }, (_, index) => post(`did:cid:p${index}`, ALICE, `Post ${index}.`)) });
        render(<App api={api} />);
        const user = userEvent.setup();

        expect(await screen.findByText('Post 49.')).toBeTruthy();
        expect(screen.queryByText('Post 50.')).toBeNull();

        await user.click(screen.getByRole('button', { name: 'Older' }));

        expect(await screen.findByText('Post 59.')).toBeTruthy();
        expect(screen.getByText('Post 0.')).toBeTruthy();
        expect(api.timeline).toHaveBeenLastCalledWith([ALICE], 50);
        expect(screen.queryByRole('button', { name: 'Older' })).toBeNull();
    });

    it('does not show an author\'s posts from a read that finished after they were unfollowed', async () => {
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        const { api } = services({ me: granted });
        let late!: (page: { total: number; publications: Publication[] }) => void;
        vi.mocked(api.timeline).mockImplementation(authors => (authors.includes(BOB)
            ? new Promise(answer => { late = answer; })
            : Promise.resolve({ total: 0, publications: [] })));
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await screen.findByRole('button', { name: 'Unfollow' }));
        await waitFor(() => expect(api.timeline).toHaveBeenLastCalledWith([ALICE], 0));
        late({ total: 1, publications: [post('did:cid:2', BOB, 'Bob\'s.')] });

        expect(await screen.findByText('Nothing here yet.')).toBeTruthy();
        expect(screen.queryByText('Bob\'s.')).toBeNull();
    });

    it('shows a reply as published once its thread has it', async () => {
        const root = post('did:cid:1', ALICE, 'A post.');
        const { api } = services({ me: granted, timeline: [root] });
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await screen.findByRole('button', { name: 'Open' }));
        await user.type(await screen.findByLabelText('Reply'), 'A reply.');
        await user.click(screen.getByRole('button', { name: 'Publish' }));
        expect(await screen.findByText('Waiting to be anchored')).toBeTruthy();

        vi.mocked(api.thread).mockResolvedValue([{ publication: post('did:cid:new1', ALICE, 'A reply.'), depth: 1 }]);
        await user.click(screen.getByRole('button', { name: 'Refresh' }));

        await waitFor(() => expect(screen.queryByText('Waiting to be anchored')).toBeNull());
        expect(screen.getAllByText('A reply.')).toHaveLength(1);
    });

    it('does not take what is typed while a post is being published', async () => {
        const { api } = services({ me: granted });
        let done!: (did: string) => void;
        vi.mocked(api.publish).mockReturnValue(new Promise(answer => { done = answer; }));
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.type(await screen.findByLabelText('Post'), 'One.');
        await user.click(screen.getByRole('button', { name: 'Publish' }));

        expect((screen.getByLabelText('Post') as HTMLTextAreaElement).disabled).toBe(true);
        done('did:cid:new1');
        await waitFor(() => expect((screen.getByLabelText('Post') as HTMLTextAreaElement).disabled).toBe(false));
    });

    it('stays signed in, and says so, when the service does not sign the reader out', async () => {
        const { api } = services({ me: granted });
        vi.mocked(api.logout).mockRejectedValue(new ApiError(502, 'the service could not answer'));
        render(<App api={api} />);

        await userEvent.setup().click(await screen.findByRole('button', { name: 'Sign out' }));

        expect((await screen.findByRole('alert')).textContent).toMatch(/still signed in/);
        expect(screen.getByRole('heading', { name: /Timeline/ })).toBeTruthy();
    });

    it('stays signed out when an answer about who was signed in arrives afterwards', async () => {
        const waitingForGrant: Me = { did: ALICE, pending: ['did:cid:grant'], link: 'archon://grant?request=abc' };
        const { api } = services({ me: waitingForGrant });
        render(<App api={api} />);
        const user = userEvent.setup();

        await screen.findByText(/waiting to be anchored on its chain/);
        let late!: (me: Me) => void;
        vi.mocked(api.me).mockReturnValue(new Promise(answer => { late = answer; }));
        await user.click(screen.getByRole('button', { name: 'Check again' }));
        await user.click(screen.getByRole('button', { name: 'Sign out' }));
        await screen.findByRole('button', { name: 'Sign in with your wallet' });

        late(granted);
        await new Promise(wait => setTimeout(wait, 50));

        expect(screen.getByRole('button', { name: 'Sign in with your wallet' })).toBeTruthy();
        expect(screen.queryByLabelText('Post')).toBeNull();
    });

    it('shows the next reader nothing the last one was waiting on', async () => {
        const { api, state } = services({ me: granted });
        render(<App api={api} pollMs={60_000} />);
        const user = userEvent.setup();

        await user.type(await screen.findByLabelText('Post'), 'Alice\'s draft.');
        await user.click(screen.getByRole('button', { name: 'Publish' }));
        expect(await screen.findByText('Waiting to be anchored')).toBeTruthy();

        await user.click(screen.getByRole('button', { name: 'Sign out' }));
        await screen.findByRole('button', { name: 'Sign in with your wallet' });
        vi.mocked(api.login).mockImplementation(async () => { state.me = { did: BOB, grant: 'did:cid:g2', registry: 'BTC:mainnet' }; return { did: BOB }; });
        await user.click(screen.getByRole('button', { name: 'Sign in with your wallet' }));
        await user.click(await screen.findByText('My wallet gave me a response to paste'));
        await user.type(screen.getByLabelText('Response'), 'did:cid:response');
        await user.click(screen.getByRole('button', { name: 'Sign in' }));

        await screen.findByRole('heading', { name: /Timeline/ });
        expect(screen.queryByText('Alice\'s draft.')).toBeNull();
    });

    it('reads the rest, each publication once, when a post arrived between two reads', async () => {
        const all = Array.from({ length: 120 }, (_, index) => post(`did:cid:p${index}`, ALICE, `Post ${index}.`));
        const { api, state } = services({ me: granted, timeline: all });
        render(<App api={api} />);
        const user = userEvent.setup();

        await screen.findByText('Post 49.');
        // The next page begins one publication early: with the last one already shown.
        state.timeline = [post('did:cid:newest', ALICE, 'Newest.'), ...all];
        await user.click(screen.getByRole('button', { name: 'Older' }));
        await screen.findByText('Post 98.');
        expect(screen.getAllByText('Post 49.')).toHaveLength(1);
        expect(screen.queryByText('Post 99.')).toBeNull();

        await user.click(screen.getByRole('button', { name: 'Older' }));
        expect(await screen.findByText('Post 119.')).toBeTruthy();
        expect(api.timeline).toHaveBeenLastCalledWith([ALICE], 100);
        expect(screen.queryByRole('button', { name: 'Older' })).toBeNull();
    });

    it('keeps a reader signed in, with the way to sign out, when a check of who they are fails', async () => {
        const { api } = services({ me: { did: ALICE, pending: ['did:cid:grant'], link: 'archon://grant?request=abc' } });
        render(<App api={api} />);
        const user = userEvent.setup();

        await screen.findByText(/waiting to be anchored on its chain/);
        vi.mocked(api.me).mockRejectedValue(new ApiError(502, 'the service could not answer'));
        await user.click(screen.getByRole('button', { name: 'Check again' }));

        expect((await screen.findByRole('alert')).textContent).toBe('the service could not answer');
        expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
    });

    it('does not show the next reader a post of the last one\'s that was accepted after they signed out', async () => {
        const { api, state } = services({ me: granted });
        let accepted!: (did: string) => void;
        vi.mocked(api.publish).mockReturnValue(new Promise(answer => { accepted = answer; }));
        render(<App api={api} pollMs={60_000} />);
        const user = userEvent.setup();

        await user.type(await screen.findByLabelText('Post'), 'Alice\'s words.');
        await user.click(screen.getByRole('button', { name: 'Publish' }));
        await user.click(screen.getByRole('button', { name: 'Sign out' }));
        await screen.findByRole('button', { name: 'Sign in with your wallet' });

        state.me = { did: BOB, grant: 'did:cid:g2', registry: 'BTC:mainnet' };
        vi.mocked(api.login).mockResolvedValue({ did: BOB });
        await user.click(screen.getByRole('button', { name: 'Sign in with your wallet' }));
        await user.click(await screen.findByText('My wallet gave me a response to paste'));
        await user.type(screen.getByLabelText('Response'), 'did:cid:response');
        await user.click(screen.getByRole('button', { name: 'Sign in' }));
        await screen.findByRole('heading', { name: /Timeline/ });

        accepted('did:cid:late');
        await new Promise(wait => setTimeout(wait, 50));

        expect(screen.queryByText('Alice\'s words.')).toBeNull();
        expect(screen.queryByText('Waiting to be anchored')).toBeNull();
    });

    it('asks for one challenge at a time', async () => {
        const { api } = services();
        vi.mocked(api.challenge).mockReturnValue(new Promise(() => undefined));
        render(<App api={api} />);
        const user = userEvent.setup();
        const button = await screen.findByRole('button', { name: 'Sign in with your wallet' });

        await user.click(button);
        await user.click(button);

        expect(api.challenge).toHaveBeenCalledTimes(1);
        expect((button as HTMLButtonElement).disabled).toBe(true);
    });

    it('says what an entry is when it has no text of its own to show', async () => {
        const { api } = services({
            me: granted,
            timeline: [
                { ...post('did:cid:1', ALICE, ''), memeplex: { kind: 'post', author: ALICE, content: { cid: 'bafy' } } },
                { ...post('did:cid:2', ALICE, ''), memeplex: { kind: 'paper', author: ALICE, title: 'On DIDs', summary: 'A summary.', content: { cid: 'bafy' } } },
                { ...post('did:cid:3', ALICE, ''), memeplex: { kind: 'post', author: ALICE, target: 'did:cid:bagaaieraboostedboostedboostedboostedboostedboosted' } },
            ],
        });
        render(<App api={api} />);

        expect(await screen.findByText('The text is kept apart from this entry, and this page does not show it yet.')).toBeTruthy();
        expect(screen.getByText('On DIDs')).toBeTruthy();
        expect(screen.getByText('A summary.')).toBeTruthy();
        expect(screen.getByText(/The full text is kept apart/)).toBeTruthy();
        expect(screen.getByText(/A boost of/)).toBeTruthy();
    });

    it('shows a reader as signed in, with the way to sign out, when the read after signing in fails', async () => {
        const { api } = services();
        vi.mocked(api.login).mockResolvedValue({ did: ALICE });
        vi.mocked(api.me).mockResolvedValueOnce(undefined).mockRejectedValue(new ApiError(502, 'the service could not answer'));
        render(<App api={api} pollMs={60_000} />);
        const user = userEvent.setup();

        await user.click(await screen.findByRole('button', { name: 'Sign in with your wallet' }));
        await user.click(await screen.findByText('My wallet gave me a response to paste'));
        await user.type(screen.getByLabelText('Response'), 'did:cid:response');
        await user.click(screen.getByRole('button', { name: 'Sign in' }));

        expect(await screen.findByRole('button', { name: 'Sign out' })).toBeTruthy();
        expect((await screen.findAllByRole('alert'))[0].textContent).toBe('the service could not answer');
    });

    it('takes the later of two checks of the grant, whichever answers last', async () => {
        const waitingForGrant: Me = { did: ALICE, pending: ['did:cid:grant'], link: 'archon://grant?request=abc' };
        const { api } = services({ me: waitingForGrant });
        render(<App api={api} />);
        const user = userEvent.setup();

        await screen.findByText(/waiting to be anchored on its chain/);
        let first!: (me: Me) => void;
        vi.mocked(api.me).mockReturnValueOnce(new Promise(answer => { first = answer; })).mockResolvedValueOnce(granted);
        await user.click(screen.getByRole('button', { name: 'Check again' }));
        await user.click(screen.getByRole('button', { name: 'Check again' }));
        expect(await screen.findByLabelText('Post')).toBeTruthy();

        first(waitingForGrant);
        await new Promise(wait => setTimeout(wait, 50));
        expect(screen.getByLabelText('Post')).toBeTruthy();
    });

    it('signs out', async () => {
        const { api } = services({ me: granted });
        render(<App api={api} />);

        await userEvent.setup().click(await screen.findByRole('button', { name: 'Sign out' }));

        expect(api.logout).toHaveBeenCalled();
        expect(await screen.findByRole('button', { name: 'Sign in with your wallet' })).toBeTruthy();
    });
});

describe('responding to a post', () => {
    const root = under(post('did:cid:1', BOB, 'A post.'), 'did:cid:bobs');
    const about = { target: 'did:cid:1', targetVersion: 'op-did:cid:1' };

    async function opened(start: Parameters<typeof services>[0] = {}) {
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        const made = services({ me: granted, timeline: [root], ...start });
        render(<App api={made.api} />);
        const user = userEvent.setup();

        await user.click(await screen.findByRole('button', { name: 'Open' }));
        await screen.findByRole('button', { name: 'Boost' });

        return { ...made, user };
    }

    it('shows what others have made of it', async () => {
        const made = services({ me: granted, timeline: [root] });
        made.state.responses = {
            boosts: [post('did:cid:b1', ALICE, ''), post('did:cid:b2', BOB, '')],
            ratings: { ratings: [post('did:cid:r1', BOB, '')], mean: 0.75 },
            tags: [{ tag: 'cryptography', authors: [ALICE, BOB] }, { tag: '❤️', authors: [BOB] }],
        };
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        render(<App api={made.api} />);

        await userEvent.setup().click(await screen.findByRole('button', { name: 'Open' }));

        expect(await screen.findByText(/2 boosts · rated 75% by 1/)).toBeTruthy();
        expect(screen.getByText(/cryptography 2/)).toBeTruthy();
        expect(made.api.responses).toHaveBeenCalledWith('did:cid:1');
    });

    it('boosts, likes and tags the version shown, each as an object of the reader\'s', async () => {
        const { state, user } = await opened();

        await user.click(screen.getByRole('button', { name: 'Boost' }));
        await user.click(screen.getByRole('button', { name: 'Like' }));
        await user.type(screen.getByLabelText('Tag'), '  Zero  Knowledge ');
        await user.click(screen.getByRole('button', { name: 'Add tag' }));

        expect(state.published).toStrictEqual([
            { kind: 'post', ...about },
            { kind: 'tag', ...about, tag: '❤️' },
            { kind: 'tag', ...about, tag: 'zero-knowledge' },
        ]);
        expect(await screen.findByText('Your boost is waiting to be anchored.')).toBeTruthy();
        expect(screen.getByText('Your tag zero-knowledge is waiting to be anchored.')).toBeTruthy();
        expect((screen.getByLabelText('Tag') as HTMLInputElement).value).toBe('');
    });

    it('rates with a thumb, and changes the reader\'s rating when they have one', async () => {
        const { state, user } = await opened();

        await user.click(screen.getByRole('button', { name: 'Thumb up' }));
        expect(state.published).toStrictEqual([{ kind: 'rating', ...about, rating: 1, min: 0, max: 1 }]);
    });

    it('edits the rating the reader already has, where a second would not count', async () => {
        const made = services({ me: granted, timeline: [root] });
        made.state.responses = { boosts: [], ratings: { ratings: [under(post('did:cid:myrating', ALICE, ''), 'did:cid:grant')], mean: 1 }, tags: [] };
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        render(<App api={made.api} />);
        const user = userEvent.setup();

        await user.click(await screen.findByRole('button', { name: 'Open' }));
        await screen.findByText(/rated 100% by 1/);
        await user.click(screen.getByRole('button', { name: 'Thumb down' }));

        await waitFor(() => expect(made.state.edited).toStrictEqual([
            { did: 'did:cid:myrating', object: { kind: 'rating', ...about, rating: 0, min: 0, max: 1 } },
        ]));
        expect(made.state.published).toStrictEqual([]);
    });

    it('makes a rating of its own when the reader\'s is one this service cannot change', async () => {
        const made = services({ me: granted, timeline: [root] });
        made.state.responses = { boosts: [], ratings: { ratings: [under(post('did:cid:elsewhere', ALICE, ''), 'did:cid:another-client')], mean: 1 }, tags: [] };
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        render(<App api={made.api} />);
        const user = userEvent.setup();

        await user.click(await screen.findByRole('button', { name: 'Open' }));
        await screen.findByText(/rated 100% by 1/);
        await user.click(screen.getByRole('button', { name: 'Thumb down' }));

        await waitFor(() => expect(made.state.published).toStrictEqual([{ kind: 'rating', ...about, rating: 0, min: 0, max: 1 }]));
        expect(made.state.edited).toStrictEqual([]);
    });

    it('changes the rating it has just made when the reader thinks again, before the indexer shows it', async () => {
        const { state, user } = await opened();

        await user.click(screen.getByRole('button', { name: 'Thumb up' }));
        await screen.findByText('Your thumb up is waiting to be anchored.');
        await user.click(screen.getByRole('button', { name: 'Thumb down' }));

        await waitFor(() => expect(state.edited).toStrictEqual([
            { did: 'did:cid:new1', object: { kind: 'rating', ...about, rating: 0, min: 0, max: 1 } },
        ]));
        expect(state.published).toHaveLength(1);
        // The first thumb is no longer what waits.
        await screen.findByText('Your thumb down is waiting to be anchored.');
        expect(screen.queryByText('Your thumb up is waiting to be anchored.')).toBeNull();

        state.responses = { boosts: [], ratings: { ratings: [{ ...under(post('did:cid:new1', ALICE, ''), 'did:cid:grant'), memeplex: { kind: 'rating', author: ALICE, grant: 'did:cid:grant', rating: 0 } }], mean: 0 }, tags: [] };
        await user.click(screen.getByRole('button', { name: 'Refresh counts' }));
        await waitFor(() => expect(screen.queryByText(/is waiting to be anchored/)).toBeNull());
    });

    it('keeps a tag the service refused, for the reader to try again', async () => {
        const { api, user } = await opened();
        vi.mocked(api.publish).mockRejectedValue(new ApiError(502, 'the node did not accept the operation'));

        await user.type(screen.getByLabelText('Tag'), 'cryptography');
        await user.click(screen.getByRole('button', { name: 'Add tag' }));

        await screen.findByRole('alert');
        expect((screen.getByLabelText('Tag') as HTMLInputElement).value).toBe('cryptography');
    });

    it('stops showing a failure to read the counts once they are read', async () => {
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        const { api } = services({ me: granted, timeline: [root] });
        vi.mocked(api.responses).mockRejectedValueOnce(new ApiError(503, 'the index is still being built'));
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await screen.findByRole('button', { name: 'Open' }));
        expect((await screen.findByRole('alert')).textContent).toBe('the index is still being built');

        await user.click(screen.getByRole('button', { name: 'Refresh counts' }));
        await screen.findByText(/0 boosts · no ratings/);
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('takes no thumb until it knows whether the reader has a rating', async () => {
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        const { api } = services({ me: granted, timeline: [root] });
        vi.mocked(api.responses).mockReturnValue(new Promise(() => undefined));
        render(<App api={api} />);

        await userEvent.setup().click(await screen.findByRole('button', { name: 'Open' }));

        expect((await screen.findByRole('button', { name: 'Thumb up' }) as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByRole('button', { name: 'Boost' }) as HTMLButtonElement).disabled).toBe(false);
    });

    it('stops saying a response is waiting once the indexer shows it', async () => {
        const { state, user } = await opened();

        await user.click(screen.getByRole('button', { name: 'Boost' }));
        await user.click(screen.getByRole('button', { name: 'Like' }));
        await screen.findByText('Your like is waiting to be anchored.');

        state.responses = { boosts: [post('did:cid:new1', ALICE, '')], ratings: { ratings: [] }, tags: [] };
        await user.click(screen.getByRole('button', { name: 'Refresh counts' }));

        await waitFor(() => expect(screen.queryByText('Your boost is waiting to be anchored.')).toBeNull());
        expect(screen.getByText('Your like is waiting to be anchored.')).toBeTruthy();

        state.responses = { ...state.responses, tags: [{ tag: '❤️', authors: [ALICE] }] };
        await user.click(screen.getByRole('button', { name: 'Refresh counts' }));
        await waitFor(() => expect(screen.queryByText(/is waiting to be anchored/)).toBeNull());
    });

    it('says why a response was refused', async () => {
        const { api, user } = await opened();
        vi.mocked(api.publish).mockRejectedValue(new ApiError(403, 'no grant to publish under'));

        await user.click(screen.getByRole('button', { name: 'Boost' }));

        expect((await screen.findByRole('alert')).textContent).toBe('no grant to publish under');
        expect(screen.queryByText(/is waiting to be anchored/)).toBeNull();
    });

    it('offers no response to a reader with no grant', async () => {
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        const { api } = services({ me: { did: ALICE, pending: [], link: 'archon://grant?request=abc' }, timeline: [root] });
        render(<App api={api} />);

        await userEvent.setup().click(await screen.findByRole('button', { name: 'Open' }));
        await screen.findByText(/0 boosts · no ratings/);

        expect(screen.queryByRole('button', { name: 'Boost' })).toBeNull();
    });

    it('writes a tag as it is published', () => {
        expect(tagWord('  Zero  Knowledge ')).toBe('zero-knowledge');
        expect(tagWord('Cafe\u0301')).toBe('caf\u00e9');
        expect(tagWord('   ')).toBe('');
        // Lower-casing takes this letter apart; what is published is composed.
        expect(tagWord('J\u030c')).toBe('\u01f0');
        expect(tagWord('J\u030c')).toBe(tagWord('\u01f0'));
    });
});

describe('a grant that allows some kinds', () => {
    const root = under(post('did:cid:1', BOB, 'A post.'), 'did:cid:bobs');

    it('offers only what the grant allows', async () => {
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        const { api } = services({ me: { ...granted, actions: ['memeplex:reply', 'memeplex:tag'] }, timeline: [root] });
        render(<App api={api} />);
        const user = userEvent.setup();

        const open = await screen.findByRole('button', { name: 'Open' });
        expect(screen.queryByLabelText('Post')).toBeNull();

        await user.click(open);
        await screen.findByText(/0 boosts · no ratings/);

        expect(screen.getByLabelText('Reply')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Like' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Add tag' })).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Boost' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Thumb up' })).toBeNull();
    });

    it('still lets the reader change a rating they made before their grant was narrowed', async () => {
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        const made = services({ me: { ...granted, actions: ['memeplex:post'] }, timeline: [root] });
        made.state.responses = { boosts: [], ratings: { ratings: [under(post('did:cid:myrating', ALICE, ''), 'did:cid:grant')], mean: 1 }, tags: [] };
        render(<App api={made.api} />);
        const user = userEvent.setup();

        await user.click(await screen.findByRole('button', { name: 'Open' }));
        await user.click(await screen.findByRole('button', { name: 'Thumb down' }));

        await waitFor(() => expect(made.state.edited).toHaveLength(1));
        expect(made.state.edited[0].did).toBe('did:cid:myrating');
        expect(made.state.published).toStrictEqual([]);
    });

    it('offers everything when the grant names no actions', async () => {
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        const { api } = services({ me: granted, timeline: [root] });
        render(<App api={api} />);
        const user = userEvent.setup();

        expect(await screen.findByLabelText('Post')).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Open' }));

        for (const name of ['Boost', 'Thumb up', 'Thumb down', 'Like', 'Add tag']) {
            expect(await screen.findByRole('button', { name })).toBeTruthy();
        }
        expect(screen.getByLabelText('Reply')).toBeTruthy();
    });
});

describe('editing', () => {
    it('rewrites the reader\'s own reply, keeping what it answers', async () => {
        const mine = under({ ...post('did:cid:1', ALICE, 'A reply.'), memeplex: { kind: 'reply', author: ALICE, text: 'A reply.', target: 'did:cid:0', targetVersion: 'op-0', v: 1 } }, 'did:cid:grant');
        const { api, state } = services({ me: granted, timeline: [mine] });
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await screen.findByRole('button', { name: 'Open' }));
        await user.click(await screen.findByRole('button', { name: 'Edit' }));
        await user.clear(screen.getByLabelText('Edit'));
        await user.type(screen.getByLabelText('Edit'), 'A better reply.');
        await user.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(state.edited).toStrictEqual([
            { did: 'did:cid:1', object: { kind: 'reply', target: 'did:cid:0', targetVersion: 'op-0', text: 'A better reply.' } },
        ]));
        expect(await screen.findByText('Your edit is waiting to be anchored.')).toBeTruthy();
        // One edit at a time, and the post is as it was until the edit is anchored.
        expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
        expect(screen.getByText('A reply.')).toBeTruthy();

        vi.mocked(api.publication).mockResolvedValue({ ...mine, current: 1, memeplex: { ...mine.memeplex!, text: 'A better reply.' } });
        await user.click(screen.getByRole('button', { name: 'Refresh' }));

        expect(await screen.findByText('A better reply.')).toBeTruthy();
        await waitFor(() => expect(screen.queryByText('Your edit is waiting to be anchored.')).toBeNull());
        await user.click(screen.getByRole('button', { name: 'Edit' }));
        expect((screen.getByLabelText('Edit') as HTMLTextAreaElement).value).toBe('A better reply.');
    });

    it('offers no edit of a post that a refresh shows was withdrawn', async () => {
        const mine = under(post('did:cid:1', ALICE, 'A post.'), 'did:cid:grant');
        const { api } = services({ me: granted, timeline: [mine] });
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await screen.findByRole('button', { name: 'Open' }));
        await screen.findByRole('button', { name: 'Edit' });

        vi.mocked(api.publication).mockResolvedValue({ ...mine, state: 'withdrawn' });
        await user.click(screen.getByRole('button', { name: 'Refresh' }));

        await waitFor(() => expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull());
    });

    it('offers no edit of another author\'s post, or of one published through another client', async () => {
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        const { api } = services({ me: granted, timeline: [under(post('did:cid:2', BOB, 'Bob\'s.'), 'did:cid:bobs')] });
        render(<App api={api} />);

        await userEvent.setup().click(await screen.findByRole('button', { name: 'Open' }));
        await screen.findByRole('button', { name: 'Boost' });

        expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    });
});

describe('the services\' client', () => {
    const answering = (answers: Record<string, { status: number; body: unknown }>) => {
        const asked: { url: string; init?: RequestInit }[] = [];
        const fetcher = (async (url: string, init?: RequestInit) => {
            asked.push({ url, init });
            const answer = answers[`${init?.method ?? 'GET'} ${url}`] ?? { status: 404, body: { error: 'no such route' } };

            return new Response(JSON.stringify(answer.body), { status: answer.status });
        }) as unknown as typeof fetch;

        return { api: createApi({ memepool: '/memepool', memeplex: '/memeplex' }, fetcher), asked };
    };

    it('reads who is signed in, and nobody when the service says so', async () => {
        expect(await answering({ 'GET /memepool/api/v1/me': { status: 200, body: granted } }).api.me()).toStrictEqual(granted);
        expect(await answering({ 'GET /memepool/api/v1/me': { status: 401, body: { error: 'not signed in' } } }).api.me()).toBeUndefined();
    });

    it('sends what it publishes as JSON, with the browser\'s cookies and to its own host', async () => {
        const { api, asked } = answering({ 'POST /memepool/api/v1/objects': { status: 200, body: { did: 'did:cid:new' } } });

        expect(await api.publish({ kind: 'post', text: 'x' })).toBe('did:cid:new');
        expect(asked[0].init).toMatchObject({ method: 'POST', credentials: 'same-origin', body: '{"kind":"post","text":"x"}', headers: { 'Content-Type': 'application/json' } });
    });

    it('asks the indexer for a timeline of several authors, and for none asks nothing', async () => {
        const { api, asked } = answering({ 'GET /memeplex/api/v1/timeline?author=did%3Acid%3Aa&author=did%3Acid%3Ab': { status: 200, body: { total: 0, publications: [] } } });

        expect(await api.timeline(['did:cid:a', 'did:cid:b'])).toStrictEqual({ total: 0, publications: [] });
        expect(await api.timeline([])).toStrictEqual({ total: 0, publications: [] });
        expect(asked).toHaveLength(1);
    });

    it('reports a refusal with the service\'s own words, and a publication the indexer has not as absent', async () => {
        const { api } = answering({ 'POST /memepool/api/v1/objects': { status: 403, body: { error: 'no grant to publish under' } } });

        await expect(api.publish({ kind: 'post', text: 'x' })).rejects.toMatchObject({ status: 403, message: 'no grant to publish under' });
        expect(await api.publication('did:cid:none')).toBeUndefined();
    });
});
