import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
        // The bodies the service holds, by the DID of the entry.
        bodies: {} as Record<string, string>,
        // What the service says of each identity, by its DID.
        people: {} as Record<string, { name?: string; address?: string }>,
        // The publications the indexer has, by DID, beside those of a timeline.
        known: {} as Record<string, Publication>,
        // Publications as they were at a version, by DID and version.
        revisions: {} as Record<string, Publication>,
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
        publication: vi.fn(async (did: string) => state.known[did]),
        revision: vi.fn(async (did: string, version: string) => state.revisions[`${did} ${version}`] ?? (state.known[did] ? 'no-revision' as const : undefined)),
        content: vi.fn(async (did: string, version?: string) => state.bodies[`${did} ${version}`] ?? state.bodies[did]),
        avatar: (did: string) => `/memepool/api/v1/avatars/${encodeURIComponent(did)}`,
        identity: vi.fn(async (did: string) => state.people[did] ?? {}),
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
        const { api } = services({ me: { did: ALICE, pending: [], link: 'archon://auth?grant=abc' } });
        render(<App api={api} />);

        expect((await screen.findByLabelText('Or copy the grant link') as HTMLInputElement).value).toBe('archon://auth?grant=abc');
        expect(screen.getByLabelText('Grant request')).toBeTruthy();
        expect(screen.queryByLabelText('Post')).toBeNull();
    });

    it('says why when the service can ask for no grant', async () => {
        const { api } = services({ me: { did: ALICE, pending: [], unavailable: 'this node supports no registry a grant may be made on' } });
        render(<App api={api} />);

        expect((await screen.findByRole('alert')).textContent).toMatch(/cannot be granted here: this node supports no registry/);
        expect(screen.queryByRole('button', { name: 'I have approved it' })).toBeNull();
        expect(screen.queryByLabelText('Grant request')).toBeNull();
    });

    it('copies the grant link, and says when it could not', async () => {
        const { api } = services({ me: { did: ALICE, pending: [], link: 'archon://auth?grant=abc' } });
        const user = userEvent.setup();
        const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
        render(<App api={api} />);

        await user.click(await screen.findByRole('button', { name: 'Copy grant link' }));
        expect(write).toHaveBeenCalledWith('archon://auth?grant=abc');
        expect((await screen.findByRole('status')).textContent).toMatch(/Copied/);

        write.mockRejectedValue(new Error('not allowed'));
        await user.click(screen.getByRole('button', { name: 'Copy grant link' }));
        await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/Could not copy/));
    });

    it('copies a post\'s DID, and says the DID when it could not', async () => {
        const { api } = services({ me: granted, timeline: [post('did:cid:1', ALICE, 'First.'), post('did:cid:2', BOB, 'Second.')] });
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        const user = userEvent.setup();
        const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
        render(<App api={api} />);

        // Each post has its own, the reader's and another author's alike.
        const copies = await screen.findAllByRole('button', { name: 'Copy DID' });
        expect(copies).toHaveLength(2);
        await user.click(copies[1]);
        expect(write).toHaveBeenCalledWith('did:cid:2');
        expect((await screen.findByRole('status')).textContent).toMatch(/Copied/);

        write.mockRejectedValue(new Error('not allowed'));
        await user.click(copies[0]);
        await waitFor(() => expect(screen.getAllByRole('status').some(said => /Could not copy\. The DID is did:cid:1/.test(said.textContent ?? ''))).toBe(true));
        localStorage.clear();
    });

    it('copies the DID of a post that is open, and offers none for one that was withdrawn', async () => {
        const withdrawn = { ...post('did:cid:2', ALICE, 'Gone.'), state: 'withdrawn' as const };
        const { api } = services({ me: granted, timeline: [post('did:cid:1', ALICE, 'First.'), withdrawn] });
        const user = userEvent.setup();
        const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
        render(<App api={api} />);

        expect(await screen.findAllByRole('button', { name: 'Copy DID' })).toHaveLength(1);
        await user.click(screen.getByRole('button', { name: 'Open' }));
        await user.click(await screen.findByRole('button', { name: 'Copy DID' }));
        expect(write).toHaveBeenCalledWith('did:cid:1');
    });

    it('says a grant is waiting to be anchored, and checks again when asked', async () => {
        const { api, state } = services({ me: { did: ALICE, pending: ['did:cid:grant'], link: 'archon://auth?grant=abc' } });
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
        const waitingForGrant: Me = { did: ALICE, pending: ['did:cid:grant'], link: 'archon://auth?grant=abc' };
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
        const { api } = services({ me: { did: ALICE, pending: ['did:cid:grant'], link: 'archon://auth?grant=abc' } });
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
            ],
        });
        render(<App api={api} />);

        expect(await screen.findByText('On DIDs')).toBeTruthy();
        expect(screen.getByText('A summary.')).toBeTruthy();
        // A list shows what an article says of itself, and reads no body.
        expect(screen.getAllByText('Open it to read the full text.')).toHaveLength(2);
        expect(api.content).not.toHaveBeenCalled();
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
        const waitingForGrant: Me = { did: ALICE, pending: ['did:cid:grant'], link: 'archon://auth?grant=abc' };
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
        const { api } = services({ me: { did: ALICE, pending: [], link: 'archon://auth?grant=abc' }, timeline: [root] });
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
        await user.click(await screen.findByRole('button', { name: 'Open' }));

        for (const name of ['Boost', 'Thumb up', 'Thumb down', 'Like', 'Add tag']) {
            expect(await screen.findByRole('button', { name })).toBeTruthy();
        }
        expect(screen.getByLabelText('Reply')).toBeTruthy();
    });
});

