import { attribute, coauthors, currentRatings, ratingValue } from '@didcid/memeplex';
import type { Publication } from '@didcid/memeplex';
import { History } from './attribution-vectors.ts';
import { agent, cid, exported } from './grant-vectors.ts';
import type { Signer } from './grant-vectors.ts';

// The readings indexers have to agree on: docs/plans/memeplex-reference-1436.md,
// "Ratings" and "Coauthors". The publications are attributed from signed histories
// a Gatekeeper accepted and exported, as in attribution-vectors.ts.

let alice: Signer, bob: Signer, web: Signer, bot: Signer;
let agents: Signer[];
let nonces = 0;

const publication = async (object: History, grant: History): Promise<Publication> =>
    attribute((await exported(agents, object.steps)).history, (await exported(agents, grant.steps)).history);

// A live grant from a user to a client, anchored at block 100.
const grantTo = (user: Signer, client: Signer) => History.create(user, {
    memeplexGrant: { v: 1, client: client.did, nonce: Buffer.from(new Uint8Array(18).fill(nonces++)).toString('base64url') },
}, 100);

beforeAll(async () => {
    [alice, bob, web, bot] = await Promise.all([0x41, 0x42, 0x43, 0x44].map(agent));
    agents = [alice, bob, web, bot];
}, 60_000);

describe('ratingValue', () => {
    it.each([
        [3, 1, 5, 0.5], [80, 0, 100, 0.8], [1, 0, 1, 1], [0, -2, 2, 0.5], [4, 1, 5, 0.75],
    ])('%i on %i to %i is %f', (rating, min, max, value) => {
        expect(ratingValue({ rating, min, max })).toBe(value);
    });
});

describe('currentRatings', () => {
    let target: string, other: string, version: string;
    let viaWeb: History, viaBot: History;
    const rate = (grant: History, value: number, on = target, by = alice) =>
        ({ memeplex: { v: 1, author: by.did, grant: grant.did, kind: 'rating', target: on, targetVersion: version, rating: value, min: 1, max: 5 } });

    beforeAll(async () => {
        target = `did:cid:${await cid({ target: 1 })}`;
        other = `did:cid:${await cid({ target: 2 })}`;
        version = await cid({ version: 1 });
        viaWeb = await grantTo(alice, web);
        viaBot = await grantTo(alice, bot);
    }, 60_000);

    it('counts the one anchored latest when two clients each published one', async () => {
        const early = await publication(await History.create(web, rate(viaWeb, 2), 200), viaWeb);
        const late = await publication(await History.create(bot, rate(viaBot, 5), 300), viaBot);

        expect(currentRatings([early, late])).toStrictEqual([late]);
        expect(currentRatings([late, early])).toStrictEqual([late]);
    }, 60_000);

    it('goes by the version shown, so an edit makes an older object the later one', async () => {
        const first = await History.create(web, rate(viaWeb, 2), 200);
        await first.update(web, { didDocumentData: rate(viaWeb, 3) }, 400);
        const edited = await publication(first, viaWeb);
        const second = await publication(await History.create(bot, rate(viaBot, 5), 300), viaBot);

        expect(edited.memeplex!.rating).toBe(3);
        expect(currentRatings([edited, second])).toStrictEqual([edited]);
    }, 60_000);

    it('leaves the next one when the latest is withdrawn', async () => {
        const early = await publication(await History.create(web, rate(viaWeb, 2), 200), viaWeb);
        const withdrawn = await publication(await (await History.create(bot, rate(viaBot, 5), 300)).delete(bot, 350), viaBot);

        expect(withdrawn.state).toBe('withdrawn');
        expect(currentRatings([early, withdrawn])).toStrictEqual([early]);
        expect(currentRatings([withdrawn])).toStrictEqual([]);
    }, 60_000);

    it('breaks a tie in block time by the smaller version identity', async () => {
        const one = await publication(await History.create(web, rate(viaWeb, 2), 200), viaWeb);
        const two = await publication(await History.create(bot, rate(viaBot, 5), 200), viaBot);
        const smaller = one.versions[0].opid! < two.versions[0].opid! ? one : two;

        expect(currentRatings([one, two])).toStrictEqual([smaller]);
        expect(currentRatings([two, one])).toStrictEqual([smaller]);
    }, 60_000);

    it('keeps one for each author and each target, and only attributed ratings', async () => {
        const viaBob = await grantTo(bob, web);
        const mine = await publication(await History.create(web, rate(viaWeb, 2), 200), viaWeb);
        const elsewhere = await publication(await History.create(web, rate(viaWeb, 4, other), 200), viaWeb);
        const bobs = await publication(await History.create(web, rate(viaBob, 1, target, bob), 200), viaBob);
        // Alice's name under a grant that is Bob's.
        const forged = await publication(await History.create(web, rate(viaBob, 5), 900), viaBob);
        const pending = await publication(await History.create(web, rate(viaWeb, 5)), viaWeb);

        expect([forged.state, pending.state]).toStrictEqual(['none', 'pending']);
        expect(currentRatings([mine, elsewhere, bobs, forged, pending])).toStrictEqual([mine, elsewhere, bobs]);
    }, 60_000);
});

