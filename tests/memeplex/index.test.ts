import { MemeplexIndex } from '@didcid/memeplex';
import type { AcceptedEvent } from '@didcid/memeplex';
import { History } from './attribution-vectors.ts';
import { agent, cid, exported } from './grant-vectors.ts';
import type { Signer } from './grant-vectors.ts';

// The index of publications: docs/plans/memeplex-1436.md, "A graph anyone can
// reconstruct". Its histories are signed, imported into a Gatekeeper with chain
// receipts and exported again, as in attribution-vectors.ts.

let alice: Signer, bob: Signer, carol: Signer, web: Signer, bot: Signer;
let agents: Signer[];
let nonces = 0;

// Every history the tests hand to an index: each DID's, at each length it had.
const evidence = new Map<string, AcceptedEvent[][]>();

// Exports a history at every length from its creation on, so that a test can hand
// an index the history as it stood at any point.
async function record(history: History): Promise<string> {
    const prefixes: AcceptedEvent[][] = [];

    for (let length = 1; length <= history.steps.length; length++) {
        prefixes.push((await exported(agents, history.steps.slice(0, length))).history);
    }
    evidence.set(history.did, prefixes);
    return history.did;
}

const latest = (did: string) => evidence.get(did)!.at(-1)!;
const filled = (dids: Iterable<string> = evidence.keys()) => {
    const index = new MemeplexIndex();

    for (const did of dids) index.put(did, latest(did));
    return index;
};

const grantTo = (user: Signer, client: Signer, more: Record<string, unknown> = {}) => History.create(user, {
    memeplexGrant: { v: 1, client: client.did, nonce: Buffer.from(new Uint8Array(18).fill(nonces++)).toString('base64url'), ...more },
}, 100);

let aliceGrant: History, bobGrant: History, carolGrant: History, revokedGrant: History;
let paper: string, post: string, edited: string, withdrawn: string, boost: string, forged: string, pending: string, late: string;
let reply: string, nested: string, gone: string, underGone: string;
let version: string;
const dids: Record<string, string> = {};

beforeAll(async () => {
    [alice, bob, carol, web, bot] = await Promise.all([0x51, 0x52, 0x53, 0x54, 0x55].map(agent));
    agents = [alice, bob, carol, web, bot];
    version = await cid({ version: 1 });

    aliceGrant = await grantTo(alice, web);
    bobGrant = await grantTo(bob, bot);
    carolGrant = await grantTo(carol, web);
    revokedGrant = await (await grantTo(alice, bot)).delete(alice, 400);
    for (const grant of [aliceGrant, bobGrant, carolGrant, revokedGrant]) await record(grant);

    const by = (user: Signer, grant: History) => ({ v: 1, author: user.did, grant: grant.did });
    const content = { cid: await cid({ content: 1 }), type: 'text/markdown', bytes: 100 };

    paper = await record(await History.create(web, {
        memeplex: { ...by(alice, aliceGrant), kind: 'paper', title: 'A paper', summary: 'Its abstract.', authors: [alice.did, bob.did], content },
    }, 200));
    post = await record(await History.create(web, { memeplex: { ...by(alice, aliceGrant), kind: 'post', text: 'First.' } }, 210));
    edited = await record(await (await History.create(web, { memeplex: { ...by(alice, aliceGrant), kind: 'post', text: 'Draft.' } }, 220))
        .update(web, { didDocumentData: { memeplex: { ...by(alice, aliceGrant), kind: 'post', text: 'Final.' } } }, 320));
    withdrawn = await record(await (await History.create(web, { memeplex: { ...by(alice, aliceGrant), kind: 'post', text: 'Oops.' } }, 230))
        .delete(web, 330));
    // Published under a grant that was later revoked: it stays, and the deletion
    // that followed the revocation withdraws nothing.
    late = await record(await (await History.create(bot, { memeplex: { ...by(alice, revokedGrant), kind: 'post', text: 'Kept.' } }, 240))
        .delete(bot, 500));
    // Alice's name under a grant that is Bob's.
    forged = await record(await History.create(bot, { memeplex: { ...by(alice, bobGrant), kind: 'post', text: 'Not hers.' } }, 250));
    pending = await record(await History.create(web, { memeplex: { ...by(alice, aliceGrant), kind: 'post', text: 'Soon.' } }));
    boost = await record(await History.create(bot, { memeplex: { ...by(bob, bobGrant), kind: 'post', target: post, targetVersion: version } }, 260));

    const respond = (user: Signer, grant: History, client: Signer, target: string, more: Record<string, unknown>, block: number) =>
        History.create(client, { memeplex: { ...by(user, grant), target, targetVersion: version, ...more } }, block);

    reply = await record(await respond(bob, bobGrant, bot, post, { kind: 'reply', text: 'Second.' }, 300));
    nested = await record(await respond(carol, carolGrant, web, reply, { kind: 'reply', text: 'Third.' }, 310));
    gone = await record(await (await respond(carol, carolGrant, web, post, { kind: 'reply', text: 'Never mind.' }, 305)).delete(web, 340));
    underGone = await record(await respond(bob, bobGrant, bot, gone, { kind: 'reply', text: 'Mind what?' }, 315));

    dids.bobRating = await record(await respond(bob, bobGrant, bot, paper, { kind: 'rating', rating: 4, min: 1, max: 5 }, 300));
    dids.carolEarly = await record(await respond(carol, carolGrant, web, paper, { kind: 'rating', rating: 1, min: 0, max: 1 }, 300));
    // Carol rates again through the same client; the later one counts.
    dids.carolLate = await record(await respond(carol, carolGrant, web, paper, { kind: 'rating', rating: 0, min: 0, max: 1 }, 350));

    const paperVersion = latest(paper)[0].opid!;
    dids.confirm = await record(await History.create(bot, {
        memeplex: { ...by(bob, bobGrant), kind: 'tag', target: paper, targetVersion: paperVersion, tag: 'coauthor' },
    }, 300));
    dids.bobTag = await record(await respond(bob, bobGrant, bot, post, { kind: 'tag', tag: 'archon' }, 300));
    dids.bobTagAgain = await record(await respond(bob, bobGrant, bot, post, { kind: 'tag', tag: 'archon' }, 301));
    dids.carolTag = await record(await respond(carol, carolGrant, web, post, { kind: 'tag', tag: 'archon' }, 302));
    dids.carolHeart = await record(await respond(carol, carolGrant, web, post, { kind: 'tag', tag: '❤️' }, 303));
    dids.removedTag = await record(await (await respond(carol, carolGrant, web, post, { kind: 'tag', tag: 'spam' }, 304)).delete(web, 306));
}, 240_000);

