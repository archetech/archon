import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App, { coauthorsIn, responsesAt, tagWord } from '../App';
import { ApiError, createApi } from '../api';
import type { Api, Coauthor, Me, Publication, Responses } from '../api';
import { linkTo, pathOf, routeOf, setRoot } from '../route';

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
// The first post listed that a click opens, once there is one.
const toOpen = () => waitFor(() => {
    const found = document.querySelector<HTMLElement>('article.post.opens');

    if (!found) {
        throw new Error('nothing is listed that a click opens');
    }

    return found;
});

// Chooses one of the things the post that is open offers under its More button.
const choose = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
    await user.click(await screen.findByRole('button', { name: 'More' }));
    await user.click(screen.getByRole('menuitem', { name }));
};
// What the post that is open offers under its More button.
const offered = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(await screen.findByRole('button', { name: 'More' }));
    const names = screen.getAllByRole('menuitem').map(each => each.textContent);

    await user.keyboard('{Escape}');

    return names;
};

const PAGE = 50;
// The kinds a reader's timeline and an author's posts are, and an author's replies.
const POSTS = ['post', 'paper'];
const REPLIES = ['reply'];

// The services, as far as the pages can tell.
function services(start: { me?: Me; timeline?: Publication[] } = {}) {
    const state = {
        me: start.me as Me | undefined,
        timeline: start.timeline ?? [],
        published: [] as Record<string, unknown>[],
        edited: [] as { did: string; object: Record<string, unknown> }[],
        responses: { boosts: [], ratings: { ratings: [] }, tags: [] } as Responses,
        // The bodies the node has, by CID.
        bodies: {} as Record<string, string>,
        // How each coauthor a paper lists stands, by the paper's DID.
        coauthors: {} as Record<string, Coauthor[]>,
        // The last version of each object as the node has it, anchored or not, by DID.
        unanchored: {} as Record<string, { versionId: string; memeplex: NonNullable<Publication['memeplex']> }>,
        // What the service says of each identity, by its DID.
        people: {} as Record<string, { name?: string; address?: string }>,
        // The publications the indexer has, by DID, beside those of a timeline.
        known: {} as Record<string, Publication>,
        // Where the service says each of the reader's objects stands, by DID.
        states: {} as Record<string, { state: Publication['state']; registry?: string }>,
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
        timeline: vi.fn(async (authors, offset = 0, kinds, titled) => {
            const article = (each: Publication) => typeof each.memeplex!.title === 'string';
            const all = state.timeline.filter(each => authors.includes(each.memeplex!.author) && (!kinds || kinds.includes(String(each.memeplex!.kind)))
                && (titled === undefined || each.memeplex!.kind !== 'post' || article(each) === titled));

            return { total: all.length, publications: all.slice(offset, offset + PAGE) };
        }),
        thread: vi.fn(async () => []),
        coauthors: vi.fn(async (did: string) => state.coauthors[did] ?? []),
        responses: vi.fn(async () => state.responses),
        publication: vi.fn(async (did: string) => state.known[did]),
        state: vi.fn(async (did: string) => state.states[did]),
        upload: vi.fn(async () => ({ did: 'did:cid:bagaaieraimage', versionId: 'bafyimage' })),
        file: vi.fn(async (kind: 'pdf' | 'source', file: Blob) => ({ cid: `bafy${kind}`, type: kind === 'pdf' ? 'application/pdf' : 'application/x-tex', bytes: file.size })),
        download: (file: { cid: string }, name: string) => `/api/v1/ipfs/stream/${file.cid}?filename=${encodeURIComponent(name)}`,
        revision: vi.fn(async (did: string, version: string) => state.revisions[`${did} ${version}`] ?? (state.known[did] ? 'no-revision' as const : undefined)),
        content: vi.fn(async (cid: string) => state.bodies[cid]),
        // The node has every object, at the version shown unless a test says it has a later one.
        unanchored: vi.fn(async (did: string) => {
            const shown = [...state.timeline, ...Object.values(state.known)].find(each => each.did === did);
            const opid = shown?.versions[shown.current ?? 0]?.opid;

            return state.unanchored[did] ?? (shown?.memeplex && opid ? { versionId: opid, memeplex: shown.memeplex } : undefined);
        }),
        avatar: (did: string) => `/memepool/api/v1/avatars/${encodeURIComponent(did)}`,
        identity: vi.fn(async (did: string) => state.people[did] ?? {}),
        image: (did: string, version: string) => `/memepool/api/v1/images/${encodeURIComponent(did)}?versionId=${version}`,
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

        // A post that is open has its own, another author's as the reader's.
        await user.click((await screen.findByText('Second.')).closest('article')!);
        await choose(user, 'Copy DID');
        expect(write).toHaveBeenCalledWith('did:cid:2');
        expect(within(document.querySelector('.more') as HTMLElement).getByRole('status').textContent).toMatch(/Copied/);

        write.mockRejectedValue(new Error('not allowed'));
        await user.click(screen.getByRole('button', { name: 'Back' }));
        await user.click((await screen.findByText('First.')).closest('article')!);
        await choose(user, 'Copy DID');
        await waitFor(() => expect(screen.getAllByRole('status').some(said => /Could not copy\. The DID is did:cid:1/.test(said.textContent ?? ''))).toBe(true));
        localStorage.clear();
    });

    it('copies the DID of a post that is open, and offers none for one that was withdrawn', async () => {
        const withdrawn = { ...post('did:cid:2', ALICE, 'Gone.'), state: 'withdrawn' as const };
        const { api } = services({ me: granted, timeline: [post('did:cid:1', ALICE, 'First.'), withdrawn] });
        const user = userEvent.setup();
        const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
        render(<App api={api} />);

        // What was withdrawn is not there to open.
        expect(await screen.findByText('Withdrawn')).toBeTruthy();
        expect(document.querySelectorAll('article.post.opens')).toHaveLength(1);
        await user.click(await toOpen());
        await choose(user, 'Copy DID');
        expect(write).toHaveBeenCalledWith('did:cid:1');
    });

    it('says that it is checking for the grant, and what it found and when, where none is found yet', async () => {
        const { api } = services({ me: { did: ALICE, pending: ['did:cid:grant'] } });
        render(<App api={api} />);
        const user = userEvent.setup();

        const button = await screen.findByRole('button', { name: 'Check again' }) as HTMLButtonElement;
        let answer = (_: Me) => {};

        expect(screen.queryByRole('status')).toBeNull();
        vi.mocked(api.me).mockImplementation(() => new Promise<Me>(resolve => { answer = resolve; }));
        await user.click(button);

        // While the service is asked, the button says so and cannot be pressed.
        expect(button.textContent).toBe('Checking…');
        expect(button.disabled).toBe(true);
        answer({ did: ALICE, pending: ['did:cid:grant'] });

        await waitFor(() => expect(button.textContent).toBe('Check again'));
        expect(button.disabled).toBe(false);
        expect(screen.getByRole('status').textContent).toMatch(/^Not anchored yet, as of .+\. A chain can take from minutes to hours\.$/);

        // A check the service did not answer says why, and nothing of what was found.
        vi.mocked(api.me).mockRejectedValueOnce(new ApiError(502, 'the service did not answer'));
        await user.click(button);
        expect((await screen.findByRole('alert')).textContent).toContain('the service did not answer');
        expect(screen.queryByRole('status')).toBeNull();
        expect(button.disabled).toBe(false);

        // A reader who has approved nothing the service can see is told that.
        vi.mocked(api.me).mockResolvedValue({ did: ALICE, link: 'archon://auth?grant=did:cid:request' });
        await user.click(button);
        await user.click(await screen.findByRole('button', { name: 'I have approved it' }));
        expect((await screen.findByRole('status')).textContent).toMatch(/^No grant of yours was found, as of .+\.$/);

        // And one whose grant is found is shown what they came for.
        vi.mocked(api.me).mockResolvedValue(granted);
        await user.click(screen.getByRole('button', { name: 'I have approved it' }));
        expect(await screen.findByLabelText('Post')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'I have approved it' })).toBeNull();
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
        expect(api.timeline).toHaveBeenCalledWith([ALICE, BOB], 0, POSTS);
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

        await user.click(await toOpen());
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

        // Each is opened, and what it offers is looked at.
        const offers = async (text: string) => {
            await user.click((await screen.findByText(text)).closest('article')!);
            const names = await offered(user);

            await user.click(screen.getByRole('button', { name: 'Back' }));

            return names.includes('Withdraw');
        };

        expect(await offers('Under my other grant.')).toBe(true);
        expect(await offers('Through another client.')).toBe(false);
        expect(await offers('Bob\'s.')).toBe(false);
        // Nothing listed is withdrawn from the list.
        await screen.findByText('Mine.');
        expect(screen.queryByRole('button', { name: 'Withdraw' })).toBeNull();

        await user.click(screen.getByText('Mine.').closest('article')!);
        await choose(user, 'Withdraw');

        expect(api.withdraw).toHaveBeenCalledWith('did:cid:1');
        // The reader is back where the post was listed, and it is gone from there.
        expect(await screen.findByText('Withdrawn')).toBeTruthy();
        expect(screen.getByRole('heading', { name: /Timeline/ })).toBeTruthy();
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
        expect(api.timeline).toHaveBeenLastCalledWith([ALICE], 50, POSTS);
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
        await waitFor(() => expect(api.timeline).toHaveBeenLastCalledWith([ALICE], 0, POSTS));
        late({ total: 1, publications: [post('did:cid:2', BOB, 'Bob\'s.')] });

        expect(await screen.findByText('Nothing here yet.')).toBeTruthy();
        expect(screen.queryByText('Bob\'s.')).toBeNull();
    });

    it('shows a reply as published once its thread has it', async () => {
        const root = post('did:cid:1', ALICE, 'A post.');
        const { api } = services({ me: granted, timeline: [root] });
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await toOpen());
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
        expect(api.timeline).toHaveBeenLastCalledWith([ALICE], 100, POSTS);
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

    it('makes one check of the grant at a time', async () => {
        const waitingForGrant: Me = { did: ALICE, pending: ['did:cid:grant'], link: 'archon://auth?grant=abc' };
        const { api } = services({ me: waitingForGrant });
        render(<App api={api} />);
        const user = userEvent.setup();

        await screen.findByText(/waiting to be anchored on its chain/);
        let first!: (me: Me) => void;
        const asked = vi.mocked(api.me).mock.calls.length;

        vi.mocked(api.me).mockReturnValueOnce(new Promise(answer => { first = answer; }));
        const button = screen.getByRole('button', { name: 'Check again' });

        await user.click(button);
        await user.click(button);
        expect(vi.mocked(api.me).mock.calls.length).toBe(asked + 1);

        first(granted);
        expect(await screen.findByLabelText('Post')).toBeTruthy();
    });

    it('shows the reader the grant it publishes under: what it allows, its registry and when it expires', async () => {
        const { api } = services({ me: { ...granted, others: ['did:cid:second'] } });
        const view = render(<App api={api} />);

        const shown = (await screen.findByText(/^Publishing on BTC:mainnet/)).closest('details') as HTMLElement;

        // Put away until looked at, with nothing said of an expiry there is none of.
        expect((shown as HTMLDetailsElement).open).toBe(false);
        expect(within(shown).queryByText('Grant expires soon')).toBeNull();
        expect([...shown.querySelectorAll('li')].map(each => each.textContent)).toStrictEqual([
            'Post, boost, and write articles and papers', 'Reply and review', 'Rate', 'Tag and like',
        ]);
        const said = (term: string) => [...shown.querySelectorAll('dt')].find(each => each.textContent === term)?.nextElementSibling?.textContent;

        expect(said('Expires')).toBe('Never');
        expect(said('Registry')).toMatch(/^BTC:mainnet/);
        expect(said('Other grants in force')).toMatch(/^1\./);
        expect(within(shown).getByTitle('did:cid:grant')).toBeTruthy();
        expect(within(shown).getByText(/Change or revoke it in your wallet/)).toBeTruthy();
        // Nothing here changes the grant.
        expect(within(shown).getAllByRole('button').map(each => each.textContent)).toStrictEqual(['Copy grant DID']);
        view.unmount();

        // A narrowed grant lists what it allows, with an action the pages have no words for as it is written.
        const soon = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
        const narrowed = services({ me: { ...granted, actions: ['memeplex:post', 'did:cid:schema?versionId=bafy'], expiresAt: soon } });
        render(<App api={narrowed.api} />);
        const narrow = (await screen.findByText(/^Publishing on BTC:mainnet/)).closest('details') as HTMLElement;

        expect([...narrow.querySelectorAll('li')].map(each => each.textContent)).toStrictEqual(['Post, boost, and write articles and papers', 'did:cid:schema?versionId=bafy']);
        expect(within(narrow).getByText('What your grant does not allow is not offered here.')).toBeTruthy();
        expect(within(narrow).getByRole('status').textContent).toBe('Grant expires soon');
        expect([...narrow.querySelectorAll('dt')].find(each => each.textContent === 'Expires')?.nextElementSibling?.textContent).toMatch(/Change it in your wallet/);
    });

    it('shows no grant to someone who has none, or who has not signed in', async () => {
        const waiting = services({ me: { did: ALICE, link: 'archon://auth?grant=did:cid:request' } });
        const view = render(<App api={waiting.api} />);

        await screen.findByRole('button', { name: 'I have approved it' });
        expect(screen.queryByText(/^Publishing on/)).toBeNull();
        view.unmount();

        const { api, state } = services({ timeline: [post('did:cid:1', BOB, 'From Bob.')] });
        state.known['did:cid:1'] = state.timeline[0];
        window.history.replaceState(null, '', '/p/did:cid:1');
        render(<App api={api} />);
        await screen.findByText('From Bob.');
        expect(screen.queryByText(/^Publishing on/)).toBeNull();
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

        await user.click(await toOpen());
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

        await userEvent.setup().click(await toOpen());

        expect(await screen.findByText(/2 boosts · rated 75% by 1/)).toBeTruthy();
        expect(screen.getByText(/cryptography 2/)).toBeTruthy();
        expect(made.api.responses).toHaveBeenCalledWith('did:cid:1');
    });

    // What the reader made of a post is theirs to take back: each is an object they withdraw.
    describe('taking a response back', () => {
        const mine = (did: string, more: Record<string, unknown> = {}) => under({ ...post(did, ALICE, ''), memeplex: { kind: 'post', author: ALICE, ...about, ...more } }, 'did:cid:grant');
        const made = () => ({
            boosts: [mine('did:cid:b1'), under(post('did:cid:b2', BOB, ''), 'did:cid:bobs')],
            ratings: { ratings: [mine('did:cid:r1', { kind: 'rating', rating: 1, min: 0, max: 1 })], mean: 1 },
            tags: [
                { tag: 'cryptography', authors: [ALICE, BOB], applied: [{ did: 'did:cid:t1', author: ALICE, grant: 'did:cid:grant' }, { did: 'did:cid:t2', author: BOB, grant: 'did:cid:bobs' }] },
                { tag: '❤️', authors: [ALICE], applied: [{ did: 'did:cid:l1', author: ALICE, grant: 'did:cid:grant' }] },
                { tag: 'theirs', authors: [BOB], applied: [{ did: 'did:cid:t3', author: BOB, grant: 'did:cid:bobs' }] },
            ],
        }) as Responses;

        async function responded(responses = made()) {
            localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
            const services_ = services({ me: granted, timeline: [root] });
            services_.state.responses = responses;
            render(<App api={services_.api} />);
            const user = userEvent.setup();

            await user.click(await toOpen());
            await screen.findByText(/\d boosts? · /);

            return { ...services_, user };
        }

        it('undoes the reader\'s boost, which is no longer offered, and waits until it is anchored', async () => {
            const { api, state, user } = await responded();

            // The reader has boosted this, so undoing is what is offered.
            expect(screen.queryByRole('button', { name: 'Boost' })).toBeNull();
            await user.click(await screen.findByRole('button', { name: 'Undo boost' }));

            expect(api.withdraw).toHaveBeenCalledWith('did:cid:b1');
            expect(api.withdraw).not.toHaveBeenCalledWith('did:cid:b2');
            expect(await screen.findByText('The undoing of your boost is waiting to be anchored.')).toBeTruthy();
            // It is not asked for twice: what is withdrawn is the reader's to undo no more.
            await waitFor(() => expect(screen.queryByRole('button', { name: 'Undo boost' })).toBeNull());
            expect(screen.getByRole('button', { name: 'Boost' })).toBeTruthy();

            // Nor when the post is left and come back to, while the indexer still shows the boost.
            await user.click(screen.getByRole('button', { name: 'Back' }));
            await user.click(await toOpen());
            await screen.findByText(/\d boosts? · /);
            expect(screen.queryByRole('button', { name: 'Undo boost' })).toBeNull();
            expect(api.withdraw).toHaveBeenCalledTimes(1);

            state.responses = { ...made(), boosts: made().boosts.slice(1) };
            await user.click(screen.getByRole('button', { name: 'Refresh counts' }));
            expect(await screen.findByRole('button', { name: 'Boost' })).toBeTruthy();
        });

        it('undoes no post of the reader\'s that quotes this one, which is their writing and no boost', async () => {
            const quoting = made();

            quoting.boosts = [mine('did:cid:q1', { text: 'What I think of this.' }), mine('did:cid:q2', { title: 'On this', content: { cid: 'bafy', type: 'text/markdown', bytes: 3 } })];
            const { api } = await responded(quoting);

            // Nothing of theirs here is a boost, so Boost is what is offered.
            expect(await screen.findByRole('button', { name: 'Boost' })).toBeTruthy();
            expect(screen.queryByRole('button', { name: 'Undo boost' })).toBeNull();

            cleanup();
            quoting.boosts.push(mine('did:cid:b1'));
            const again = await responded(quoting);

            await again.user.click(await screen.findByRole('button', { name: 'Undo boost' }));
            await waitFor(() => expect(again.api.withdraw).toHaveBeenCalledTimes(1));
            expect(again.api.withdraw).toHaveBeenCalledWith('did:cid:b1');
            expect(api.withdraw).not.toHaveBeenCalled();
        });

        it('keeps a like made after one was taken off waiting, until the indexer shows the one made', async () => {
            const { api, state, user } = await responded();

            await user.click(await screen.findByRole('button', { name: 'Unlike' }));
            await user.click(await screen.findByRole('button', { name: 'Like' }));
            expect(await screen.findByText('Your like is waiting to be anchored.')).toBeTruthy();

            // The indexer still shows the one taken off, which is not the one made.
            await user.click(screen.getByRole('button', { name: 'Refresh counts' }));
            await waitFor(() => expect(api.responses).toHaveBeenCalledTimes(2));
            expect(screen.getByText('Your like is waiting to be anchored.')).toBeTruthy();

            state.responses = { ...made(), tags: [{ tag: '❤️', authors: [ALICE], applied: [{ did: 'did:cid:new1', author: ALICE, grant: 'did:cid:grant' }] }] };
            await user.click(screen.getByRole('button', { name: 'Refresh counts' }));
            await waitFor(() => expect(screen.queryByText('Your like is waiting to be anchored.')).toBeNull());
        });

        it('offers no undoing in the timeline of a boost undone under its post, nor under the post of one undone in the timeline', async () => {
            localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
            const boost = mine('did:cid:b1');
            const both = services({ me: granted, timeline: [root, boost] });
            both.state.responses = made();
            both.state.revisions['did:cid:1 op-did:cid:1'] = root;
            both.state.known['did:cid:1'] = root;
            render(<App api={both.api} />);
            const user = userEvent.setup();

            // Undone in the timeline, on the boost's own card.
            await user.click(await screen.findByRole('button', { name: 'Undo boost' }));
            await waitFor(() => expect(both.api.withdraw).toHaveBeenCalledWith('did:cid:b1'));
            await waitFor(() => expect(screen.queryByRole('button', { name: 'Undo boost' })).toBeNull());

            // And not offered under the post, which the indexer still shows boosted.
            await user.click((await screen.findByText('A post.', { selector: 'article.post:not(.boost) *' })).closest('article')!);
            await screen.findByText(/\d boosts? · /);
            expect(screen.queryByRole('button', { name: 'Undo boost' })).toBeNull();
            expect(both.api.withdraw).toHaveBeenCalledTimes(1);
        });

        it('tries once more only what is left, where one of two could not be withdrawn', async () => {
            const twice = made();

            twice.boosts = [mine('did:cid:b1'), mine('did:cid:b3')];
            const { api, user } = await responded(twice);

            vi.mocked(api.withdraw).mockImplementation(async did => {
                if (did === 'did:cid:b3' && vi.mocked(api.withdraw).mock.calls.length < 3) {
                    throw new ApiError(502, 'the node did not answer');
                }
            });
            await user.click(await screen.findByRole('button', { name: 'Undo boost' }));
            expect((await screen.findByRole('alert')).textContent).toContain('the node did not answer');

            await user.click(await screen.findByRole('button', { name: 'Undo boost' }));
            await waitFor(() => expect(screen.queryByRole('button', { name: 'Undo boost' })).toBeNull());
            // The one withdrawn the first time is not asked for a second.
            expect(vi.mocked(api.withdraw).mock.calls.map(call => call[0])).toStrictEqual(['did:cid:b1', 'did:cid:b3', 'did:cid:b3']);
        });

        it('lets a like be taken back by a reader whose grant allows no tag since, and a rating be made after one is removed', async () => {
            localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
            const narrowed = services({ me: { ...granted, actions: ['memeplex:post', 'memeplex:rate'] }, timeline: [root] });
            narrowed.state.responses = made();
            render(<App api={narrowed.api} />);
            const user = userEvent.setup();

            await user.click(await toOpen());
            // No new like or tag, and the ones made are still theirs to take off.
            expect(await screen.findByRole('button', { name: 'Unlike' })).toBeTruthy();
            expect(screen.queryByRole('button', { name: 'Like' })).toBeNull();
            expect(screen.queryByLabelText('Tag')).toBeNull();
            expect(screen.getByRole('button', { name: 'Remove tag cryptography' })).toBeTruthy();

            // A thumb after the rating is removed makes a rating, and changes none that is gone.
            await user.click(screen.getByRole('button', { name: 'Remove rating' }));
            await waitFor(() => expect(narrowed.api.withdraw).toHaveBeenCalledWith('did:cid:r1'));
            await user.click(screen.getByRole('button', { name: 'Thumb down' }));
            await waitFor(() => expect(narrowed.state.published).toHaveLength(1));
            expect(narrowed.api.edit).not.toHaveBeenCalled();
        });

        it('is done when its own objects are gone, though another client\'s still applies the tag for the reader', async () => {
            const both = made();

            both.tags = [{ tag: '❤️', authors: [ALICE], applied: [{ did: 'did:cid:l1', author: ALICE, grant: 'did:cid:grant' }, { did: 'did:cid:l2', author: ALICE, grant: 'did:cid:another' }] }];
            const { state, user } = await responded(both);

            await user.click(await screen.findByRole('button', { name: 'Unlike' }));
            expect(await screen.findByText('The removal of your like is waiting to be anchored.')).toBeTruthy();

            state.responses = { ...both, tags: [{ tag: '❤️', authors: [ALICE], applied: [{ did: 'did:cid:l2', author: ALICE, grant: 'did:cid:another' }] }] };
            await user.click(screen.getByRole('button', { name: 'Refresh counts' }));
            await waitFor(() => expect(screen.queryByText(/removal of your like/)).toBeNull());
        });

        it('removes the reader\'s rating, like and tag, and no one else\'s', async () => {
            const { api, user } = await responded();

            await user.click(await screen.findByRole('button', { name: 'Remove rating' }));
            await waitFor(() => expect(api.withdraw).toHaveBeenLastCalledWith('did:cid:r1'));
            await user.click(screen.getByRole('button', { name: 'Unlike' }));
            await waitFor(() => expect(api.withdraw).toHaveBeenLastCalledWith('did:cid:l1'));
            await user.click(screen.getByRole('button', { name: 'Remove tag cryptography' }));
            await waitFor(() => expect(api.withdraw).toHaveBeenLastCalledWith('did:cid:t1'));

            expect(vi.mocked(api.withdraw).mock.calls.map(call => call[0])).toStrictEqual(['did:cid:r1', 'did:cid:l1', 'did:cid:t1']);
            // A tag only another put on it is not the reader's to take off.
            expect(screen.queryByRole('button', { name: 'Remove tag theirs' })).toBeNull();
            expect(screen.getByText('The removal of your rating is waiting to be anchored.')).toBeTruthy();
            expect(screen.getByText('The removal of your like is waiting to be anchored.')).toBeTruthy();
            expect(screen.getByText('The removal of your tag cryptography is waiting to be anchored.')).toBeTruthy();
        });

        it('offers no undoing of what the reader made through another client', async () => {
            const elsewhere = made();

            elsewhere.boosts = [under(mine('did:cid:b1'), 'did:cid:another')];
            elsewhere.ratings.ratings = [under(mine('did:cid:r1', { kind: 'rating', rating: 1, min: 0, max: 1 }), 'did:cid:another')];
            elsewhere.tags = [{ tag: '❤️', authors: [ALICE], applied: [{ did: 'did:cid:l1', author: ALICE, grant: 'did:cid:another' }] }];
            await responded(elsewhere);

            expect(await screen.findByRole('button', { name: 'Boost' })).toBeTruthy();
            expect(screen.getByRole('button', { name: 'Like' })).toBeTruthy();
            for (const name of ['Undo boost', 'Remove rating', 'Unlike']) {
                expect([name, screen.queryByRole('button', { name })]).toStrictEqual([name, null]);
            }
        });

        it('says why a response could not be taken back, and offers it once more', async () => {
            const { api, user } = await responded();

            vi.mocked(api.withdraw).mockRejectedValueOnce(new ApiError(403, 'no grant to publish under'));
            await user.click(await screen.findByRole('button', { name: 'Undo boost' }));

            expect((await screen.findByRole('alert')).textContent).toContain('no grant to publish under');
            expect(screen.queryByText(/undoing of your boost/)).toBeNull();
            expect((await screen.findByRole('button', { name: 'Undo boost' }) as HTMLButtonElement).disabled).toBe(false);
        });

        it('reads a view of the tags that names no objects, from an indexer that gives none, and offers no undoing', async () => {
            const older = made();

            older.tags = [{ tag: '❤️', authors: [ALICE] }, { tag: 'cryptography', authors: [ALICE] }];
            await responded(older);

            expect(await screen.findByRole('button', { name: 'Like' })).toBeTruthy();
            expect(screen.queryByRole('button', { name: 'Unlike' })).toBeNull();
            expect(screen.queryByRole('button', { name: /Remove tag/ })).toBeNull();
        });
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

        await user.click(await toOpen());
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

        await user.click(await toOpen());
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

        await user.click(await toOpen());
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

        await userEvent.setup().click(await toOpen());

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

        await userEvent.setup().click(await toOpen());
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

        const open = await toOpen();
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

        await user.click(await toOpen());
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
        await user.click(await toOpen());

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
        expect(lastRead(api)).toStrictEqual([[BOB], 0, ['post'], false]);
        // Who it is, and nowhere to write: these are another's posts.
        expect(within(document.querySelector('.author') as HTMLElement).getByText('Bob B.')).toBeTruthy();
        expect(screen.queryByLabelText('Post')).toBeNull();
        expect(screen.queryByRole('heading', { name: 'Following' })).toBeNull();

        await user.click(screen.getByRole('button', { name: 'Back to your timeline' }));
        expect(await screen.findByText('From Alice.')).toBeTruthy();
        expect(screen.getByLabelText('Post')).toBeTruthy();
        expect(lastRead(api)).toStrictEqual([[ALICE, BOB], 0, POSTS]);
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
        expect(lastRead(api)).toStrictEqual([[BOB], 0, ['post'], false]);

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
        await user.click(screen.getByText('From Bob.').closest('article')!);
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

        await user.click(screen.getByText('From Bob.').closest('article')!);
        await screen.findByLabelText('Reply');
        await user.click(authorOf('From Bob.'));

        // The same author's list, read anew and not left waiting.
        expect(await screen.findByText('Bob once more.')).toBeTruthy();
        expect(screen.queryByLabelText('Reply')).toBeNull();
        expect(screen.queryByText('Loading…')).toBeNull();
        expect(lastRead(api)).toStrictEqual([[BOB], 0, ['post'], false]);

        // And the reader's timeline likewise, from a post opened on it.
        await user.click(screen.getByRole('button', { name: 'Back to your timeline' }));
        await user.click((await screen.findByText('From Alice.')).closest('article')!);
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

    it('are listed apart from the author\'s replies, each shown with what it answers', async () => {
        const PARENT = 'did:cid:bagaaieraparentparentparentparentparentparentparentparentpar';
        const parent: Publication = { ...post(PARENT, ALICE, 'What Alice asked.'), versions: [{ opid: 'bafyparent', type: 'create', outcome: 'attributed' }] };
        const answer: Publication = { ...post('did:cid:answer', BOB, 'What Bob answered.'), memeplex: { kind: 'reply', author: BOB, text: 'What Bob answered.', target: PARENT, targetVersion: 'bafyparent' } };
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        const { api, state } = services({ me: granted, timeline: [post('did:cid:2', BOB, 'From Bob.'), answer] });
        state.known[PARENT] = parent;
        state.revisions[`${PARENT} bafyparent`] = parent;
        render(<App api={api} />);
        const user = userEvent.setup();

        // The reader's timeline holds no reply.
        await screen.findByText('From Bob.');
        expect(screen.queryByText('What Bob answered.')).toBeNull();
        expect(lastRead(api)).toStrictEqual([[ALICE, BOB], 0, POSTS]);

        // Nor does the author's posts.
        await user.click(authorOf('From Bob.'));
        await waitFor(() => expect(lastRead(api)).toStrictEqual([[BOB], 0, ['post'], false]));
        expect(screen.queryByText('What Bob answered.')).toBeNull();
        expect(screen.getByRole('tab', { name: 'Posts' }).getAttribute('aria-selected')).toBe('true');

        // The author's replies are their own list.
        await user.click(screen.getByRole('tab', { name: 'Replies' }));
        const reply = (await screen.findByText('What Bob answered.')).closest('article')!;

        expect(lastRead(api)).toStrictEqual([[BOB], 0, REPLIES]);
        expect(screen.getByRole('heading', { name: /Replies/ })).toBeTruthy();
        expect(screen.queryByText('From Bob.')).toBeNull();
        // What it answers is above it, as that was at the version answered.
        const answered = reply.querySelector('.answered') as HTMLElement;
        expect(within(answered).getByText('Replying to')).toBeTruthy();
        expect(await within(answered).findByText('What Alice asked.')).toBeTruthy();
        expect(api.revision).toHaveBeenCalledWith(PARENT, 'bafyparent');

        // And the posts are three tabs back, by the keyboard as well: past the papers and the articles.
        screen.getByRole('tab', { name: 'Replies' }).focus();
        await user.keyboard('{ArrowLeft}');
        expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Papers' }));
        await user.keyboard('{ArrowLeft}{ArrowLeft}');
        expect(await screen.findByText('From Bob.')).toBeTruthy();
        expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Posts' }));
        expect(screen.getByRole('tab', { name: 'Replies' }).tabIndex).toBe(-1);
    });

    it('show an author\'s posts first whichever list was left, and say when a reply\'s post cannot be shown', async () => {
        const answer: Publication = { ...post('did:cid:answer', BOB, 'What Bob answered.'), memeplex: { kind: 'reply', author: BOB, text: 'What Bob answered.', target: 'did:cid:bagaaieranowhere', targetVersion: 'bafynowhere' } };
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        const { api } = services({ me: granted, timeline: [post('did:cid:1', ALICE, 'From Alice.'), post('did:cid:2', BOB, 'From Bob.'), answer] });
        render(<App api={api} />);
        const user = userEvent.setup();

        await screen.findByText('From Bob.');
        await user.click(authorOf('From Bob.'));
        await user.click(await screen.findByRole('tab', { name: 'Replies' }));
        const reply = (await screen.findByText('What Bob answered.')).closest('article')!;
        expect(await within(reply).findByText(/which cannot be shown/)).toBeTruthy();

        // Another author's view starts at their posts.
        await user.click(within(document.querySelector('header.top') as HTMLElement).getByRole('button', { name: /did:cid/ }));
        expect(await screen.findByText('From Alice.')).toBeTruthy();
        expect(screen.getByRole('tab', { name: 'Posts' }).getAttribute('aria-selected')).toBe('true');
        expect(lastRead(api)).toStrictEqual([[ALICE], 0, ['post'], false]);
    });

    it('reach older posts past a page of replies, from an indexer that gives every kind', async () => {
        const replies = Array.from({ length: PAGE }, (_, index): Publication =>
            ({ ...post(`did:cid:r${index}`, ALICE, `Reply ${index}.`), memeplex: { kind: 'reply', author: ALICE, text: `Reply ${index}.` } }));
        const { api } = services({ me: granted });
        const all = [...replies, post('did:cid:old', ALICE, 'An older post.')];
        // The indexer pages what it has and does not know of kinds; the client keeps the kinds asked for.
        vi.mocked(api.timeline).mockImplementation(async (_authors, offset = 0, kinds) => {
            const given = all.slice(offset, offset + PAGE);

            return { total: all.length, publications: given.filter(each => !kinds || kinds.includes(String(each.memeplex!.kind))), read: given.length };
        });
        render(<App api={api} />);
        const user = userEvent.setup();

        // A whole page of replies shows nothing, and there is more to read.
        await user.click(await screen.findByRole('button', { name: 'Older' }));

        expect(await screen.findByText('An older post.')).toBeTruthy();
        expect(lastRead(api)).toStrictEqual([[ALICE], PAGE, POSTS]);
        expect(screen.queryByRole('button', { name: 'Older' })).toBeNull();
    });

    it('hold a reply of the reader\'s that waits to be anchored, among the reader\'s replies and nowhere else', async () => {
        const { api } = services({ me: granted, timeline: [post('did:cid:1', ALICE, 'From Alice.')] });
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click((await screen.findByText('From Alice.')).closest('article')!);
        await user.type(await screen.findByLabelText('Reply'), 'Not anchored yet.');
        await user.click(screen.getByRole('button', { name: 'Publish' }));
        await screen.findByText('Waiting to be anchored');

        // Not in the timeline, nor among the reader's posts.
        await user.click(screen.getByRole('button', { name: 'Back' }));
        await screen.findByText('From Alice.');
        expect(screen.queryByText('Not anchored yet.')).toBeNull();
        await user.click(within(document.querySelector('header.top') as HTMLElement).getByRole('button', { name: /did:cid/ }));
        await screen.findByRole('tab', { name: 'Posts' });
        expect(screen.queryByText('Not anchored yet.')).toBeNull();

        await user.click(screen.getByRole('tab', { name: 'Replies' }));
        expect(await screen.findByText('Not anchored yet.')).toBeTruthy();
        expect(screen.getByText('Waiting to be anchored')).toBeTruthy();
        expect(screen.queryByText('Nothing here yet.')).toBeNull();
    });

    it('hold no reply as waiting that its thread has shown, though the list of replies does not', async () => {
        const { api } = services({ me: granted, timeline: [post('did:cid:1', ALICE, 'From Alice.')] });
        vi.mocked(api.publish).mockResolvedValue('did:cid:reply');
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click((await screen.findByText('From Alice.')).closest('article')!);
        await user.type(await screen.findByLabelText('Reply'), 'Soon anchored.');
        await user.click(screen.getByRole('button', { name: 'Publish' }));
        await screen.findByText('Waiting to be anchored');

        // The thread shows it once it is anchored, here as withdrawn since: no list of replies ever holds it.
        vi.mocked(api.thread).mockResolvedValue([{ depth: 0, publication: { ...post('did:cid:reply', ALICE, 'Soon anchored.'), state: 'withdrawn' } }]);
        await user.click(screen.getByRole('button', { name: 'Refresh' }));
        await waitFor(() => expect(screen.queryByText('Waiting to be anchored')).toBeNull());

        await user.click(screen.getByRole('button', { name: 'Back' }));
        await user.click(within(document.querySelector('header.top') as HTMLElement).getByRole('button', { name: /did:cid/ }));
        await user.click(await screen.findByRole('tab', { name: 'Replies' }));

        expect(await screen.findByText('Nothing here yet.')).toBeTruthy();
        expect(screen.queryByText('Waiting to be anchored')).toBeNull();
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
        expect(lastRead(api)).toStrictEqual([[BOB], PAGE, ['post'], false]);
    });
});

describe('a post that is listed, and what an open one offers', () => {
    const REPLY = 'did:cid:bagaaierareplyreplyreplyreplyreplyreplyreplyreplyreplyreplyre';
    const listed = () => [under(post('did:cid:1', ALICE, 'Mine, with [a link](https://example.org/).'), 'did:cid:grant'), post('did:cid:2', BOB, 'From Bob.')];

    it('is opened by a click on it, and offers nothing else where it is listed', async () => {
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        const { api } = services({ me: granted, timeline: listed() });
        render(<App api={api} />);
        const user = userEvent.setup();

        const theirs = (await screen.findByText('From Bob.')).closest('article')!;

        for (const name of ['Open', 'Withdraw', 'Copy link', 'Copy embed', 'Copy DID', 'More']) {
            expect([name, screen.queryByRole('button', { name })]).toStrictEqual([name, null]);
        }

        await user.click(screen.getByText('From Bob.'));
        await waitFor(() => expect(api.thread).toHaveBeenCalledWith('did:cid:2'));
        expect(window.location.pathname).toBe('/p/did:cid:2');
        // The post that is open is not opened again by a click on it.
        expect(theirs.isConnected).toBe(false);
        expect(document.querySelector('article.post.opens')).toBeNull();
    });

    it('is not opened by a click on something in it that does something of its own, or by selecting its text', async () => {
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        const { api } = services({ me: granted, timeline: listed() });
        render(<App api={api} />);

        const link = await screen.findByRole('link', { name: 'a link' });

        link.addEventListener('click', event => event.preventDefault());
        fireEvent.click(link);
        expect(api.thread).not.toHaveBeenCalled();

        // The end of a selection is a click as well.
        const selected = vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => 'From' } as Selection);

        fireEvent.click(screen.getByText('From Bob.'));
        expect(api.thread).not.toHaveBeenCalled();
        selected.mockRestore();

        // Nor by any button but the first one of the mouse.
        fireEvent.click(screen.getByText('From Bob.'), { button: 1 });
        expect(api.thread).not.toHaveBeenCalled();

        // The author's name goes to the author.
        fireEvent.click(within(screen.getByText('From Bob.').closest('article')!).getByRole('button', { name: /Posts by this author|did:cid/ }));
        await screen.findByRole('tab', { name: 'Posts' });
        expect(api.thread).not.toHaveBeenCalled();
    });

    it('offers what else can be done with it under one button, which the keyboard works as the mouse does', async () => {
        const { api } = services({ me: granted, timeline: listed() });
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click((await screen.findByText(/^Mine, with/)).closest('article')!);
        const more = await screen.findByRole('button', { name: 'More' });

        // It is at the end of the post's header.
        expect(more.closest('header')).toBe(document.querySelector('article.post > header'));
        expect(more.getAttribute('aria-expanded')).toBe('false');
        expect(screen.queryByRole('menu')).toBeNull();

        await user.click(more);
        expect(more.getAttribute('aria-expanded')).toBe('true');
        expect(screen.getAllByRole('menuitem').map(each => each.textContent)).toStrictEqual(['Withdraw', 'Copy link', 'Copy embed', 'Copy DID', 'View source']);
        // The first is where the keyboard is, and the arrows go round.
        expect(document.activeElement?.textContent).toBe('Withdraw');
        await user.keyboard('{ArrowUp}');
        expect(document.activeElement?.textContent).toBe('View source');
        await user.keyboard('{ArrowDown}{ArrowDown}');
        expect(document.activeElement?.textContent).toBe('Copy link');

        // Escape puts it away and leaves the keyboard on the button.
        await user.keyboard('{Escape}');
        expect(screen.queryByRole('menu')).toBeNull();
        expect(document.activeElement).toBe(more);
        expect(api.withdraw).not.toHaveBeenCalled();

        // From the button as well, where the keyboard has gone back to it.
        await user.click(more);
        await user.keyboard('{Shift>}{Tab}{/Shift}');
        expect(document.activeElement).toBe(more);
        await user.keyboard('{Escape}');
        expect(screen.queryByRole('menu')).toBeNull();

        // And when the keyboard leaves it for something else.
        await user.click(more);
        await user.keyboard('{Shift>}{Tab}{Tab}{/Shift}');
        expect(screen.queryByRole('menu')).toBeNull();

        // So does a click anywhere else, and a second one on the button.
        await user.click(more);
        await user.click(screen.getByRole('heading', { name: 'Memepool' }));
        expect(screen.queryByRole('menu')).toBeNull();
        await user.click(more);
        await user.click(more);
        expect(screen.queryByRole('menu')).toBeNull();
    });

    it('says why a post could not be withdrawn, and leaves it open', async () => {
        const { api } = services({ me: granted, timeline: listed() });
        vi.mocked(api.withdraw).mockRejectedValue(new ApiError(502, 'the node did not answer'));
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click((await screen.findByText(/^Mine, with/)).closest('article')!);
        await choose(user, 'Withdraw');

        expect((await within(document.querySelector('.more') as HTMLElement).findByRole('status')).textContent).toContain('the node did not answer');
        expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();
        expect(screen.getByText(/^Mine, with/)).toBeTruthy();
    });

    it('offers no embed of a post whose edit waits, and nothing that changes an earlier version', async () => {
        const mine = { ...listed()[0], current: 1, versions: [
            { opid: 'bafyone', type: 'create' as const, outcome: 'attributed' as const, position: { block: 1, time: '2026-11-21T12:00:00Z' } },
            { opid: 'bafytwo', type: 'update' as const, outcome: 'attributed' as const, position: { block: 2, time: '2026-11-22T12:00:00Z' } },
        ] };
        const { api, state } = services({ me: granted, timeline: [mine] });
        state.revisions['did:cid:1 bafyone'] = { ...mine, current: 0, memeplex: { ...mine.memeplex!, text: 'As it was at first.' } };
        state.unanchored['did:cid:1'] = { versionId: 'bafythree', memeplex: { ...mine.memeplex!, text: 'As I left it.' } };
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click((await screen.findByText('As I left it.')).closest('article')!);
        await screen.findByText(/Your edit is waiting to be anchored\. Until it is/);
        // An embed is of a version, and the one waiting is not one yet.
        expect(await offered(user)).toStrictEqual(['Withdraw', 'Copy link', 'Copy DID', 'View source']);

        // An earlier version is there to copy, and is not withdrawn by itself.
        await user.selectOptions(screen.getByLabelText('Version'), 'bafyone');
        await screen.findByText('As it was at first.');
        expect(await offered(user)).toStrictEqual(['Copy link', 'Copy embed', 'Copy DID', 'View source']);
    });

    it('shows the text of a post as its author wrote it, and renders none of it', async () => {
        const text = 'Some *emphasis*, [a link](https://example.org/) and $x^2$.\n\n<b>bold</b>';
        const { api } = services({ me: granted, timeline: [post('did:cid:1', BOB, text)] });
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await toOpen());
        expect(await screen.findByRole('link', { name: 'a link' })).toBeTruthy();
        await choose(user, 'View source');

        const source = document.querySelector('article.post pre.source') as HTMLElement;

        expect(source.textContent).toBe(text);
        expect(source.children).toHaveLength(0);
        expect(screen.queryByRole('link', { name: 'a link' })).toBeNull();
        // The same button puts it back as it is read.
        expect(await offered(user)).toContain('Hide source');
        await choose(user, 'Hide source');
        expect(document.querySelector('pre.source')).toBeNull();
        expect(screen.getByRole('link', { name: 'a link' })).toBeTruthy();
    });

    it('shows the source of an article, read from the node, and of an earlier version its own; a boost has none', async () => {
        const article = (cid: string, current: number): Publication => ({
            ...post('did:cid:1', BOB, ''), current,
            versions: [
                { opid: 'bafyone', type: 'create', outcome: 'attributed', position: { block: 1, time: '2026-11-21T12:00:00Z' } },
                { opid: 'bafytwo', type: 'update', outcome: 'attributed', position: { block: 2, time: '2026-11-22T12:00:00Z' } },
            ] as Publication['versions'],
            memeplex: { kind: 'post', author: BOB, title: 'An article', content: { cid, type: 'text/markdown', bytes: 9 } },
        });
        const original = post('did:cid:2', BOB, 'From Bob.');
        const boost = post('did:cid:9', BOB, '', { memeplex: { kind: 'post', author: BOB, target: 'did:cid:2', targetVersion: 'op-did:cid:2' } });
        const { api, state } = services({ me: granted, timeline: [article('bafybodytwo', 1)] });
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        state.bodies.bafybodytwo = '# Second\n\nAs it **is**.';
        state.bodies.bafybodyone = '# First\n\nAs it **was**.';
        state.revisions['did:cid:1 bafyone'] = article('bafybodyone', 0);
        state.known['did:cid:2'] = original;
        state.known['did:cid:9'] = boost;
        state.revisions['did:cid:2 op-did:cid:2'] = original;
        const view = render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await toOpen());
        await screen.findByRole('heading', { name: 'Second' });
        await choose(user, 'View source');
        await waitFor(() => expect(document.querySelector('article.post pre.source')?.textContent).toBe('# Second\n\nAs it **is**.'));
        expect(screen.queryByRole('heading', { name: 'Second' })).toBeNull();
        // The title is the entry's and is still there.
        expect(screen.getByText('An article')).toBeTruthy();

        await user.selectOptions(screen.getByLabelText('Version'), 'bafyone');
        await screen.findByRole('heading', { name: 'First' });
        await choose(user, 'View source');
        await waitFor(() => expect([...document.querySelectorAll('article.post pre.source')].map(each => each.textContent)).toContain('# First\n\nAs it **was**.'));
        view.unmount();

        window.history.replaceState(null, '', '/p/did:cid:9');
        render(<App api={api} />);
        await screen.findByText('From Bob.');
        expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
    });

    it('leaves the reader where they went while a post was being withdrawn', async () => {
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        const { api } = services({ me: granted, timeline: listed() });
        let done = () => {};
        vi.mocked(api.withdraw).mockImplementation(() => new Promise<void>(resolve => { done = resolve; }));
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click((await screen.findByText(/^Mine, with/)).closest('article')!);
        await choose(user, 'Withdraw');
        await user.click(screen.getByRole('button', { name: 'Back' }));
        await user.click((await screen.findByText('From Bob.')).closest('article')!);
        await waitFor(() => expect(api.thread).toHaveBeenCalledWith('did:cid:2'));

        done();
        await new Promise(resolve => { setTimeout(resolve, 50); });
        expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();
        expect(window.location.pathname).toBe('/p/did:cid:2');
    });

    it('gives a card a link to what it shows, and keeps a click on a card that cannot be opened from opening what it is in', async () => {
        const QUOTE = 'did:cid:bagaaieraquotequotequotequotequotequotequotequotequotequote';
        const quoted = { ...post(QUOTE, BOB, 'What Bob wrote.'), versions: [{ opid: 'bafyquote', type: 'create' as const, outcome: 'attributed' as const }] };
        const { api, state } = services({ me: granted, timeline: [post('did:cid:1', ALICE, `See:\n\n![it](${QUOTE}?versionId=bafyquote)`)] });
        state.known[QUOTE] = quoted;
        state.revisions[`${QUOTE} bafyquote`] = quoted;
        const view = render(<App api={api} />);

        const card = (await screen.findByText('What Bob wrote.')).closest('.quoted') as HTMLElement;
        expect(within(card).getByRole('link').getAttribute('href')).toBe(`/p/${QUOTE}`);
        view.unmount();

        // Withdrawn since: the card says so, has no link, and a click on it opens nothing.
        state.revisions[`${QUOTE} bafyquote`] = { ...quoted, state: 'withdrawn' };
        render(<App api={api} />);
        const gone = (await screen.findByText('What Bob wrote.')).closest('.quoted') as HTMLElement;

        expect(within(gone).queryByRole('link')).toBeNull();
        fireEvent.click(screen.getByText('What Bob wrote.'));
        await new Promise(resolve => { setTimeout(resolve, 50); });
        expect(api.thread).not.toHaveBeenCalled();
    });

    it('goes from a boost that is open to the post it is of, which is where there is something to copy', async () => {
        const original = post('did:cid:2', BOB, 'From Bob.');
        const boost = post('did:cid:9', ALICE, '', { memeplex: { kind: 'post', author: ALICE, target: 'did:cid:2', targetVersion: 'op-did:cid:2' } });
        const { api, state } = services({ me: granted });
        state.known['did:cid:2'] = original;
        state.known['did:cid:9'] = boost;
        state.revisions['did:cid:2 op-did:cid:2'] = original;
        window.history.replaceState(null, '', '/p/did:cid:9');
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click((await screen.findByText('From Bob.')).closest('article')!);
        await waitFor(() => expect(window.location.pathname).toBe('/p/did:cid:2'));
        expect(await offered(user)).toStrictEqual(['Copy link', 'Copy embed', 'Copy DID', 'View source']);
    });

    it('opens a reply from the thread it is in, and what a reply answers from the card above it', async () => {
        const root = post('did:cid:1', BOB, 'What Bob asked.');
        const reply: Publication = { ...post(REPLY, ALICE, 'What Alice answered.'), memeplex: { kind: 'reply', author: ALICE, text: 'What Alice answered.', target: 'did:cid:1', targetVersion: 'op-did:cid:1' } };
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        const { api, state } = services({ me: granted, timeline: [root] });
        state.known['did:cid:1'] = root;
        state.known[REPLY] = reply;
        state.revisions['did:cid:1 op-did:cid:1'] = root;
        vi.mocked(api.thread).mockImplementation(async did => (did === 'did:cid:1' ? [{ publication: reply, depth: 1 }] as never : []));
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await toOpen());
        await user.click((await screen.findByText('What Alice answered.')).closest('article')!);

        await waitFor(() => expect(api.thread).toHaveBeenCalledWith(REPLY));
        await waitFor(() => expect(window.location.pathname).toBe(`/p/${REPLY}`));
    });
});

