// The route label for a finished request. It reads originalUrl, not path: a
// handler mounted with app.use() sees req.path without its mount prefix, and
// still does when the response finishes, so `/cashu/v1/keys/<id>` would be
// labelled `/v1/keys/<id>` and miss the replacements below.
export function routeLabel(req: { originalUrl: string }): string {
    return normalizePath(req.originalUrl.split('?')[0]);
}

// A path is a caller's to choose, and a label is a series the node keeps for
// as long as it runs. Two bounds keep a caller from making series at will.

// The label of every request that no route or mount took.
export const UNROUTED = '/:unrouted';

// Mounted after every route and mount, so it is reached only by a request that
// none of them took. It marks the request and passes it on to Express's own 404.
export function markUnrouted(
    _req: unknown,
    res: { locals: Record<string, unknown> },
    next: () => void,
): void {
    res.locals.unrouted = true;
    next();
}

// The label a finished request is recorded under.
//
// A request that matched a declared route is labelled by that route's own
// pattern under its mount, `/api/v1/did/:did`: the routes are the code's, so
// these labels are a fixed set and are never crowded out. A request taken by a
// mount that forwards it has only its path, which is normalized and then
// bounded.
export function requestLabel(
    req: { originalUrl: string; baseUrl?: string; route?: { path?: unknown } },
    res: { locals: Record<string, unknown> },
    bounded: (label: string) => string,
): string {
    if (res.locals.unrouted) {
        return UNROUTED;
    }
    if (typeof req.route?.path === 'string') {
        // The mount is given as the caller wrote it, and Express matches it in
        // any case. Drawbridge's mounts are lower-case.
        return `${(req.baseUrl ?? '').toLowerCase()}${req.route.path}`;
    }
    return bounded(routeLabel(req));
}

// The label of a request whose own label would be one too many.
export const OVERFLOW = '/:other';

// How many labels a node keeps for the paths its proxy mounts forward.
export const MAX_ROUTE_LABELS = 500;

// Lets the first `limit` distinct labels through and gives every later one
// the overflow label. A proxy mount forwards whatever follows its prefix, so
// the paths under it cannot be listed, and this is what bounds them. Declared
// routes do not pass through it: see requestLabel.
export function labelLimiter(limit: number = MAX_ROUTE_LABELS): (label: string) => string {
    const kept = new Set<string>();

    return label => {
        if (kept.has(label)) {
            return label;
        }
        if (kept.size >= limit) {
            return OVERFLOW;
        }
        kept.add(label);
        return label;
    };
}

// Route labels for Drawbridge's request metrics. Dynamic segments (DIDs, CIDs,
// registries, identifiers) are replaced with placeholders so dashboards do not
// get one time series per identifier.
export function normalizePath(path: string): string {
    const label = path
        .replace(/\/did\/(?:did:[^/]+|did%3[aA][^/]+)/, '/did/:did')
        .replace(/\/identifiers\/(?:did:[^/]+|did%3[aA][^/]+)/, '/identifiers/:did')
        .replace(/\/invoice\/(?:did:[^/]+|did%3[aA][^/]+)/, '/invoice/:did')
        .replace(/\/ipfs\/json\/[^/]+/, '/ipfs/json/:cid')
        .replace(/\/ipfs\/text\/[^/]+/, '/ipfs/text/:cid')
        .replace(/\/ipfs\/data\/[^/]+/, '/ipfs/data/:cid')
        .replace(/\/ipfs\/stream\/[^/]+/, '/ipfs/stream/:cid')
        .replace(/\/queue\/[^/]+/, '/queue/:registry')
        .replace(/\/block\/[^/]+\/latest/, '/block/:registry/latest')
        .replace(/\/block\/[^/]+\/[^/]+/, '/block/:registry/:blockId')
        .replace(/\/payments\/[^/]+/, '/payments/:did')
        // Herald's Personal Agent Protocol routes carry a sign-in ID, a name,
        // a DID or an agent ID; each sign-in would otherwise add a series.
        .replace(/\/poppy\/signin\/(?!response$)[^/]+/, '/poppy/signin/:id')
        .replace(/\/poppy\/api\/(names|members)\/[^/]+/, '/poppy/api/$1/:name')
        .replace(/\/poppy\/api\/dids\/[^/]+/, '/poppy/api/dids/:did')
        .replace(/\/api\/poppy\/connections\/[^/]+/, '/api/poppy/connections/:id')
        // Cashu mint routes carry keyset and quote IDs, and a payment method
        // the caller chooses.
        .replace(/\/cashu\/v1\/keys\/[^/]+/, '/cashu/v1/keys/:keyset')
        .replace(/\/cashu\/v1\/(mint|melt)\/quote\/[^/]+\/[^/]+/, '/cashu/v1/$1/quote/:method/:quote')
        .replace(/\/cashu\/v1\/(mint|melt)\/quote\/[^/]+$/, '/cashu/v1/$1/quote/:method')
        .replace(/\/cashu\/v1\/(mint|melt)\/(?!quote$)[^/]+$/, '/cashu/v1/$1/:method')
        // The Memeplex indexer's views of one object carry its DID, or whatever
        // a caller sends in its place.
        .replace(/\/memeplex\/api\/v1\/(publications|threads|boosts|ratings|tags|coauthors)\/[^/]+/, '/memeplex/api/v1/$1/:did')
        // An object Memepool changes or withdraws is named by its DID, as is
        // the identity whose avatar or name it serves, and an image it serves.
        .replace(/\/memepool\/api\/v1\/(objects|avatars|identities|images)\/[^/]+/, '/memepool/api/v1/$1/:did');

    // The indexer's routes are few and fixed, and its mount is public, so a
    // path under it that is none of them shares one label.
    if ((label === '/memeplex' || label.startsWith('/memeplex/')) && !MEMEPLEX_ROUTES.test(label)) {
        return '/memeplex/:other';
    }

    if ((label === '/memepool' || label.startsWith('/memepool/')) && !MEMEPOOL_ROUTES.test(label)) {
        return '/memepool/:other';
    }

    return label;
}

const MEMEPOOL_ROUTES = /^\/memepool\/api\/v1\/(?:ready|version|config|challenge|callback|login|logout|me|objects(?:\/:did(?:\/(?:content|state))?)?|images|(?:avatars|identities|images)\/:did)$/;
const MEMEPLEX_ROUTES = /^\/memeplex\/api\/v1\/(?:ready|version|status|timeline|(?:publications|threads|boosts|ratings|tags|coauthors)\/:did)$/;
