// What the pages show is named by the fragment of their address, so that an
// address can be given to someone else: a publication of any kind by its DID,
// and an author by theirs, with the author's replies apart from their posts.
// It is the fragment because the pages are files served under whatever path
// their node gives them, and a fragment needs nothing of the server.
export type Route =
    | { publication: string }
    | { author: string; replies?: boolean }
    | null;

const DID = /^did:[a-z0-9]+:[A-Za-z0-9._%-]+$/;

// The route a fragment names, or none for one that names nothing the pages
// show. The fragment is whatever was in a link, so a DID is taken only where
// it has the shape of one.
export function routeOf(hash: string): Route {
    const [, kind, did, rest, ...more] = hash.replace(/^#/, '').split('/');

    if (more.length > 0 || !DID.test(did ?? '')) {
        return null;
    }
    if (kind === 'p' && rest === undefined) {
        return { publication: did };
    }
    if (kind === 'a' && (rest === undefined || rest === 'replies')) {
        return { author: did, replies: rest === 'replies' };
    }

    return null;
}

// The fragment that names a route, which is empty for the reader's timeline.
export function hashOf(route: Route): string {
    if (!route) {
        return '';
    }

    return 'publication' in route
        ? `#/p/${route.publication}`
        : `#/a/${route.author}${route.replies ? '/replies' : ''}`;
}

// The whole address of a route, as it is given to someone else.
export function linkTo(route: Route, from: Pick<Location, 'origin' | 'pathname' | 'search'> = window.location): string {
    return `${from.origin}${from.pathname}${from.search}${hashOf(route)}`;
}