describe('an author\'s avatar', () => {
    const pictures = (within: ParentNode) => [...within.querySelectorAll('.avatar')] as HTMLElement[];

    it('is beside every post, asked for from the service by the author\'s DID', async () => {
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        const { api } = services({ me: granted, timeline: [post('did:cid:1', ALICE, 'From Alice.'), post('did:cid:2', BOB, 'From Bob.')] });
        render(<App api={api} />);

        const posts = (await screen.findAllByRole('article')).filter(each => !each.classList.contains('waiting'));
        const asked = posts.map(each => pictures(each)[0].querySelector('img')?.getAttribute('src'));

        expect(asked.sort()).toStrictEqual([ALICE, BOB].map(did => `/memepool/api/v1/avatars/${encodeURIComponent(did)}`).sort());
        // A picture says nothing a screen reader needs: the author is named beside it.
        expect(pictures(posts[0])[0].getAttribute('aria-hidden')).toBe('true');
    });

    it('is a figure where the author has none, of a colour that is the author\'s own', async () => {
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        const { api } = services({ me: granted, timeline: [post('did:cid:1', ALICE, 'From Alice.'), post('did:cid:2', BOB, 'From Bob.'), post('did:cid:3', ALICE, 'Alice once more.')] });
        render(<App api={api} />);

        const posts = (await screen.findAllByRole('article')).filter(each => !each.classList.contains('waiting'));
        const of = (text: string) => pictures(posts.find(each => each.textContent?.includes(text))!)[0];

        // The service has no avatar for Alice.
        fireEvent.error(of('From Alice.').querySelector('img')!);

        expect(of('From Alice.').querySelector('img')).toBeNull();
        expect(of('From Alice.').querySelector('svg')).not.toBeNull();
        // The figure is beneath a picture too, and shows until one has loaded.
        expect(of('From Bob.').querySelector('svg')).not.toBeNull();
        expect(of('From Bob.').querySelector('img')).not.toBeNull();
        expect(of('From Bob.').querySelector('img')!.classList.contains('loaded')).toBe(false);
        fireEvent.load(of('From Bob.').querySelector('img')!);
        expect(of('From Bob.').querySelector('img')!.classList.contains('loaded')).toBe(true);

        expect(of('From Alice.').style.background).toBe(of('Alice once more.').style.background);
        expect(of('From Alice.').style.background).not.toBe(of('From Bob.').style.background);
    });

    it('is beside the reader\'s own DID and each author followed', async () => {
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        const { api } = services({ me: granted });
        render(<App api={api} />);

        await screen.findByRole('button', { name: 'Unfollow' });
        const asked = pictures(document.body).map(each => each.querySelector('img')?.getAttribute('src'));

        expect(asked).toContain(`/memepool/api/v1/avatars/${encodeURIComponent(ALICE)}`);
        expect(asked).toContain(`/memepool/api/v1/avatars/${encodeURIComponent(BOB)}`);
    });
});