describe('an author\'s articles and papers', () => {
    const lastRead = (api: Api) => vi.mocked(api.timeline).mock.calls.slice(-1)[0];
    const article = (did: string, author: string, title: string): Publication =>
        ({ ...post(did, author, ''), memeplex: { kind: 'post', author, title, content: { cid: `bafy${did.slice(-1)}`, type: 'text/markdown', bytes: 3 } } });
    const paper = (did: string, author: string, title: string): Publication =>
        ({ ...post(did, author, ''), memeplex: { kind: 'paper', author, title, summary: 'About it.', authors: [author], content: { cid: `bafy${did.slice(-1)}`, type: 'text/markdown', bytes: 3 } } });
    const all = () => [post('did:cid:1', BOB, 'A note from Bob.'), article('did:cid:2', BOB, 'An article by Bob'), paper('did:cid:3', BOB, 'A paper by Bob')];

    it('are each listed apart from the author\'s posts, and all of them are in a reader\'s timeline', async () => {
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        const { api } = services({ me: granted, timeline: all() });
        render(<App api={api} />);
        const user = userEvent.setup();

        // A reader's timeline is what those they follow have published, of every kind but replies.
        await screen.findByText('A note from Bob.');
        expect(screen.getByText('An article by Bob')).toBeTruthy();
        expect(screen.getByText('A paper by Bob')).toBeTruthy();

        await user.click(within(screen.getByText('A note from Bob.').closest('article')!).getByRole('button', { name: /Posts by this author|did:cid/ }));

        // The author's posts are those with no title.
        await waitFor(() => expect(lastRead(api)).toStrictEqual([[BOB], 0, ['post'], false]));
        await waitFor(() => expect(screen.queryByText('An article by Bob')).toBeNull());
        expect(screen.getByText('A note from Bob.')).toBeTruthy();
        expect(screen.queryByText('A paper by Bob')).toBeNull();
        expect(screen.getAllByRole('tab').map(each => each.textContent)).toStrictEqual(['Posts', 'Articles', 'Papers', 'Replies']);

        await user.click(screen.getByRole('tab', { name: 'Articles' }));
        expect(await screen.findByText('An article by Bob')).toBeTruthy();
        expect(lastRead(api)).toStrictEqual([[BOB], 0, ['post'], true]);
        expect(screen.queryByText('A note from Bob.')).toBeNull();
        expect(screen.getByRole('heading', { name: /Articles/ })).toBeTruthy();
        expect(window.location.pathname).toBe(`/a/${BOB}/articles`);

        await user.click(screen.getByRole('tab', { name: 'Papers' }));
        expect(await screen.findByText('A paper by Bob')).toBeTruthy();
        expect(lastRead(api)).toStrictEqual([[BOB], 0, ['paper']]);
        expect(screen.queryByText('An article by Bob')).toBeNull();
        expect(window.location.pathname).toBe(`/a/${BOB}/papers`);
    });

    it('are what a link to them shows, and what a link copied there names', async () => {
        const { api } = services({ me: granted, timeline: all() });
        const copied: string[] = [];
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied.push(text); } } });
        window.history.replaceState(null, '', `/a/${BOB}/papers`);
        render(<App api={api} />);

        expect(await screen.findByText('A paper by Bob')).toBeTruthy();
        expect(screen.getByRole('tab', { name: 'Papers' }).getAttribute('aria-selected')).toBe('true');
        expect(screen.queryByText('A note from Bob.')).toBeNull();

        fireEvent.click(within(document.querySelector('.author') as HTMLElement).getByRole('button', { name: 'Copy link' }));
        await waitFor(() => expect(copied).toStrictEqual([`${window.location.origin}/a/${BOB}/papers`]));
    });

    it('have what the reader published and waits to be anchored each in its own list', async () => {
        const { api } = services({ me: granted });
        localStorage.setItem(`memepool.waiting.${ALICE}`, JSON.stringify([
            { did: 'did:cid:w1', text: 'A waiting note.' },
            { did: 'did:cid:w2', title: 'A waiting article' },
            { did: 'did:cid:w3', title: 'A waiting paper', paper: true },
            { did: 'did:cid:w4', text: 'A waiting reply.', target: 'did:cid:9' },
        ]));
        render(<App api={api} />);
        const user = userEvent.setup();

        // The reader's timeline has all but the reply.
        await screen.findByText('A waiting note.');
        expect(screen.getByText('A waiting article')).toBeTruthy();
        expect(screen.getByText('A waiting paper')).toBeTruthy();
        expect(screen.queryByText('A waiting reply.')).toBeNull();

        await user.click(within(document.querySelector('header.top') as HTMLElement).getByRole('button', { name: /did:cid/ }));
        await screen.findByRole('tab', { name: 'Articles' });
        const waits = async (tab: string) => {
            await user.click(screen.getByRole('tab', { name: tab }));
            await screen.findByRole('heading', { name: new RegExp(tab) });

            return ['A waiting note.', 'A waiting article', 'A waiting paper', 'A waiting reply.'].filter(text => screen.queryByText(text));
        };

        expect(await waits('Articles')).toStrictEqual(['A waiting article']);
        expect(await waits('Papers')).toStrictEqual(['A waiting paper']);
        expect(await waits('Replies')).toStrictEqual(['A waiting reply.']);
        expect(await waits('Posts')).toStrictEqual(['A waiting note.']);
    });
});

