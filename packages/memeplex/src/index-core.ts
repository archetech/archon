import { attribute } from './attribution.js';
import { coauthors, currentRatings, ratingValue } from './views.js';
import type { Publication } from './attribution.js';
import type { AcceptedEvent } from './grant.js';
import type { Coauthor } from './views.js';

// An index of publications, derived from accepted histories it is handed:
// docs/plans/memeplex-1436.md, "A graph anyone can reconstruct".
//
// The index holds each DID's latest accepted history and nothing it could not
// derive again from those. Every view is a function of the histories held, so an
// index filled in any order, or refilled from nothing, answers the same as one
// kept up to date. It fetches nothing: whoever runs it reads a Gatekeeper's events
// and hands over the history of each DID that changed.

export interface Reply {
    publication: Publication;
    replies: Reply[];
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

export class MemeplexIndex {
    private histories = new Map<string, AcceptedEvent[]>();
    private publications = new Map<string, Publication>();
    // The grant each object's creation names, and the objects naming each grant,
    // each author and each target.
    private grantOf = new Map<string, string>();
    private byGrant = new Map<string, Set<string>>();
    private byAuthor = new Map<string, Set<string>>();
    private byTarget = new Map<string, Set<string>>();

    // Records the accepted history of a DID, replacing any held for it. An empty
    // history removes the DID. Histories of DIDs that are neither objects nor
    // grants are kept out.
    put(did: string, history: AcceptedEvent[]): void {
        const data = history[0]?.operation?.data;
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
        const before = this.publications.get(did)?.memeplex;
        const history = this.histories.get(did);
        const claimed = history?.[0]?.operation?.data?.memeplex;

        // The grant link follows what the creation claims, so that the object is
        // attributed again when that grant's history arrives or changes.
        this.unlink(this.byGrant, this.grantOf.get(did), did);
        this.grantOf.delete(did);
        this.unlink(this.byAuthor, before?.author, did);
        this.unlink(this.byTarget, before?.target, did);
        this.publications.delete(did);

        if (!history || claimed === undefined) {
            return;
        }

        if (typeof claimed?.grant === 'string') {
            this.grantOf.set(did, claimed.grant);
            this.link(this.byGrant, claimed.grant, did);
        }

        const publication = attribute(history, this.histories.get(claimed?.grant) ?? []);

        // Only an attributed object appears anywhere: a claim is not a publication.
        if (publication.current !== undefined) {
            this.publications.set(did, publication);
            this.link(this.byAuthor, publication.memeplex!.author, did);
            this.link(this.byTarget, publication.memeplex!.target, did);
        }
    }

    private under(index: Map<string, Set<string>>, key: string): Publication[] {
        return [...index.get(key) ?? []].map(did => this.publications.get(did)!);
    }

    // The publication of an object, published or withdrawn. An object with no
    // attributed version has none.
    publication(did: string): Publication | undefined {
        return this.publications.get(did);
    }

    // What the authors have published and not withdrawn, newest first: posts,
    // papers and replies.
    timeline(authors: string[]): Publication[] {
        return [...new Set(authors)]
            .flatMap(author => this.under(this.byAuthor, author))
            .filter(each => each.state === 'published' && ['post', 'paper', 'reply'].includes(kindOf(each)!))
            .sort(newestFirst);
    }

    // The replies to an object, each with its own, oldest first. A withdrawn reply
    // stays as a tombstone so that the replies under it keep their place.
    thread(target: string, seen = new Set<string>()): Reply[] {
        // A target is a DID anyone can write, so a reply may name one that names it back.
        if (seen.has(target)) {
            return [];
        }

        const below = new Set(seen).add(target);

        return this.under(this.byTarget, target)
            .filter(each => kindOf(each) === 'reply')
            .sort((a, b) => newestFirst(b, a))
            .map(publication => ({ publication, replies: this.thread(publication.did!, below) }));
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
