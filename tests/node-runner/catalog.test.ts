import { readFileSync } from 'fs';
import { isSecret, parseCatalog } from '../../services/node-runner/server/src/catalog.ts';
import { pairingWarnings } from '../../services/node-runner/server/src/profiles.ts';

const SAMPLE = `# General
ARCHON_UID=1000

# Docker Compose optional service profiles. Leave empty for only the core
#   ARCHON_HERALD_URL=      (without the \`herald\` profile)
COMPOSE_PROFILES=hyperswarm

# Security — set these in production deployments
# Bind services to localhost when behind a reverse proxy.
ARCHON_BIND_ADDRESS=0.0.0.0
# REQUIRED. Protects admin API routes.
# Generate with: openssl rand -hex 32
ARCHON_ADMIN_API_KEY=CHANGE_ME

# Core Lightning (ghcr.io/archetech/cln). tor and hybrid modes need the tor
# profile.
ARCHON_CLN_NETWORK_MODE=tor
# Tor SOCKS proxy for onion egress.
# ARCHON_HERALD_TOR_PROXY=tor:9050 # default
ARCHON_HERALD_URL=http://herald:4230

# Security
ARCHON_EXTRA=1
`;

describe('parseCatalog', () => {
    const sections = parseCatalog(SAMPLE);
    const byKey = new Map(sections.flatMap(s => s.settings).map(s => [s.key, s]));

    it('takes section names from the first comment after a blank line', () => {
        expect(sections.map(s => s.name)).toEqual(['General', 'Security', 'Core Lightning']);
    });

    it('describes a setting with the comments directly above it', () => {
        expect(byKey.get('ARCHON_BIND_ADDRESS')).toEqual({
            key: 'ARCHON_BIND_ADDRESS',
            section: 'Security',
            description: 'Bind services to localhost when behind a reverse proxy.',
            default: '0.0.0.0',
            secret: false,
        });
        expect(byKey.get('ARCHON_ADMIN_API_KEY')!.description).toBe('REQUIRED. Protects admin API routes. Generate with: openssl rand -hex 32');
    });

    it('treats a commented-out assignment as optional, with an example value', () => {
        expect(byKey.get('ARCHON_HERALD_TOR_PROXY')).toMatchObject({ default: '', example: 'tor:9050', description: 'Tor SOCKS proxy for onion egress.' });
    });

    it('ignores indented examples in prose and the keys managed elsewhere', () => {
        expect(byKey.get('ARCHON_HERALD_URL')!.section).toBe('Core Lightning');
        expect(byKey.has('COMPOSE_PROFILES')).toBe(false);
    });

    it('merges a section that recurs', () => {
        expect(sections.find(s => s.name === 'Security')!.settings.map(s => s.key)).toEqual(['ARCHON_BIND_ADDRESS', 'ARCHON_ADMIN_API_KEY', 'ARCHON_EXTRA']);
    });

    it('reads the repository sample.env without losing settings', () => {
        const real = readFileSync('sample.env', 'utf-8');
        const keys = parseCatalog(real).flatMap(s => s.settings.map(x => x.key));
        const assigned = [...real.matchAll(/^([A-Z_][A-Z0-9_]*)=/gm)].map(m => m[1]).filter(k => k !== 'COMPOSE_PROFILES');

        expect(keys.length).toBe(new Set(keys).size);
        expect(assigned.filter(k => !keys.includes(k))).toEqual([]);
    });
});