describe('what the reader published that waits to be anchored', () => {
    const publishing = async (text: string, did: string) => {
        const made = services({ me: granted, timeline: [post('did:cid:1', ALICE, 'Anchored.')] });
        vi.mocked(made.api.publish).mockResolvedValue(did);
        const view = render(<App api={made.api} />);
        const user = userEvent.setup();

        await user.type(await screen.findByLabelText('Post'), text);
        await user.click(screen.getByRole('button', { name: 'Publish' }));

        return { ...made, view, user };
    };
    const waitingCard = async (text: string) => (await screen.findByText(text)).closest('article.waiting') as HTMLElement;

    it('is shown as the reader\'s post, marked as waiting, with the chain it waits on once the service says', async () => {
        const { state, user } = await publishing('Not anchored **yet**.', 'did:cid:new');
        const card = await waitingCard('yet');

        // It is the reader's, shown as a post is: who wrote it and what it says.
        expect(within(card).getByTitle(ALICE)).toBeTruthy();
        expect(within(card).getByText('yet').tagName).toBe('STRONG');
        expect(within(card).getByRole('status').textContent).toBe('Waiting to be anchored');

        state.states['did:cid:new'] = { state: 'pending', registry: 'BTC:mainnet' };
        await user.click(screen.getByRole('button', { name: 'Refresh' }));
        await waitFor(() => expect(within(card).getByRole('status').textContent).toBe('Waiting to be anchored on BTC:mainnet'));
    });

    it('is still there when the page is read anew, for the reader who published it and no other', async () => {
        const { api, state, view } = await publishing('Kept across a reload.', 'did:cid:new');
        state.states['did:cid:new'] = { state: 'pending', registry: 'SOL:mainnet-beta' };
        await waitingCard('Kept across a reload.');
        view.unmount();

        const again = render(<App api={api} />);
        const card = await waitingCard('Kept across a reload.');
        await waitFor(() => expect(within(card).getByRole('status').textContent).toBe('Waiting to be anchored on SOL:mainnet-beta'));
        again.unmount();

        // Another reader signs in on this browser.
        state.me = { did: BOB, grant: 'did:cid:bobs', registry: 'BTC:mainnet' };
        render(<App api={api} />);
        await screen.findByRole('button', { name: 'Sign out' });
        await screen.findByRole('heading', { name: /Timeline/ });
        expect(screen.queryByText('Kept across a reload.')).toBeNull();
    });

    it('is put away once the indexer shows it, or the service says it is published', async () => {
        const { api, state, view, user } = await publishing('Soon published.', 'did:cid:new');
        await waitingCard('Soon published.');

        // The service says so before the indexer has it.
        state.states['did:cid:new'] = { state: 'published', registry: 'BTC:mainnet' };
        await user.click(screen.getByRole('button', { name: 'Refresh' }));
        await waitFor(() => expect(document.querySelector('article.waiting')).toBeNull());
        expect(JSON.parse(localStorage.getItem(`memepool.waiting.${ALICE}`)!)).toStrictEqual([]);
        view.unmount();

        // And it is not back when the page is read anew.
        render(<App api={api} />);
        await screen.findByText('Anchored.');
        expect(screen.queryByText('Soon published.')).toBeNull();
    });

    it('says when it will never be published, and is the reader\'s to put away', async () => {
        const { state, user } = await publishing('Too late.', 'did:cid:new');
        state.states['did:cid:new'] = { state: 'none' };
        await user.click(screen.getByRole('button', { name: 'Refresh' }));

        const card = await waitingCard('Too late.');
        await waitFor(() => expect(within(card).getByRole('status').textContent).toBe('Not published'));
        expect(within(card).getByText(/will not be published/)).toBeTruthy();

        await user.click(within(card).getByRole('button', { name: 'Dismiss' }));
        expect(screen.queryByText('Too late.')).toBeNull();
        expect(JSON.parse(localStorage.getItem(`memepool.waiting.${ALICE}`)!)).toStrictEqual([]);
    });

    it('stays as it is when the service cannot say, and is not undone by what the browser kept that is no entry', async () => {
        localStorage.setItem(`memepool.waiting.${ALICE}`, JSON.stringify([{ did: 'did:cid:kept', text: 'Kept.' }, 'nonsense', { text: 'no did' }, null, { did: 7 }]));
        const { api } = services({ me: granted });
        vi.mocked(api.state).mockRejectedValue(new Error('the service is away'));
        render(<App api={api} />);

        const card = await waitingCard('Kept.');
        await waitFor(() => expect(api.state).toHaveBeenCalledWith('did:cid:kept'));
        expect(within(card).getByRole('status').textContent).toBe('Waiting to be anchored');
        expect(document.querySelectorAll('article.waiting')).toHaveLength(1);

        localStorage.setItem(`memepool.waiting.${BOB}`, '{not json');
        cleanup();
        render(<App api={services({ me: { did: BOB, grant: 'did:cid:bobs' } }).api} />);
        expect(await screen.findByText('Nothing here yet.')).toBeTruthy();
    });

    it('is not lost to another page of the same reader, which writes what it changed and leaves the rest', async () => {
        const KEY = `memepool.waiting.${ALICE}`;
        const { state, user } = await publishing('Published in this page.', 'did:cid:here');
        await waitingCard('Published in this page.');

        // Another page of this reader publishes, and this one knows nothing of it.
        localStorage.setItem(KEY, JSON.stringify([...JSON.parse(localStorage.getItem(KEY)!), { did: 'did:cid:there', text: 'Published in another page.' }]));

        // This page changes its own entry, and then puts it away.
        state.states['did:cid:here'] = { state: 'pending', registry: 'BTC:mainnet' };
        await user.click(screen.getByRole('button', { name: 'Refresh' }));
        await waitFor(() => expect(JSON.parse(localStorage.getItem(KEY)!)).toStrictEqual([
            { did: 'did:cid:there', text: 'Published in another page.' },
            { did: 'did:cid:here', text: 'Published in this page.', registry: 'BTC:mainnet' },
        ]));

        state.states['did:cid:here'] = { state: 'published' };
        await user.click(screen.getByRole('button', { name: 'Refresh' }));
        await waitFor(() => expect(JSON.parse(localStorage.getItem(KEY)!)).toStrictEqual([{ did: 'did:cid:there', text: 'Published in another page.' }]));
    });

    it('takes up what another page of the reader writes, and does not bring back what that page put away', async () => {
        const KEY = `memepool.waiting.${ALICE}`;
        // Both pages hold an entry that will never be published.
        localStorage.setItem(KEY, JSON.stringify([{ did: 'did:cid:failed', text: 'Never published.', failed: true }]));
        const { api } = services({ me: granted, timeline: [post('did:cid:1', ALICE, 'Anchored.')] });
        vi.mocked(api.publish).mockResolvedValue('did:cid:new');
        render(<App api={api} />);
        const user = userEvent.setup();
        const another = (entries: unknown[]) => {
            localStorage.setItem(KEY, JSON.stringify(entries));
            fireEvent(window, new StorageEvent('storage', { key: KEY, newValue: JSON.stringify(entries) }));
        };

        await waitingCard('Never published.');

        // The other page dismisses it.
        another([]);
        await waitFor(() => expect(screen.queryByText('Never published.')).toBeNull());

        // This page then publishes something else, and writes no dismissed entry back.
        await user.type(screen.getByLabelText('Post'), 'Something else.');
        await user.click(screen.getByRole('button', { name: 'Publish' }));
        await waitingCard('Something else.');
        await waitFor(() => expect(JSON.parse(localStorage.getItem(KEY)!)).toStrictEqual([{ did: 'did:cid:new', text: 'Something else.' }]));

        // What the other page publishes is shown here as waiting too.
        another([{ did: 'did:cid:new', text: 'Something else.' }, { did: 'did:cid:there', text: 'From the other page.' }]);
        expect(await waitingCard('From the other page.')).not.toBeNull();

        // A write to another reader's list, or to something else, is not this page's.
        fireEvent(window, new StorageEvent('storage', { key: `memepool.waiting.${BOB}`, newValue: '[]' }));
        fireEvent(window, new StorageEvent('storage', { key: 'memepool.follows', newValue: '[]' }));
        expect(screen.getByText('From the other page.')).toBeTruthy();
    });

    it('is the list of whoever is signed in, when that changes under the page', async () => {
        localStorage.setItem(`memepool.waiting.${ALICE}`, JSON.stringify([{ did: 'did:cid:hers', text: 'Alice wrote this.' }]));
        localStorage.setItem(`memepool.waiting.${BOB}`, JSON.stringify([{ did: 'did:cid:his', text: 'Bob wrote this.' }]));
        const { api, state } = services({ me: { did: ALICE, link: 'archon://auth?grant=x' } });
        render(<App api={api} />);
        const user = userEvent.setup();

        await waitingCard('Alice wrote this.');

        // Another page signs in as Bob, and this one learns of it when it asks who is signed in.
        state.me = { did: BOB, link: 'archon://auth?grant=y' };
        await user.click(screen.getByRole('button', { name: 'I have approved it' }));

        expect(await waitingCard('Bob wrote this.')).not.toBeNull();
        expect(screen.queryByText('Alice wrote this.')).toBeNull();
        // Neither reader's list is written over with the other's.
        expect(JSON.parse(localStorage.getItem(`memepool.waiting.${ALICE}`)!)).toStrictEqual([{ did: 'did:cid:hers', text: 'Alice wrote this.' }]);
        expect(JSON.parse(localStorage.getItem(`memepool.waiting.${BOB}`)!)).toStrictEqual([{ did: 'did:cid:his', text: 'Bob wrote this.' }]);
    });

    it('is a reply in its thread, kept and marked in the same way', async () => {
        const { api, state } = services({ me: granted, timeline: [post('did:cid:1', ALICE, 'From Alice.')] });
        vi.mocked(api.publish).mockResolvedValue('did:cid:reply');
        state.states['did:cid:reply'] = { state: 'pending', registry: 'BTC:mainnet' };
        const view = render(<App api={api} />);
        const user = userEvent.setup();

        await user.click((await screen.findByText('From Alice.')).closest('article')!);
        await user.type(await screen.findByLabelText('Reply'), 'A reply that waits.');
        await user.click(screen.getByRole('button', { name: 'Publish' }));
        const card = await waitingCard('A reply that waits.');
        await waitFor(() => expect(within(card).getByRole('status').textContent).toBe('Waiting to be anchored on BTC:mainnet'));
        view.unmount();

        render(<App api={api} />);
        await user.click((await screen.findByText('From Alice.')).closest('article')!);
        expect(await waitingCard('A reply that waits.')).not.toBeNull();
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

        // A click on the boost opens the post, and the boost offers nothing to copy.
        const boost = (await screen.findByText('What Bob wrote.')).closest('article.boost') as HTMLElement;
        expect(within(boost).queryByRole('button', { name: /Copy/ })).toBeNull();

        await user.click(await toOpen());
        // The thread is the post's own, as it is: that is what there is to answer.
        expect(await screen.findByLabelText('Reply')).toBeTruthy();
        await choose(user, 'Copy DID');
        expect(write).toHaveBeenCalledWith(ORIGINAL);
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
        await user.click((document.querySelector('article.post.opens') as HTMLElement));

        // The version boosted is not opened in its place.
        expect(await screen.findByText(/The post cannot be opened as it is/)).toBeTruthy();
        expect(screen.queryByLabelText('Reply')).toBeNull();
        expect(api.thread).not.toHaveBeenCalled();

        // Withdrawn since the boost was read.
        state.known[ORIGINAL] = { ...state.known[ORIGINAL], state: 'withdrawn' };
        await user.click((document.querySelector('article.post.opens') as HTMLElement));
        expect(await screen.findByText(/The post cannot be opened as it is/)).toBeTruthy();
        expect(api.thread).not.toHaveBeenCalled();

        // And opened once it can be.
        state.known[ORIGINAL] = post(ORIGINAL, BOB, 'What Bob wrote.');
        await user.click((document.querySelector('article.post.opens') as HTMLElement));
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
        await user.click(await toOpen());
        await waitFor(() => expect(api.thread).toHaveBeenCalledWith(ORIGINAL));
        await choose(user, 'Copy DID');
        expect(write).toHaveBeenCalledWith(ORIGINAL);
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

describe('adding an image to what is written', () => {
    it('shows the reader its button, and not the browser\'s own file chooser', async () => {
        const { api } = services({ me: granted });
        render(<App api={api} />);

        await screen.findByLabelText('Post');
        expect(chooser('Post').hidden).toBe(true);
        expect(screen.getByRole('button', { name: 'Add image' })).toBeTruthy();
        // The pages style every input, which is a rule the browser's own for what is hidden gives way to.
        const styles = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');
        expect(styles).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important/);
    });

    const EMBED = '![a chart](did:cid:bagaaieraimage?versionId=bafyimage)';
    const file = (name: string, type: string, bytes = 100) => new File([new Uint8Array(bytes)], name, { type });
    const chooser = (label: string) => screen.getByLabelText('An image to add to ' + label) as HTMLInputElement;

    it('has the service store it, and puts its embed where the reader was writing', async () => {
        const { api, state } = services({ me: granted });
        render(<App api={api} />);
        const user = userEvent.setup();
        const area = await screen.findByLabelText('Post') as HTMLTextAreaElement;

        await user.type(area, 'Before. After.');
        area.setSelectionRange(7, 7);
        await user.upload(chooser('Post'), file('a chart.png', 'image/png'));

        await waitFor(() => expect(area.value).toBe('Before.\n\n' + EMBED + '\n\n After.'));
        expect(vi.mocked(api.upload).mock.calls[0][0]).toBeInstanceOf(File);

        // It is published as the reader left it, embed and all.
        await user.click(screen.getByRole('button', { name: 'Publish' }));
        await waitFor(() => expect(state.published).toStrictEqual([{ kind: 'post', text: 'Before.\n\n' + EMBED + '\n\n After.' }]));
    });

    it('puts an image into an empty text alone, and names it by its file with nothing that would end the embed', async () => {
        const { api } = services({ me: granted });
        render(<App api={api} />);
        const user = userEvent.setup();
        const area = await screen.findByLabelText('Post') as HTMLTextAreaElement;

        await user.upload(chooser('Post'), file('a [odd] name.final.jpg', 'image/jpeg'));
        await waitFor(() => expect(area.value).toBe('![a  odd  name.final](did:cid:bagaaieraimage?versionId=bafyimage)'));
    });

    it('sends nothing that is not an image text may embed, and says why', async () => {
        const { api } = services({ me: granted });
        render(<App api={api} />);
        const user = userEvent.setup({ applyAccept: false });

        await screen.findByLabelText('Post');
        await user.upload(chooser('Post'), file('drawing.svg', 'image/svg+xml'));
        expect((await screen.findByRole('alert')).textContent).toMatch(/PNG, JPEG, WebP or GIF/);

        await user.upload(chooser('Post'), file('huge.png', 'image/png', 10_000_001));
        await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/10 MB at most/));
        expect(api.upload).not.toHaveBeenCalled();
    });

    it('takes an image pasted into the text box, and puts its embed where the reader was writing', async () => {
        const { api, state } = services({ me: granted });
        render(<App api={api} />);
        const user = userEvent.setup();
        const area = await screen.findByLabelText('Post') as HTMLTextAreaElement;

        await user.type(area, 'Before. After.');
        area.setSelectionRange(7, 7);
        fireEvent.paste(area, { clipboardData: { items: [{ kind: 'file', getAsFile: () => file('image.png', 'image/png') }] } });

        await waitFor(() => expect(area.value).toBe('Before.\n\n![image](did:cid:bagaaieraimage?versionId=bafyimage)\n\n After.'));
        expect(vi.mocked(api.upload).mock.calls[0][0]).toBeInstanceOf(File);

        // Nothing of the paste reaches the text box as its own content.
        expect(area.value).not.toContain('[object');

        // It is published as the reader left it.
        await user.click(screen.getByRole('button', { name: 'Publish' }));
        await waitFor(() => expect(state.published).toStrictEqual([{ kind: 'post', text: 'Before.\n\n![image](did:cid:bagaaieraimage?versionId=bafyimage)\n\n After.' }]));
    });

    // A spreadsheet or a document copies a picture of the selection beside its words.
    it('pastes what was copied as text as text, though a picture of it is on the clipboard as well', async () => {
        const { api } = services({ me: granted });
        render(<App api={api} />);
        const area = await screen.findByLabelText('Post') as HTMLTextAreaElement;
        const picture = { kind: 'file', type: 'image/png', getAsFile: () => file('image.png', 'image/png') };
        const words = { kind: 'string', type: 'text/plain' };
        const markup = { kind: 'string', type: 'text/html' };

        for (const items of [[words, markup, picture], [picture, words], [markup, picture, words]]) {
            // The paste is left to the browser, which puts the words in.
            expect(fireEvent.paste(area, { clipboardData: { items } })).toBe(true);
        }
        expect(api.upload).not.toHaveBeenCalled();

        // An image copied from a page has its markup beside it and no words, and is taken.
        expect(fireEvent.paste(area, { clipboardData: { items: [markup, picture] } })).toBe(false);
        await waitFor(() => expect(api.upload).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(area.value).toContain('![image](did:cid:bagaaieraimage?versionId=bafyimage)'));
    });

    it('leaves text pasted into the text box alone, and stores no image for what is no file', async () => {
        const { api } = services({ me: granted });
        render(<App api={api} />);
        const user = userEvent.setup();
        const area = await screen.findByLabelText('Post') as HTMLTextAreaElement;

        await user.click(area);
        await user.paste('Just words.');

        expect(area.value).toBe('Just words.');
        expect(api.upload).not.toHaveBeenCalled();
    });

    it('says when the service did not store it, and leaves what was written', async () => {
        const { api } = services({ me: granted });
        vi.mocked(api.upload).mockRejectedValue(new ApiError(429, 'too many images; try again within the hour'));
        render(<App api={api} />);
        const user = userEvent.setup();
        const area = await screen.findByLabelText('Post') as HTMLTextAreaElement;

        await user.type(area, 'Kept.');
        await user.upload(chooser('Post'), file('a chart.png', 'image/png'));

        expect((await screen.findByRole('alert')).textContent).toMatch(/was not stored: too many images/);
        expect(area.value).toBe('Kept.');
        expect((screen.getByRole('button', { name: 'Add image' }) as HTMLButtonElement).disabled).toBe(false);
    });

    it('holds back what is written until the image is in it, and takes no image for a text that was put away', async () => {
        const { api, state } = services({ me: granted });
        // Each image being stored, for the test to say when it has been.
        const storing: ((image: { did: string; versionId: string }) => void)[] = [];
        const stored = () => storing.shift()?.({ did: 'did:cid:bagaaieraimage', versionId: 'bafyimage' });
        vi.mocked(api.upload).mockImplementation(() => new Promise(resolve => { storing.push(resolve); }));
        render(<App api={api} />);
        const user = userEvent.setup();
        const area = await screen.findByLabelText('Post') as HTMLTextAreaElement;

        await user.type(area, 'See this.');
        await user.upload(chooser('Post'), file('a chart.png', 'image/png'));

        // While it is being stored the post is not whole, and is not to be published.
        expect(await screen.findByRole('button', { name: 'Storing the image…' })).toBeTruthy();
        expect((screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement).disabled).toBe(true);
        expect(state.published).toStrictEqual([]);

        stored();
        await waitFor(() => expect(area.value).toBe('See this.\n\n' + EMBED));
        await waitFor(() => expect((screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement).disabled).toBe(false));

        // An article that is cancelled while its image is stored takes none.
        await user.click(screen.getByRole('button', { name: 'Write an article' }));
        await user.type(screen.getByLabelText('Title'), 'A title');
        await user.type(screen.getByLabelText('Article'), 'A body.');
        await user.upload(chooser('Article'), file('a chart.png', 'image/png'));
        await screen.findByRole('button', { name: 'Storing the image…' });
        expect((screen.getByRole('button', { name: 'Publish article' }) as HTMLButtonElement).disabled).toBe(true);
        await user.click(screen.getByRole('button', { name: 'Cancel' }));
        stored();

        // The article is gone, and its image is put into nothing that is there.
        const post = await screen.findByLabelText('Post') as HTMLTextAreaElement;
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(post.value).not.toContain('bagaaieraimage');
        expect(screen.queryByRole('alert')).toBeNull();
        expect(state.published).toStrictEqual([]);
    });

    it('puts the embed where the reader is writing once the image is stored, though they wrote more meanwhile', async () => {
        const { api } = services({ me: granted });
        const storing: ((image: { did: string; versionId: string }) => void)[] = [];
        vi.mocked(api.upload).mockImplementation(() => new Promise(resolve => { storing.push(resolve); }));
        render(<App api={api} />);
        const user = userEvent.setup();
        const area = await screen.findByLabelText('Post') as HTMLTextAreaElement;

        await user.type(area, 'Before. After.');
        area.setSelectionRange(7, 7);
        await user.upload(chooser('Post'), file('a chart.png', 'image/png'));
        await screen.findByRole('button', { name: 'Storing the image…' });

        // The reader goes to the start and writes more while the image is stored.
        await user.type(area, 'New ', { initialSelectionStart: 0, initialSelectionEnd: 0 });
        expect(area.value).toBe('New Before. After.');
        area.setSelectionRange(11, 11);
        storing.shift()?.({ did: 'did:cid:bagaaieraimage', versionId: 'bafyimage' });

        // No word is split: the embed is where the reader left off.
        await waitFor(() => expect(area.value).toBe('New Before.\n\n' + EMBED + '\n\n After.'));
    });

    it('keeps the reader\'s place while the preview is shown, for the image and for the reader', async () => {
        const { api } = services({ me: granted });
        const storing: ((image: { did: string; versionId: string }) => void)[] = [];
        vi.mocked(api.upload).mockImplementation(() => new Promise(resolve => { storing.push(resolve); }));
        render(<App api={api} />);
        const user = userEvent.setup();
        const area = await screen.findByLabelText('Post') as HTMLTextAreaElement;

        await user.type(area, 'Before. After.');
        area.setSelectionRange(7, 7);
        fireEvent.select(area);
        await user.upload(chooser('Post'), file('a chart.png', 'image/png'));
        await screen.findByRole('button', { name: 'Storing the image…' });

        // The text box is gone while the preview is shown, and the image is stored meanwhile.
        await user.click(screen.getByRole('tab', { name: 'Preview' }));
        expect(screen.queryByLabelText('Post')).toBeNull();
        storing.shift()?.({ did: 'did:cid:bagaaieraimage', versionId: 'bafyimage' });

        await user.click(screen.getByRole('tab', { name: 'Write' }));
        const back = await screen.findByLabelText('Post') as HTMLTextAreaElement;
        await waitFor(() => expect(back.value).toBe('Before.\n\n' + EMBED + '\n\n After.'));
    });

    it('gives the text box back its place when the reader returns from the preview', async () => {
        const { api } = services({ me: granted });
        render(<App api={api} />);
        const user = userEvent.setup();
        const area = await screen.findByLabelText('Post') as HTMLTextAreaElement;

        await user.type(area, 'Before. After.');
        area.setSelectionRange(7, 7);
        fireEvent.select(area);
        await user.click(screen.getByRole('tab', { name: 'Preview' }));
        await user.click(screen.getByRole('tab', { name: 'Write' }));

        expect((screen.getByLabelText('Post') as HTMLTextAreaElement).selectionStart).toBe(7);
    });

    it('is offered for an article and a reply as well, and to nobody who has not granted the service', async () => {
        const { api } = services({ me: granted, timeline: [post('did:cid:1', ALICE, 'From Alice.')] });
        const view = render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await screen.findByRole('button', { name: 'Write an article' }));
        await user.upload(chooser('Article'), file('a chart.png', 'image/png'));
        await waitFor(() => expect((screen.getByLabelText('Article') as HTMLTextAreaElement).value).toBe(EMBED));
        await user.click(screen.getByRole('button', { name: 'Cancel' }));

        await user.click(screen.getByText('From Alice.').closest('article')!);
        await screen.findByLabelText('Reply');
        expect(chooser('Reply')).toBeTruthy();
        view.unmount();

        render(<App api={services({ me: { did: ALICE, link: 'archon://auth?grant=x' } }).api} />);
        await screen.findByRole('button', { name: 'Sign out' });
        expect(screen.queryByRole('button', { name: 'Add image' })).toBeNull();
    });
});