describe('publications', () => {
    it('holds what is attributed and nothing that is only claimed', () => {
        const index = filled();

        expect(index.publication(post)).toMatchObject({ state: 'published', did: post });
        expect(index.publication(edited)!.memeplex!.text).toBe('Final.');
        expect(index.publication(withdrawn)!.state).toBe('withdrawn');
        expect(index.publication(late)).toMatchObject({ state: 'published', current: 0 });
        expect(index.publication(forged)).toBeUndefined();
        expect(index.publication(pending)).toBeUndefined();
        expect(index.publication(aliceGrant.did)).toBeUndefined();
    });

    it('attributes an object once its grant\'s history arrives, whichever came first', () => {
        const index = new MemeplexIndex();

        index.put(post, latest(post));
        expect(index.publication(post)).toBeUndefined();
        index.put(aliceGrant.did, latest(aliceGrant.did));
        expect(index.publication(post)).toMatchObject({ state: 'published' });
    });

    it('reads a grant\'s objects again when the grant\'s history changes', () => {
        const index = new MemeplexIndex();
        const [live, revoked] = evidence.get(revokedGrant.did)!;

        // The deletion at block 500 withdraws the post while the grant is live...
        index.put(revokedGrant.did, live);
        index.put(late, latest(late));
        expect(index.publication(late)!.state).toBe('withdrawn');
        // ...and withdraws nothing once the revocation at block 400 is known.
        index.put(revokedGrant.did, revoked);
        expect(index.publication(late)).toMatchObject({ state: 'published', current: 0 });
    });

    it('forgets a DID whose history is taken away', () => {
        const index = filled();

        index.put(post, []);
        expect(index.publication(post)).toBeUndefined();
        expect(index.timeline([alice.did]).map(each => each.did)).not.toContain(post);
        // The replies to it are publications of their own, and stay.
        expect(index.thread(post).map(each => each.publication.did)).toStrictEqual([reply, nested, gone, underGone]);
        expect(index.snapshot()).toStrictEqual(filled([...evidence.keys()].filter(did => did !== post)).snapshot());
    });
});

