import { execSync } from 'child_process';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';

// sqlite3's install script is `prebuild-install -r napi || node-gyp rebuild`,
// and the node:*-slim images have no Python or C++ toolchain -- so any hiccup
// fetching the prebuilt binary escalates into a source build that cannot
// succeed, and `npm ci` fails. #879 removed the network from that path by
// seeding ./prebuilds before the image build.
//
// It seeded three workflows and missed the other three jobs that also build
// images, which is #913: a spurious red check on PRs that changed nothing near
// Docker, reported as a Python error when the cause is a node native module.
//
// A job either builds images or it does not; if it does, it must seed first.
// Checked per job rather than per file, because docker-build-test.yml has two
// image-building jobs and covering only one would look correct from the outside.

const WORKFLOW_DIR = '.github/workflows';
const PREFETCH = 'scripts/prefetch-prebuilds.mjs';

// Anything that can cause a Dockerfile in this repo to run `npm ci`. Includes
// start-node-ci, which wraps `docker compose build`, since a wrapper script
// hides the build from a naive grep -- that is the shape of the miss this file
// exists to catch.
const BUILD_PATTERNS = [
    /docker\s+compose[^\n]*\bbuild\b/,
    /docker\s+compose[^\n]*--build\b/,
    /docker\s+build\b/,
    /docker\/build-push-action/,
    /start-node-ci/,
];

interface Step {
    run?: string;
    uses?: string;
}

function stepText(step: Step): string {
    return `${step.run ?? ''}\n${step.uses ?? ''}`;
}

function jobs(file: string): Array<{ id: string; steps: Step[] }> {
    const parsed = parseYaml(readFileSync(join(WORKFLOW_DIR, file), 'utf-8')) as {
        jobs?: Record<string, { steps?: Step[] }>;
    };

    return Object.entries(parsed?.jobs ?? {}).map(([id, job]) => ({
        id,
        steps: job?.steps ?? [],
    }));
}

function workflowFiles(): string[] {
    return readdirSync(WORKFLOW_DIR).filter(name => /\.ya?ml$/.test(name));
}

// The env vars prebuild-install reads, derived from the script's own target
// list so the two cannot drift: adding a third native module there makes this
// require it in the Dockerfiles too. prebuild-install lowercases the package
// name and replaces every non-alphanumeric character with an underscore, so
// `@ipshipyard/node-datachannel` becomes ipshipyard_node_datachannel.
function expectedPrebuildVars(): string[] {
    const script = readFileSync(join('scripts', 'prefetch-prebuilds.mjs'), 'utf-8');
    const targets = [...script.matchAll(/\bname:\s*'([^']+)'/g)].map(m => m[1]);

    expect(targets.length).toBeGreaterThan(0);

    return targets.map(name => `npm_config_${name.replace(/^@/, '').replace(/[^a-zA-Z0-9]/g, '_')}_local_prebuilds`);
}

describe('native prebuild seeding', () => {
    it('finds workflows to check', () => {
        // Guard the guard: an empty listing would make the check below vacuous.
        expect(workflowFiles().length).toBeGreaterThan(0);
    });

    it('seeds ./prebuilds before the first image build in every job that builds one', () => {
        // Position matters, not mere presence: a prefetch step sitting after
        // the build has already let that build fall back to the network, and a
        // guard that only asked "is it in this job somewhere" would call that
        // fine.
        const unseeded: string[] = [];

        for (const file of workflowFiles()) {
            for (const { id, steps } of jobs(file)) {
                const firstBuild = steps.findIndex(step =>
                    BUILD_PATTERNS.some(pattern => pattern.test(stepText(step)))
                );

                if (firstBuild === -1) {
                    continue;
                }

                const prefetch = steps.findIndex(step => stepText(step).includes(PREFETCH));

                if (prefetch === -1) {
                    unseeded.push(`${file}:${id} (no prefetch step)`);
                }
                else if (prefetch > firstBuild) {
                    unseeded.push(`${file}:${id} (prefetch at step ${prefetch}, after build at ${firstBuild})`);
                }
            }
        }

        expect(unseeded).toStrictEqual([]);
    });

    it('has a prefetch script for those jobs to run', () => {
        // The step above is a string match, so it would keep passing if the
        // script were renamed or removed.
        expect(readdirSync('scripts')).toContain('prefetch-prebuilds.mjs');
    });

    it('points every seeded image at the directory it seeds, for every module', () => {
        // Seeding is useless unless the Dockerfile copies ./prebuilds in and
        // tells prebuild-install to look there. Each module is checked by name:
        // matching any *_local_prebuilds assignment would stay green if
        // sqlite3's were dropped while node-datachannel's remained -- and
        // sqlite3 is the module #913 is actually about.
        const expected = expectedPrebuildVars();
        const problems: string[] = [];

        for (const name of readdirSync('docker').filter(f => f.startsWith('Dockerfile.'))) {
            const source = readFileSync(join('docker', name), 'utf-8');
            const copies = /COPY\s+prebuilds\//.test(source);
            const missing = expected.filter(variable => !source.includes(`${variable}=/prebuilds`));

            if (copies && missing.length) {
                problems.push(`${name} copies prebuilds/ but does not set ${missing.join(', ')}`);
            }

            if (!copies && missing.length < expected.length) {
                problems.push(`${name} points at /prebuilds but never copies it in`);
            }
        }

        expect(problems).toStrictEqual([]);
    });
});

// The seeded filename carries the package version, so a lockfile pinning a
// different one gets nothing and falls back to the un-retried network fetch at
// npm-ci time -- silently, because the build still succeeds. satoshi installs
// sqlite3 5.1.7 while zcash, solana and ethereum install 6.0.1, and only the
// root was being read.
describe('prefetch covers every installed version', () => {
    const TARGETS = ['sqlite3', '@ipshipyard/node-datachannel'];

    function versionsOf(name: string): Set<string> {
        const locks = execSync("git ls-files '*package-lock.json'", { encoding: 'utf-8' })
            .split('\n')
            .filter(Boolean);

        const found = new Set<string>();

        for (const lock of locks) {
            const doc = JSON.parse(readFileSync(lock, 'utf-8'));
            const version = doc.packages?.[`node_modules/${name}`]?.version;
            if (version) {
                found.add(version);
            }
        }

        return found;
    }

    it('reads every tracked lockfile, not only the root', () => {
        const script = readFileSync('scripts/prefetch-prebuilds.mjs', 'utf-8');

        expect(script).toMatch(/git['"],\s*\['ls-files', '\*package-lock\.json'\]/);
    });

    it.each(TARGETS)('finds a version of %s to seed', (name) => {
        // Guard the guard: a rename would make the check below vacuous.
        expect(versionsOf(name).size).toBeGreaterThan(0);
    });

    it('has more than one sqlite3 version to cover, which is the case that broke', () => {
        // If the versions are ever aligned this can go, but until then a
        // root-only reader silently misses three mediators.
        expect(versionsOf('sqlite3').size).toBeGreaterThan(1);
    });
});