describe('a post embedded in another', () => {
    const QUOTED = 'did:cid:bagaaieraquotedquotedquotedquotedquotedquotedquotedquote';
    // A version is named by the CID of the operation that made it.
    const at = (did: string, author: string, text: string, opid = 'bafyv1'): Publication =>
        ({ ...post(did, author, text), versions: [{ opid, type: 'create', outcome: 'attributed', position: { block: 1, time: '2026-11-21T12:00:00Z' } }] });
    const embed = (version = 'bafyv1') => `![what Bob wrote](${QUOTED}?versionId=${version})`;
    const has = (state: ReturnType<typeof services>['state'], publication: Publication) => {
        state.known[publication.did!] = publication;
        state.revisions[`${publication.did} ${publication.versions[0].opid}`] = publication;
    };

    it('is shown as a card with its author and what that version said, whatever it says since', async () => {
        const { api, state } = services({ me: granted, timeline: [post('did:cid:1', ALICE, `I agree with this:\n\n${embed()}`)] });
        const first = at(QUOTED, BOB, 'What **Bob** wrote.');
        has(state, first);
        state.known[QUOTED] = { ...post(QUOTED, BOB, 'Something else.'), current: 1, versions: [first.versions[0], { opid: 'op-edit', type: 'update', outcome: 'attributed' }] };
        state.people[BOB] = { name: 'Bob B.' };
        render(<App api={api} />);

        const card = (await screen.findByText('Bob')).closest('.embed.card') as HTMLElement;

        expect(card).not.toBeNull();
        expect(await within(card).findByText('Bob B.')).toBeTruthy();
        expect(screen.getByText('I agree with this:')).toBeTruthy();
        expect(screen.queryByText('Something else.')).toBeNull();
        expect(api.revision).toHaveBeenCalledWith(QUOTED, 'bafyv1');
    });

    it('is opened as it is, from the card', async () => {
        const { api, state } = services({ me: granted, timeline: [post('did:cid:1', ALICE, embed())] });
        has(state, at(QUOTED, BOB, 'What Bob wrote.'));
        render(<App api={api} />);
        const user = userEvent.setup();

        const card = (await screen.findByText('What Bob wrote.')).closest('.embed.card') as HTMLElement;
        await user.click(card.querySelector('.quoted') as HTMLElement);

        expect(await screen.findByLabelText('Reply')).toBeTruthy();
        expect(api.thread).toHaveBeenCalledWith(QUOTED);
    });

    it('is read anew when the timeline is refreshed, and when the thread it is in is', async () => {
        const { api, state } = services({ me: granted, timeline: [post('did:cid:1', ALICE, `See:\n\n${embed()}`)] });
        render(<App api={api} />);
        const user = userEvent.setup();

        // The indexer has not read the post quoted.
        await waitFor(() => expect(api.revision).toHaveBeenCalledTimes(1));
        expect(screen.queryByText('What Bob wrote.')).toBeNull();

        has(state, at(QUOTED, BOB, 'What Bob wrote.'));
        await user.click(screen.getByRole('button', { name: 'Refresh' }));
        expect((await screen.findByText('What Bob wrote.')).closest('.embed.card')).not.toBeNull();

        // In the thread of the post that quotes it, a replay puts the version out of the history.
        // The post's own way to be opened, and not the card's.
        await user.click(screen.getByText('See:').closest('article')!);
        await screen.findByLabelText('Reply');
        expect(await screen.findByText('What Bob wrote.')).toBeTruthy();
        delete state.revisions[`${QUOTED} bafyv1`];
        await user.click(screen.getByRole('button', { name: 'Refresh' }));

        expect(await screen.findByText(/this version is no longer in its history/)).toBeTruthy();
        expect(screen.queryByText('What Bob wrote.')).toBeNull();
    });

    it('shows the post as it is when it is opened from a card inside its own thread', async () => {
        // A reply to the post quotes the post, at the version it answered.
        const first = at(QUOTED, BOB, 'What Bob wrote.');
        const { api, state } = services({ me: granted, timeline: [first] });
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        has(state, first);
        vi.mocked(api.thread).mockResolvedValue([{ depth: 0, publication: post('did:cid:reply', ALICE, `On this: ${embed()}`) }]);
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click((await screen.findByText('What Bob wrote.')).closest('article')!);
        const card = await waitFor(() => { const found = document.querySelector('.embed.card'); expect(found).not.toBeNull(); return found as HTMLElement; });

        // Bob edits the post, and the thread still shows it as it was read.
        state.known[QUOTED] = { ...at(QUOTED, BOB, 'What Bob wrote, corrected.'), current: 1, versions: [first.versions[0], { opid: 'bafyv2', type: 'update', outcome: 'attributed' }] };
        await user.click(card.querySelector('.quoted') as HTMLElement);

        expect(await screen.findAllByText('What Bob wrote, corrected.')).not.toHaveLength(0);
    });

    it('shows a card\'s own embeds by their words, so that no card is inside another', async () => {
        const INNER = 'did:cid:bagaaierainnerinnerinnerinnerinnerinnerinnerinnerinnerinn';
        const { api, state } = services({ me: granted, timeline: [post('did:cid:1', ALICE, embed())] });
        has(state, at(QUOTED, BOB, `Bob quotes: ![the inner post](${INNER}?versionId=bafyinner)`));
        has(state, at(INNER, BOB, 'Never shown here.', 'bafyinner'));
        render(<App api={api} />);

        const card = (await screen.findByText(/Bob quotes/)).closest('.embed.card') as HTMLElement;

        expect(within(card).getByText('the inner post')).toBeTruthy();
        expect(screen.queryByText('Never shown here.')).toBeNull();
        expect(card.querySelector('.card')).toBeNull();
    });

    it('is shown as an image when the DID is no object\'s, asked of the service', async () => {
        const IMAGE = 'did:cid:bagaaieraimageimageimageimageimageimageimageimageimageim';
        const { api } = services({ me: granted, timeline: [post('did:cid:1', ALICE, `![a chart](${IMAGE}?versionId=bafyv1)`)] });
        render(<App api={api} />);

        await waitFor(() => expect(document.querySelector('.embed img')).not.toBeNull());
        const image = document.querySelector('.embed img') as HTMLImageElement;

        expect(image.getAttribute('src')).toBe(`/memepool/api/v1/images/${encodeURIComponent(IMAGE)}?versionId=bafyv1`);
        expect(image.getAttribute('alt')).toBe('a chart');
    });

    it('is what a post\'s Copy embed gives, at the version shown, and is shown in a preview', async () => {
        const { api, state } = services({ me: granted, timeline: [post('did:cid:1', ALICE, 'Mine.')] });
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        has(state, { ...at(QUOTED, BOB, 'What Bob wrote.'), memeplex: { kind: 'post', author: BOB, text: 'What Bob wrote.', title: 'On [DIDs]' } });
        state.timeline.push(state.known[QUOTED]);
        const user = userEvent.setup();
        const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
        render(<App api={api} />);

        await user.click((await screen.findByText('What Bob wrote.')).closest('article')!);
        await choose(user, 'Copy embed');

        const copied = `![On  DIDs](${QUOTED}?versionId=bafyv1)`;
        expect(write).toHaveBeenCalledWith(copied);
        await user.click(screen.getByRole('button', { name: 'Back' }));

        // Pasted into a post, the preview shows the card.
        await user.click(screen.getByLabelText('Post'));
        await user.paste(`See:\n\n${copied}`);
        await user.click(screen.getAllByRole('tab', { name: 'Preview' })[0]);
        const preview = screen.getByRole('tabpanel', { name: 'Post preview' });

        expect((await within(preview).findByText('What Bob wrote.')).closest('.embed.card')).not.toBeNull();
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

    it('shows an article with its title and subtitle above its body', async () => {
        const { api } = services({ me: granted });
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await screen.findByRole('button', { name: 'Write an article' }));
        await user.type(screen.getByLabelText('Title'), 'On DIDs');
        await user.type(screen.getByLabelText('Subtitle'), 'What they are for.');
        await user.type(screen.getByLabelText('Article'), '## A section{Enter}{Enter}- one{Enter}- two');
        await user.click(screen.getByRole('tab', { name: 'Preview' }));

        const preview = screen.getByRole('tabpanel', { name: 'Article preview' });
        expect(within(preview).getByRole('heading', { name: 'On DIDs' })).toBeTruthy();
        expect(within(preview).getByText('What they are for.').className).toBe('subtitle');
        expect(within(preview).getByRole('heading', { name: 'A section' })).toBeTruthy();
        expect(within(preview).getAllByRole('listitem')).toHaveLength(2);
        // The body is set apart from what is above it, as an opened article's is.
        expect(preview.querySelector('.markdown')?.classList.contains('article')).toBe(true);
        // The title and subtitle are still there to change.
        expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('On DIDs');
    });

    it('shows a reply, and an edit, as each will be shown', async () => {
        const mine = under(post('did:cid:1', ALICE, 'A post.'), 'did:cid:grant');
        const { api } = services({ me: granted, timeline: [mine] });
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await toOpen());
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

    it('is written with a title, a subtitle if the writer gives one, and a body, which the service is sent to store', async () => {
        const { api, state } = services({ me: granted });
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await screen.findByRole('button', { name: 'Write an article' }));
        expect((screen.getByRole('button', { name: 'Publish article' }) as HTMLButtonElement).disabled).toBe(true);
        await user.type(screen.getByLabelText('Title'), 'On DIDs');
        // A writer is asked for no summary: that is a paper's.
        expect(screen.queryByLabelText('Summary')).toBeNull();
        await user.type(screen.getByLabelText('Subtitle'), ' What they are for. ');
        await user.type(screen.getByLabelText('Article'), 'Every post is one.');
        await user.click(screen.getByRole('button', { name: 'Publish article' }));

        await waitFor(() => expect(state.published).toStrictEqual([
            { kind: 'post', title: 'On DIDs', subtitle: 'What they are for.', body: 'Every post is one.' },
        ]));
        // What waits to be anchored has the subtitle the preview showed, and keeps it when the page is read anew.
        const waiting = (await screen.findByRole('heading', { name: 'On DIDs' })).closest('.waiting') as HTMLElement;
        expect(within(waiting).getByText('What they are for.').className).toBe('subtitle');
        expect(JSON.parse(localStorage.getItem(`memepool.waiting.${ALICE}`)!)).toMatchObject([{ title: 'On DIDs', subtitle: 'What they are for.' }]);
        state.states[JSON.parse(localStorage.getItem(`memepool.waiting.${ALICE}`)!)[0].did] = { state: 'pending', registry: 'BTC:mainnet' };
        await user.click(screen.getByRole('button', { name: 'Refresh' }));
        await waitFor(() => expect(within(waiting).getByRole('status').textContent).toBe('Waiting to be anchored on BTC:mainnet'));
        expect(within(waiting).getByText('What they are for.')).toBeTruthy();
        // Waiting to be anchored, under its title, and the short form is back.
        expect((await screen.findByRole('heading', { name: 'On DIDs' })).closest('.waiting')).not.toBeNull();
        expect(screen.getByLabelText('Post')).toBeTruthy();
    });

    it('is written with no subtitle, and then has none', async () => {
        const { api, state } = services({ me: granted });
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await screen.findByRole('button', { name: 'Write an article' }));
        await user.type(screen.getByLabelText('Title'), 'On DIDs');
        await user.type(screen.getByLabelText('Article'), 'Every post is one.');
        await user.click(screen.getByRole('button', { name: 'Publish article' }));

        await waitFor(() => expect(state.published).toStrictEqual([{ kind: 'post', title: 'On DIDs', body: 'Every post is one.' }]));
    });

    it('is shown with its subtitle under its title, in a timeline and where it is quoted', async () => {
        const titled: Publication = { ...post('did:cid:1', ALICE, ''), memeplex: { kind: 'post', author: ALICE, title: 'On DIDs', subtitle: 'What they are for.', content: { cid: 'bafkreibody', type: 'text/markdown', bytes: 4 } } };
        const { api } = services({ me: granted, timeline: [titled] });
        render(<App api={api} />);

        const entry = (await screen.findByRole('heading', { name: 'On DIDs' })).closest('article')!;
        const subtitle = within(entry).getByText('What they are for.');

        expect(subtitle.className).toBe('subtitle');
        // Under the title, and above what says to open it.
        expect(entry.querySelector('h3')!.nextElementSibling).toBe(subtitle);
        expect(within(entry).getByText('Open it to read the full text.')).toBeTruthy();
    });

    it('has its subtitle changed, added and taken away by an edit, and keeps a summary it was given', async () => {
        const first: Publication = under({
            ...post('did:cid:1', ALICE, ''),
            memeplex: { kind: 'post', author: ALICE, title: 'On DIDs', subtitle: 'What they are for.', summary: 'An old summary.', content: { cid: 'bafkreibody', type: 'text/markdown', bytes: BODY.length }, v: 1 },
        }, 'did:cid:grant');
        const { api, state } = services({ me: granted, timeline: [first] });
        state.bodies.bafkreibody = BODY;
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await toOpen());
        await user.click(await screen.findByRole('button', { name: 'Edit' }));
        await waitFor(() => expect((screen.getByLabelText('Article') as HTMLTextAreaElement).value).toBe(BODY));
        expect((screen.getByLabelText('Subtitle') as HTMLInputElement).value).toBe('What they are for.');
        // An article that was given a summary keeps the place to change it.
        expect((screen.getByLabelText('Summary') as HTMLTextAreaElement).value).toBe('An old summary.');

        await user.clear(screen.getByLabelText('Subtitle'));
        await user.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(state.edited).toHaveLength(1));
        expect(state.edited[0].object).not.toHaveProperty('subtitle');
        expect(state.edited[0].object).toMatchObject({ title: 'On DIDs', summary: 'An old summary.' });
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
        state.bodies.bafkreibody = BODY;
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await toOpen());

        expect(await screen.findByText(/Every post is one\./)).toBeTruthy();
        // The body asked for is that of the version shown.
        expect(api.content).toHaveBeenCalledWith('bafkreibody');
        expect(screen.getByText('A summary.')).toBeTruthy();
    });

    it('says so when the node does not have the body, or it could not be read', async () => {
        const { api } = services({ me: granted, timeline: [article('did:cid:1', BOB)] });
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await toOpen());
        expect(await screen.findByText('The full text is not on this node.')).toBeTruthy();

        vi.mocked(api.content).mockRejectedValue(new ApiError(502, 'the node does not have the body'));
        await user.click(screen.getByRole('button', { name: 'Back' }));
        await user.click(await toOpen());
        expect((await screen.findByRole('alert')).textContent).toMatch(/could not be read: the node does not have the body/);
        localStorage.clear();
    });

    it('is published with when and where it first appeared, where the writer says, and with an https address only', async () => {
        const { api, state } = services({ me: granted });
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await screen.findByRole('button', { name: 'Write an article' }));
        await user.type(screen.getByLabelText('Title'), 'A title');
        await user.type(screen.getByLabelText('Article'), 'A body.');
        const publish = screen.getByRole('button', { name: 'Publish article' }) as HTMLButtonElement;

        // Both are left empty by a work that is new.
        expect(publish.disabled).toBe(false);
        fireEvent.change(screen.getByLabelText('First published'), { target: { value: '2019-03-12' } });
        await user.type(screen.getByLabelText('Original'), 'http://example.org/a-title');
        expect(screen.getByText('The original is an https address, with no spaces.')).toBeTruthy();
        expect(publish.disabled).toBe(true);

        await user.clear(screen.getByLabelText('Original'));
        await user.type(screen.getByLabelText('Original'), ' https://example.org/a-title ');
        expect(publish.disabled).toBe(false);
        await user.click(publish);

        await waitFor(() => expect(state.published).toStrictEqual([
            { kind: 'post', title: 'A title', body: 'A body.', firstPublished: '2019-03-12', original: 'https://example.org/a-title' },
        ]));
    });

    it('says when and where it first appeared as its author\'s claim, and follows no address but an https one', async () => {
        const first = (did: string, more: Record<string, unknown>): Publication => ({ ...article(did), memeplex: { ...article(did).memeplex!, ...more } });
        const { api } = services({ me: granted, timeline: [
            first('did:cid:1', { title: 'Both', firstPublished: '2019-03-12', original: 'https://example.org/a-title' }),
            first('did:cid:2', { title: 'A day', firstPublished: '2020-02-29' }),
            first('did:cid:3', { title: 'A place', original: 'https://example.org/elsewhere' }),
            first('did:cid:4', { title: 'A script', firstPublished: '2019-02-30x', original: ['javascript', 'alert(1)'].join(':') }),
            first('did:cid:5', { title: 'Neither' }),
            first('did:cid:6', { title: 'Long ago', firstPublished: '0099-03-12' }),
            first('did:cid:7', { title: 'No such day', firstPublished: '2019-02-30' }),
            first('did:cid:8', { title: 'Long', original: `https://example.org/${'🙂'.repeat(1900)}` }),
            first('did:cid:9', { title: 'Too long', original: `https://example.org/${'a'.repeat(1981)}` }),
            first('did:cid:10', { title: 'No address', original: 'https://:80' }),
        ] });
        render(<App api={api} />);

        const of = async (title: string) => (await screen.findByText(title)).closest('article')!.querySelector('.first');
        const both = (await of('Both'))!;

        expect(both.textContent).toMatch(/^First published .*2019.* · original$/);
        expect(both.textContent).toMatch(/12/);
        const link = both.querySelector('a')!;

        expect(link.getAttribute('href')).toBe('https://example.org/a-title');
        expect(link.getAttribute('rel')).toBe('noreferrer noopener');
        expect(within(both as HTMLElement).getByRole('link', { name: 'original publication' })).toBe(link);
        // A day alone, and a place alone.
        expect((await of('A day'))!.textContent).toMatch(/^First published .*29.*2020|^First published .*2020/);
        expect((await of('A day'))!.querySelector('a')).toBeNull();
        expect((await of('A place'))!.textContent).toBe('First published elsewhere · original');
        // What is no date and no https address is not shown, and nothing is said of a work that says nothing.
        expect(await of('A script')).toBeNull();
        expect(await of('Neither')).toBeNull();
        // A year is the one written, and a day that is none is not shown as another.
        expect((await of('Long ago'))!.textContent).toMatch(/\b0*99\b/);
        expect((await of('Long ago'))!.textContent).not.toMatch(/1999/);
        expect(await of('No such day')).toBeNull();
        // An address is as long as the protocol counts it, in code points.
        expect((await of('Long'))!.querySelector('a')).not.toBeNull();
        expect(await of('Too long')).toBeNull();
        // What has the shape and is no address a browser can open is no link.
        expect(await of('No address')).toBeNull();
        expect(document.querySelector('a[href^="javascript"]')).toBeNull();
    });

    it('has when and where it first appeared changed, and taken off, by an edit', async () => {
        const was = { ...article('did:cid:1'), memeplex: { ...article('did:cid:1').memeplex!, firstPublished: '2019-03-12', original: 'https://example.org/a-title' } };
        const { api, state } = services({ me: granted, timeline: [was] });
        state.bodies.bafkreibody = BODY;
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await toOpen());
        await user.click(await screen.findByRole('button', { name: 'Edit' }));
        await waitFor(() => expect((screen.getByLabelText('Article') as HTMLTextAreaElement).value).toBe(BODY));
        expect((screen.getByLabelText('First published') as HTMLInputElement).value).toBe('2019-03-12');
        expect((screen.getByLabelText('Original') as HTMLInputElement).value).toBe('https://example.org/a-title');
        expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);

        fireEvent.change(screen.getByLabelText('First published'), { target: { value: '2018-01-02' } });
        await user.clear(screen.getByLabelText('Original'));
        await user.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(state.edited).toHaveLength(1));
        expect(state.edited[0].object.firstPublished).toBe('2018-01-02');
        expect('original' in state.edited[0].object).toBe(false);
    });

    it('is edited with its body, and sends the body only when it has changed', async () => {
        const { api, state } = services({ me: granted, timeline: [article('did:cid:1')] });
        state.bodies.bafkreibody = BODY;
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await toOpen());
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
        state.bodies.bafkreibody = BODY;
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await toOpen());
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
        state.bodies.bafkreibody = BODY;
        state.bodies.bafkreisecond = 'Rewritten.';
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await toOpen());
        expect(await screen.findByText(/Every post is one\./)).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Edit' }));
        await waitFor(() => expect((screen.getByLabelText('Article') as HTMLTextAreaElement).value).toBe(BODY));
        await user.clear(screen.getByLabelText('Summary'));
        await user.click(screen.getByRole('button', { name: 'Save' }));

        // Not anchored: the version shown is the one before, with its body.
        expect(await screen.findByText(/Your edit is waiting to be anchored/)).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
        expect(screen.getByText(/Every post is one\./)).toBeTruthy();

        vi.mocked(api.publication).mockResolvedValue({
            ...first, current: 1,
            versions: [...first.versions, { opid: 'op-second', type: 'update', outcome: 'attributed', position: { block: 2, time: '2026-11-22T12:00:00Z' } }],
            memeplex: { ...first.memeplex!, summary: undefined, content: { cid: 'bafkreisecond', type: 'text/markdown', bytes: 10 } },
        });
        await user.click(screen.getByRole('button', { name: 'Refresh' }));

        expect(await screen.findByText('Rewritten.')).toBeTruthy();
        await waitFor(() => expect(screen.queryByText(/Your edit is waiting to be anchored/)).toBeNull());
        expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
    });

    it('starts an edit again from another version that a refresh shows, and keeps a paper\'s summary when it is emptied', async () => {
        const paper = under({
            ...post('did:cid:1', ALICE, ''),
            memeplex: { kind: 'paper', author: ALICE, title: 'On DIDs', summary: 'A summary.', authors: [ALICE], content: { cid: 'bafkreibody', type: 'text/markdown', bytes: BODY.length }, v: 1 },
        }, 'did:cid:grant');
        const { api, state } = services({ me: granted, timeline: [paper] });
        state.bodies.bafkreibody = BODY;
        state.bodies.bafkreisecond = 'Rewritten elsewhere.';
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await toOpen());
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

    it('cannot be changed here when the node does not have its body', async () => {
        const { api, state } = services({ me: granted, timeline: [article('did:cid:1')] });
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await toOpen());
        await user.click(await screen.findByRole('button', { name: 'Edit' }));

        expect((await screen.findByRole('alert')).textContent).toMatch(/full text is not on this node/);
        expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
        expect(state.edited).toStrictEqual([]);
    });
});

