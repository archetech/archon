import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { load } from 'js-yaml';

// minimal-sample.env and the compose fragments hold the same variable list in
// two places. Compose does not fail on a missing variable -- it substitutes an
// empty string and warns -- so a fragment gaining a variable the sample never
// grows produces a stack that starts and then misbehaves (#954 was that class
// of drift, across three workflow matrices).

const MINIMAL = 'docker/compose/minimal.yml';
const SAMPLE = 'minimal-sample.env';

// ${VAR}, ${VAR:-default} and ${VAR?err}. Only the bare form needs the sample:
// the others carry their own fallback.
const INTERPOLATION = /\$\{([A-Za-z_][A-Za-z0-9_]*)(:?[-?+][^}]*)?\}/g;

function includedFragments(): string[] {
    const dir = dirname(MINIMAL);
    const doc = load(readFileSync(MINIMAL, 'utf-8')) as any;
    const include = doc?.include;

    // Guard the guard: a restructured minimal.yml must not leave every
    // assertion below comparing two empty sets.
    expect(Array.isArray(include)).toBe(true);
    expect(include.length).toBeGreaterThan(0);

    return include.map((entry: string) =>
        // The flavor selectors are the only interpolation in the include list;
        // resolve them to their defaults, which is what an unset .env yields.
        join(dir, entry.replace(INTERPOLATION, (_m, _v, fallback) =>
            fallback ? fallback.replace(/^:?-/, '') : '')));
}

function requiredVariables(): Set<string> {
    const required = new Set<string>();

    for (const fragment of includedFragments()) {
        const text = readFileSync(fragment, 'utf-8');
        for (const [, name, fallback] of text.matchAll(INTERPOLATION)) {
            // ${VAR?err} and ${VAR:?err} carry no fallback -- compose demands the
            // variable be set -- so they are required just as a bare ${VAR} is.
            if (!fallback || fallback.startsWith('?') || fallback.startsWith(':?')) {
                required.add(name);
            }
        }
    }
    return required;
}

function sampleVariables(): Set<string> {
    const text = readFileSync(SAMPLE, 'utf-8');
    const names = [...text.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)=/gm)].map(m => m[1]);

    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);

    return new Set(names);
}

describe('minimal-sample.env', () => {
    it('defines every variable the minimal stack leaves without a default', () => {
        const missing = [...requiredVariables()].filter(v => !sampleVariables().has(v));
        expect(missing.sort()).toEqual([]);
    });

    it('carries nothing the minimal stack does not read', () => {
        const required = requiredVariables();

        // COMPOSE_PROFILES is read by compose itself rather than interpolated
        // by a fragment, so it never appears in the scan above.
        const extra = [...sampleVariables()]
            .filter(v => v !== 'COMPOSE_PROFILES' && !required.has(v));
        expect(extra.sort()).toEqual([]);
    });

    it('selects the profile of every service the fragments gate', () => {
        const selected = readFileSync(SAMPLE, 'utf-8')
            .match(/^COMPOSE_PROFILES=(.*)$/m)?.[1].split(',').map(p => p.trim()) ?? [];

        // A profile-gated service is silently absent when its profile is not
        // selected: the stack comes up, minus the mediator that services the
        // registry the gatekeeper is configured to publish to.
        const gated = new Set<string>();
        for (const fragment of includedFragments()) {
            const doc = load(readFileSync(fragment, 'utf-8')) as any;
            for (const service of Object.values(doc?.services ?? {}) as any[]) {
                for (const profile of service?.profiles ?? []) {
                    gated.add(profile);
                }
            }
        }

        expect(gated.size).toBeGreaterThan(0);
        expect([...gated].filter(p => !selected.includes(p)).sort()).toEqual([]);
    });

    it('agrees with sample.env wherever both set the same variable', () => {
        const parse = (path: string) => new Map(
            [...readFileSync(path, 'utf-8').matchAll(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/gm)]
                .map(m => [m[1], m[2]]));

        const full = parse('sample.env');

        // COMPOSE_PROFILES is the one variable the two files are meant to
        // disagree on: sample.env selects every profile a full node runs.
        const divergent = [...parse(SAMPLE)]
            .filter(([name]) => name !== 'COMPOSE_PROFILES')
            .filter(([name, value]) => full.has(name) && full.get(name) !== value)
            .map(([name]) => name);

        expect(divergent.sort()).toEqual([]);
    });
});