describe('isSecret', () => {
    it.each([
        ['ARCHON_ADMIN_API_KEY', true],
        ['ARCHON_PASSPHRASE', true],
        ['ARCHON_LIGHTNING_MEDIATOR_CLN_RUNE', true],
        ['GRAFANA_ADMIN_PASSWORD', true],
        ['ARCHON_PIN_API_TOKEN', true],
        ['ARCHON_HERALD_IPNS_KEY_NAME', false],
        ['ARCHON_GATEKEEPER_URL', false],
        ['ARCHON_SECRET_FILE', false],
        ['ARCHON_SIGNET_INS_PASS', true],
        ['ARCHON_ETH_RPC_URL', true],
        ['ARCHON_BTC_FALLBACK_RPC_URL', true],
    ])('%s → %s', (key, secret) => {
        expect(isSecret(key)).toBe(secret);
    });

    it('treats any URL carrying a user and password as a secret', () => {
        expect(isSecret('ARCHON_SOME_URL', 'http://user:hunter2@host:8332')).toBe(true);
        expect(isSecret('ARCHON_SOME_URL', 'http://host:8332')).toBe(false);
    });
});

describe('pairingWarnings', () => {
    const catalog = new Map(parseCatalog(`# Drawbridge
# ARCHON_DIDCOMM_URL=http://didcomm:4236
ARCHON_HERALD_URL=
`).flatMap(s => s.settings).map(s => [s.key, s]));

    const messages = (profiles: string[], values: Record<string, string>) =>
        pairingWarnings(profiles, new Map(Object.entries(values)), catalog);

    it('offers the example URL when a profile runs a service Drawbridge does not offer', () => {
        const [warning] = messages(['didcomm', 'drawbridge', 'tor'], {});

        expect(warning.message).toBe('The didcomm profile runs the DIDComm relay, but Drawbridge only offers it when ARCHON_DIDCOMM_URL is set.');
        expect(warning.fix).toEqual({ key: 'ARCHON_DIDCOMM_URL', value: 'http://didcomm:4236', label: 'Set ARCHON_DIDCOMM_URL=http://didcomm:4236' });
    });

    it('offers to clear a URL whose profile is off', () => {
        const [warning] = messages(['drawbridge'], { ARCHON_HERALD_URL: 'http://herald:4230' });

        expect(warning.fix).toEqual({ key: 'ARCHON_HERALD_URL', value: '', label: 'Clear ARCHON_HERALD_URL' });
    });

    it('flags a Tor proxy without tor, fronted services without drawbridge, and mongodb without its profile', () => {
        const all = messages(['didcomm', 'herald'], {
            ARCHON_DIDCOMM_URL: 'http://didcomm:4236',
            ARCHON_HERALD_URL: 'http://herald:4230',
            ARCHON_DIDCOMM_TOR_PROXY: 'tor:9050',
            ARCHON_GATEKEEPER_DB: 'mongodb',
        }).map(w => w.message);

        expect(all).toEqual([
            'The DIDComm relay still points at Tor, which is not enabled; .onion delivery would fail on connect.',
            'herald is enabled without drawbridge, so nothing fronts it.',
            'ARCHON_GATEKEEPER_DB is set to mongodb, which needs the mongodb profile.',
        ]);
    });

    it('uses what Compose would: an absent key falls back to the fragment default, not the sample value', () => {
        // lightning on, its URL absent: Drawbridge gets an empty value.
        expect(messages(['lightning', 'drawbridge'], {}).map(w => w.message)).toContain(
            'The lightning profile runs Lightning, but Drawbridge only offers it when ARCHON_LIGHTNING_MEDIATOR_URL is set.');
        // Tor proxy absent: Compose defaults it to tor:9050.
        expect(messages(['didcomm', 'drawbridge'], { ARCHON_DIDCOMM_URL: 'http://didcomm:4236' }).map(w => w.message)).toContain(
            'The DIDComm relay still points at Tor, which is not enabled; .onion delivery would fail on connect.');
        // Set empty: no proxy, nothing to warn about.
        expect(messages(['didcomm', 'drawbridge'], { ARCHON_DIDCOMM_URL: 'http://didcomm:4236', ARCHON_DIDCOMM_TOR_PROXY: '' })).toEqual([]);
    });

    it('is quiet for a consistent configuration', () => {
        expect(messages(['drawbridge', 'herald', 'tor'], { ARCHON_HERALD_URL: 'http://herald:4230' })).toEqual([]);
    });
});