describe('a paper', () => {
    const CAROL = 'did:cid:bagaaieracarolcarolcarolcarolcarolcarolcarolcarolcarolcarol';
    const paper = (more: Partial<Publication> = {}): Publication => ({
        ...post('did:cid:9', BOB, ''),
        memeplex: {
            kind: 'paper', author: BOB, title: 'Convergent Replay', summary: 'We show that nodes agree.',
            authors: [BOB, ALICE, CAROL], content: { cid: 'bafypaper', type: 'text/markdown', bytes: 20 },
        },
        ...more,
    });

    it('reads the DIDs written as coauthors, and says what among them is none', () => {
        expect(coauthorsIn(`${BOB}\n ${CAROL}, ${BOB}`)).toStrictEqual({ dids: [BOB, CAROL], others: [] });
        expect(coauthorsIn(`${BOB} bob@example.org not-a-did`)).toStrictEqual({ dids: [BOB], others: ['bob@example.org', 'not-a-did'] });
        expect(coauthorsIn('  \n ')).toStrictEqual({ dids: [], others: [] });
    });

    it('is written with an abstract and its coauthors, and published with the reader as its first author', async () => {
        const { api, state } = services({ me: granted });
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await screen.findByRole('button', { name: 'Write a paper' }));
        await user.type(screen.getByLabelText('Title'), 'Convergent Replay');
        await user.type(screen.getByLabelText('Paper'), 'The full text.');
        // A paper has an abstract.
        expect((screen.getByRole('button', { name: 'Publish paper' }) as HTMLButtonElement).disabled).toBe(true);
        await user.type(screen.getByLabelText('Abstract'), 'We show that nodes agree.');

        // What is no DID is said, and nothing is published with it.
        await user.type(screen.getByLabelText('Coauthors'), 'bob');
        expect((await screen.findByRole('alert')).textContent).toBe('Not a DID: bob');
        expect((screen.getByRole('button', { name: 'Publish paper' }) as HTMLButtonElement).disabled).toBe(true);
        await user.clear(screen.getByLabelText('Coauthors'));
        fireEvent.change(screen.getByLabelText('Coauthors'), { target: { value: `${BOB}\n${ALICE}\n${BOB}` } });
        expect(screen.getByText(/listed by you until they confirm it/)).toBeTruthy();

        await user.click(screen.getByRole('button', { name: 'Publish paper' }));

        await waitFor(() => expect(state.published).toStrictEqual([{
            kind: 'paper', title: 'Convergent Replay', body: 'The full text.', summary: 'We show that nodes agree.',
            // The reader once, and first, however the list was written.
            authors: [ALICE, BOB],
        }]));
        // It waits to be anchored as an article does, under its title.
        expect(await screen.findByText('Convergent Replay')).toBeTruthy();
        expect(screen.getByLabelText('Post')).toBeTruthy();
    });

    it('is not what an article is written as, which has no abstract and no coauthors', async () => {
        const { api, state } = services({ me: granted });
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await screen.findByRole('button', { name: 'Write an article' }));
        expect(screen.queryByLabelText('Abstract')).toBeNull();
        expect(screen.queryByLabelText('Coauthors')).toBeNull();
        await user.type(screen.getByLabelText('Title'), 'On DIDs');
        await user.type(screen.getByLabelText('Article'), 'Words.');
        await user.click(screen.getByRole('button', { name: 'Publish article' }));

        await waitFor(() => expect(state.published).toStrictEqual([{ kind: 'post', title: 'On DIDs', body: 'Words.' }]));
    });

    it('lists who wrote it, and how each coauthor stands once it is open', async () => {
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        const { api, state } = services({ me: { did: CAROL }, timeline: [paper()] });
        state.bodies.bafypaper = 'The full text.';
        state.coauthors['did:cid:9'] = [{ did: ALICE, status: 'confirmed' }, { did: CAROL, status: 'listed' }];
        state.people = { [BOB]: { name: 'Bob B.' }, [ALICE]: { name: 'Alice A.' } };
        render(<App api={api} />);
        const user = userEvent.setup();

        // In a list its authors are named, and nothing is asked about how they stand.
        const listed = (await screen.findByText('Convergent Replay')).closest('article')!;

        expect(await within(listed).findByText('Alice A.')).toBeTruthy();
        expect(within(listed).getByText('We show that nodes agree.')).toBeTruthy();
        expect(api.coauthors).not.toHaveBeenCalled();
        expect(within(listed).queryByText(/confirmed|listed by the publisher/)).toBeNull();

        await user.click(listed);
        const authors = await waitFor(() => document.querySelector('.authors') as HTMLElement);

        expect(await within(authors).findByText('confirmed')).toBeTruthy();
        expect(within(authors).getByText('listed by the publisher')).toBeTruthy();
        expect(api.coauthors).toHaveBeenCalledWith('did:cid:9');
        // Its publisher is its author, and is not one who confirms.
        expect(within(authors).getAllByRole('listitem')).toHaveLength(3);
        expect(await screen.findByText('The full text.')).toBeTruthy();
    });

    it('is confirmed by a reader it lists, of the revision shown, and not by one it does not or who has', async () => {
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        const { api, state } = services({ me: granted, timeline: [paper()] });
        state.coauthors['did:cid:9'] = [{ did: ALICE, status: 'listed' }, { did: CAROL, status: 'listed' }];
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await toOpen());
        expect(await screen.findByText(/This paper lists you as a coauthor/)).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Confirm this revision' }));

        await waitFor(() => expect(state.published).toStrictEqual([{ kind: 'tag', target: 'did:cid:9', targetVersion: 'op-did:cid:9', tag: 'coauthor' }]));
        expect(await screen.findByText('Your confirmation is waiting to be anchored.')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Confirm this revision' })).toBeNull();

        // One who confirmed an earlier revision is told so, and one who has confirmed this is asked nothing.
        cleanup();
        state.coauthors['did:cid:9'] = [{ did: ALICE, status: 'confirmed-other' }];
        render(<App api={api} />);
        await user.click(await toOpen());
        expect(await screen.findByText(/You confirmed an earlier revision/)).toBeTruthy();

        cleanup();
        state.coauthors['did:cid:9'] = [{ did: ALICE, status: 'confirmed' }];
        render(<App api={api} />);
        await user.click(await toOpen());
        await screen.findByText('confirmed');
        expect(screen.queryByRole('button', { name: 'Confirm this revision' })).toBeNull();
    });

    it('reads how coauthors stand anew when the paper is, and asks of another revision what it asked of the last', async () => {
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        const { api, state } = services({ me: granted, timeline: [paper()] });
        state.coauthors['did:cid:9'] = [{ did: ALICE, status: 'listed' }];
        state.known['did:cid:9'] = paper();
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await toOpen());
        await user.click(await screen.findByRole('button', { name: 'Confirm this revision' }));
        expect(await screen.findByText('Your confirmation is waiting to be anchored.')).toBeTruthy();

        // The confirmation is anchored, with the paper as it was: it waits no more.
        state.coauthors['did:cid:9'] = [{ did: ALICE, status: 'confirmed' }];
        await user.click(screen.getByRole('button', { name: 'Refresh' }));
        await waitFor(() => expect(screen.queryByText('Your confirmation is waiting to be anchored.')).toBeNull());
        expect(await screen.findByText('confirmed')).toBeTruthy();

        // The reader takes it back, and is asked once more, with nothing said to be waiting.
        state.coauthors['did:cid:9'] = [{ did: ALICE, status: 'listed' }];
        await user.click(screen.getByRole('button', { name: 'Refresh' }));
        expect(await screen.findByRole('button', { name: 'Confirm this revision' })).toBeTruthy();
        expect(screen.queryByText('Your confirmation is waiting to be anchored.')).toBeNull();

        // Its publisher revises it. What was confirmed was the revision before.
        state.known['did:cid:9'] = paper({
            current: 1,
            versions: [...paper().versions, { opid: 'op-revised', type: 'update', outcome: 'attributed', position: { block: 2, time: '2026-11-22T12:00:00Z' } }],
        });
        state.coauthors['did:cid:9'] = [{ did: ALICE, status: 'confirmed-other' }];
        await user.click(screen.getByRole('button', { name: 'Refresh' }));

        expect(await screen.findByText(/You confirmed an earlier revision/)).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Confirm this revision' }));
        await waitFor(() => expect(state.published.slice(-1)[0]).toStrictEqual({ kind: 'tag', target: 'did:cid:9', targetVersion: 'op-revised', tag: 'coauthor' }));
    });

    it('is published with the PDF and the source chosen for it, which the service stores when they are chosen', async () => {
        const { api, state } = services({ me: granted });
        render(<App api={api} />);
        const user = userEvent.setup();
        const pdf = new File([new Uint8Array(2048)], 'replay.pdf', { type: 'application/pdf' });
        const tex = new File(['\\documentclass{article}'], 'replay.tex', { type: '' });

        await user.click(await screen.findByRole('button', { name: 'Write a paper' }));
        await user.type(screen.getByLabelText('Title'), 'Convergent Replay');
        await user.type(screen.getByLabelText('Abstract'), 'We show that nodes agree.');
        await user.type(screen.getByLabelText('Paper'), 'The full text.');
        await user.upload(screen.getByLabelText('PDF'), pdf);
        await user.upload(screen.getByLabelText('Source'), tex);

        // Each is stored as it is chosen, and named with its size.
        expect(await screen.findByText(/PDF: replay\.pdf \(2 kB\)/)).toBeTruthy();
        expect(await screen.findByText(/Source: replay\.tex/)).toBeTruthy();
        expect(vi.mocked(api.file).mock.calls.map(call => call[0])).toStrictEqual(['pdf', 'source']);

        // One chosen by mistake is taken off, and another chosen.
        await user.click(within(screen.getByText(/Source: replay\.tex/).closest('p')!).getByRole('button', { name: 'Remove' }));
        expect(screen.getByLabelText('Source')).toBeTruthy();

        await user.click(screen.getByRole('button', { name: 'Publish paper' }));
        await waitFor(() => expect(state.published).toStrictEqual([{
            kind: 'paper', title: 'Convergent Replay', body: 'The full text.', summary: 'We show that nodes agree.', authors: [ALICE],
            pdf: { cid: 'bafypdf', type: 'application/pdf', bytes: 2048 },
        }]));
    });

    it('stores no file that is too large, says why one was refused, and waits for one that is being stored', async () => {
        const { api } = services({ me: granted });
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await screen.findByRole('button', { name: 'Write a paper' }));
        await user.type(screen.getByLabelText('Title'), 'T');
        await user.type(screen.getByLabelText('Abstract'), 'A');
        await user.type(screen.getByLabelText('Paper'), 'B');

        const large = new File([''], 'large.pdf', { type: 'application/pdf' });
        Object.defineProperty(large, 'size', { value: 10_000_001 });
        await user.upload(screen.getByLabelText('PDF'), large);
        expect((await screen.findByRole('alert')).textContent).toBe('PDF may be 10 MB at most.');
        expect(api.file).not.toHaveBeenCalled();

        vi.mocked(api.file).mockRejectedValueOnce(new ApiError(400, 'not a PDF'));
        await user.upload(screen.getByLabelText('PDF'), new File(['x'], 'notes.pdf'));
        expect((await screen.findByRole('alert')).textContent).toBe('PDF was not stored: not a PDF');

        // While one is being stored the paper is not published without it.
        let stored!: (file: { cid: string; type: string; bytes: number }) => void;
        vi.mocked(api.file).mockImplementationOnce(() => new Promise(resolve => { stored = resolve; }));
        await user.upload(screen.getByLabelText('PDF'), new File(['x'], 'slow.pdf'));
        expect(await screen.findByText('Storing PDF…')).toBeTruthy();
        expect((screen.getByRole('button', { name: 'Publish paper' }) as HTMLButtonElement).disabled).toBe(true);
        stored({ cid: 'bafyslow', type: 'application/pdf', bytes: 1 });
        await waitFor(() => expect((screen.getByRole('button', { name: 'Publish paper' }) as HTMLButtonElement).disabled).toBe(false));
    });

    it('offers its PDF and its source as downloads once it is open, under its name, and shows neither', async () => {
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        const filed = paper({
            memeplex: {
                ...paper().memeplex!,
                pdf: { cid: 'bafypdf', type: 'application/pdf', bytes: 912_340 },
                source: { cid: 'bafysource', type: 'application/gzip', bytes: 84_112 },
            },
        });
        const { api } = services({ me: granted, timeline: [filed] });
        render(<App api={api} />);
        const user = userEvent.setup();

        // In a list a paper is its title and abstract.
        await screen.findByText('Convergent Replay');
        expect(screen.queryByRole('link', { name: /PDF/ })).toBeNull();

        await user.click((document.querySelector('article.post.opens') as HTMLElement));
        const pdf = await screen.findByRole('link', { name: 'PDF (912 kB)' });
        const source = screen.getByRole('link', { name: 'Source (84 kB)' });

        expect(pdf.getAttribute('href')).toBe('/api/v1/ipfs/stream/bafypdf?filename=convergent-replay.pdf');
        expect(pdf.getAttribute('download')).toBe('convergent-replay.pdf');
        expect(source.getAttribute('download')).toBe('convergent-replay.tar.gz');
        expect(document.querySelector('iframe, embed, object')).toBeNull();
    });

    it('offers no download of what a paper says of a file that is none', async () => {
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        const odd = paper({ memeplex: { ...paper().memeplex!, pdf: { cid: '../../version', type: 'application/pdf', bytes: 1 }, source: 'bafysource' } });
        const { api } = services({ me: granted, timeline: [odd] });
        render(<App api={api} />);

        await userEvent.setup().click(await toOpen());
        await screen.findByRole('button', { name: 'Back' });
        await waitFor(() => expect(api.thread).toHaveBeenCalled());
        expect(screen.queryByRole('link', { name: /PDF|Source/ })).toBeNull();
    });

    // A reply that gives a verdict is a review.
    it('is reviewed by a reply that gives a verdict, of the revision shown, and answered by one that gives none', async () => {
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        const { api, state } = services({ me: granted, timeline: [paper()] });
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await toOpen());
        await user.type(await screen.findByLabelText('Reply'), 'Section 4 assumes too much.');
        // With no verdict it is a reply.
        expect(screen.getByRole('button', { name: 'Publish' })).toBeTruthy();
        await user.type(screen.getByLabelText('Verdict'), '  minor revisions ');
        await user.click(screen.getByRole('button', { name: 'Publish review' }));

        await waitFor(() => expect(state.published).toStrictEqual([{
            kind: 'reply', target: 'did:cid:9', targetVersion: 'op-did:cid:9', text: 'Section 4 assumes too much.', verdict: 'minor revisions',
        }]));
        // It waits as a reply does, shown as the review it is, and the form is cleared for the next.
        const waiting = (await screen.findByText('Section 4 assumes too much.')).closest('article')!;

        expect(within(waiting).getByText('minor revisions')).toBeTruthy();
        expect(within(waiting).getByText('Review')).toBeTruthy();
        expect((screen.getByLabelText('Verdict') as HTMLInputElement).value).toBe('');

        // Once the service says which chain it waits on, it is still the review it was.
        state.states['did:cid:new1'] = { state: 'pending', registry: 'BTC:mainnet' };
        await user.click(screen.getByRole('button', { name: 'Refresh' }));
        const named = (await screen.findByText(/Waiting to be anchored on BTC:mainnet/)).closest('article')!;

        expect(within(named).getByText('minor revisions')).toBeTruthy();
        expect(JSON.parse(localStorage.getItem(`memepool.waiting.${ALICE}`)!)[0]).toMatchObject({ did: 'did:cid:new1', verdict: 'minor revisions', registry: 'BTC:mainnet' });

        await user.type(screen.getByLabelText('Reply'), 'A question, and no review.');
        await user.click(screen.getByRole('button', { name: 'Publish' }));
        await waitFor(() => expect(state.published[1]).toStrictEqual({
            kind: 'reply', target: 'did:cid:9', targetVersion: 'op-did:cid:9', text: 'A question, and no review.',
        }));
    });

    it('shows a review as one in its thread, and a reply as a reply', async () => {
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        const { api } = services({ me: granted, timeline: [paper()] });
        const answer = (did: string, text: string, more: Record<string, unknown> = {}) => ({
            depth: 1,
            publication: { ...post(did, CAROL, text), memeplex: { kind: 'reply', author: CAROL, text, target: 'did:cid:9', targetVersion: 'op-did:cid:9', ...more } },
        });
        vi.mocked(api.thread).mockResolvedValue([
            answer('did:cid:r1', 'The argument holds.', { verdict: 'accept' }),
            answer('did:cid:r2', 'Thanks for this.'),
            // A verdict is a stranger's words, and is shown as words.
            answer('did:cid:r3', 'See below.', { verdict: '<b>reject</b>' }),
        ]);
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await toOpen());
        const review = (await screen.findByText('The argument holds.')).closest('article')!;

        expect(within(review).getByText('accept')).toBeTruthy();
        expect(within(review).getByText('Review')).toBeTruthy();
        expect(within(screen.getByText('Thanks for this.').closest('article')!).queryByText('Review')).toBeNull();
        expect(screen.getByText('<b>reject</b>')).toBeTruthy();
        expect(document.querySelector('.verdict b')).toBeNull();
    });

    it('asks for no verdict where what is answered is no paper', async () => {
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        const { api } = services({ me: granted, timeline: [post('did:cid:1', BOB, 'A post.')] });
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await toOpen());
        await screen.findByLabelText('Reply');
        expect(screen.queryByLabelText('Verdict')).toBeNull();
    });

    it('asks no reader it does not list, nor one who is not signed in or whose grant allows no tag', async () => {
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        const unlisted = paper({ memeplex: { ...paper().memeplex!, authors: [BOB, CAROL] } });
        const { api, state } = services({ me: granted, timeline: [unlisted] });
        state.coauthors['did:cid:9'] = [{ did: CAROL, status: 'listed' }];
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await toOpen());
        await screen.findByText('listed by the publisher');
        expect(screen.queryByRole('button', { name: 'Confirm this revision' })).toBeNull();

        cleanup();
        const narrowed = services({ me: { ...granted, actions: ['memeplex:post'] }, timeline: [paper()] });
        narrowed.state.coauthors['did:cid:9'] = [{ did: ALICE, status: 'listed' }];
        render(<App api={narrowed.api} />);
        await user.click(await toOpen());
        await screen.findAllByText('listed by the publisher');
        expect(screen.queryByRole('button', { name: 'Confirm this revision' })).toBeNull();
    });

    it('says why a confirmation was refused, and asks once more', async () => {
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        const { api, state } = services({ me: granted, timeline: [paper()] });
        state.coauthors['did:cid:9'] = [{ did: ALICE, status: 'listed' }];
        vi.mocked(api.publish).mockRejectedValueOnce(new ApiError(403, 'no grant to publish under'));
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await toOpen());
        await user.click(await screen.findByRole('button', { name: 'Confirm this revision' }));

        expect((await screen.findByRole('alert')).textContent).toContain('no grant to publish under');
        expect(screen.getByRole('button', { name: 'Confirm this revision' })).toBeTruthy();
    });
});

