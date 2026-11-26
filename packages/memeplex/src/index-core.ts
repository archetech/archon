import { attribute } from './attribution.js';
import { coauthors, currentRatings, ratingValue } from './views.js';
import type { Publication } from './attribution.js';
import type { ResolvedVersion } from './grant.js';
import type { Coauthor } from './views.js';

// An index of publications, derived from the versions of the DIDs it is handed:
// docs/plans/memeplex-1436.md, "A graph anyone can reconstruct".
//
// The index holds the versions of each DID, as a Gatekeeper resolves them, and
// nothing it could not derive again from those. Every view is a function of the
// versions held, so an index filled in any order, or refilled from nothing,
// answers the same as one kept up to date. It fetches nothing: whoever runs it
// asks a Gatekeeper which DIDs changed and hands over the versions of each.

// A reply in a thread, with how far below the thread's target it sits: 1 for a
// reply to the target, 2 for a reply to that, and so on.
export interface Reply {
    publication: Publication;
    depth: number;
}

export interface RatingSummary {
    // The ratings that count: one for each author.
    ratings: Publication[];
    // Their mean on the scale from 0 to 1, when there is at least one.
    mean?: number;
}

const kindOf = (publication: Publication) => publication.memeplex?.kind as string | undefined;

// When the version a publication began with was anchored, for ordering.
function createdAt(publication: Publication): number {
    const first = publication.versions[0];

    return first?.outcome === 'attributed' ? Date.parse(first.position.time) : NaN;
}

// Newest first; two anchored at one time, by DID, so the order never depends on
// the order of arrival.
function newestFirst(a: Publication, b: Publication): number {
    return createdAt(b) - createdAt(a) || (a.did! < b.did! ? -1 : 1);
}

// The kinds of object a timeline holds.
export const TIMELINE_KINDS = ['post', 'paper', 'reply'] as const;

export class MemeplexIndex {
    private histories = new Map<string, ResolvedVersion[]>();
    private publications = new Map<string, Publication>();
    // Where each object is filed, kept apart from the publications handed out so
    // that nothing a caller does to one can leave the index filed wrongly.
    private filed = new Map<string, { grant?: string; author?: string; target?: string }>();
    // The objects naming each grant, each author and each target.
    private byGrant = new Map<string, Set<string>>();
    private byAuthor = new Map<string, Set<string>>();
    private byTarget = new Map<string, Set<string>>();

    // Records the versions of a DID, replacing any held for it. With no versions
    // the DID is removed. Versions of DIDs that are neither objects nor
    // grants are kept out.
    put(did: string, history: ResolvedVersion[]): void {
        const data = history[0]?.didDocumentData as Record<string, unknown> | undefined;
        const relevant = history.length > 0 && data && typeof data === 'object'
            && (data.memeplex !== undefined || data.memeplexGrant !== undefined);

        if (relevant) {
            this.histories.set(did, history);
        }
        else {
            this.histories.delete(did);
        }

        this.derive(did);

        // A grant's history decides what is attributed under it. Deriving an object
        // files it under its grant again, so the set is copied before the walk.
        for (const object of [...this.byGrant.get(did) ?? []]) {
            this.derive(object);
        }
    }

    private unlink(index: Map<string, Set<string>>, key: unknown, did: string) {
        if (typeof key === 'string') {
            const set = index.get(key);

            set?.delete(did);
            if (set?.size === 0) {
                index.delete(key);
            }
        }
    }

    private link(index: Map<string, Set<string>>, key: unknown, did: string) {
        if (typeof key === 'string') {
            index.set(key, (index.get(key) ?? new Set()).add(did));
        }
    }

    // Attributes one object again from the histories held, and files the result.
    private derive(did: string): void {
        const before = this.filed.get(did);
        const history = this.histories.get(did);
        const claimed = (history?.[0]?.didDocumentData as Record<string, any> | undefined)?.memeplex;

        // The grant link follows what the creation claims, so that the object is
        // attributed again when that grant's history arrives or changes.
        this.unlink(this.byGrant, before?.grant, did);
        this.unlink(this.byAuthor, before?.author, did);
        this.unlink(this.byTarget, before?.target, did);
        this.filed.delete(did);
        this.publications.delete(did);

        if (!history || claimed === undefined) {
            return;
        }

        const filed: { grant?: string; author?: string; target?: string } = {};

        if (typeof claimed?.grant === 'string') {
            filed.grant = claimed.grant;
            this.link(this.byGrant, filed.grant, did);
        }

        const publication = attribute(history, this.histories.get(claimed?.grant) ?? []);

        // Only an attributed object appears anywhere: a claim is not a publication.
        if (publication.current !== undefined) {
            const { author, target } = publication.memeplex!;

            this.publications.set(did, publication);
            filed.author = author;
            this.link(this.byAuthor, author, did);
            if (typeof target === 'string') {
                filed.target = target;
                this.link(this.byTarget, target, did);
            }
        }

        this.filed.set(did, filed);
    }

    private under(index: Map<string, Set<string>>, key: string): Publication[] {
        return [...index.get(key) ?? []].flatMap(did => this.publications.get(did) ?? []);
    }

    // Whether the index holds a history for a DID, and every DID it holds one
    // for: objects, attributed or not, and grants.
    holds(did: string): boolean {
        return this.histories.has(did);
    }

    dids(): string[] {
        return [...this.histories.keys()];
    }

