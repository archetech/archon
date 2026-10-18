// Route labels for Drawbridge's request metrics. Dynamic segments (DIDs, CIDs,
// registries, identifiers) are replaced with placeholders so dashboards do not
// get one time series per identifier.
export function normalizePath(path: string): string {
    return path
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
        .replace(/\/api\/poppy\/connections\/[^/]+/, '/api/poppy/connections/:id');
}