describe('the earlier versions of a post', () => {
    const at = (block: number) => ({ block, time: `2026-11-2${block}T12:00:00Z` });
    // A post edited twice, and once more after its grant had ended. That last
    // edit was never attributed, and nothing after one that was not ever is.
    const edited = (): Publication => ({
        state: 'published',
        did: 'did:cid:1',
        current: 2,
        versions: [
            { opid: 'v1', type: 'create', outcome: 'attributed', position: at(1) },
            { opid: 'v2', type: 'update', outcome: 'attributed', position: at(2) },
            { opid: 'v3', type: 'update', outcome: 'attributed', position: at(3) },
            { opid: 'vx', type: 'update', outcome: 'unattributed' },
        ],
        memeplex: { kind: 'post', author: BOB, text: 'As it is.' },
    });
    const then = (text: string, current: number): Publication => ({ ...edited(), current, memeplex: { kind: 'post', author: BOB, text } });
    const answer = (did: string, text: string, version: string, depth = 1, target = 'did:cid:1') => ({
        depth,
        publication: { ...post(did, ALICE, text), memeplex: { kind: 'reply', author: ALICE, text, target, targetVersion: version } },
    });
    const made = (did: string, version: string, more: Record<string, unknown>) =>
        ({ ...post(did, ALICE, ''), memeplex: { kind: 'post', author: ALICE, target: 'did:cid:1', targetVersion: version, ...more } }) as Publication;

    // What is in sight: the latest is put out of sight while an earlier version is looked at.
    const seen = (text: string | RegExp) => screen.queryAllByText(text).filter(each => !each.closest('[hidden]'));
    const labelled = (label: string) => screen.queryAllByLabelText(label).filter(each => !each.closest('[hidden]'));

    async function opened() {
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        const services_ = services({ me: granted, timeline: [edited()] });

        services_.state.known['did:cid:1'] = edited();
        services_.state.revisions['did:cid:1 v1'] = then('As it was first.', 0);
        services_.state.revisions['did:cid:1 v2'] = then('As it was next.', 1);
        vi.mocked(services_.api.thread).mockResolvedValue([
            answer('did:cid:r1', 'To the first.', 'v1'),
            answer('did:cid:r1a', 'To that answer.', 'op-did:cid:r1', 2, 'did:cid:r1'),
            answer('did:cid:r2', 'To the second.', 'v2'),
            answer('did:cid:r3', 'To the latest.', 'v3'),
        ]);
        services_.state.responses = {
            boosts: [made('did:cid:b1', 'v1', {}), made('did:cid:b3', 'v3', {})],
            ratings: {
                ratings: [made('did:cid:g1', 'v1', { kind: 'rating', rating: 1, min: 0, max: 1 }), made('did:cid:g3', 'v3', { kind: 'rating', rating: 0, min: 0, max: 1 })],
                mean: 0.5,
            },
            tags: [
                { tag: 'draft', authors: [ALICE], applied: [{ did: 'did:cid:t1', author: ALICE, grant: 'did:cid:grant', version: 'v1' }] },
                { tag: 'final', authors: [ALICE], applied: [{ did: 'did:cid:t3', author: ALICE, grant: 'did:cid:grant', version: 'v3' }] },
            ],
        };
        render(<App api={services_.api} />);
        const user = userEvent.setup();

        await user.click(await toOpen());
        await screen.findByLabelText('Version');

        return { ...services_, user };
    }

    it('are what was made of the post at one of them, of all that was made of it', () => {
        const all: Responses = {
            boosts: [made('did:cid:b1', 'v1', {}), made('did:cid:b3', 'v3', {})],
            ratings: { ratings: [made('did:cid:g1', 'v1', { kind: 'rating', rating: 4, min: 1, max: 5 }), made('did:cid:g3', 'v3', { kind: 'rating', rating: 0, min: 0, max: 1 })], mean: 0.375 },
            tags: [
                { tag: 'a', authors: [ALICE, BOB], applied: [{ did: 'did:cid:t1', author: ALICE, grant: 'g', version: 'v1' }, { did: 'did:cid:t2', author: BOB, grant: 'g', version: 'v3' }] },
                { tag: 'b', authors: [ALICE], applied: [{ did: 'did:cid:t3', author: ALICE, grant: 'g', version: 'v3' }] },
                // A view that does not say which version tells nothing of one.
                { tag: 'c', authors: [ALICE] },
            ],
        };
        const first = responsesAt(all, 'v1');

        expect(first.boosts.map(each => each.did)).toStrictEqual(['did:cid:b1']);
        expect(first.ratings.ratings.map(each => each.did)).toStrictEqual(['did:cid:g1']);
        expect(first.ratings.mean).toBe(0.75);
        expect(first.tags).toStrictEqual([{ tag: 'a', authors: [ALICE], applied: [{ did: 'did:cid:t1', author: ALICE, grant: 'g', version: 'v1' }] }]);
        expect(responsesAt(all, 'v2')).toStrictEqual({ boosts: [], ratings: { ratings: [] }, tags: [] });
    });

    it('are offered for a post that was edited, each that was published and none that was not', async () => {
        await opened();

        const options = within(screen.getByLabelText('Version')).getAllByRole('option') as HTMLOptionElement[];

        expect(options.map(each => each.value)).toStrictEqual(['v1', 'v2', 'v3']);
        expect(options[2].textContent).toMatch(/^3 of 3.*\(latest\)$/);
        expect((screen.getByLabelText('Version') as HTMLSelectElement).value).toBe('v3');
    });

    it('show the post as it was, with the replies, ratings and tags made on that version and no others', async () => {
        const { api, user } = await opened();

        await user.selectOptions(screen.getByLabelText('Version'), 'v1');

        expect(await screen.findByText('As it was first.')).toBeTruthy();
        expect(api.revision).toHaveBeenCalledWith('did:cid:1', 'v1');
        expect(seen('As it is.')).toHaveLength(0);
        // The answers to that version, with what was said in answer to them.
        expect(screen.getByText('To the first.')).toBeTruthy();
        expect(screen.getByText('To that answer.')).toBeTruthy();
        expect(screen.queryByText('To the second.')).toBeNull();
        expect(screen.queryByText('To the latest.')).toBeNull();
        // What was made of it then.
        expect(await screen.findByText(/1 boost · rated 100% by 1/)).toBeTruthy();
        expect(screen.getByText(/draft 1/)).toBeTruthy();
        expect(screen.queryByText(/final/)).toBeNull();
        // Nothing is made of an earlier version from here, and nothing of it is changed.
        for (const name of ['Boost', 'Undo boost', 'Thumb up', 'Like', 'Add tag', 'Edit', 'Publish']) {
            expect([name, screen.queryByRole('button', { name })]).toStrictEqual([name, null]);
        }
        expect(labelled('Reply')).toHaveLength(0);

        await user.selectOptions(screen.getByLabelText('Version'), 'v2');
        expect(await screen.findByText('As it was next.')).toBeTruthy();
        expect(screen.getByText('To the second.')).toBeTruthy();
        expect(screen.queryByText('To the first.')).toBeNull();
        expect(await screen.findByText(/0 boosts · no ratings/)).toBeTruthy();

        await user.click(screen.getByRole('button', { name: 'Latest version' }));
        expect(await screen.findByText('As it is.')).toBeTruthy();
        expect(screen.getByLabelText('Reply')).toBeTruthy();
    });

    it('are all counted together where the latest is shown, until the reader asks for that version\'s alone', async () => {
        const { user } = await opened();
        const only = screen.getByLabelText('Only responses to this version') as HTMLInputElement;

        // An edit puts nothing out of sight: every answer, and all that was made of the post.
        expect(only.checked).toBe(false);
        expect(await screen.findByText(/2 boosts · rated 50% by 2/)).toBeTruthy();
        for (const text of ['To the first.', 'To that answer.', 'To the second.', 'To the latest.']) {
            expect([text, seen(text)]).toStrictEqual([text, [expect.anything()]]);
        }
        expect(screen.getByText(/draft 1/)).toBeTruthy();

        await user.click(only);

        // What was made of the latest, and no other: its one answer, boost, rating and tag.
        expect(await screen.findByText(/1 boost · rated 0% by 1/)).toBeTruthy();
        expect(seen('To the latest.')).toHaveLength(1);
        for (const text of ['To the first.', 'To that answer.', 'To the second.']) {
            expect([text, seen(text)]).toStrictEqual([text, []]);
        }
        expect(screen.getByText(/final 1/)).toBeTruthy();
        // A tag of an earlier version is not counted, and is still the reader's to take off.
        expect(screen.queryByText(/draft 1/)).toBeNull();
        expect(screen.getByRole('button', { name: 'Remove tag draft' })).toBeTruthy();
        // It is still the latest: the reader may answer it and make of it what they will.
        expect(labelled('Reply')).toHaveLength(1);
        expect(screen.getByRole('button', { name: 'Boost' })).toBeTruthy();

        await user.click(only);
        expect(await screen.findByText(/2 boosts · rated 50% by 2/)).toBeTruthy();
        expect(seen('To the first.')).toHaveLength(1);
    });

    it('leave what the reader made of an earlier one theirs to change, though only the latest\'s are counted', async () => {
        const { api, state, user } = await opened();
        const mine = (did: string, version: string, more: Record<string, unknown>) => under(made(did, version, more), 'did:cid:grant');

        // The reader rated, boosted and tagged the first version.
        state.responses = {
            boosts: [mine('did:cid:b1', 'v1', {})],
            ratings: { ratings: [mine('did:cid:g1', 'v1', { kind: 'rating', rating: 1, min: 0, max: 1 })], mean: 1 },
            tags: [{ tag: 'draft', authors: [ALICE], applied: [{ did: 'did:cid:t1', author: ALICE, grant: 'did:cid:grant', version: 'v1' }] }],
        };
        await user.click(screen.getByRole('button', { name: 'Refresh counts' }));
        await screen.findByRole('button', { name: 'Undo boost' });

        await user.click(screen.getByLabelText('Only responses to this version'));
        // None of it is of the latest, so none is counted.
        expect(await screen.findByText(/0 boosts · no ratings/)).toBeTruthy();
        // It is still theirs: a thumb changes their rating and makes no second, and the rest is theirs to take back.
        await user.click(screen.getByRole('button', { name: 'Thumb down' }));
        await waitFor(() => expect(api.edit).toHaveBeenCalledWith('did:cid:g1', expect.objectContaining({ kind: 'rating', rating: 0 })));
        expect(state.published).toHaveLength(0);
        expect(screen.getByRole('button', { name: 'Undo boost' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Remove tag draft' })).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Boost' })).toBeNull();
    });

    it('are opened with what was made of them alone, and shown with all that was made of the post where the reader asks', async () => {
        const { user } = await opened();

        await user.selectOptions(screen.getByLabelText('Version'), 'v1');
        const only = screen.getByLabelText('Only responses to this version') as HTMLInputElement;

        await screen.findByText('As it was first.');
        expect(only.checked).toBe(true);
        expect(seen('To the second.')).toHaveLength(0);

        await user.click(only);

        // The post as it was, with every answer: one to another version says so.
        expect(seen('As it was first.')).toHaveLength(1);
        expect(await screen.findByText(/2 boosts · rated 50% by 2/)).toBeTruthy();
        const later = seen('To the latest.')[0].closest('article')!.parentElement!;

        expect(within(later).getByText(/This answered another version/)).toBeTruthy();
        expect(within(seen('To the first.')[0].closest('article')!.parentElement!).queryByText(/another version/)).toBeNull();
        // Nothing is made of an earlier version, however its responses are shown.
        expect(screen.queryByRole('button', { name: 'Boost' })).toBeNull();
        expect(labelled('Reply')).toHaveLength(0);

        // An answer to the latest leads to the latest, with all of them once more.
        await user.click(within(later).getByRole('button', { name: 'See that version' }));
        await waitFor(() => expect(seen('As it is.')).toHaveLength(1));
        expect((screen.getByLabelText('Only responses to this version') as HTMLInputElement).checked).toBe(false);
    });

    it('are named on the answers made to them, where the latest is shown, and reached from there', async () => {
        const { user } = await opened();

        // Every answer is in the thread, whichever version it answered.
        const first = (await screen.findByText('To the first.')).closest('article')!.parentElement!;
        const latest = screen.getByText('To the latest.').closest('article')!.parentElement!;

        expect(within(first).getByText(/This answered an earlier version/)).toBeTruthy();
        expect(within(latest).queryByText(/This answered an earlier version/)).toBeNull();
        // An answer to an answer is to that answer, and is marked as none.
        expect(within(screen.getByText('To that answer.').closest('article')!.parentElement!).queryByText(/earlier version/)).toBeNull();

        await user.click(within(first).getByRole('button', { name: 'See that version' }));
        expect(await screen.findByText('As it was first.')).toBeTruthy();
        expect((screen.getByLabelText('Version') as HTMLSelectElement).value).toBe('v1');
    });

    it('say when one is no longer in the history, or could not be read', async () => {
        const { api, state, user } = await opened();

        delete state.revisions['did:cid:1 v1'];
        await user.selectOptions(screen.getByLabelText('Version'), 'v1');
        expect(await screen.findByText('That version is no longer in its history.')).toBeTruthy();

        vi.mocked(api.revision).mockRejectedValueOnce(new Error('no indexer'));
        await user.selectOptions(screen.getByLabelText('Version'), 'v2');
        expect((await screen.findByRole('alert')).textContent).toBe('That version could not be read.');
    });

    it('say of a version an answer names that is not in the history that it is not, and show no other in its place', async () => {
        const { api, user } = await opened();

        vi.mocked(api.thread).mockResolvedValue([answer('did:cid:r9', 'To one that is gone.', 'vgone')]);
        await user.click(screen.getByRole('button', { name: 'Refresh' }));

        const gone = (await screen.findByText('To one that is gone.')).closest('article')!.parentElement!;

        await user.click(within(gone).getByRole('button', { name: 'See that version' }));
        expect(await screen.findByText('That version is no longer in its history.')).toBeTruthy();
        // The latest is not shown as though it were that version, and nothing is made of it from here.
        expect(seen('As it is.')).toHaveLength(0);
        expect(labelled('Reply')).toHaveLength(0);
        expect((screen.getByLabelText('Version') as HTMLSelectElement).value).toBe('vgone');
    });

    it('keep what the reader made of the latest while an earlier one is looked at', async () => {
        const { api, state, user } = await opened();

        // A rating of the latest, which waits to be anchored.
        await user.click(await screen.findByRole('button', { name: 'Thumb up' }));
        await waitFor(() => expect(state.published).toHaveLength(1));
        expect(await screen.findByText('Your thumb up is waiting to be anchored.')).toBeTruthy();

        await user.selectOptions(screen.getByLabelText('Version'), 'v1');
        await screen.findByText('As it was first.');
        await user.click(screen.getByRole('button', { name: 'Latest version' }));
        await screen.findByText('As it is.');

        // It is still the reader's rating: another thumb changes it, and makes no second.
        expect(screen.getByText('Your thumb up is waiting to be anchored.')).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Thumb down' }));
        await waitFor(() => expect(api.edit).toHaveBeenCalledWith('did:cid:new1', expect.objectContaining({ kind: 'rating', rating: 0 })));
        expect(state.published).toHaveLength(1);
    });

    it('show the reader\'s own answer to one as an edit of theirs that waits leaves it', async () => {
        const { state, user } = await opened();

        // The reader has edited their answer to the first version, and the edit waits.
        state.unanchored['did:cid:r1'] = { versionId: 'op-edit', memeplex: { kind: 'reply', author: ALICE, text: 'To the first, reworded.', target: 'did:cid:1', targetVersion: 'v1' } };
        await user.click(screen.getByRole('button', { name: 'Refresh' }));
        await screen.findByText('To the first, reworded.');

        await user.selectOptions(screen.getByLabelText('Version'), 'v1');
        await screen.findByText('As it was first.');
        const mine = (await screen.findByText('To the first, reworded.')).closest('article')!;

        expect(within(mine).getByText('Edit waiting to be anchored')).toBeTruthy();
        expect(screen.queryByText('To the first.')).toBeNull();
    });

    it('keep what the reader was writing of the latest, and what they confirmed, while an earlier one is looked at', async () => {
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        const authored = (current: number): Publication => ({
            ...edited(), current,
            memeplex: { kind: 'paper', author: BOB, title: 'The paper', summary: 'About it.', authors: [BOB, ALICE], content: { cid: 'bafypaper', type: 'text/markdown', bytes: 3 } },
        });
        const { api, state } = services({ me: granted, timeline: [authored(2)] });

        state.known['did:cid:1'] = authored(2);
        state.revisions['did:cid:1 v1'] = authored(0);
        state.coauthors['did:cid:1'] = [{ did: ALICE, status: 'listed' }];
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await toOpen());
        // A confirmation that waits, and a review half written.
        await user.click(await screen.findByRole('button', { name: 'Confirm this revision' }));
        await screen.findByText('Your confirmation is waiting to be anchored.');
        await user.type(screen.getByLabelText('Reply'), 'Half a review');
        await user.type(screen.getByLabelText('Verdict'), 'accept');

        await user.selectOptions(screen.getByLabelText('Version'), 'v1');
        await waitFor(() => expect(labelled('Reply')).toHaveLength(0));
        await user.click(screen.getByRole('button', { name: 'Latest version' }));

        // Neither is lost, and the paper is not offered for confirming a second time.
        expect((screen.getByLabelText('Reply') as HTMLTextAreaElement).value).toBe('Half a review');
        expect((screen.getByLabelText('Verdict') as HTMLInputElement).value).toBe('accept');
        expect(seen('Your confirmation is waiting to be anchored.')).toHaveLength(1);
        expect(screen.queryByRole('button', { name: 'Confirm this revision' })).toBeNull();
        expect(state.published.filter(each => each.kind === 'tag')).toHaveLength(1);
    });

    it('keep an edit the reader was making of the latest while an earlier one is looked at', async () => {
        localStorage.setItem('memepool.follows', JSON.stringify([ALICE]));
        const mine = { ...edited(), memeplex: { kind: 'post', author: ALICE, text: 'As it is.', grant: 'did:cid:grant' } };
        const { api, state } = services({ me: granted, timeline: [mine] });

        state.known['did:cid:1'] = mine;
        state.revisions['did:cid:1 v1'] = { ...mine, current: 0, memeplex: { ...mine.memeplex, text: 'As it was first.' } };
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await toOpen());
        await user.click(await screen.findByRole('button', { name: 'Edit' }));
        await user.type(screen.getByLabelText('Edit'), ' And more.');

        await user.selectOptions(screen.getByLabelText('Version'), 'v1');
        await screen.findByText('As it was first.');
        expect(labelled('Edit')).toHaveLength(0);
        await user.click(screen.getByRole('button', { name: 'Latest version' }));

        expect((screen.getByLabelText('Edit') as HTMLTextAreaElement).value).toBe('As it is. And more.');
    });

    it('say nothing of how a paper\'s coauthors stand on an earlier revision, which is known of its latest', async () => {
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        const authored = (text: string, current: number): Publication => ({
            ...edited(), current,
            memeplex: { kind: 'paper', author: BOB, title: text, summary: 'About it.', authors: [BOB, ALICE], content: { cid: 'bafypaper', type: 'text/markdown', bytes: 3 } },
        });
        const { api, state } = services({ me: granted, timeline: [authored('The paper', 2)] });

        state.known['did:cid:1'] = authored('The paper', 2);
        state.revisions['did:cid:1 v1'] = authored('The paper, first', 0);
        state.coauthors['did:cid:1'] = [{ did: ALICE, status: 'confirmed' }];
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await toOpen());
        expect(await screen.findByText('confirmed')).toBeTruthy();
        const asked = vi.mocked(api.coauthors).mock.calls.length;

        await user.selectOptions(await screen.findByLabelText('Version'), 'v1');
        expect(await screen.findByText('The paper, first')).toBeTruthy();
        // Its authors are named, and nothing is said or asked of what they confirmed.
        expect([...document.querySelectorAll('.authors li')].filter(each => !each.closest('[hidden]'))).toHaveLength(2);
        expect(seen('confirmed')).toHaveLength(0);
        expect(screen.queryByRole('button', { name: 'Confirm this revision' })).toBeNull();
        expect(api.coauthors).toHaveBeenCalledTimes(asked);
    });

    it('are not offered for a post that was never edited, which is not marked as edited', async () => {
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        const { api } = services({ me: granted, timeline: [post('did:cid:1', BOB, 'A post.'), edited()] });
        render(<App api={api} />);
        const user = userEvent.setup();

        // In a list, one that was edited says so.
        const plain = (await screen.findByText('A post.')).closest('article')!;

        expect(within(plain).queryByText('edited')).toBeNull();
        expect(within(screen.getByText('As it is.').closest('article')!).getByText('edited')).toBeTruthy();

        await user.click(plain);
        await screen.findByRole('button', { name: 'Back' });
        await waitFor(() => expect(api.thread).toHaveBeenCalled());
        expect(screen.queryByLabelText('Version')).toBeNull();
    });
});