describe('an author\'s own posts', () => {
    const both = () => [post('did:cid:1', ALICE, 'From Alice.'), post('did:cid:2', BOB, 'From Bob.'), post('did:cid:3', BOB, 'Bob once more.')];
    // What the indexer was last asked for: whose posts, and from where.
    const lastRead = (api: Api) => vi.mocked(api.timeline).mock.calls.slice(-1)[0];
    const authorOf = (text: string) => within(screen.getByText(text).closest('article')!).getByRole('button', { name: /Posts by this author|did:cid/ });

    it('are what is shown when the reader goes to the author, and the timeline is a step back', async () => {
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        const { api, state } = services({ me: granted, timeline: both() });
        state.people[BOB] = { name: 'Bob B.' };
        render(<App api={api} />);
        const user = userEvent.setup();

        await screen.findByText('From Alice.');
        await user.click(authorOf('From Bob.'));

        // Bob's posts and no other's, asked of the indexer for Bob alone.
        expect(await screen.findByRole('heading', { name: /Posts/ })).toBeTruthy();
        await waitFor(() => expect(screen.queryByText('From Alice.')).toBeNull());
        expect(screen.getByText('From Bob.')).toBeTruthy();
        expect(screen.getByText('Bob once more.')).toBeTruthy();
        expect(lastRead(api)).toStrictEqual([[BOB], 0]);
        // Who it is, and nowhere to write: these are another's posts.
        expect(within(document.querySelector('.author') as HTMLElement).getByText('Bob B.')).toBeTruthy();
        expect(screen.queryByLabelText('Post')).toBeNull();
        expect(screen.queryByRole('heading', { name: 'Following' })).toBeNull();

        await user.click(screen.getByRole('button', { name: 'Back to your timeline' }));
        expect(await screen.findByText('From Alice.')).toBeTruthy();
        expect(screen.getByLabelText('Post')).toBeTruthy();
        expect(lastRead(api)).toStrictEqual([[ALICE, BOB], 0]);
    });

    it('can be followed and unfollowed from there, which is kept as any follow is', async () => {
        const { api } = services({ me: granted, timeline: both() });
        // The reader came on Bob by a boost or a reply, and does not follow him.
        vi.mocked(api.timeline).mockImplementation(async authors => {
            const publications = authors.includes(ALICE) ? both() : both().filter(each => authors.includes(each.memeplex!.author));

            return { total: publications.length, publications };
        });
        render(<App api={api} />);
        const user = userEvent.setup();

        await screen.findByText('From Bob.');
        await user.click(authorOf('From Bob.'));
        await user.click(await screen.findByRole('button', { name: 'Follow' }));

        expect(JSON.parse(localStorage.getItem('memepool.follows')!)).toStrictEqual([BOB]);
        // Still Bob's posts: following changes the reader's timeline, not this list.
        expect(lastRead(api)).toStrictEqual([[BOB], 0]);

        await user.click(await screen.findByRole('button', { name: 'Unfollow' }));
        expect(JSON.parse(localStorage.getItem('memepool.follows')!)).toStrictEqual([]);
    });

    it('are the reader\'s own when the reader goes to themselves, with nobody to follow', async () => {
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        const { api } = services({ me: granted, timeline: both() });
        render(<App api={api} />);
        const user = userEvent.setup();

        await screen.findByText('From Bob.');
        await user.click(within(document.querySelector('header.top') as HTMLElement).getByRole('button', { name: /did:cid/ }));

        await waitFor(() => expect(screen.queryByText('From Bob.')).toBeNull());
        expect(screen.getByText('From Alice.')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Follow' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Unfollow' })).toBeNull();
    });

    it('are reached from an open post as well, which closes it', async () => {
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        const { api } = services({ me: granted, timeline: both() });
        render(<App api={api} />);
        const user = userEvent.setup();

        await screen.findByText('From Bob.');
        await user.click(within(screen.getByText('From Bob.').closest('article')!).getByRole('button', { name: 'Open' }));
        await screen.findByLabelText('Reply');
        await user.click(authorOf('From Bob.'));

        expect(await screen.findByRole('button', { name: 'Back to your timeline' })).toBeTruthy();
        expect(screen.queryByLabelText('Reply')).toBeNull();
        expect(await screen.findByText('Bob once more.')).toBeTruthy();
    });

    it('are still there when a post opened from them is left by way of its author', async () => {
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        const { api } = services({ me: granted, timeline: both() });
        render(<App api={api} />);
        const user = userEvent.setup();

        await screen.findByText('From Bob.');
        await user.click(authorOf('From Bob.'));
        await waitFor(() => expect(screen.queryByText('From Alice.')).toBeNull());

        await user.click(within(screen.getByText('From Bob.').closest('article')!).getByRole('button', { name: 'Open' }));
        await screen.findByLabelText('Reply');
        await user.click(authorOf('From Bob.'));

        // The same author's list, read anew and not left waiting.
        expect(await screen.findByText('Bob once more.')).toBeTruthy();
        expect(screen.queryByLabelText('Reply')).toBeNull();
        expect(screen.queryByText('Loading…')).toBeNull();
        expect(lastRead(api)).toStrictEqual([[BOB], 0]);

        // And the reader's timeline likewise, from a post opened on it.
        await user.click(screen.getByRole('button', { name: 'Back to your timeline' }));
        await user.click(within((await screen.findByText('From Alice.')).closest('article')!).getByRole('button', { name: 'Open' }));
        await screen.findByLabelText('Reply');
        await user.click(screen.getByRole('button', { name: 'Back' }));
        expect(await screen.findByText('From Bob.')).toBeTruthy();
    });

    it('say there is nothing for an author with none, whatever of the reader\'s is waiting', async () => {
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        const { api } = services({ me: granted, timeline: [post('did:cid:1', ALICE, 'From Alice.')] });
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.type(await screen.findByLabelText('Post'), 'Not anchored yet.');
        await user.click(screen.getByRole('button', { name: 'Publish' }));
        expect(await screen.findByText('Waiting to be anchored')).toBeTruthy();

        // Bob, whom the reader follows, has published nothing.
        await user.click(within(screen.getByRole('heading', { name: 'Following' }).closest('section')!).getByRole('button', { name: /did:cid/ }));

        expect(await screen.findByText('Nothing here yet.')).toBeTruthy();
        expect(screen.queryByText('Waiting to be anchored')).toBeNull();

        // The reader's own posts hold what is waiting.
        await user.click(within(document.querySelector('header.top') as HTMLElement).getByRole('button', { name: /did:cid/ }));
        expect(await screen.findByText('Waiting to be anchored')).toBeTruthy();
    });

    it('show older posts a page at a time, of that author', async () => {
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        const many = Array.from({ length: PAGE + 2 }, (_, index) => post(`did:cid:b${index}`, BOB, `Bob ${index}.`));
        const { api } = services({ me: granted, timeline: [post('did:cid:1', ALICE, 'From Alice.'), ...many] });
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(authorOf(await screen.findByText('Bob 0.').then(() => 'Bob 0.')));
        await waitFor(() => expect(screen.queryByText('From Alice.')).toBeNull());
        await user.click(await screen.findByRole('button', { name: 'Older' }));

        expect(await screen.findByText(`Bob ${PAGE + 1}.`)).toBeTruthy();
        expect(lastRead(api)).toStrictEqual([[BOB], PAGE]);
    });
});