describe('coauthors', () => {
    let aliceGrant: History, bobGrant: History;
    const content = (n: number) => cid({ content: n }).then(value => ({ cid: value, type: 'text/markdown', bytes: 100 + n }));
    const paper = async (n: number) => ({
        memeplex: {
            v: 1, author: alice.did, grant: aliceGrant.did, kind: 'paper', title: 'A paper', summary: 'Its abstract.',
            authors: [alice.did, bob.did], content: await content(n),
        },
    });
    const confirm = (on: Publication, revision: string, by = bob, grant = bobGrant) => History.create(bot, {
        memeplex: { v: 1, author: by.did, grant: grant.did, kind: 'tag', target: on.did, targetVersion: revision, tag: 'coauthor' },
    }, 400);

    beforeAll(async () => {
        aliceGrant = await grantTo(alice, web);
        bobGrant = await grantTo(bob, bot);
    }, 60_000);

    it('shows a coauthor as listed until they confirm, and confirmed once they pin the revision shown', async () => {
        const published = await publication(await History.create(web, await paper(1), 200), aliceGrant);
        const tag = await publication(await confirm(published, published.versions[0].opid!), bobGrant);

        expect(coauthors(published, [])).toStrictEqual([{ did: bob.did, status: 'listed' }]);
        expect(coauthors(published, [tag])).toStrictEqual([{ did: bob.did, status: 'confirmed' }]);
    }, 60_000);

    it('does not carry a confirmation over to a later revision', async () => {
        const object = await History.create(web, await paper(1), 200);
        const first = await publication(object, aliceGrant);
        const tag = await publication(await confirm(first, first.versions[0].opid!), bobGrant);
        const revised = await publication(await object.update(web, { didDocumentData: await paper(2) }, 500), aliceGrant);

        expect(coauthors(revised, [tag])).toStrictEqual([
            { did: bob.did, status: 'confirmed-other', revisions: [first.versions[0].opid] },
        ]);
    }, 60_000);

    it('reads the tag\'s publication state: a withdrawn tag confirms nothing', async () => {
        const published = await publication(await History.create(web, await paper(1), 200), aliceGrant);
        const tag = await confirm(published, published.versions[0].opid!);
        const withdrawn = await publication(await tag.delete(bot, 450), bobGrant);

        expect(coauthors(published, [withdrawn])).toStrictEqual([{ did: bob.did, status: 'listed' }]);
    }, 60_000);

    it('ignores a tag by someone else, one in the coauthor\'s name they did not grant, and other tags', async () => {
        const published = await publication(await History.create(web, await paper(1), 200), aliceGrant);
        const revision = published.versions[0].opid!;
        const byAlice = await publication(await History.create(web, {
            memeplex: { v: 1, author: alice.did, grant: aliceGrant.did, kind: 'tag', target: published.did, targetVersion: revision, tag: 'coauthor' },
        }, 400), aliceGrant);
        const forged = await publication(await History.create(web, {
            memeplex: { v: 1, author: bob.did, grant: aliceGrant.did, kind: 'tag', target: published.did, targetVersion: revision, tag: 'coauthor' },
        }, 400), aliceGrant);
        const label = await publication(await History.create(bot, {
            memeplex: { v: 1, author: bob.did, grant: bobGrant.did, kind: 'tag', target: published.did, targetVersion: revision, tag: 'cryptography' },
        }, 400), bobGrant);

        expect([byAlice.state, forged.state, label.state]).toStrictEqual(['published', 'none', 'published']);
        expect(coauthors(published, [byAlice, forged, label])).toStrictEqual([{ did: bob.did, status: 'listed' }]);
    }, 60_000);

    it('lists no coauthors for anything but a published paper', async () => {
        const withdrawn = await publication(await (await History.create(web, await paper(1), 200)).delete(web, 300), aliceGrant);

        expect(coauthors(withdrawn, [])).toStrictEqual([]);
    }, 60_000);
});