describe('editing', () => {
    it('rewrites the reader\'s own reply, keeping what it answers', async () => {
        const mine = under({ ...post('did:cid:1', ALICE, 'A reply.'), memeplex: { kind: 'reply', author: ALICE, text: 'A reply.', target: 'did:cid:0', targetVersion: 'op-0', v: 1 } }, 'did:cid:grant');
        const { api, state } = services({ me: granted, timeline: [mine] });
        render(<App api={api} />);
        const user = userEvent.setup();

        // A reply is found among the reader's own replies, and not in the timeline.
        await screen.findByRole('button', { name: 'Sign out' });
        await user.click(within(document.querySelector('header.top') as HTMLElement).getByRole('button', { name: /did:cid/ }));
        await user.click(await screen.findByRole('tab', { name: 'Replies' }));
        await user.click((await screen.findByText('A reply.')).closest('article')!);
        await user.click(await screen.findByRole('button', { name: 'Edit' }));
        await user.clear(screen.getByLabelText('Edit'));
        await user.type(screen.getByLabelText('Edit'), 'A better reply.');
        await user.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(state.edited).toStrictEqual([
            { did: 'did:cid:1', object: { kind: 'reply', target: 'did:cid:0', targetVersion: 'op-0', text: 'A better reply.' } },
        ]));
        expect(await screen.findByText(/Your edit is waiting to be anchored/)).toBeTruthy();
        // One edit at a time, and the post is as it was until the edit is anchored.
        expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
        expect(screen.getByText('A reply.')).toBeTruthy();

        vi.mocked(api.publication).mockResolvedValue({ ...mine, current: 1, memeplex: { ...mine.memeplex!, text: 'A better reply.' } });
        await user.click(screen.getByRole('button', { name: 'Refresh' }));

        expect(await screen.findByText('A better reply.')).toBeTruthy();
        await waitFor(() => expect(screen.queryByText(/Your edit is waiting to be anchored/)).toBeNull());
        await user.click(screen.getByRole('button', { name: 'Edit' }));
        expect((screen.getByLabelText('Edit') as HTMLTextAreaElement).value).toBe('A better reply.');
    });

    // The page may be read anew, or the post left and come back to, while an
    // edit waits: only the node still knows of the edit.
    it('shows an edit that waits, and offers no other, when the post is opened once the page has forgotten it', async () => {
        const mine = under({ ...post('did:cid:1', ALICE, ''), memeplex: { kind: 'post', author: ALICE, title: 'On DIDs', content: { cid: 'bafyold', type: 'text/markdown', bytes: 9 } } }, 'did:cid:grant');
        const { api, state } = services({ me: granted, timeline: [mine] });
        state.bodies.bafyold = 'The old text.';
        state.bodies.bafynew = 'The new text, with an image.';
        state.unanchored['did:cid:1'] = {
            versionId: 'op-edit',
            memeplex: { ...mine.memeplex!, title: 'On DIDs, again', content: { cid: 'bafynew', type: 'text/markdown', bytes: 28 } },
        };
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await toOpen());

        // The author is shown the post as their edit leaves it, marked as waiting.
        expect(await screen.findByText(/Your edit is waiting to be anchored/)).toBeTruthy();
        expect(await screen.findByText('The new text, with an image.')).toBeTruthy();
        expect(screen.getByText('On DIDs, again')).toBeTruthy();
        expect(screen.getByText('Edit waiting to be anchored')).toBeTruthy();
        expect(screen.queryByText('The old text.')).toBeNull();
        // An edit made over it would be of the old text, and would undo it.
        expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();

        // Once the indexer shows that version, the edit waits no more.
        vi.mocked(api.publication).mockResolvedValue({
            ...mine, current: 1,
            versions: [...mine.versions, { opid: 'op-edit', type: 'update', outcome: 'attributed', position: { block: 2, time: '2026-11-22T12:00:00Z' } }],
            memeplex: state.unanchored['did:cid:1'].memeplex,
        });
        await user.click(screen.getByRole('button', { name: 'Refresh' }));

        await waitFor(() => expect(screen.queryByText(/Your edit is waiting to be anchored/)).toBeNull());
        expect(screen.queryByText('Edit waiting to be anchored')).toBeNull();
        expect(await screen.findByRole('button', { name: 'Edit' })).toBeTruthy();
    });

    it('takes for waiting a version the indexer says is pending, and not one it says will not be published', async () => {
        const edit = { versionId: 'op-edit', memeplex: { kind: 'post', author: ALICE, text: 'As I left it.', grant: 'did:cid:grant' } };
        const mine = under(post('did:cid:1', ALICE, 'As it was.'), 'did:cid:grant');
        const read = (outcome: string) => ({ ...mine, versions: [...mine.versions, { opid: 'op-edit', type: 'update', outcome }] }) as Publication;
        const { api, state } = services({ me: granted, timeline: [read('pending')] });
        state.unanchored['did:cid:1'] = edit;
        render(<App api={api} />);

        expect(await screen.findByText('As I left it.')).toBeTruthy();
        expect(screen.getByText('Edit waiting to be anchored')).toBeTruthy();

        cleanup();
        state.timeline = [read('unattributed')];
        render(<App api={api} />);
        expect(await screen.findByText('As it was.')).toBeTruthy();
        await waitFor(() => expect(api.unanchored).toHaveBeenCalledTimes(2));
        expect(screen.queryByText('Edit waiting to be anchored')).toBeNull();
        expect(screen.queryByText('As I left it.')).toBeNull();
    });

    it('lists the reader\'s own post as an edit that waits leaves it, marked as waiting, and another\'s as it is', async () => {
        const mine = under(post('did:cid:1', ALICE, 'As it was.'), 'did:cid:grant');
        const theirs = post('did:cid:2', BOB, 'From Bob.');
        const { api, state } = services({ me: granted, timeline: [mine, theirs] });
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        state.unanchored['did:cid:1'] = { versionId: 'op-edit', memeplex: { ...mine.memeplex!, text: 'As I left it.' } };
        // The node has more of another's post than the indexer shows, which is not the reader's to see.
        state.unanchored['did:cid:2'] = { versionId: 'op-other', memeplex: { ...theirs.memeplex!, text: 'Not yet.' } };
        render(<App api={api} />);

        const article = (await screen.findByText('As I left it.')).closest('article')!;

        expect(within(article).getByText('Edit waiting to be anchored')).toBeTruthy();
        expect(screen.queryByText('As it was.')).toBeNull();
        expect(screen.getByText('From Bob.')).toBeTruthy();
        expect(screen.queryByText('Not yet.')).toBeNull();
        expect(api.unanchored).not.toHaveBeenCalledWith('did:cid:2');
    });

    it('asks the node for nothing of another\'s post, and shows no edit where the node has the version shown', async () => {
        const theirs = post('did:cid:2', BOB, 'From Bob.');
        const mine = under(post('did:cid:1', ALICE, 'A post.'), 'did:cid:grant');
        const { api, state } = services({ me: granted, timeline: [theirs, mine] });
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        state.unanchored['did:cid:1'] = { versionId: 'op-did:cid:1', memeplex: mine.memeplex! };
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click((await screen.findByText('From Bob.')).closest('article')!);
        await screen.findByRole('button', { name: 'Back' });
        expect(api.unanchored).not.toHaveBeenCalledWith('did:cid:2');

        await user.click(screen.getByRole('button', { name: 'Back' }));
        await user.click((await screen.findByText('A post.')).closest('article')!);
        expect(await screen.findByRole('button', { name: 'Edit' })).toBeTruthy();
        expect(api.unanchored).toHaveBeenCalledWith('did:cid:1');
        expect(screen.queryByText(/Your edit is waiting to be anchored/)).toBeNull();
    });

    it('opens the reader\'s post when the node cannot say what it has, and offers no edit until it can', async () => {
        const mine = under(post('did:cid:1', ALICE, 'A post.'), 'did:cid:grant');
        const { api, state } = services({ me: granted, timeline: [mine] });
        vi.mocked(api.unanchored).mockRejectedValue(new Error('no node'));
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await toOpen());

        expect(await screen.findByRole('button', { name: 'Back' })).toBeTruthy();
        await waitFor(() => expect(api.thread).toHaveBeenCalled());
        expect(screen.getByText('A post.')).toBeTruthy();
        expect(screen.queryByRole('alert')).toBeNull();
        // An edit may be waiting that the node has not told of.
        expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();

        state.unanchored['did:cid:1'] = { versionId: 'op-did:cid:1', memeplex: mine.memeplex! };
        vi.mocked(api.unanchored).mockImplementation(async did => state.unanchored[did]);
        await user.click(screen.getByRole('button', { name: 'Refresh' }));
        expect(await screen.findByRole('button', { name: 'Edit' })).toBeTruthy();
    });

    it('shows the thread, and offers the edit, though the node is slow to give a reply of the reader\'s', async () => {
        const mine = under(post('did:cid:1', ALICE, 'A post.'), 'did:cid:grant');
        const reply = under({ ...post('did:cid:3', ALICE, 'A reply.'), memeplex: { kind: 'reply', author: ALICE, text: 'A reply.', target: 'did:cid:1', targetVersion: 'op-did:cid:1' } }, 'did:cid:grant');
        const { api } = services({ me: granted, timeline: [mine] });
        const node = vi.mocked(api.unanchored).getMockImplementation()!;
        vi.mocked(api.unanchored).mockImplementation(did => (did === 'did:cid:3' ? new Promise(() => undefined) : node(did)));
        vi.mocked(api.thread).mockResolvedValue([{ publication: reply, depth: 1 }]);
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await toOpen());

        expect(await screen.findByText('A reply.')).toBeTruthy();
        expect(await screen.findByRole('button', { name: 'Edit' })).toBeTruthy();
        expect(screen.queryByText('Loading replies…')).toBeNull();
    });

    it('shows nothing the node gives that is not the same object, or that the pages cannot show, and offers no edit over it', async () => {
        const mine = under(post('did:cid:1', ALICE, 'A post.'), 'did:cid:grant');
        const { api, state } = services({ me: granted, timeline: [mine] });
        // Another's, or another kind of object, at a version the indexer has not read.
        state.unanchored['did:cid:1'] = { versionId: 'op-edit', memeplex: { ...mine.memeplex!, author: BOB, text: 'Not mine.' } };
        render(<App api={api} />);
        const user = userEvent.setup();

        await screen.findByText('A post.');
        await waitFor(() => expect(api.unanchored).toHaveBeenCalledWith('did:cid:1'));
        expect(screen.queryByText('Not mine.')).toBeNull();
        expect(screen.queryByText('Edit waiting to be anchored')).toBeNull();

        await user.click((document.querySelector('article.post.opens') as HTMLElement));
        await screen.findByRole('button', { name: 'Back' });
        await waitFor(() => expect(api.thread).toHaveBeenCalled());
        expect(screen.getByText('A post.')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    });

    it('asks the node about each of the reader\'s posts once as older ones are listed, and anew when the list is read from its start', async () => {
        const posts = Array.from({ length: 60 }, (_, at) => under(post(`did:cid:${at + 1}`, ALICE, `Post ${at + 1}.`), 'did:cid:grant'));
        const { api } = services({ me: granted, timeline: posts });
        render(<App api={api} />);
        const user = userEvent.setup();

        await screen.findByText('Post 1.');
        await waitFor(() => expect(api.unanchored).toHaveBeenCalledTimes(50));
        await user.click(await screen.findByRole('button', { name: /older/i }));
        await screen.findByText('Post 60.');
        await waitFor(() => expect(api.unanchored).toHaveBeenCalledTimes(60));

        await user.click(screen.getByRole('button', { name: 'Refresh' }));
        await waitFor(() => expect(api.unanchored).toHaveBeenCalledTimes(110));
    });

    it('lists each waiting edit as the node gives it, and opens the post as it is anchored where nothing more can be read', async () => {
        const one = under(post('did:cid:1', ALICE, 'One, as it was.'), 'did:cid:grant');
        const two = under(post('did:cid:2', ALICE, 'Two, as it was.'), 'did:cid:grant');
        const { api, state } = services({ me: granted, timeline: [one, two] });
        const node = vi.mocked(api.unanchored).getMockImplementation()!;
        state.unanchored['did:cid:2'] = { versionId: 'op-edit', memeplex: { ...two.memeplex!, text: 'Two, as I left it.' } };
        // The node never answers for the first.
        vi.mocked(api.unanchored).mockImplementation(did => (did === 'did:cid:1' ? new Promise(() => undefined) : node(did)));
        render(<App api={api} />);
        const user = userEvent.setup();

        const article = (await screen.findByText('Two, as I left it.')).closest('article')!;

        expect(screen.getByText('One, as it was.')).toBeTruthy();

        // Opened where the indexer and the node can say nothing more, it is what is anchored.
        vi.mocked(api.publication).mockResolvedValue(undefined);
        vi.mocked(api.unanchored).mockRejectedValue(new Error('no node'));
        await user.click(article);
        await screen.findByRole('button', { name: 'Back' });
        await waitFor(() => expect(api.thread).toHaveBeenCalledWith('did:cid:2'));
        expect(await screen.findByText('Two, as it was.')).toBeTruthy();
        expect(screen.queryByText('Two, as I left it.')).toBeNull();
    });

    it('saves nothing from an editor that was open when an edit was found to be waiting', async () => {
        const mine = under(post('did:cid:1', ALICE, 'A post.'), 'did:cid:grant');
        const { api, state } = services({ me: granted, timeline: [mine] });
        state.unanchored['did:cid:1'] = { versionId: 'op-did:cid:1', memeplex: mine.memeplex! };
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await toOpen());
        await user.click(await screen.findByRole('button', { name: 'Edit' }));
        await user.type(screen.getByLabelText('Edit'), ' More.');
        expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false);

        // An edit made elsewhere is found, of the version this editor was opened on.
        state.unanchored['did:cid:1'] = { versionId: 'op-edit', memeplex: { ...mine.memeplex!, text: 'Edited elsewhere.' } };
        await user.click(screen.getByRole('button', { name: 'Refresh' }));

        expect(await screen.findByText(/another cannot be saved until it is/)).toBeTruthy();
        expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
        // What was written is still there, to keep.
        expect((screen.getByLabelText('Edit') as HTMLTextAreaElement).value).toBe('A post. More.');
        expect(state.edited).toStrictEqual([]);
    });

    it('shows the author their post as an edit leaves it though another client made the post, and their reply in another\'s thread', async () => {
        // Under a grant that is not this service's, so the post is not theirs to change here.
        const elsewhere = under(post('did:cid:1', ALICE, 'As it was.'), 'did:cid:other-grant');
        const theirs = post('did:cid:2', BOB, 'From Bob.');
        const reply = under({ ...post('did:cid:3', ALICE, 'A reply.'), memeplex: { kind: 'reply', author: ALICE, text: 'A reply.', target: 'did:cid:2', targetVersion: 'op-did:cid:2' } }, 'did:cid:grant');
        const { api, state } = services({ me: granted, timeline: [elsewhere, theirs] });
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        state.unanchored['did:cid:1'] = { versionId: 'op-edit', memeplex: { ...elsewhere.memeplex!, text: 'As I left it.' } };
        state.unanchored['did:cid:3'] = { versionId: 'op-reply-edit', memeplex: { ...reply.memeplex!, text: 'A better reply.' } };
        vi.mocked(api.thread).mockImplementation(async did => (did === 'did:cid:2' ? [{ publication: reply, depth: 1 }] : []));
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click((await screen.findByText('As I left it.')).closest('article')!);
        await screen.findByRole('button', { name: 'Back' });
        await waitFor(() => expect(api.thread).toHaveBeenCalledWith('did:cid:1'));
        expect(await screen.findByText('As I left it.')).toBeTruthy();
        expect(screen.getByText('Edit waiting to be anchored')).toBeTruthy();

        await user.click(screen.getByRole('button', { name: 'Back' }));
        await user.click((await screen.findByText('From Bob.')).closest('article')!);
        const answer = (await screen.findByText('A better reply.')).closest('article')!;

        expect(within(answer).getByText('Edit waiting to be anchored')).toBeTruthy();
        expect(screen.queryByText('A reply.')).toBeNull();
    });

    it('offers no edit of a post that a refresh shows was withdrawn', async () => {
        const mine = under(post('did:cid:1', ALICE, 'A post.'), 'did:cid:grant');
        const { api } = services({ me: granted, timeline: [mine] });
        render(<App api={api} />);
        const user = userEvent.setup();

        await user.click(await toOpen());
        await screen.findByRole('button', { name: 'Edit' });

        vi.mocked(api.publication).mockResolvedValue({ ...mine, state: 'withdrawn' });
        await user.click(screen.getByRole('button', { name: 'Refresh' }));

        await waitFor(() => expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull());
    });

    it('offers no edit of another author\'s post, or of one published through another client', async () => {
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        const { api } = services({ me: granted, timeline: [under(post('did:cid:2', BOB, 'Bob\'s.'), 'did:cid:bobs')] });
        render(<App api={api} />);

        await userEvent.setup().click(await toOpen());
        await screen.findByRole('button', { name: 'Boost' });

        expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    });
});

