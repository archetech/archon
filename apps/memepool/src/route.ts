// What the pages show is named by their address, so that an address can be
// given to someone else: a publication of any kind by its DID, and an author
// by theirs, with the author's replies apart from their posts.
//
// It is a path under the pages' own, `p/<DID>` and `a/<DID>`, since whatever
// shows a link asks for the address and is given the page that says what is
// there, and the part of an address after a `#` is never asked for. The
// service answers such a path with the page.
export type Route =
    | { publication: string }
    | { author: string; replies?: boolean }
    | null;

const DID = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;

// The path the pages are served under, which ends in a slash. It is where
// their files are, whatever address the page was opened at.
let root = '/';

export function setRoot(path: string): void {
    root = path.endsWith('/') ? path : `${path}/`;
}

const named = (parts: (string | undefined)[]): Route => {
    const [kind, did, rest, ...more] = parts;

    if (more.length > 0 || !DID.test(did ?? '')) {
        return null;
    }
    if (kind === 'p' && rest === undefined) {
        return { publication: did as string };
    }
    if (kind === 'a' && (rest === undefined || rest === 'replies')) {
        return { author: did as string, replies: rest === 'replies' };
    }

    return null;
};

// The route an address names, or none for one that names nothing the pages
// show. The address is whatever was in a link, so a DID is taken only where
// it has the shape of one.
//
// A link made when the route was in the fragment, `#/p/<DID>`, is still read.
export function routeOf(at: Pick<Location, 'pathname' | 'hash'>): Route {
    let path: string;

    try {
        path = decodeURIComponent(at.pathname);
    }
    catch {
        return null;
    }

    const under = path.startsWith(root) ? named(path.slice(root.length).split('/')) : null;

    return under ?? named(at.hash.replace(/^#\/?/, '').split('/'));
}

// The path that names a route, which is the pages' own for the reader's timeline.
export function pathOf(route: Route): string {
    if (!route) {
        return root;
    }

    return 'publication' in route
        ? `${root}p/${route.publication}`
        : `${root}a/${route.author}${route.replies ? '/replies' : ''}`;
}

// The whole address of a route, as it is given to someone else.
export function linkTo(route: Route, from: Pick<Location, 'origin'> = window.location): string {
    return `${from.origin}${pathOf(route)}`;
}
