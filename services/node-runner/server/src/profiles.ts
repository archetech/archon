import type { CatalogSetting } from './catalog.js';

export const PROFILE_DESCRIPTIONS: Record<string, string> = {
    hyperswarm: 'Peer-to-peer gossip of DID operations.',
    cli: 'Command-line container for the Archon CLI.',
    explorer: 'Public DID explorer.',
    'gatekeeper-client': 'Gatekeeper demo client.',
    'keymaster-client': 'Keymaster demo client.',
    'react-wallet': 'Browser wallet.',
    observability: 'Prometheus and Grafana, with alerting.',
    mongodb: 'MongoDB, for any database setting set to mongodb.',
    'btc-mainnet': 'Bitcoin mainnet registry.',
    'btc-signet': 'Bitcoin signet registry.',
    'btc-testnet4': 'Bitcoin testnet4 registry with its own node.',
    'btc-testnet4-hosted': 'Bitcoin testnet4 registry on a hosted node.',
    lightning: 'Core Lightning, LNbits, RTL and the Lightning mediator.',
    drawbridge: 'The node’s front-door proxy.',
    herald: 'Names and .well-known endpoints.',
    tor: 'Onion hidden service for Drawbridge and Lightning.',
    didcomm: 'DIDComm relay mailbox.',
    cashu: 'Cashu ecash mint on the node’s Lightning node (experimental).',
    'zcash-mainnet': 'Zcash mainnet registry.',
    'eth-mainnet': 'Ethereum mainnet registry.',
    'eth-sepolia': 'Ethereum Sepolia registry.',
    'sol-mainnet': 'Solana mainnet registry.',
    'sol-devnet': 'Solana devnet registry.',
    pinning: 'Pins operations to an IPFS pinning service.',
    filecoin: 'Filecoin storage for operations.',
};

export interface Warning {
    message: string;
    fix?: { key: string, value: string, label: string };
}

export function parseProfiles(value: string | undefined): string[] {
    return (value ?? '').split(',').map(p => p.trim()).filter(Boolean);
}

// Drawbridge offers a service when its upstream URL is set, independently of
// whether the profile that runs it is enabled (see sample.env). Both or neither.
const UPSTREAMS: { profile: string, key: string, what: string }[] = [
    { profile: 'didcomm', key: 'ARCHON_DIDCOMM_URL', what: 'the DIDComm relay' },
    { profile: 'herald', key: 'ARCHON_HERALD_URL', what: 'Herald' },
    { profile: 'explorer', key: 'ARCHON_EXPLORER_URL', what: 'the explorer' },
    { profile: 'lightning', key: 'ARCHON_LIGHTNING_MEDIATOR_URL', what: 'Lightning' },
];

const FRONTED = ['herald', 'lightning', 'tor'];

// Defaults the Compose fragments apply when a key is absent (`${KEY-default}`).
const COMPOSE_DEFAULTS: Record<string, string> = {
    ARCHON_DIDCOMM_TOR_PROXY: 'tor:9050',
};

// Settings that only work together with a profile, checked against the
// values the node would run with.
export function pairingWarnings(
    profiles: string[],
    values: Map<string, string>,
    catalog: Map<string, CatalogSetting>,
): Warning[] {
    const on = new Set(profiles);
    // What Compose would use: the .env value when the key is there (even if
    // empty), otherwise the fragment's own default. sample.env values are
    // examples, used only to suggest a fix.
    const value = (key: string) => values.has(key) ? values.get(key)! : COMPOSE_DEFAULTS[key] ?? '';
    const warnings: Warning[] = [];

    for (const { profile, key, what } of UPSTREAMS) {
        const url = value(key);
        const example = catalog.get(key)?.example || catalog.get(key)?.default;
        if (on.has(profile) && !url) {
            warnings.push({
                message: `The ${profile} profile runs ${what}, but Drawbridge only offers it when ${key} is set.`,
                ...(example ? { fix: { key, value: example, label: `Set ${key}=${example}` } } : {}),
            });
        }
        if (!on.has(profile) && url) {
            warnings.push({
                message: `${key} is set without the ${profile} profile, so Drawbridge would offer ${what} while it is not running.`,
                fix: { key, value: '', label: `Clear ${key}` },
            });
        }
    }

    if (on.has('didcomm') && !on.has('tor') && value('ARCHON_DIDCOMM_TOR_PROXY')) {
        warnings.push({
            message: 'The DIDComm relay still points at Tor, which is not enabled; .onion delivery would fail on connect.',
            fix: { key: 'ARCHON_DIDCOMM_TOR_PROXY', value: '', label: 'Clear ARCHON_DIDCOMM_TOR_PROXY' },
        });
    }

    if (!on.has('drawbridge')) {
        for (const profile of FRONTED.filter(p => on.has(p))) {
            warnings.push({ message: `${profile} is enabled without drawbridge, so nothing fronts it.` });
        }
    }

    const mongo = [...values.entries()].filter(([key, v]) => /_DB$/.test(key) && v === 'mongodb').map(([key]) => key);
    if (mongo.length && !on.has('mongodb')) {
        warnings.push({ message: `${mongo.join(', ')} ${mongo.length === 1 ? 'is' : 'are'} set to mongodb, which needs the mongodb profile.` });
    }

    return warnings;
}

// The placeholder sample.env puts in settings that must be chosen.
export const PLACEHOLDER = 'CHANGE_ME';

// Settings a node cannot run correctly without. `ids` is the user node-runner
// runs as, which is the operator: the value ARCHON_UID and ARCHON_GID need.
export function requiredWarnings(values: Map<string, string>, ids: { uid: number, gid: number }): Warning[] {
    const warnings: Warning[] = [];
    for (const [key, id] of [['ARCHON_UID', ids.uid], ['ARCHON_GID', ids.gid]] as const) {
        if (!values.get(key)) {
            warnings.push({
                message: `${key} is not set, so services that run as the node's user run as root and leave root-owned files in data/.`,
                fix: { key, value: String(id), label: `Set ${key}=${id}` },
            });
        }
    }
    const secrets: [string, string][] = [
        ['ARCHON_ADMIN_API_KEY', 'Gatekeeper will not start without it. Generate one with `openssl rand -hex 32`.'],
        ['ARCHON_PASSPHRASE', 'Keymaster will not start without it. It encrypts the wallet, so change it only on a node with no wallet yet.'],
    ];
    for (const [key, why] of secrets) {
        const value = values.get(key);
        if (!value) {
            warnings.push({ message: `${key} is not set. ${why}` });
        }
        else if (value === PLACEHOLDER) {
            warnings.push({ message: `${key} is still the sample placeholder ${PLACEHOLDER}. ${why}` });
        }
    }
    return warnings;
}