describe('the address of what is shown', () => {
    const both = () => [post('did:cid:1', ALICE, 'From Alice.'), post('did:cid:2', BOB, 'From Bob.')];
    const lastRead = (api: Api) => vi.mocked(api.timeline).mock.calls.slice(-1)[0];
    const at = (hash: string) => window.history.replaceState(null, '', `/${hash}`);
    const go = (hash: string) => {
        window.history.pushState(null, '', `/${hash}`);
        fireEvent(window, new PopStateEvent('popstate'));
    };

    it('names a publication or an author, and nothing else', () => {
        const at = (pathname: string) => routeOf({ pathname });

        expect(at(`/p/${BOB}`)).toStrictEqual({ publication: BOB });
        expect(at(`/a/${BOB}`)).toStrictEqual({ author: BOB, list: 'posts' });
        expect(at(`/a/${BOB}/replies`)).toStrictEqual({ author: BOB, list: 'replies' });
        expect(at(`/a/${BOB}/articles`)).toStrictEqual({ author: BOB, list: 'articles' });
        expect(at(`/a/${BOB}/papers`)).toStrictEqual({ author: BOB, list: 'papers' });
        // A DID's own part may be written encoded, as an address may be.
        expect(at(`/p/${encodeURIComponent(BOB)}`)).toStrictEqual({ publication: BOB });
        for (const path of ['/', '/p/', '/p/not-a-did', `/x/${BOB}`, `/p/${BOB}/replies`, `/a/${BOB}/posts`, `/a/${BOB}/replies/more`, '/p/did:cid:<b>', '/p/%E0%A4%A', '/assets/index.js']) {
            expect([path, at(path)]).toStrictEqual([path, null]);
        }

        // An address is read back as the route it was made from.
        // A DID's own part may have colons in it.
        for (const route of [{ publication: BOB }, { author: BOB, list: 'posts' as const }, { author: BOB, list: 'articles' as const }, { author: BOB, list: 'papers' as const }, { author: BOB, list: 'replies' as const }, { publication: 'did:web:example.org:users:alice' }]) {
            expect(at(pathOf(route))).toStrictEqual(route);
        }
        expect(pathOf(null)).toBe('/');
        expect(linkTo({ publication: BOB }, { origin: 'https://node.example' })).toBe(`https://node.example/p/${BOB}`);

    });

    it('is under the path the pages are served at, wherever that is', () => {
        setRoot('/memepool/');
        try {
            expect(pathOf({ publication: BOB })).toBe(`/memepool/p/${BOB}`);
            expect(pathOf(null)).toBe('/memepool/');
            expect(routeOf({ pathname: `/memepool/a/${BOB}/replies` })).toStrictEqual({ author: BOB, list: 'replies' });
            // A path that is not under the pages' own names nothing.
            expect(routeOf({ pathname: `/p/${BOB}` })).toBeNull();
            expect(linkTo({ author: BOB }, { origin: 'https://node.example' })).toBe(`https://node.example/memepool/a/${BOB}`);
        }
        finally {
            setRoot('/');
        }
    });

    it('opens the publication a link names, of whatever kind, for a reader who follows nobody', async () => {
        const { api, state } = services({ me: granted, timeline: both() });
        state.known['did:cid:2'] = post('did:cid:2', BOB, 'From Bob.');
        at('p/did:cid:2');
        render(<App api={api} />);

        expect(await screen.findByRole('button', { name: 'Back' })).toBeTruthy();
        expect(screen.getByText('From Bob.')).toBeTruthy();
        expect(screen.queryByText('From Alice.')).toBeNull();
        await waitFor(() => expect(api.thread).toHaveBeenCalledWith('did:cid:2'));
        // The link is still the address of what is shown.
        expect(window.location.pathname).toBe('/p/did:cid:2');
    });

    it('shows the author a link names, and the author\'s replies where it names them', async () => {
        const { api } = services({ me: granted, timeline: both() });
        at(`a/${BOB}`);
        render(<App api={api} />);

        expect(await screen.findByText('From Bob.')).toBeTruthy();
        expect(screen.queryByText('From Alice.')).toBeNull();
        expect(lastRead(api)).toStrictEqual([[BOB], 0, ['post'], false]);

        cleanup();
        at(`a/${BOB}/replies`);
        render(<App api={api} />);
        expect(await screen.findByRole('heading', { name: /Replies/ })).toBeTruthy();
        await waitFor(() => expect(lastRead(api)).toStrictEqual([[BOB], 0, REPLIES]));
    });

    it('follows the reader from one thing to another, and back', async () => {
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        const { api, state } = services({ me: granted, timeline: both() });
        state.known['did:cid:2'] = post('did:cid:2', BOB, 'From Bob.');
        render(<App api={api} />);
        const user = userEvent.setup();

        await screen.findByText('From Alice.');
        expect(window.location.pathname).toBe('/');

        // To an author, to the author's replies, and to a post.
        await user.click(within(screen.getByText('From Bob.').closest('article')!).getByRole('button', { name: /Posts by this author|did:cid/ }));
        await waitFor(() => expect(window.location.pathname).toBe(`/a/${BOB}`));
        await user.click(screen.getByRole('tab', { name: 'Replies' }));
        await waitFor(() => expect(window.location.pathname).toBe(`/a/${BOB}/replies`));
        await user.click(screen.getByRole('tab', { name: 'Posts' }));
        await user.click((await screen.findByText('From Bob.')).closest('article')!);
        await waitFor(() => expect(window.location.pathname).toBe('/p/did:cid:2'));

        // Back to the reader's own timeline, which has no name.
        await user.click(screen.getByRole('button', { name: 'Back' }));
        await user.click(await screen.findByRole('button', { name: 'Back to your timeline' }));
        await waitFor(() => expect(window.location.pathname).toBe('/'));
        expect(await screen.findByText('From Alice.')).toBeTruthy();

        // The browser's own back and forward show what each address names.
        go(`a/${BOB}`);
        await waitFor(() => expect(screen.queryByText('From Alice.')).toBeNull());
        expect(lastRead(api)).toStrictEqual([[BOB], 0, ['post'], false]);
        go('p/did:cid:2');
        expect(await screen.findByRole('button', { name: 'Back' })).toBeTruthy();
        go('');
        expect(await screen.findByText('From Alice.')).toBeTruthy();
        expect(screen.getByLabelText('Post')).toBeTruthy();

        // And the browser's history itself, a step back and a step forward.
        window.history.back();
        expect(await screen.findByRole('button', { name: 'Back' })).toBeTruthy();
        expect(window.location.pathname).toBe('/p/did:cid:2');
        window.history.back();
        await waitFor(() => expect(window.location.pathname).toBe(`/a/${BOB}`));
        await waitFor(() => expect(screen.queryByRole('button', { name: 'Back' })).toBeNull());
        expect(lastRead(api)).toStrictEqual([[BOB], 0, ['post'], false]);
        window.history.forward();
        expect(await screen.findByRole('button', { name: 'Back' })).toBeTruthy();
        expect(window.location.pathname).toBe('/p/did:cid:2');
    });

    it('gives each post a link to itself, and an author one, to copy', async () => {
        const { api } = services({ me: granted, timeline: both() });
        const copied: string[] = [];
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied.push(text); } } });
        render(<App api={api} />);

        const article = (await screen.findByText('From Alice.')).closest('article')!;

        // The time is the link, as it is elsewhere.
        expect(within(article).getByRole('link', { name: /2026|Nov|21/ }).getAttribute('href')).toBe('/p/did:cid:1');
        fireEvent.click(article);
        fireEvent.click(await screen.findByRole('button', { name: 'More' }));
        fireEvent.click(screen.getByRole('menuitem', { name: 'Copy link' }));
        await waitFor(() => expect(copied).toStrictEqual([`${window.location.origin}/p/did:cid:1`]));

        fireEvent.click(within(document.querySelector('article.post') as HTMLElement).getByRole('button', { name: /Posts by this author|did:cid/ }));
        fireEvent.click(within(await waitFor(() => document.querySelector('.author') as HTMLElement)).getByRole('button', { name: 'Copy link' }));
        await waitFor(() => expect(copied[1]).toBe(`${window.location.origin}/a/${ALICE}`));
    });

    it('says so when a link names nothing published, and shows the timeline', async () => {
        const { api } = services({ me: granted, timeline: both() });
        at('p/did:cid:none');
        render(<App api={api} />);

        expect((await screen.findByRole('alert')).textContent).toMatch(/Nothing is published at that link/);
        // The timeline is read after, and what it says of the link stays.
        expect(await screen.findByText('From Alice.')).toBeTruthy();
        expect(screen.getByRole('alert').textContent).toMatch(/Nothing is published at that link/);
    });

    it('shows the reader\'s timeline for a link to nothing, whatever was shown, until the reader goes elsewhere', async () => {
        localStorage.setItem('memepool.follows', JSON.stringify([BOB]));
        const { api, state } = services({ me: granted, timeline: both() });
        state.known['did:cid:2'] = post('did:cid:2', BOB, 'From Bob.');
        at('p/did:cid:2');
        render(<App api={api} />);
        const user = userEvent.setup();

        await screen.findByRole('button', { name: 'Back' });
        go('p/did:cid:none');

        expect((await screen.findByRole('alert')).textContent).toMatch(/Nothing is published at that link/);
        expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
        expect(await screen.findByText('From Alice.')).toBeTruthy();
        expect(window.location.pathname).toBe('/p/did:cid:none');

        // From an author's list as well, and it is said no longer once the reader has gone on.
        go(`a/${BOB}`);
        await waitFor(() => expect(screen.queryByText('From Alice.')).toBeNull());
        expect(screen.queryByRole('alert')).toBeNull();
        go('p/did:cid:none');
        expect(await screen.findByText('From Alice.')).toBeTruthy();
        expect(screen.getByRole('alert').textContent).toMatch(/Nothing is published/);
        await user.click(screen.getByText('From Bob.').closest('article')!);
        await waitFor(() => expect(window.location.pathname).toBe('/p/did:cid:2'));
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('does not open a boosted post that was asked for before the reader went elsewhere', async () => {
        const original = post('did:cid:2', BOB, 'From Bob.');
        const boost = post('did:cid:9', ALICE, '', { memeplex: { kind: 'post', author: ALICE, target: 'did:cid:2', targetVersion: 'op-did:cid:2' } });
        const { api, state } = services({ me: granted, timeline: [boost] });
        state.revisions['did:cid:2 op-did:cid:2'] = original;
        render(<App api={api} />);
        const user = userEvent.setup();

        const article = (await screen.findByText('From Bob.')).closest('article')!;
        let answer!: (found: Publication) => void;
        vi.mocked(api.publication).mockImplementation(() => new Promise(resolve => { answer = resolve; }));

        // Open is pressed, and the reader goes to an author before the post is read.
        await user.click(article);
        go(`a/${BOB}`);
        await waitFor(() => expect(lastRead(api)).toStrictEqual([[BOB], 0, ['post'], false]));
        answer(original);
        await new Promise(resolve => setTimeout(resolve, 50));

        expect(window.location.pathname).toBe(`/a/${BOB}`);
        expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    });

    it('opens nothing its author has withdrawn', async () => {
        const { api, state } = services({ me: granted, timeline: both() });
        state.known['did:cid:2'] = post('did:cid:2', BOB, 'From Bob.', { state: 'withdrawn' });
        at('p/did:cid:2');
        render(<App api={api} />);

        expect((await screen.findByRole('alert')).textContent).toMatch(/Nothing is published at that link/);
        expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    });

    it('gives a boost the link of the post it is of', async () => {
        const original = post('did:cid:2', BOB, 'From Bob.');
        const boost = post('did:cid:9', ALICE, '', { memeplex: { kind: 'post', author: ALICE, target: 'did:cid:2', targetVersion: 'op-did:cid:2' } });
        const { api, state } = services({ me: granted, timeline: [boost] });
        state.known['did:cid:2'] = original;
        state.revisions['did:cid:2 op-did:cid:2'] = original;
        const copied: string[] = [];
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied.push(text); } } });
        render(<App api={api} />);

        const article = (await screen.findByText('From Bob.')).closest('article')!;

        expect(within(article).getByRole('link', { name: /2026|Nov|21/ }).getAttribute('href')).toBe('/p/did:cid:2');
        // The boost opens the post, whose link is the one to give on.
        fireEvent.click(article);
        fireEvent.click(await screen.findByRole('button', { name: 'More' }));
        fireEvent.click(screen.getByRole('menuitem', { name: 'Copy link' }));
        await waitFor(() => expect(copied).toStrictEqual([`${window.location.origin}/p/did:cid:2`]));
    });

    it('does not show a publication an address named once the reader has gone elsewhere', async () => {
        const { api, state } = services({ me: granted, timeline: both() });
        let answer!: (found: Publication) => void;
        vi.mocked(api.publication).mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
        at('p/did:cid:2');
        render(<App api={api} />);
        const user = userEvent.setup();

        // The reader opens another post while the link's is still being read.
        state.known['did:cid:1'] = post('did:cid:1', ALICE, 'From Alice.');
        await user.click((await screen.findByText('From Alice.')).closest('article')!);
        await waitFor(() => expect(window.location.pathname).toBe('/p/did:cid:1'));
        answer(post('did:cid:2', BOB, 'From Bob.'));
        await new Promise(resolve => setTimeout(resolve, 50));

        expect(window.location.pathname).toBe('/p/did:cid:1');
        expect(screen.getByText('From Alice.')).toBeTruthy();
        expect(screen.queryByText('From Bob.')).toBeNull();
    });
});

describe('a visitor, who has not signed in', () => {
    const both = () => [post('did:cid:1', ALICE, 'From Alice.'), post('did:cid:2', BOB, 'From Bob.')];
    const at = (hash: string) => window.history.replaceState(null, '', `/${hash}`);
    const lastRead = (api: Api) => vi.mocked(api.timeline).mock.calls.slice(-1)[0];

    it('reads the publication a link names, with its author, and is offered nothing that publishes', async () => {
        const { api, state } = services({ timeline: both() });
        state.known['did:cid:2'] = post('did:cid:2', BOB, 'From Bob.');
        state.people[BOB] = { name: 'Bob B.' };
        state.responses = { boosts: [{ author: ALICE, did: 'did:cid:b' }], ratings: { ratings: [] }, tags: [] } as never;
        at('p/did:cid:2');
        render(<App api={api} />);

        expect(await screen.findByText('From Bob.')).toBeTruthy();
        expect(await screen.findByText('Bob B.')).toBeTruthy();
        expect(api.thread).toHaveBeenCalledWith('did:cid:2');
        // Nobody is signed in, and nothing is asked that needs someone to be.
        expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
        expect(screen.queryByRole('heading', { name: /Let Memepool publish for you/ })).toBeNull();
        for (const name of ['Boost', 'Reply', 'Edit', 'Add image', 'Withdraw', 'Follow']) {
            expect([name, screen.queryByRole('button', { name })]).toStrictEqual([name, null]);
        }
        expect(screen.queryByLabelText('Reply')).toBeNull();
        expect(api.state).not.toHaveBeenCalled();
        expect(api.publish).not.toHaveBeenCalled();
        // A link to copy is theirs to give on, and nothing that changes the post.
        expect(await offered(userEvent.setup())).toStrictEqual(['Copy link', 'Copy embed', 'Copy DID', 'View source']);
    });

    it('reads an author a link names, and the author\'s replies, and goes from one thing to another', async () => {
        const { api, state } = services({ timeline: both() });
        state.known['did:cid:2'] = post('did:cid:2', BOB, 'From Bob.');
        at(`a/${BOB}`);
        render(<App api={api} />);
        const user = userEvent.setup();

        expect(await screen.findByText('From Bob.')).toBeTruthy();
        expect(screen.queryByText('From Alice.')).toBeNull();
        expect(lastRead(api)).toStrictEqual([[BOB], 0, ['post'], false]);
        // They have no timeline to go back to, and nobody to follow as.
        expect(screen.queryByRole('button', { name: 'Back to your timeline' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Follow' })).toBeNull();
        expect(screen.queryByLabelText('Post')).toBeNull();

        await user.click(screen.getByRole('tab', { name: 'Replies' }));
        await waitFor(() => expect(lastRead(api)).toStrictEqual([[BOB], 0, REPLIES]));
        await user.click(screen.getByRole('tab', { name: 'Posts' }));
        await user.click((await screen.findByText('From Bob.')).closest('article')!);
        await waitFor(() => expect(window.location.pathname).toBe('/p/did:cid:2'));
        expect(await screen.findByRole('button', { name: 'Back' })).toBeTruthy();
    });

    it('is asked to sign in where the address names nothing, and reads no timeline', async () => {
        const { api } = services({ timeline: both() });
        render(<App api={api} />);

        expect(await screen.findByRole('button', { name: 'Sign in with your wallet' })).toBeTruthy();
        expect(screen.queryByRole('heading', { name: /Timeline/ })).toBeNull();
        expect(api.timeline).not.toHaveBeenCalled();
    });

    it('is told when a link names nothing published, and asked to sign in', async () => {
        const { api } = services({ timeline: both() });
        at('p/did:cid:none');
        render(<App api={api} />);

        expect((await screen.findByRole('alert')).textContent).toMatch(/Nothing is published at that link/);
        expect(screen.getByRole('button', { name: 'Sign in with your wallet' })).toBeTruthy();
    });

    it('signs in from what they are reading, and is still there, with what a reader may do', async () => {
        const { api, state } = services({ timeline: both() });
        state.known['did:cid:2'] = post('did:cid:2', BOB, 'From Bob.');
        vi.mocked(api.login).mockImplementation(async body => {
            if (body?.confirm === ALICE) {
                state.me = granted;
                return { did: ALICE };
            }
            return { answered: ALICE };
        });
        at('p/did:cid:2');
        render(<App api={api} pollMs={10} />);
        const user = userEvent.setup();

        await screen.findByText('From Bob.');
        await user.click(screen.getByRole('button', { name: 'Sign in' }));
        await user.click(await screen.findByRole('button', { name: 'Sign in with your wallet' }));
        await user.click(await screen.findByRole('button', { name: 'This is me' }));

        expect(await screen.findByRole('button', { name: 'Sign out' })).toBeTruthy();
        expect(await screen.findByText('From Bob.')).toBeTruthy();
        expect(window.location.pathname).toBe('/p/did:cid:2');
        expect(await screen.findByLabelText('Reply')).toBeTruthy();
    });

    it('keeps a sign-in that is under way when they go back from what they were reading, and return', async () => {
        const { api, state } = services({ timeline: both() });
        state.known['did:cid:2'] = post('did:cid:2', BOB, 'From Bob.');
        vi.mocked(api.login).mockResolvedValue({ answered: ALICE });
        at('p/did:cid:2');
        render(<App api={api} pollMs={10} />);
        const user = userEvent.setup();

        await screen.findByText('From Bob.');
        await user.click(screen.getByRole('button', { name: 'Sign in' }));
        await user.click(await screen.findByRole('button', { name: 'Sign in with your wallet' }));
        expect(await screen.findByRole('button', { name: 'This is me' })).toBeTruthy();

        // Back from the post, to where the address names nothing.
        await user.click(screen.getByRole('button', { name: 'Back' }));
        await waitFor(() => expect(screen.queryByText('From Bob.')).toBeNull());
        expect(screen.getByRole('button', { name: 'This is me' })).toBeTruthy();
        expect(api.challenge).toHaveBeenCalledTimes(1);

        window.history.replaceState(null, '', '/p/did:cid:2');
        fireEvent(window, new PopStateEvent('popstate'));
        expect(await screen.findByText('From Bob.')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'This is me' })).toBeTruthy();
        expect(api.challenge).toHaveBeenCalledTimes(1);
    });

    it('keeps a sign-in started where the address names nothing when they go on to something', async () => {
        const { api, state } = services({ timeline: both() });
        state.known['did:cid:2'] = post('did:cid:2', BOB, 'From Bob.');
        vi.mocked(api.login).mockResolvedValue({ answered: ALICE });
        render(<App api={api} pollMs={10} />);
        const user = userEvent.setup();

        await user.click(await screen.findByRole('button', { name: 'Sign in with your wallet' }));
        expect(await screen.findByRole('button', { name: 'This is me' })).toBeTruthy();

        window.history.pushState(null, '', '/p/did:cid:2');
        fireEvent(window, new PopStateEvent('popstate'));

        expect(await screen.findByText('From Bob.')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'This is me' })).toBeTruthy();
        expect(api.challenge).toHaveBeenCalledTimes(1);
    });

    it('is not left waiting when they go back while a link within what they read is looked up', async () => {
        const { api, state } = services({ timeline: both() });
        state.known['did:cid:2'] = post('did:cid:2', BOB, 'From Bob.');
        at('p/did:cid:2');
        render(<App api={api} />);
        const user = userEvent.setup();

        await screen.findByText('From Bob.');
        // A link to another publication is followed, and its lookup does not answer.
        vi.mocked(api.publication).mockImplementation(() => new Promise(() => undefined));
        window.history.pushState(null, '', '/p/did:cid:1');
        fireEvent(window, new PopStateEvent('popstate'));
        await user.click(screen.getByRole('button', { name: 'Back' }));

        expect(await screen.findByRole('button', { name: 'Sign in with your wallet' })).toBeTruthy();
        expect(screen.queryByText('Loading…')).toBeNull();
    });

    it('is a visitor once more after signing out, at what was being read', async () => {
        const { api, state } = services({ me: granted, timeline: both() });
        state.known['did:cid:2'] = post('did:cid:2', BOB, 'From Bob.');
        at('p/did:cid:2');
        render(<App api={api} />);
        const user = userEvent.setup();

        await screen.findByLabelText('Reply');
        await user.click(screen.getByRole('button', { name: 'Sign out' }));

        expect(await screen.findByRole('button', { name: 'Sign in' })).toBeTruthy();
        expect(await screen.findByText('From Bob.')).toBeTruthy();
        expect(screen.queryByLabelText('Reply')).toBeNull();
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

    it('reads an object\'s last version from the node, anchored or not', async () => {
        const asked: string[] = [];
        const fetcher = (async (url: string) => {
            asked.push(url);

            return url.endsWith('did%3Acid%3A1')
                ? new Response(JSON.stringify({ didDocumentMetadata: { versionId: 'op-edit' }, didDocumentData: { memeplex: { kind: 'post', author: ALICE, text: 'x' } } }), { status: 200 })
                : url.endsWith('did%3Acid%3A2')
                    ? new Response(JSON.stringify({ didDocumentMetadata: { versionId: 'op' }, didDocumentData: { other: 1 } }), { status: 200 })
                    : new Response('no', { status: 502 });
        }) as unknown as typeof fetch;
        const api = createApi({ memepool: '/memepool', memeplex: '/memeplex', node: 'https://node.example' }, fetcher);

        expect(await api.unanchored('did:cid:1')).toStrictEqual({ versionId: 'op-edit', memeplex: { kind: 'post', author: ALICE, text: 'x' } });
        expect(asked[0]).toBe('https://node.example/api/v1/did/did%3Acid%3A1');
        // What is no Memeplex object, and what the node cannot give, are nothing.
        expect(await api.unanchored('did:cid:2')).toBeUndefined();
        expect(await api.unanchored('did:cid:3')).toBeUndefined();

        // Nor is an object whose words are not words: it is shown before any verifier has read it.
        for (const memeplex of [{ kind: 'post', author: ALICE, title: 42 }, { kind: 'post', text: 'x' }, { kind: 'post', author: ALICE, content: 'cid' }, ['post'], 'post']) {
            const odd = createApi({ memepool: '/memepool', memeplex: '/memeplex' }, (async () => new Response(JSON.stringify({ didDocumentMetadata: { versionId: 'op' }, didDocumentData: { memeplex } }), { status: 200 })) as unknown as typeof fetch);

            expect([memeplex, await odd.unanchored('did:cid:1')]).toStrictEqual([memeplex, undefined]);
        }
    });

    it('sends a paper\'s file as bytes of no stated kind, and asks the node for one as a download', async () => {
        const asked: { url: string; init?: RequestInit }[] = [];
        const fetcher = (async (url: string, init?: RequestInit) => {
            asked.push({ url, init });

            return new Response(JSON.stringify({ cid: 'bafypdf', type: 'application/pdf', bytes: 3 }), { status: 200 });
        }) as unknown as typeof fetch;
        const api = createApi({ memepool: '/memepool', memeplex: '/memeplex', node: 'https://node.example' }, fetcher);

        expect(await api.file('pdf', new Blob(['abc']))).toStrictEqual({ cid: 'bafypdf', type: 'application/pdf', bytes: 3 });
        expect(asked[0].url).toBe('/memepool/api/v1/files?kind=pdf');
        expect(asked[0].init).toMatchObject({ method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' } });
        // Asked for as bytes, under a name, so that a browser saves it.
        expect(api.download({ cid: 'bafypdf', type: 'application/pdf', bytes: 3 }, 'a paper.pdf'))
            .toBe('https://node.example/api/v1/ipfs/stream/bafypdf?filename=a%20paper.pdf&type=application%2Foctet-stream');
    });

    it('asks a timeline for posts with a title or with none, and keeps to that where the indexer does not', async () => {
        const asked: string[] = [];
        const both = [post('did:cid:1', BOB, 'A note.'), { ...post('did:cid:2', BOB, ''), memeplex: { kind: 'post', author: BOB, title: 'An article' } }];
        const fetcher = (async (url: string) => {
            asked.push(url);

            // An indexer that does not know the question gives posts of both kinds.
            return new Response(JSON.stringify({ total: 2, publications: both }), { status: 200 });
        }) as unknown as typeof fetch;
        const api = createApi({ memepool: '/memepool', memeplex: '/memeplex' }, fetcher);

        const articles = await api.timeline([BOB], 0, ['post'], true);

        expect(asked[0]).toBe(`/memeplex/api/v1/timeline?author=${encodeURIComponent(BOB)}&kind=post&titled=true`);
        expect(articles.publications.map(each => each.did)).toStrictEqual(['did:cid:2']);
        expect(articles.read).toBe(2);
        expect((await api.timeline([BOB], 0, ['post'], false)).publications.map(each => each.did)).toStrictEqual(['did:cid:1']);
        expect(asked[1]).toContain('titled=false');
        // Asked for neither, nothing is said of titles.
        await api.timeline([BOB], 0, ['post', 'paper']);
        expect(asked[2]).not.toContain('titled');
    });

    it('reads a body from the node by its CID, as text, and none when the node has none', async () => {
        const asked: { url: string; init?: RequestInit }[] = [];
        const fetcher = (async (url: string, init?: RequestInit) => {
            asked.push({ url, init });

            // The node is asked to read no more than the most a body may be.
            return url === 'https://node.example/api/v1/ipfs/text/bafkreibody?limit=1000000'
                ? new Response('# On DIDs\n', { status: 200 })
                : new Response('no such content', { status: 500 });
        }) as unknown as typeof fetch;
        const api = createApi({ memepool: '/memepool', memeplex: '/memeplex', node: 'https://node.example' }, fetcher);

        expect(await api.content('bafkreibody')).toBe('# On DIDs\n');
        expect(await api.content('bafkreinone')).toBeUndefined();
        // It is the node's to give to anyone, so nothing of the reader is sent with the asking.
        expect(asked[0].init).toBeUndefined();

        // With no node named, it is the host the pages are on.
        const here = createApi({ memepool: '/memepool', memeplex: '/memeplex' }, fetcher);
        await here.content('bafkreibody');
        expect(asked[2].url).toBe('/api/v1/ipfs/text/bafkreibody?limit=1000000');
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

    it('asks the indexer for the kinds wanted, and keeps no other kind an indexer gives', async () => {
        const mixed = [post('did:cid:1', ALICE, 'A post.'), { ...post('did:cid:2', ALICE, 'A reply.'), memeplex: { kind: 'reply', author: ALICE, text: 'A reply.' } }];
        const { api, asked } = answering({
            'GET /memeplex/api/v1/timeline?author=did%3Acid%3Aa&kind=post&kind=paper': { status: 200, body: { total: 2, publications: mixed } },
        });

        const page = await api.timeline(['did:cid:a'], 0, ['post', 'paper']);

        expect(page.publications.map(each => each.did)).toStrictEqual(['did:cid:1']);
        // What the indexer gave is what the next page comes after.
        expect(page.read).toBe(2);
        expect(asked[0].url).toBe('/memeplex/api/v1/timeline?author=did%3Acid%3Aa&kind=post&kind=paper');
    });

    it('asks the service where an object stands, and says nothing when the service does not', async () => {
        const { api } = answering({ 'GET /memepool/api/v1/objects/did%3Acid%3A1/state': { status: 200, body: { state: 'pending', registry: 'BTC:mainnet' } } });

        expect(await api.state('did:cid:1')).toStrictEqual({ state: 'pending', registry: 'BTC:mainnet' });
        expect(await api.state('did:cid:2')).toBeUndefined();
    });

    it('sends an image to the service as bytes, with the browser\'s cookies', async () => {
        const { api, asked } = answering({ 'POST /memepool/api/v1/images': { status: 200, body: { did: 'did:cid:image', versionId: 'bafyv1', type: 'image/png' } } });
        const image = new Blob([new Uint8Array(4)], { type: 'image/png' });

        expect(await api.upload(image)).toMatchObject({ did: 'did:cid:image', versionId: 'bafyv1' });
        expect(asked[0].init).toMatchObject({ method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' } });
        expect(asked[0].init?.body).toBe(image);
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