describe('views', () => {
    it('lists what authors have published, newest first, without the withdrawn', () => {
        const index = filled();

        expect(index.timeline([alice.did]).map(each => each.did)).toStrictEqual([late, edited, post, paper]);
        expect(index.timeline([alice.did, bob.did, alice.did]).map(each => each.did))
            .toStrictEqual([underGone, reply, boost, late, edited, post, paper]);
        expect(index.timeline([])).toStrictEqual([]);
    });

    it('builds a thread, oldest first, keeping a withdrawn reply as a tombstone', () => {
        const thread = filled().thread(post);

        expect(thread.map(each => [each.publication.did, each.depth, each.publication.state])).toStrictEqual([
            [reply, 1, 'published'], [nested, 2, 'published'], [gone, 1, 'withdrawn'], [underGone, 2, 'published'],
        ]);
    });

    // Anyone can publish a chain of replies as long as they like.
    it('builds a thread too deep to walk by recursion', () => {
        const index = filled();
        const template = index.publication(reply)!;
        const root = 'did:cid:deep-0';
        const depth = 20_000;

        // Publications as attribute returns them, filed directly: signing twenty
        // thousand histories would test the Gatekeeper, not the walk.
        const internals = index as unknown as { publications: Map<string, unknown>; byTarget: Map<string, Set<string>> };
        for (let level = 1; level <= depth; level++) {
            const did = `did:cid:deep-${level}`;

            internals.publications.set(did, { ...template, did, memeplex: { ...template.memeplex, target: `did:cid:deep-${level - 1}` } });
            internals.byTarget.set(`did:cid:deep-${level - 1}`, new Set([did]));
        }

        const thread = index.thread(root);
        expect(thread).toHaveLength(depth);
        expect(thread.at(-1)).toMatchObject({ depth, publication: { did: `did:cid:deep-${depth}` } });
    });

    it('is not misfiled by a caller changing a publication it was given', () => {
        const index = filled();

        index.publication(post)!.memeplex!.author = bob.did;
        index.put(post, []);

        expect(() => index.timeline([alice.did, bob.did])).not.toThrow();
        expect(index.timeline([alice.did, bob.did]).map(each => each.did)).not.toContain(post);
    });

    it('lists boosts', () => {
        expect(filled().boosts(post).map(each => each.did)).toStrictEqual([boost]);
    });

    it('counts one rating for each author and averages them', () => {
        const { ratings, mean } = filled().ratings(paper);

        expect(ratings.map(each => each.did)).toStrictEqual([dids.carolLate, dids.bobRating]);
        // Bob's four of five is 0.75 and Carol's thumbs down is 0.
        expect(mean).toBe(0.375);
        expect(filled().ratings(post)).toStrictEqual({ ratings: [] });
    });

    it('groups tags by value, counting an author once for a value', () => {
        expect([...filled().tags(post)]).toStrictEqual([
            ['archon', [bob.did, carol.did].sort()],
            ['❤️', [carol.did]],
        ]);
    });

    it('reads coauthor confirmations', () => {
        expect(filled().coauthors(paper)).toStrictEqual([{ did: bob.did, status: 'confirmed' }]);
        expect(filled().coauthors(post)).toStrictEqual([]);
    });
});

describe('a rebuilt index', () => {
    // A small generator, so that a failing order can be run again.
    const shuffled = <T>(items: T[], seed: number) => {
        const out = [...items];
        let state = seed;
        const next = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;

        for (let index = out.length - 1; index > 0; index--) {
            const other = Math.floor(next() * (index + 1));
            [out[index], out[other]] = [out[other], out[index]];
        }
        return out;
    };

    const views = (index: MemeplexIndex) => JSON.stringify({
        snapshot: index.snapshot(),
        timeline: index.timeline([alice.did, bob.did, carol.did]),
        thread: index.thread(post),
        ratings: index.ratings(paper),
        tags: [...index.tags(post)],
        coauthors: index.coauthors(paper),
        boosts: index.boosts(post),
    });

    it('matches one kept up to date, in whatever order the histories arrived and grew', () => {
        const fresh = views(filled());

        for (let seed = 1; seed <= 25; seed++) {
            // Every DID's history at every length it had, with the lengths of one
            // DID in order and the DIDs interleaved at random.
            const arrivals = shuffled([...evidence].flatMap(([did, prefixes]) => prefixes.map((_, length) => ({ did, length }))), seed);
            const reached = new Map<string, number>();
            const index = new MemeplexIndex();

            for (const { did } of arrivals) {
                const length = reached.get(did) ?? 0;

                reached.set(did, length + 1);
                index.put(did, evidence.get(did)![length]);
            }

            expect({ seed, views: views(index) }).toStrictEqual({ seed, views: fresh });
        }
    });

    it('matches after a history is replaced by a shorter one and then restored', () => {
        const index = filled();

        // As a reorganization might: a later operation is gone, then accepted again.
        for (const [did, prefixes] of evidence) {
            index.put(did, prefixes[0]);
        }
        for (const did of shuffled([...evidence.keys()], 7)) {
            index.put(did, latest(did));
        }

        expect(views(index)).toBe(views(filled()));
    });
});
