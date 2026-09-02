import { readFileSync } from 'fs';
import { globSync } from 'fs';
import { load } from 'js-yaml';

// A service with no profile always starts; a gated one starts only when its
// profile is selected. So a required dependency on a gated service is only
// satisfiable when every profile that starts the dependent also starts the
// dependency -- an ungated dependent never qualifies, and a dependent gated
// behind some other profile qualifies only if its profiles are a subset.

const COMPOSE = globSync('docker/compose/*.yml').concat(globSync('docker-compose*.yml'));

type Service = { profiles?: string[], depends_on?: unknown };

function servicesOf(path: string): Record<string, Service> {
    const doc = load(readFileSync(path, 'utf-8')) as any;
    return doc?.services ?? {};
}

// `required: false` depends on a service that may not be in the project: the
// ordering is honoured when it runs and skipped otherwise. Only a required
// dependency can strand the dependent.
function requiredDependencies(dependsOn: unknown): string[] {
    if (Array.isArray(dependsOn)) {
        return dependsOn as string[];
    }
    if (dependsOn && typeof dependsOn === 'object') {
        return Object.entries(dependsOn as Record<string, { required?: boolean }>)
            .filter(([, options]) => options?.required !== false)
            .map(([name]) => name);
    }
    return [];
}

describe('compose profiles', () => {
    // Gathered across every fragment: a service is defined in one file and
    // depended on from another, so neither side alone shows the pairing.
    const gated = new Map<string, Set<string>>();
    const dependencies: { from: string, on: string, path: string }[] = [];

    for (const path of COMPOSE) {
        for (const [name, service] of Object.entries(servicesOf(path))) {
            if (service?.profiles?.length) {
                gated.set(name, new Set(service.profiles));
            }
            for (const on of requiredDependencies(service?.depends_on)) {
                dependencies.push({ from: name, on, path });
            }
        }
    }

    it('reads the fragments it is meant to check', () => {
        expect(COMPOSE.length).toBeGreaterThan(10);
        expect(dependencies.length).toBeGreaterThan(0);

        // Named rather than counted: the assertion below stays green on any
        // non-empty set, so a service losing its gate would go unnoticed.
        expect([...gated.get('mongodb') ?? []]).toEqual(['mongodb']);
        expect([...gated.get('hyperswarm-mediator') ?? []]).toEqual(['hyperswarm']);
    });

    it('are not required by services their profile does not start', () => {
        const unsatisfiable = dependencies
            .filter(({ from, on }) => {
                const target = gated.get(on);
                if (!target) {
                    return false;
                }
                const source = gated.get(from);
                return !source || [...source].some(profile => !target.has(profile));
            })
            .map(({ from, on, path }) => {
                const source = [...gated.get(from) ?? []];
                const where = source.length ? `starts under ${source.join(',')}` : 'always starts';
                return `${path}: ${from} ${where} but requires ${on}, gated behind ${[...gated.get(on)!].join(',')}`;
            });

        expect([...new Set(unsatisfiable)].sort()).toEqual([]);
    });
});