describe('a boost', () => {
    const ORIGINAL = 'did:cid:bagaaieraoriginaloriginaloriginaloriginaloriginalorigina';
    const MIDDLE = 'did:cid:bagaaieramiddlemiddlemiddlemiddlemiddlemiddlemiddlemiddl';
    // A boost names what it is of and the version of it.
    const boostOf = (did: string, author: string, target: string, targetVersion = `op-${target}`): Publication =>
        ({ ...post(did, author, ''), memeplex: { kind: 'post', author, target, targetVersion, grant: 'did:cid:grant' } });
    // The indexer has a publication as it is, and as it was at its first version.
    const has = (state: ReturnType<typeof services>['state'], publication: Publication) => {
        state.known[publication.did!] = publication;
        state.revisions[`${publication.did} ${publication.versions[0].opid}`] = publication;
    };

    it('is shown as the post it is of, under who boosted it', async () => {
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        const { api, state } = services({ me: granted, timeline: [boostOf('did:cid:boost', ALICE, ORIGINAL)] });
        has(state, post(ORIGINAL, BOB, 'What **Bob** wrote.'));
        state.people[ALICE] = { name: 'Alice' };
        state.people[BOB] = { name: 'Bob B.' };
        render(<App api={api} />);

        const entry = (await screen.findByText('boosted')).closest('article')!;

        // Who boosted, and then the post as it is shown anywhere: its author and its text.
        expect(await within(entry.querySelector('.boosted') as HTMLElement).findByText('Alice')).toBeTruthy();
        const original = await waitFor(() => entry.querySelector('.original') as HTMLElement);
        expect(await within(original).findByText('Bob B.')).toBeTruthy();
        expect(within(original).getByText('Bob').tagName).toBe('STRONG');
        // It is asked for at the version the boost names.
        expect(api.revision).toHaveBeenCalledWith(ORIGINAL, `op-${ORIGINAL}`);
        expect(screen.queryByText(/A boost of/)).toBeNull();
    });

    it('shows the version boosted, whatever the post says since', async () => {
        const { api, state } = services({ me: granted, timeline: [boostOf('did:cid:boost', ALICE, ORIGINAL)] });
        const first = post(ORIGINAL, BOB, 'What Bob wrote.');
        has(state, first);
        // Bob has edited the post since, and the indexer shows the edit as the post.
        state.known[ORIGINAL] = {
            ...post(ORIGINAL, BOB, 'Something else entirely.'),
            current: 1,
            versions: [first.versions[0], { opid: 'op-edit', type: 'update', outcome: 'attributed' }],
        };
        render(<App api={api} />);
        const user = userEvent.setup();

        expect(await screen.findByText('What Bob wrote.')).toBeTruthy();
        expect(screen.queryByText('Something else entirely.')).toBeNull();

        // Reading the timeline anew changes nothing: the boost is of that version.
        await user.click(screen.getByRole('button', { name: 'Refresh' }));
        await waitFor(() => expect(vi.mocked(api.revision).mock.calls.length).toBeGreaterThan(1));
        expect(screen.getByText('What Bob wrote.')).toBeTruthy();
        expect(screen.queryByText('Something else entirely.')).toBeNull();
    });

    it('opens the post as it is, and copies its DID', async () => {
        const { api, state } = services({ me: granted, timeline: [boostOf('did:cid:boost', ALICE, ORIGINAL)] });
        const first = post(ORIGINAL, BOB, 'What Bob wrote.');
        has(state, first);
        state.known[ORIGINAL] = { ...post(ORIGINAL, BOB, 'What Bob wrote, corrected.'), current: 1, versions: [first.versions[0], { opid: 'op-edit', type: 'update', outcome: 'attributed' }] };
        const user = userEvent.setup();
        const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
        render(<App api={api} />);

        await screen.findByText('What Bob wrote.');
        await user.click(screen.getByRole('button', { name: 'Copy DID' }));
        expect(write).toHaveBeenCalledWith(ORIGINAL);

        await user.click(screen.getByRole('button', { name: 'Open' }));
        // The thread is the post's own, as it is: that is what there is to answer.
        expect(await screen.findByLabelText('Reply')).toBeTruthy();
        expect(api.thread).toHaveBeenCalledWith(ORIGINAL);
        expect(screen.getByText('What Bob wrote, corrected.')).toBeTruthy();
        expect(screen.queryByText('boosted')).toBeNull();
    });

    it('opens nothing when the post cannot be read as it is, or has just been withdrawn', async () => {
        const { api, state } = services({ me: granted, timeline: [boostOf('did:cid:boost', ALICE, ORIGINAL)] });
        has(state, post(ORIGINAL, BOB, 'What Bob wrote.'));
        render(<App api={api} />);
        const user = userEvent.setup();

        await screen.findByText('What Bob wrote.');
        vi.mocked(api.publication).mockRejectedValueOnce(new Error('the indexer is away'));
        await user.click(screen.getByRole('button', { name: 'Open' }));

        // The version boosted is not opened in its place.
        expect(await screen.findByText(/The post cannot be opened as it is/)).toBeTruthy();
        expect(screen.queryByLabelText('Reply')).toBeNull();
        expect(api.thread).not.toHaveBeenCalled();

        // Withdrawn since the boost was read.
        state.known[ORIGINAL] = { ...state.known[ORIGINAL], state: 'withdrawn' };
        await user.click(screen.getByRole('button', { name: 'Open' }));
        expect(await screen.findByText(/The post cannot be opened as it is/)).toBeTruthy();
        expect(api.thread).not.toHaveBeenCalled();

        // And opened once it can be.
        state.known[ORIGINAL] = post(ORIGINAL, BOB, 'What Bob wrote.');
        await user.click(screen.getByRole('button', { name: 'Open' }));
        expect(await screen.findByLabelText('Reply')).toBeTruthy();
    });

    it('is undone by the reader who made it, which withdraws the boost and not the post', async () => {
        const { api, state } = services({ me: granted, timeline: [boostOf('did:cid:boost', ALICE, ORIGINAL)] });
        has(state, post(ORIGINAL, BOB, 'What Bob wrote.'));
        render(<App api={api} />);
        const user = userEvent.setup();

        await screen.findByText('What Bob wrote.');
        expect(screen.queryByRole('button', { name: 'Withdraw' })).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Undo boost' }));

        await waitFor(() => expect(api.withdraw).toHaveBeenCalledWith('did:cid:boost'));
    });

    it('still shows a post its author has since withdrawn, says so, and offers nothing to open', async () => {
        const { api, state } = services({ me: granted, timeline: [boostOf('did:cid:boost', ALICE, ORIGINAL)] });
        const gone = { ...post(ORIGINAL, BOB, 'What Bob wrote.'), state: 'withdrawn' as const };
        has(state, gone);
        render(<App api={api} />);

        expect(await screen.findByText('What Bob wrote.')).toBeTruthy();
        expect(screen.getByText('Its author has since withdrawn this post.')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
    });

    it('shows no other version in place of one that is not in the post\'s history', async () => {
        const { api, state } = services({ me: granted, timeline: [boostOf('did:cid:boost', ALICE, ORIGINAL, 'op-displaced')] });
        // The history holds another version where the one boosted was.
        has(state, post(ORIGINAL, BOB, 'What took its place.'));
        render(<App api={api} />);

        expect(await screen.findByText(/The version boosted is no longer in the history of/)).toBeTruthy();
        expect(screen.getByTitle(ORIGINAL)).toBeTruthy();
        expect(screen.queryByText('What took its place.')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
    });

    it('says so when the indexer has no such post or cannot be read, and shows it once it can', async () => {
        const { api, state } = services({ me: granted, timeline: [boostOf('did:cid:boost', ALICE, ORIGINAL)] });
        render(<App api={api} />);
        const user = userEvent.setup();

        expect(await screen.findByText(/The post cannot be shown/)).toBeTruthy();
        expect(screen.getByTitle(ORIGINAL)).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();

        vi.mocked(api.revision).mockRejectedValueOnce(new Error('the indexer is away'));
        await user.click(screen.getByRole('button', { name: 'Refresh' }));
        await waitFor(() => expect(vi.mocked(api.revision).mock.calls.length).toBeGreaterThan(1));
        expect(screen.getByText(/The post cannot be shown/)).toBeTruthy();

        // The indexer has read the post since.
        has(state, post(ORIGINAL, BOB, 'What Bob wrote.'));
        await user.click(screen.getByRole('button', { name: 'Refresh' }));
        expect(await screen.findByText('What Bob wrote.')).toBeTruthy();
    });

    it('shows the post a boost of a boost passes on, each at the version the one before names', async () => {
        const { api, state } = services({ me: granted, timeline: [boostOf('did:cid:boost', ALICE, MIDDLE)] });
        const middle = boostOf(MIDDLE, BOB, ORIGINAL);
        has(state, middle);
        has(state, post(ORIGINAL, BOB, 'What Bob wrote.'));
        // The boost in between has since been edited to name another version, which changes nothing here.
        state.known[MIDDLE] = { ...middle, current: 1, memeplex: { ...middle.memeplex!, targetVersion: 'op-later' } };
        const user = userEvent.setup();
        const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
        render(<App api={api} />);

        expect(await screen.findByText('What Bob wrote.')).toBeTruthy();
        expect(vi.mocked(api.revision).mock.calls).toStrictEqual([[MIDDLE, `op-${MIDDLE}`], [ORIGINAL, `op-${ORIGINAL}`]]);
        await user.click(screen.getByRole('button', { name: 'Copy DID' }));
        expect(write).toHaveBeenCalledWith(ORIGINAL);
        await user.click(screen.getByRole('button', { name: 'Open' }));
        await waitFor(() => expect(api.thread).toHaveBeenCalledWith(ORIGINAL));
    });

    it('follows boosts of boosts only so far, and never round', async () => {
        const A = 'did:cid:bagaaieraaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        const B = 'did:cid:bagaaierabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        const { api, state } = services({ me: granted, timeline: [boostOf('did:cid:boost', ALICE, A)] });
        has(state, boostOf(A, BOB, B));
        has(state, boostOf(B, BOB, A));
        const view = render(<App api={api} />);

        expect(await screen.findByText(/The post cannot be shown/)).toBeTruthy();
        expect(vi.mocked(api.revision).mock.calls.length).toBe(2);
        view.unmount();

        // A chain longer than is followed.
        const chain = Array.from({ length: 8 }, (_, index) => `did:cid:bagaaierachain${index}`);
        chain.forEach((did, index) => has(state, index === 7 ? post(did, BOB, 'At the end.') : boostOf(did, BOB, chain[index + 1])));
        state.timeline = [boostOf('did:cid:boost', ALICE, chain[0])];
        vi.mocked(api.revision).mockClear();
        render(<App api={api} />);

        expect(await screen.findByText(/The post cannot be shown/)).toBeTruthy();
        expect(screen.queryByText('At the end.')).toBeNull();
        expect(vi.mocked(api.revision).mock.calls.length).toBe(5);
    });
});

describe('an author\'s name and address', () => {
    it('are beside the author\'s posts, with the DID, and asked for once for each author', async () => {
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        const { api, state } = services({ me: granted, timeline: [post('did:cid:1', BOB, 'From Bob.'), post('did:cid:2', BOB, 'Bob once more.'), post('did:cid:3', ALICE, 'From Alice.')] });
        state.people[BOB] = { name: 'Bob B.', address: 'bob@example.org' };
        state.people[ALICE] = { name: 'Alice' };
        render(<App api={api} />);

        const first = (await screen.findByText('From Bob.')).closest('article')!;
        expect(await within(first).findByText('Bob B.')).toBeTruthy();
        expect(within(first).getByText('bob@example.org')).toBeTruthy();
        // A name is a claim, so who wrote is still there to see.
        expect(within(first).getByTitle(BOB)).toBeTruthy();
        expect(await within(screen.getByText('Bob once more.').closest('article')!).findByText('Bob B.')).toBeTruthy();

        const hers = screen.getByText('From Alice.').closest('article')!;
        expect(await within(hers).findByText('Alice')).toBeTruthy();
        expect(hers.querySelector('.address')).toBeNull();

        expect((api.identity as ReturnType<typeof vi.fn>).mock.calls.map(([did]) => did).sort()).toStrictEqual([ALICE, BOB].sort());
    });

    it('shows the DID alone for an author with neither, and when the service cannot say', async () => {
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        const { api } = services({ me: granted, timeline: [post('did:cid:1', BOB, 'From Bob.')] });
        (api.identity as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('the service is away'));
        render(<App api={api} />);

        const first = (await screen.findByText('From Bob.')).closest('article')!;
        await waitFor(() => expect(api.identity).toHaveBeenCalled());

        expect(within(first).getByTitle(BOB)).toBeTruthy();
        expect(first.querySelector('.called')).toBeNull();
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('shows a name as the text it is', async () => {
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        const { api, state } = services({ me: granted, timeline: [post('did:cid:1', BOB, 'From Bob.')] });
        state.people[BOB] = { name: '<b>Bob</b> **B**' };
        render(<App api={api} />);

        const first = (await screen.findByText('From Bob.')).closest('article')!;
        expect(await within(first).findByText('<b>Bob</b> **B**')).toBeTruthy();
        expect(first.querySelector('header b')).toBeNull();
    });
});

describe('previewing what is written', () => {
    it('shows a post as it will be shown, keeps what was written, and publishes from either view', async () => {
        const { api, state } = services({ me: granted });
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.type(await screen.findByLabelText('Post'), 'A **bold** post.{Enter}On one line.');
        await user.click(screen.getByRole('tab', { name: 'Preview' }));

        const preview = screen.getByRole('tabpanel', { name: 'Post preview' });
        expect(within(preview).getByText('bold').tagName).toBe('STRONG');
        // Markdown joins the lines of a paragraph, which is what readers will see.
        expect(preview.querySelectorAll('p')).toHaveLength(1);
        expect(screen.queryByLabelText('Post')).toBeNull();

        await user.click(screen.getByRole('tab', { name: 'Write' }));
        expect((screen.getByLabelText('Post') as HTMLTextAreaElement).value).toBe('A **bold** post.\nOn one line.');

        await user.click(screen.getByRole('tab', { name: 'Preview' }));
        await user.click(screen.getByRole('button', { name: 'Publish' }));
        await waitFor(() => expect(state.published).toStrictEqual([{ kind: 'post', text: 'A **bold** post.\nOn one line.' }]));
    });

    it('says there is nothing to preview before anything is written, and makes nothing of HTML', async () => {
        const { api } = services({ me: granted });
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await screen.findByRole('tab', { name: 'Preview' }));
        expect(screen.getByText('Nothing to preview.')).toBeTruthy();

        await user.click(screen.getByRole('tab', { name: 'Write' }));
        await user.type(screen.getByLabelText('Post'), '<b>not bold</b>');
        await user.click(screen.getByRole('tab', { name: 'Preview' }));
        const preview = screen.getByRole('tabpanel', { name: 'Post preview' });

        expect(preview.querySelector('b')).toBeNull();
        expect(preview.textContent).toContain('<b>not bold</b>');
    });

    it('previews a post as it is published, which is without the white space around it', async () => {
        const { api, state } = services({ me: granted });
        render(<App api={api} />);
        const user = userEvent.setup();

        // Four spaces before a line make a block of code of it.
        await user.type(await screen.findByLabelText('Post'), '    **bold**  ');
        await user.click(screen.getByRole('tab', { name: 'Preview' }));

        const preview = screen.getByRole('tabpanel', { name: 'Post preview' });
        expect(within(preview).getByText('bold').tagName).toBe('STRONG');
        expect(preview.querySelector('pre')).toBeNull();

        await user.click(screen.getByRole('button', { name: 'Publish' }));
        await waitFor(() => expect(state.published).toStrictEqual([{ kind: 'post', text: '**bold**' }]));
    });

    it('moves between the two views with the arrow keys, with one of them in the order the Tab key follows', async () => {
        const { api } = services({ me: granted });
        render(<App api={api} />);
        const user = userEvent.setup();
        const write = await screen.findByRole('tab', { name: 'Write' });
        const preview = screen.getByRole('tab', { name: 'Preview' });

        expect([write.tabIndex, preview.tabIndex]).toStrictEqual([0, -1]);
        expect(write.getAttribute('aria-controls')).toBe(screen.getByRole('tabpanel', { name: 'Post: write' }).id);

        write.focus();
        await user.keyboard('{ArrowRight}');
        expect(document.activeElement).toBe(preview);
        expect(preview.getAttribute('aria-selected')).toBe('true');
        expect([write.tabIndex, preview.tabIndex]).toStrictEqual([-1, 0]);
        expect(screen.getByRole('tabpanel', { name: 'Post preview' }).id).toBe(preview.getAttribute('aria-controls'));

        await user.keyboard('{ArrowLeft}');
        expect(document.activeElement).toBe(write);
        expect(screen.getByLabelText('Post')).toBeTruthy();
    });

    it('shows an article with its title and summary above its body', async () => {
        const { api } = services({ me: granted });
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await screen.findByRole('button', { name: 'Write an article' }));
        await user.type(screen.getByLabelText('Title'), 'On DIDs');
        await user.type(screen.getByLabelText('Summary'), 'A summary.');
        await user.type(screen.getByLabelText('Article'), '## A section{Enter}{Enter}- one{Enter}- two');
        await user.click(screen.getByRole('tab', { name: 'Preview' }));

        const preview = screen.getByRole('tabpanel', { name: 'Article preview' });
        expect(within(preview).getByRole('heading', { name: 'On DIDs' })).toBeTruthy();
        expect(within(preview).getByText('A summary.')).toBeTruthy();
        expect(within(preview).getByRole('heading', { name: 'A section' })).toBeTruthy();
        expect(within(preview).getAllByRole('listitem')).toHaveLength(2);
        // The body is set apart from what is above it, as an opened article's is.
        expect(preview.querySelector('.markdown')?.classList.contains('article')).toBe(true);
        // The title and summary are still there to change.
        expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('On DIDs');
    });

    it('shows a reply, and an edit, as each will be shown', async () => {
        const mine = under(post('did:cid:1', ALICE, 'A post.'), 'did:cid:grant');
        const { api } = services({ me: granted, timeline: [mine] });
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await screen.findByRole('button', { name: 'Open' }));
        await user.type(await screen.findByLabelText('Reply'), 'A `coded` reply.');
        await user.click(screen.getByRole('tab', { name: 'Preview' }));
        expect(within(screen.getByRole('tabpanel', { name: 'Reply preview' })).getByText('coded').tagName).toBe('CODE');

        await user.click(screen.getByRole('button', { name: 'Edit' }));
        await user.type(screen.getByLabelText('Edit'), ' And *more*.');
        const editor = screen.getByLabelText('Edit').closest('.draft') as HTMLElement;
        await user.click(within(editor).getByRole('tab', { name: 'Preview' }));
        expect(within(screen.getByRole('tabpanel', { name: 'Edit preview' })).getByText('more').tagName).toBe('EM');
    });
});

describe('an article', () => {
    const BODY = '# On DIDs\n\nEvery post is one.\n';
    const article = (did: string, author = ALICE): Publication => under({
        ...post(did, author, ''),
        memeplex: { kind: 'post', author, title: 'On DIDs', summary: 'A summary.', content: { cid: 'bafkreibody', type: 'text/markdown', bytes: BODY.length }, v: 1 },
    }, 'did:cid:grant');

    it('is written with a title, a summary and a body, which the service is sent to store', async () => {
        const { api, state } = services({ me: granted });
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await screen.findByRole('button', { name: 'Write an article' }));
        expect((screen.getByRole('button', { name: 'Publish article' }) as HTMLButtonElement).disabled).toBe(true);
        await user.type(screen.getByLabelText('Title'), 'On DIDs');
        await user.type(screen.getByLabelText('Summary'), 'A summary.');
        await user.type(screen.getByLabelText('Article'), 'Every post is one.');
        await user.click(screen.getByRole('button', { name: 'Publish article' }));

        await waitFor(() => expect(state.published).toStrictEqual([
            { kind: 'post', title: 'On DIDs', summary: 'A summary.', body: 'Every post is one.' },
        ]));
        // Waiting to be anchored, under its title, and the short form is back.
        expect((await screen.findByRole('heading', { name: 'On DIDs' })).closest('.waiting')).not.toBeNull();
        expect(screen.getByLabelText('Post')).toBeTruthy();
    });

    it('shows a waiting article\'s title as it was written, and a waiting post\'s text as Markdown', async () => {
        const { api } = services({ me: granted });
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.type(await screen.findByLabelText('Post'), 'A **bold** post.');
        await user.click(screen.getByRole('button', { name: 'Publish' }));
        expect((await screen.findByText('bold')).tagName).toBe('STRONG');

        await user.click(screen.getByRole('button', { name: 'Write an article' }));
        await user.type(screen.getByLabelText('Title'), '**Important**');
        await user.type(screen.getByLabelText('Article'), 'The body.');
        await user.click(screen.getByRole('button', { name: 'Publish article' }));

        expect(await screen.findByRole('heading', { name: '**Important**' })).toBeTruthy();
    });

    it('keeps what was written when the service refuses it, and leaves when cancelled', async () => {
        const { api } = services({ me: granted });
        vi.mocked(api.publish).mockRejectedValue(new ApiError(400, 'a body may be 200000 bytes, and this is 200001'));
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await screen.findByRole('button', { name: 'Write an article' }));
        await user.type(screen.getByLabelText('Title'), 'On DIDs');
        await user.type(screen.getByLabelText('Article'), 'Too much.');
        await user.click(screen.getByRole('button', { name: 'Publish article' }));

        expect((await screen.findByRole('alert')).textContent).toMatch(/a body may be 200000 bytes/);
        expect((screen.getByLabelText('Article') as HTMLTextAreaElement).value).toBe('Too much.');
        await user.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(screen.getByLabelText('Post')).toBeTruthy();
    });

    it('is read in full when it is opened', async () => {
        const { api, state } = services({ me: granted, timeline: [article('did:cid:1')] });
        state.bodies['did:cid:1'] = BODY;
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await screen.findByRole('button', { name: 'Open' }));

        expect(await screen.findByText(/Every post is one\./)).toBeTruthy();
        // The body asked for is that of the version shown.
        expect(api.content).toHaveBeenCalledWith('did:cid:1', 'op-did:cid:1');
        expect(screen.getByText('A summary.')).toBeTruthy();
    });

    it('says so when the service does not hold the body, or could not read it', async () => {
        const { api } = services({ me: granted, timeline: [article('did:cid:1', BOB)] });
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await screen.findByRole('button', { name: 'Open' }));
        expect(await screen.findByText(/this service does not hold it/)).toBeTruthy();

        vi.mocked(api.content).mockRejectedValue(new ApiError(502, 'the node does not have the body'));
        await user.click(screen.getByRole('button', { name: 'Back' }));
        await user.click(await screen.findByRole('button', { name: 'Open' }));
        expect((await screen.findByRole('alert')).textContent).toMatch(/could not be read: the node does not have the body/);
        localStorage.clear();
    });

    it('is edited with its body, and sends the body only when it has changed', async () => {
        const { api, state } = services({ me: granted, timeline: [article('did:cid:1')] });
        state.bodies['did:cid:1'] = BODY;
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await screen.findByRole('button', { name: 'Open' }));
        await user.click(await screen.findByRole('button', { name: 'Edit' }));
        await waitFor(() => expect((screen.getByLabelText('Article') as HTMLTextAreaElement).value).toBe(BODY));
        expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);

        await user.clear(screen.getByLabelText('Title'));
        await user.type(screen.getByLabelText('Title'), 'On every DID');
        await user.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(state.edited).toStrictEqual([{
            did: 'did:cid:1',
            object: { kind: 'post', title: 'On every DID', summary: 'A summary.', content: { cid: 'bafkreibody', type: 'text/markdown', bytes: BODY.length } },
        }]));
    });

    it('sends a changed body for the service to store, in place of the reference', async () => {
        const { api, state } = services({ me: granted, timeline: [article('did:cid:1')] });
        state.bodies['did:cid:1'] = BODY;
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await screen.findByRole('button', { name: 'Open' }));
        await user.click(await screen.findByRole('button', { name: 'Edit' }));
        await waitFor(() => expect((screen.getByLabelText('Article') as HTMLTextAreaElement).value).toBe(BODY));
        await user.type(screen.getByLabelText('Article'), 'More.');
        await user.clear(screen.getByLabelText('Summary'));
        await user.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(state.edited).toStrictEqual([{
            did: 'did:cid:1', object: { kind: 'post', title: 'On DIDs', body: `${BODY}More.` },
        }]));
    });

    it('reads the body again when another version is shown, and lets it be edited again', async () => {
        const first = article('did:cid:1');
        const { api, state } = services({ me: granted, timeline: [first] });
        state.bodies['did:cid:1 op-did:cid:1'] = BODY;
        state.bodies['did:cid:1 op-second'] = 'Rewritten.';
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await screen.findByRole('button', { name: 'Open' }));
        expect(await screen.findByText(/Every post is one\./)).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Edit' }));
        await waitFor(() => expect((screen.getByLabelText('Article') as HTMLTextAreaElement).value).toBe(BODY));
        await user.clear(screen.getByLabelText('Summary'));
        await user.click(screen.getByRole('button', { name: 'Save' }));

        // Not anchored: the version shown is the one before, with its body.
        expect(await screen.findByText('Your edit is waiting to be anchored.')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
        expect(screen.getByText(/Every post is one\./)).toBeTruthy();

        vi.mocked(api.publication).mockResolvedValue({
            ...first, current: 1,
            versions: [...first.versions, { opid: 'op-second', type: 'update', outcome: 'attributed', position: { block: 2, time: '2026-11-22T12:00:00Z' } }],
            memeplex: { ...first.memeplex!, summary: undefined, content: { cid: 'bafkreisecond', type: 'text/markdown', bytes: 10 } },
        });
        await user.click(screen.getByRole('button', { name: 'Refresh' }));

        expect(await screen.findByText('Rewritten.')).toBeTruthy();
        await waitFor(() => expect(screen.queryByText('Your edit is waiting to be anchored.')).toBeNull());
        expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
    });

    it('starts an edit again from another version that a refresh shows, and keeps a paper\'s summary when it is emptied', async () => {
        const paper = under({
            ...post('did:cid:1', ALICE, ''),
            memeplex: { kind: 'paper', author: ALICE, title: 'On DIDs', summary: 'A summary.', authors: [ALICE], content: { cid: 'bafkreibody', type: 'text/markdown', bytes: BODY.length }, v: 1 },
        }, 'did:cid:grant');
        const { api, state } = services({ me: granted, timeline: [paper] });
        state.bodies['did:cid:1 op-did:cid:1'] = BODY;
        state.bodies['did:cid:1 op-second'] = 'Rewritten elsewhere.';
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await screen.findByRole('button', { name: 'Open' }));
        await user.click(await screen.findByRole('button', { name: 'Edit' }));
        await waitFor(() => expect((screen.getByLabelText('Article') as HTMLTextAreaElement).value).toBe(BODY));
        await user.type(screen.getByLabelText('Article'), 'Not to be saved over what was not seen.');

        // Changed from another device while the editor is open.
        vi.mocked(api.publication).mockResolvedValue({
            ...paper, current: 1,
            versions: [...paper.versions, { opid: 'op-second', type: 'update', outcome: 'attributed', position: { block: 2, time: '2026-11-22T12:00:00Z' } }],
            memeplex: { ...paper.memeplex!, title: 'On every DID', content: { cid: 'bafkreisecond', type: 'text/markdown', bytes: 20 } },
        });
        await user.click(screen.getByRole('button', { name: 'Refresh' }));

        await waitFor(() => expect((screen.getByLabelText('Article') as HTMLTextAreaElement).value).toBe('Rewritten elsewhere.'));
        expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('On every DID');

        await user.clear(screen.getByLabelText('Summary'));
        await user.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(state.edited).toStrictEqual([{
            did: 'did:cid:1',
            object: { kind: 'paper', title: 'On every DID', summary: '', authors: [ALICE], content: { cid: 'bafkreisecond', type: 'text/markdown', bytes: 20 } },
        }]));
    });

    it('cannot be changed here when the service does not hold its body', async () => {
        const { api, state } = services({ me: granted, timeline: [article('did:cid:1')] });
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await screen.findByRole('button', { name: 'Open' }));
        await user.click(await screen.findByRole('button', { name: 'Edit' }));

        expect((await screen.findByRole('alert')).textContent).toMatch(/does not hold the full text/);
        expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
        expect(state.edited).toStrictEqual([]);
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

    it('reads a body as text, and none when the service holds none', async () => {
        const asked: string[] = [];
        const fetcher = (async (url: string) => {
            asked.push(url);

            return url === '/memepool/api/v1/objects/did%3Acid%3A1/content'
                ? new Response('# On DIDs\n', { status: 200, headers: { 'Content-Type': 'text/markdown; charset=utf-8' } })
                : new Response(JSON.stringify({ error: 'no body the service holds' }), { status: 404 });
        }) as unknown as typeof fetch;
        const api = createApi({ memepool: '/memepool', memeplex: '/memeplex' }, fetcher);

        expect(await api.content('did:cid:1')).toBe('# On DIDs\n');
        expect(await api.content('did:cid:2')).toBeUndefined();
        expect(await api.content('did:cid:1', 'bafy version')).toBeUndefined();
        expect(asked[2]).toBe('/memepool/api/v1/objects/did%3Acid%3A1/content?versionId=bafy%20version');
    });

    it('reads a publication at a version, and takes no other version for it', async () => {
        const at = (opid: string) => ({ ...post('did:cid:1', ALICE, 'First.'), current: 0, versions: [{ opid, type: 'create', outcome: 'attributed' }] });
        const path = (version: string) => `GET /memeplex/api/v1/publications/did%3Acid%3A1?versionId=${version}`;
        const { api } = answering({
            [path('v1')]: { status: 200, body: at('v1') },
            // An indexer that does not know the question answers with the publication as it is.
            [path('v0')]: { status: 200, body: at('v1') },
            [path('gone')]: { status: 404, body: { error: 'no such attributed version in the history', reason: 'no-revision' } },
            [path('none')]: { status: 404, body: { error: 'no attributed publication', reason: 'no-publication' } },
        });

        expect(await api.revision('did:cid:1', 'v1')).toMatchObject({ did: 'did:cid:1', current: 0 });
        expect(await api.revision('did:cid:1', 'v0')).toBeUndefined();
        expect(await api.revision('did:cid:1', 'gone')).toBe('no-revision');
        expect(await api.revision('did:cid:1', 'none')).toBeUndefined();
        expect(await api.revision('did:cid:1', 'unrouted')).toBeUndefined();
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
