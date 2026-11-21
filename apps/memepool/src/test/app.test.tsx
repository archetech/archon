import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../App';
import { ApiError, createApi } from '../api';
import type { Api, Me, Publication } from '../api';

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

// The services, as far as the pages can tell.
function services(start: { me?: Me; timeline?: Publication[] } = {}) {
    const state = { me: start.me as Me | undefined, timeline: start.timeline ?? [], published: [] as Record<string, unknown>[] };
    const api: Api = {
        me: vi.fn(async () => state.me),
        challenge: vi.fn(async () => ({ challenge: 'did:cid:challenge', link: 'archon://auth?challenge=did%3Acid%3Achallenge' })),
        login: vi.fn(async () => ({ waiting: true as const })),
        logout: vi.fn(async () => { state.me = undefined; }),
        publish: vi.fn(async object => { state.published.push(object); return `did:cid:new${state.published.length}`; }),
        withdraw: vi.fn(async did => { state.timeline = state.timeline.map(each => (each.did === did ? { ...each, state: 'withdrawn' as const } : each)); }),
        timeline: vi.fn(async authors => state.timeline.filter(each => authors.includes(each.memeplex!.author))),
        thread: vi.fn(async () => []),
        publication: vi.fn(async () => undefined),
    };

    return { api, state };
}

const granted: Me = { did: ALICE, grant: 'did:cid:grant', registry: 'BTC:mainnet' };

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
        expect(api.timeline).toHaveBeenCalledWith([ALICE, BOB]);
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
        const { api } = services({ me: granted, timeline: [post('did:cid:1', ALICE, 'Mine.'), post('did:cid:2', BOB, 'Bob\'s.')] });
        render(<App api={api} />);
        const user = userEvent.setup();

        const mine = (await screen.findByText('Mine.')).closest('article')!;
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

    it('signs out', async () => {
        const { api } = services({ me: granted });
        render(<App api={api} />);

        await userEvent.setup().click(await screen.findByRole('button', { name: 'Sign out' }));

        expect(api.logout).toHaveBeenCalled();
        expect(await screen.findByRole('button', { name: 'Sign in with your wallet' })).toBeTruthy();
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

        expect(await api.timeline(['did:cid:a', 'did:cid:b'])).toStrictEqual([]);
        expect(await api.timeline([])).toStrictEqual([]);
        expect(asked).toHaveLength(1);
    });

    it('reports a refusal with the service\'s own words, and a publication the indexer has not as absent', async () => {
        const { api } = answering({ 'POST /memepool/api/v1/objects': { status: 403, body: { error: 'no grant to publish under' } } });

        await expect(api.publish({ kind: 'post', text: 'x' })).rejects.toMatchObject({ status: 403, message: 'no grant to publish under' });
        expect(await api.publication('did:cid:none')).toBeUndefined();
    });
});
