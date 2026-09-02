import { readFileSync } from 'fs';
import { globSync } from 'fs';
import { load } from 'js-yaml';

// A service with no profile always starts; a gated one starts only when its
// profile is selected. So an ungated service that requires a gated one waits on
// something that need never arrive. Gated services depending on each other are
// fine, being selected together.

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
    const gated = new Set<string>();
    const dependencies: { from: string, on: string, path: string }[] = [];

    for (const path of COMPOSE) {
        for (const [name, service] of Object.entries(servicesOf(path))) {
            if (service?.profiles?.length) {
                gated.add(name);
            }
            for (const on of requiredDependencies(service?.depends_on)) {
                dependencies.push({ from: name, on, path });
            }
        }
    }

    it('reads the fragments it is meant to check', () => {
        expect(COMPOSE.length).toBeGreaterThan(10);
        expect(gated.size).toBeGreaterThan(0);
        expect(dependencies.length).toBeGreaterThan(0);
    });

    it('are not depended on by services that always start', () => {
        const unsatisfiable = dependencies
            .filter(({ from, on }) => gated.has(on) && !gated.has(from))
            .map(({ from, on, path }) => `${path}: ${from} always starts but requires ${on}, which is profile-gated`);

        expect([...new Set(unsatisfiable)].sort()).toEqual([]);
    });
});
