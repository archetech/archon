import { readFileSync } from 'fs';
import { globSync } from 'fs';
import { load } from 'js-yaml';

// Drawbridge reports an optional service as available whenever that service's
// URL is non-empty (#1552). A compose default naming a container gated behind
// a profile the reader does not share therefore advertises the service on
// every node that leaves the variable unset, whether or not the profile runs.
// Such defaults have to be empty, with the URL set alongside the profile.

const COMPOSE = globSync('docker/compose/*.yml').concat(globSync('docker-compose*.yml'));

type Service = { profiles?: string[], environment?: unknown };

function servicesOf(path: string): Record<string, Service> {
    const doc = load(readFileSync(path, 'utf-8')) as any;
    return doc?.services ?? {};
}

function environmentEntries(environment: unknown): string[] {
    if (Array.isArray(environment)) {
        return environment.map(String);
    }
    if (environment && typeof environment === 'object') {
        return Object.entries(environment as Record<string, unknown>).map(([name, value]) => `${name}=${value ?? ''}`);
    }
    return [];
}

// ARCHON_X_URL=${ARCHON_X_URL-http://host:port} (or :-), returning the host,
// which is empty for an empty default.
function defaultHost(entry: string): { name: string, host: string } | null {
    const match = entry.match(/^([A-Z][A-Z0-9_]*_URL)=\$\{[A-Z][A-Z0-9_]*:?-([^}]*)\}$/);
    if (!match) {
        return null;
    }
    if (!match[2]) {
        return { name: match[1], host: '' };
    }
    try {
        return { name: match[1], host: new URL(match[2]).hostname };
    }
    catch {
        return null;
    }
}

describe('compose URL defaults', () => {
    const gated = new Map<string, Set<string>>();
    const defaults: { service: string, name: string, host: string, path: string }[] = [];

    for (const path of COMPOSE) {
        for (const [name, service] of Object.entries(servicesOf(path))) {
            if (service?.profiles?.length) {
                gated.set(name, new Set(service.profiles));
            }
            for (const entry of environmentEntries(service?.environment)) {
                const parsed = defaultHost(entry);
                if (parsed) {
                    defaults.push({ service: name, ...parsed, path });
                }
            }
        }
    }

    it('reads the defaults it is meant to check', () => {
        expect(defaults.length).toBeGreaterThan(0);
        expect([...gated.get('lightning-mediator') ?? []]).toEqual(['lightning']);
        expect(defaults.map(({ name }) => name)).toContain('ARCHON_LIGHTNING_MEDIATOR_URL');
    });

    it('do not name a container the reader\'s profiles do not start', () => {
        const stranded = defaults
            .filter(({ service, host }) => {
                const target = gated.get(host);
                if (!target) {
                    return false;
                }
                const source = gated.get(service);
                return !source || [...source].some(profile => !target.has(profile));
            })
            .map(({ service, name, host, path }) =>
                `${path}: ${service} defaults ${name} to ${host}, gated behind ${[...gated.get(host)!].join(',')}`);

        expect(stranded.sort()).toEqual([]);
    });
});
