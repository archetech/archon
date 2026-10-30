import { execFileSync, execSync } from 'child_process';
import { existsSync, readFileSync, statSync } from 'fs';

// scripts/ci-affected.sh lets documentation and test-only changes skip the
// image builds and the suites. A path it wrongly classifies as irrelevant
// would let a breaking change merge with those checks skipped, so the image
// inputs are derived here from what the Dockerfiles actually copy.

function affected(paths: string[]): Record<string, string> {
    const output = execFileSync('scripts/ci-affected.sh', ['--paths'], {
        input: paths.join('\n'),
        encoding: 'utf-8',
    });
    return Object.fromEntries(output.trim().split('\n').map(line => line.split('=') as [string, string]));
}

function dockerfiles(): string[] {
    return execSync('git ls-files', { encoding: 'utf-8' })
        .split('\n')
        .filter(path => /(^|\/)Dockerfile(\.|$)/.test(path));
}

// A path a change to this COPY source would touch: a file the glob matches,
// or a file inside the directory.
function representative(source: string): string {
    const path = source.replace(/^\.\//, '').replace(/\/$/, '');
    if (path === '' || path === '.') {
        return 'example';
    }
    if (path.includes('*')) {
        return path.replace(/\*/g, '');
    }
    return existsSync(path) && statSync(path).isDirectory() ? `${path}/example` : path;
}

// Every COPY source from the build context, as a path a change could touch.
function copySources(): string[] {
    const sources = new Set<string>();
    for (const file of dockerfiles()) {
        for (const line of readFileSync(file, 'utf-8').split('\n')) {
            const match = line.match(/^\s*COPY\s+(.*)$/i);
            if (!match || /--from=/.test(match[1])) {
                continue;
            }
            const args = match[1].split(/\s+/).filter(arg => arg && !arg.startsWith('--'));
            for (const source of args.slice(0, -1)) {
                sources.add(representative(source));
            }
        }
    }
    return [...sources].sort();
}

// Paths written as literals in these sources, relative to the repo root.
function literalPaths(files: string[], pattern: RegExp): string[] {
    const paths = new Set<string>();
    for (const file of files) {
        for (const match of readFileSync(file, 'utf-8').matchAll(pattern)) {
            paths.add(match[1].replace(/^(\.\.?\/)+/, ''));
        }
    }
    return [...paths].sort();
}

// Documents the tests read: these are suite inputs, not prose.
function documentInputs(): string[] {
    const tests = execSync('git ls-files tests', { encoding: 'utf-8' })
        .split('\n')
        .filter(file => /\.[cm]?[jt]s$/.test(file) && file !== 'tests/ci/ci-affected.test.ts');
    return literalPaths(tests, /['"`]((?:\.\.?\/)*(?:docs\/[^'"`\s]+|[\w./-]+\.md))['"`]/g);
}

// Fixtures the parity runner replays against both gatekeepers.
function parityInputs(): string[] {
    return literalPaths(['scripts/gatekeeper-parity.mjs'], /['"`]((?:\.\.\/)+tests\/[^'"`\s]+)['"`]/g);
}

describe('ci-affected', () => {
    it('finds image inputs to check', () => {
        expect(copySources().length).toBeGreaterThan(20);
    });

    it.each(copySources())('builds images when %s changes', (path) => {
        expect(affected([path])).toStrictEqual({ unit: 'true', images: 'true', e2e: 'true' });
    });

    it('finds document and parity inputs to check', () => {
        expect(documentInputs()).toEqual(expect.arrayContaining(['docs/scheme.md', 'docs/gatekeeper-api.json']));
        expect(parityInputs()).toEqual(expect.arrayContaining(['tests/convergence/vectors.json']));
    });

    it.each(documentInputs())('runs the suites when %s, which a test reads, changes', (path) => {
        expect(affected([path]).unit).toBe('true');
    });

    it.each(parityInputs())('runs the end-to-end jobs when parity input %s changes', (path) => {
        expect(affected([path]).e2e).toBe('true');
    });

    it('skips everything for documentation', () => {
        expect(affected(['README.md', 'docs/services/drawbridge/README.md', 'deploy/claude-skill/archon-noderunner/stages/add-didcomm.md']))
            .toStrictEqual({ unit: 'false', images: 'false', e2e: 'false' });
    });

    it('runs only the suites for unit tests and proofs', () => {
        expect(affected(['tests/common/net-portable.test.ts', 'proofs/Archon.lean']))
            .toStrictEqual({ unit: 'true', images: 'false', e2e: 'false' });
    });

    it.each(['tests/cli/didcomm.test.ts', 'tests/cli-tests/generate_test_env.sh', 'tests/gatekeeper/api-parity-flows.json'])(
        'runs the end-to-end jobs for %s', (path) => {
            expect(affected([path])).toStrictEqual({ unit: 'true', images: 'false', e2e: 'true' });
        });

    it.each(['package-lock.json', 'docker-compose.yml', 'sample.env', 'docker/compose/drawbridge.yml'])(
        'runs everything for %s', (path) => {
            expect(affected([path])).toStrictEqual({ unit: 'true', images: 'true', e2e: 'true' });
        });

    it('runs everything when a workflow changes, even alongside documentation', () => {
        expect(affected(['docs/x.md', '.github/workflows/unit-test.yml']))
            .toStrictEqual({ unit: 'true', images: 'true', e2e: 'true' });
    });

    it('runs everything for an empty diff', () => {
        expect(affected([])).toStrictEqual({ unit: 'true', images: 'true', e2e: 'true' });
    });
});
