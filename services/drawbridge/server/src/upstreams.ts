// Drawbridge offers an optional service (capability true, routes proxied)
// exactly when that service's upstream URL is non-empty.
//
// Under Compose, ARCHON_COMPOSE_PROFILES carries the node's COMPOSE_PROFILES,
// and a URL that .env leaves empty points at the service's container when its
// profile is enabled and stays off when it is not. So a node offers what it
// runs without setting URLs, and does not advertise what it does not run.
//
// Outside Compose that variable is absent: an unset URL falls back to the
// service on localhost and an empty one turns the service off.
//
// A URL that is set is always used as given, for example an upstream on
// another host.

export interface Upstream {
    variable: string;
    profile: string;
    container: string;
    standalone: string;
}

export const UPSTREAMS = {
    herald: { variable: 'ARCHON_HERALD_URL', profile: 'herald', container: 'http://herald:4230', standalone: 'http://localhost:4230' },
    lightningMediator: { variable: 'ARCHON_LIGHTNING_MEDIATOR_URL', profile: 'lightning', container: 'http://lightning-mediator:4235', standalone: 'http://localhost:4235' },
    explorer: { variable: 'ARCHON_EXPLORER_URL', profile: 'explorer', container: 'http://explorer:4000', standalone: 'http://localhost:4000' },
    didcomm: { variable: 'ARCHON_DIDCOMM_URL', profile: 'didcomm', container: 'http://didcomm:4236', standalone: 'http://localhost:4236' },
    // A node without a mint must not advertise one, so there is no
    // standalone default.
    cashuMint: { variable: 'ARCHON_CASHU_MINT_URL', profile: 'cashu', container: 'http://cashu-mint:8085', standalone: '' },
} satisfies Record<string, Upstream>;

export function upstreamURL(upstream: Upstream, env: NodeJS.ProcessEnv = process.env): string {
    const value = env[upstream.variable];
    if (value) {
        return value;
    }
    const profiles = env.ARCHON_COMPOSE_PROFILES;
    if (profiles === undefined) {
        return value ?? upstream.standalone;
    }
    // `*` enables every profile, as it does for Compose.
    const enabled = profiles.split(',').map(p => p.trim());
    return enabled.includes('*') || enabled.includes(upstream.profile) ? upstream.container : '';
}
