// What the pages show is named by their address, so that an address can be
// given to someone else: a publication of any kind by its DID, and an author
// by theirs, with the author's articles, papers and replies each apart from
// their posts.
//
// It is a path under the pages' own, `p/<DID>` and `a/<DID>`, since whatever
// shows a link asks for the address and is given the page that says what is
// there, and the part of an address after a `#` is never asked for. The
// service answers such a path with the page.
// What of an author's is listed: their posts, which is what an author's
// address names by itself, or their articles, their papers or their replies.
export const LISTS = ['posts', 'articles', 'papers', 'replies'] as const;
export type Listing = typeof LISTS[number];

export type Route =
    | { publication: string }
    | { author: string; list?: Listing }
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
    if (kind === 'a' && (rest === undefined || (rest !== 'posts' && (LISTS as readonly string[]).includes(rest)))) {
        return { author: did as string, list: (rest ?? 'posts') as Listing };
    }

    return null;
};

// The route an address names, or none for one that names nothing the pages
// show. The address is whatever was in a link, so a DID is taken only where
// it has the shape of one.
export function routeOf(at: Pick<Location, 'pathname'>): Route {
    let path: string;

    try {
        path = decodeURIComponent(at.pathname);
    }
    catch {
        return null;
    }

    return path.startsWith(root) ? named(path.slice(root.length).split('/')) : null;
}

// The path that names a route, which is the pages' own for the reader's timeline.
export function pathOf(route: Route): string {
    if (!route) {
        return root;
    }

    if ('publication' in route) {
        return `${root}p/${route.publication}`;
    }

    // An author's posts are at the author's own address, and each other list under it.
    const list = route.list && route.list !== 'posts' ? `/${route.list}` : '';

    return `${root}a/${route.author}${list}`;
}

// The whole address of a route, as it is given to someone else.
export function linkTo(route: Route, from: Pick<Location, 'origin'> = window.location): string {
    return `${from.origin}${pathOf(route)}`;
}
