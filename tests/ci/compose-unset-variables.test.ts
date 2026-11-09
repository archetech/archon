import { readFileSync, globSync } from 'fs';

// Compose warns "The X variable is not set" for every ${X} without a fallback
// that the environment leaves unset, whether or not the service using it runs.
// A setting sample.env only mentions in a comment is unset on a node configured
// from it, so its reference needs a fallback; `${X:-}` passes an empty value,
// which the service reads as its own default.

const COMPOSE = globSync('docker/compose/*.yml')
    .concat(globSync('docker-compose*.yml'))
    .filter(path => !path.endsWith('gatekeeper-parity.yml'));

describe('compose variables without a fallback', () => {
    const sample = readFileSync('sample.env', 'utf-8');
    const assigned = new Set([...sample.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map(m => m[1]));

    const bare = new Map<string, Set<string>>();
    for (const path of COMPOSE) {
        for (const [, name] of readFileSync(path, 'utf-8').matchAll(/\$\{(ARCHON_[A-Z0-9_]+)\}/g)) {
            bare.set(name, (bare.get(name) ?? new Set()).add(path));
        }
    }

    it('finds the references it is meant to check', () => {
        expect(bare.has('ARCHON_ADMIN_API_KEY')).toBe(true);
    });

    it('are all assigned in sample.env', () => {
        const unassigned = [...bare.entries()]
            .filter(([name]) => !assigned.has(name))
            .map(([name, paths]) => `${name} (${[...paths].join(', ')})`);

        expect(unassigned).toEqual([]);
    });
});
