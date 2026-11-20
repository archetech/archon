import type { Publication } from './attribution.js';

// Readings over publications that independent indexers have to agree on:
// docs/plans/memeplex-reference-1436.md, "Ratings" and "Coauthors". Each takes
// publications as `attribute` returns them and looks at nothing else.

// A rating on the scale from 0 (worst) to 1 (best). Anyone can publish a valid
// rating with bounds as large as a number goes, whose difference is not a number
// at all, and one such value would spoil an average. Halving first keeps every
// difference finite and changes no result.
export function ratingValue({ rating, min, max }: { rating: number; min: number; max: number }): number {
    return (rating / 2 - min / 2) / (max / 2 - min / 2);
}

const published = (publication: Publication, kind: string) =>
    publication.state === 'published' && publication.memeplex?.kind === kind;

// The version a publication shows: its identity and when its block was mined.
function shown(publication: Publication) {
    const version = publication.versions[publication.current!];

    return { time: Date.parse(version.outcome === 'attributed' ? version.position.time : ''), opid: version.opid ?? '' };
}

// The rating that counts for each author and target. Two clients can each publish
// one for the same author and target, so of those still published the one whose
// shown version was anchored latest by block time counts, and of two anchored at
// the same time the one with the smaller version identity. A withdrawn rating
// does not count, which leaves the next by the same rule.
export function currentRatings(publications: Publication[]): Publication[] {
    const current = new Map<string, Publication>();

    for (const publication of publications.filter(each => published(each, 'rating'))) {
        const key = JSON.stringify([publication.memeplex!.author, publication.memeplex!.target]);
        const best = current.get(key);
        const [a, b] = [shown(publication), best && shown(best)];

        if (!b || a.time > b.time || (a.time === b.time && a.opid < b.opid)) {
            current.set(key, publication);
        }
    }

    return [...current.values()];
}

export type Coauthor =
    // An attributed `coauthor` tag of theirs pins the revision the paper shows.
    | { did: string; status: 'confirmed' }
    // Their tags pin only other revisions, which are listed. Not a confirmation of
    // the revision shown: the publisher can change a paper and keep the name.
    | { did: string; status: 'confirmed-other'; revisions: string[] }
    // The publisher's claim alone.
    | { did: string; status: 'listed' };

// How each coauthor a paper lists stands towards the revision it shows. `tags` are
// publications that may be coauthor tags on it; any that are not are ignored.
export function coauthors(paper: Publication, tags: Publication[]): Coauthor[] {
    if (!published(paper, 'paper') || paper.did === undefined) {
        return [];
    }

    const revision = paper.versions[paper.current!].opid;
    const listed: string[] = paper.memeplex!.authors.filter((did: string) => did !== paper.memeplex!.author);

    return listed.map(did => {
        const revisions = tags
            .filter(tag => published(tag, 'tag') && tag.memeplex!.tag === 'coauthor'
                && tag.memeplex!.author === did && tag.memeplex!.target === paper.did)
            .map(tag => tag.memeplex!.targetVersion as string);

        if (revision !== undefined && revisions.includes(revision)) {
            return { did, status: 'confirmed' };
        }

        return revisions.length ? { did, status: 'confirmed-other', revisions: [...new Set(revisions)].sort() } : { did, status: 'listed' };
    });
}