    // How many DIDs are held, and how many of them have a publication.
    get size(): { dids: number; publications: number } {
        return { dids: this.histories.size, publications: this.publications.size };
    }

    // The publication of an object, published or withdrawn. An object with no
    // attributed version has none.
    publication(did: string): Publication | undefined {
        return this.publications.get(did);
    }

    // An object as it was at one of its versions, which is what a response to
    // it cites: the publication with `current` at that version and `memeplex`
    // as the version had it. Its `state` is the object's own, so one since
    // withdrawn says so.
    //
    // A version that is not in the object's history is 'no-revision': a
    // response continues to mean the version it cited, and no other stands in
    // for one that is gone. So is a version that is in the history and is not
    // attributed, or is the object's deletion, since neither is something the
    // author published.
    revision(did: string, versionId: string): Publication | 'no-revision' | undefined {
        const publication = this.publications.get(did);

        if (!publication) {
            return undefined;
        }

        const at = publication.versions.findIndex(each => each.opid === versionId);
        const version = publication.versions[at];
        const data = this.histories.get(did)?.[at]?.didDocumentData;
        const memeplex = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, any>).memeplex : undefined;

        if (!version || version.outcome !== 'attributed' || version.type === 'delete' || memeplex === undefined) {
            return 'no-revision';
        }

        return { ...publication, current: at, memeplex };
    }

    // What the authors have published and not withdrawn, newest first: posts,
    // papers and replies, or those of them that `kinds` names. A reply is part
    // of a conversation, and a reader may want an author's posts without them.
    //
    // `titled` is of the posts among them: with it, those that have a title,
    // which are articles, or those that have none. An article is a post, and
    // is told from one by its title alone.
    timeline(authors: string[], kinds: readonly string[] = TIMELINE_KINDS, titled?: boolean): Publication[] {
        const wanted = TIMELINE_KINDS.filter(kind => kinds.includes(kind));
        const article = (each: Publication) => typeof each.memeplex?.title === 'string' && each.memeplex.title.trim() !== '';

        return [...new Set(authors)]
            .flatMap(author => this.under(this.byAuthor, author))
            .filter(each => each.state === 'published' && wanted.includes(kindOf(each) as typeof wanted[number])
                && (titled === undefined || kindOf(each) !== 'post' || article(each) === titled))
            .sort(newestFirst);
    }

    // The replies to an object and the replies to those, each directly after the
    // one it answers and the replies to one object oldest first. A withdrawn
    // reply stays as a tombstone so that the replies under it keep their place.
    //
    // The list is flat and built without recursion: anyone can publish a chain of
    // replies as long as they like, and a thread must not fail for its depth. A
    // reply names its target in its creation, which its own DID is the hash of, so
    // no reply can be above itself.
    thread(target: string): Reply[] {
        const repliesTo = (did: string, depth: number): Reply[] => this.under(this.byTarget, did)
            .filter(each => kindOf(each) === 'reply')
            .sort(newestFirst)
            .map(publication => ({ publication, depth }));

        const thread: Reply[] = [];
        // Newest first on the stack, so that the oldest is taken first.
        const waiting = repliesTo(target, 1);

        while (waiting.length > 0) {
            const reply = waiting.pop()!;

            thread.push(reply);
            for (const below of repliesTo(reply.publication.did!, reply.depth + 1)) {
                waiting.push(below);
            }
        }

        return thread;
    }

    // The boosts and quote posts of an object: posts that name it as their target.
    boosts(target: string): Publication[] {
        return this.under(this.byTarget, target)
            .filter(each => each.state === 'published' && kindOf(each) === 'post')
            .sort(newestFirst);
    }

    // The ratings of an object that count, and their mean.
    ratings(target: string): RatingSummary {
        const ratings = currentRatings(this.under(this.byTarget, target)).sort(newestFirst);
        const values = ratings.map(each => ratingValue(each.memeplex as { rating: number; min: number; max: number }));

        return values.length ? { ratings, mean: values.reduce((sum, value) => sum + value, 0) / values.length } : { ratings };
    }

    // The tags others have put on an object: each value with the authors who
    // applied it, an author counted once for a value. Values are as published;
    // grouping spellings and telling reactions from labels is the reader's.
    tags(target: string): Map<string, string[]> {
        const applied = new Map<string, Set<string>>();

        for (const each of this.under(this.byTarget, target)) {
            if (each.state === 'published' && kindOf(each) === 'tag') {
                const value: string = each.memeplex!.tag;

                applied.set(value, (applied.get(value) ?? new Set()).add(each.memeplex!.author));
            }
        }

        return new Map([...applied].sort(([a], [b]) => (a < b ? -1 : 1)).map(([value, authors]) => [value, [...authors].sort()]));
    }

    // The tags on an object, each the object that applies it: what one who
    // applied a tag withdraws to take it away.
    applied(target: string): Publication[] {
        return this.under(this.byTarget, target)
            .filter(each => each.state === 'published' && kindOf(each) === 'tag')
            .sort(newestFirst);
    }

    // How each coauthor a paper lists stands towards the revision it shows.
    coauthors(paper: string): Coauthor[] {
        const publication = this.publications.get(paper);

        return publication ? coauthors(publication, this.under(this.byTarget, paper)) : [];
    }

    // Every publication held, by DID: what two indexes are compared by.
    snapshot(): Publication[] {
        return [...this.publications.values()].sort((a, b) => (a.did! < b.did! ? -1 : 1));
    }
}
