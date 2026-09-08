import { execSync } from 'child_process';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';

// A native module's install script is `prebuild-install || node-gyp rebuild`,
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
const TARGET_NAMES = [...readFileSync(join('scripts', 'prefetch-prebuilds.mjs'), 'utf-8')
    .matchAll(/\bname:\s*'([^']+)'/g)].map(match => match[1]);

function expectedPrebuildVars(): string[] {
    return TARGET_NAMES.map(name => `npm_config_${name.replace(/^@/, '').replace(/[^a-zA-Z0-9]/g, '_')}_local_prebuilds`);
}

// Every image, wherever it lives: one Dockerfile sits under services/.
function dockerfiles(): string[] {
    return [
        ...readdirSync('docker').filter(f => f.startsWith('Dockerfile.')).map(f => join('docker', f)),
        join('services', 'herald', 'Dockerfile'),
    ];
}

function lockfiles(): string[] {
    return execSync("git ls-files '*package-lock.json'", { encoding: 'utf-8' }).split('\n').filter(Boolean);
}

function installs(lock: string, name: string): boolean {
    const packages = JSON.parse(readFileSync(lock, 'utf-8')).packages ?? {};

    return Object.keys(packages).some(key => key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`));
}

// The service directory an image copies in, which decides the second `npm ci`.
// Matched by path segment: `services/mediators/filecoin` is a string prefix of
// `services/mediators/filecoin-wallet` and installs none of its dependencies.
function copiedPaths(source: string): string[] {
    return [...source.matchAll(/^COPY\s+((?:services|apps)\/[\w./-]+)/gm)].map(match => match[1].replace(/\/$/, ''));
}

// Which lockfiles an image installs. Most copy the root manifests and run a
// root `npm ci` before the service's own, so a seeded package added to the root
// lockfile lands in every one of them -- not only in the service that named it.
export function installedLocks(source: string, locks: string[]): string[] {
    const copiesRoot = /^COPY\s+package\*?\.json/m.test(source);
    const paths = copiedPaths(source);

    return locks.filter(lock => lock === 'package-lock.json'
        ? copiesRoot
        : paths.some(dir => lock.startsWith(`${dir}/`)));
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
        // Seeding belongs to the images that install a seeded package and to no
        // others. It used to be in all 24, where 23 copied binaries nothing
        // would read and the Dockerfile implied a native dependency the service
        // does not have (#1080).
        //
        // Each image runs `npm ci` at the root and again in the one service it
        // copies, so which lockfile an image installs is what decides this.
        const expected = expectedPrebuildVars();
        const seededLocks = lockfiles().filter(lock => TARGET_NAMES.some(name => installs(lock, name)));
        const problems: string[] = [];

        for (const file of dockerfiles()) {
            const source = readFileSync(file, 'utf-8');
            const copies = /COPY\s+prebuilds\//.test(source);
            const points = /npm_config_\w+_local_prebuilds=\/prebuilds/.test(source);
            const needs = installedLocks(source, seededLocks).length > 0;

            if (copies !== needs) {
                problems.push(`${file} ${copies ? 'seeds prebuilds but installs no seeded package' : 'installs a seeded package but does not seed prebuilds'}`);
            }

            if (copies !== points) {
                problems.push(`${file} ${copies ? 'copies prebuilds/ but points at nothing' : 'points at /prebuilds but never copies it in'}`);
            }

            const missing = copies ? expected.filter(variable => !source.includes(`${variable}=/prebuilds`)) : [];

            if (missing.length) {
                problems.push(`${file} copies prebuilds/ but does not set ${missing.join(', ')}`);
            }
        }

        expect(problems).toStrictEqual([]);
    });

    it('finds an image that needs seeding, so the pairing above is not vacuous', () => {
        expect(dockerfiles().filter(f => /COPY\s+prebuilds\//.test(readFileSync(f, 'utf-8')))).not.toStrictEqual([]);
    });
});

// Checked against written-out Dockerfiles rather than the repo's, because the
// cases that matter are ones the repo does not currently contain.
describe('which lockfiles an image installs', () => {
    const ROOT = 'package-lock.json';
    const WALLET = 'services/mediators/filecoin-wallet/package-lock.json';
    const image = (...lines: string[]) => lines.join('\n');

    // The failure this exists to prevent: every image runs a root `npm ci`, so
    // a seeded package in the root lockfile is installed by all of them. A
    // mapping that reads only the service directory would clear every image.
    it('counts the root lockfile for an image that copies the root manifests', () => {
        const source = image('COPY package*.json ./', 'RUN npm ci');

        expect(installedLocks(source, [ROOT, WALLET])).toStrictEqual([ROOT]);
    });

    it('does not count it for an image that never copies them', () => {
        const source = image('COPY services/mediators/filecoin-wallet ./wallet/');

        expect(installedLocks(source, [ROOT])).toStrictEqual([]);
    });

    it('counts a service lockfile the image copies', () => {
        const source = image('COPY services/mediators/filecoin-wallet ./wallet/');

        expect(installedLocks(source, [WALLET])).toStrictEqual([WALLET]);
    });

    // `services/mediators/filecoin` is a string prefix of the wallet's path and
    // installs none of its dependencies.
    it('does not count a sibling whose path it merely prefixes', () => {
        const source = image('COPY services/mediators/filecoin ./filecoin/');

        expect(installedLocks(source, [WALLET])).toStrictEqual([]);
    });
});

// The seeded filename carries the package version, so a lockfile pinning a
// different one gets nothing and falls back to the un-retried network fetch at
// npm-ci time -- silently, because the build still succeeds. Services carry
// their own lockfiles, and only the root was being read.
describe('prefetch covers every installed version', () => {
    // Read out of the script rather than repeated here: a list kept in both
    // places drifts, and the copy in the test is the one nobody updates.
    const TARGETS = [...readFileSync('scripts/prefetch-prebuilds.mjs', 'utf-8')
        .matchAll(/\{\s*name:\s*'([^']+)'/g)].map(match => match[1]);

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

    // A target no lockfile installs seeds a file nothing will ever ask for, and
    // the build still succeeds -- so nothing else would say. This caught the
    // list still naming @ipshipyard/node-datachannel after Helia left with it
    // (#1080); the package that needs seeding now is upstream node-datachannel,
    // which filecoin-pin brings to the Filecoin wallet.
    it('seeds only packages something actually installs', () => {
        expect(TARGETS.filter(name => versionsOf(name).size === 0)).toStrictEqual([]);
    });
});
