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

describe('native prebuild seeding', () => {
    it('finds workflows to check', () => {
        // Guard the guard: an empty listing would make the check below vacuous.
        expect(workflowFiles().length).toBeGreaterThan(0);
    });

    it('seeds ./prebuilds in every job that builds a Docker image', () => {
        const unseeded: string[] = [];

        for (const file of workflowFiles()) {
            for (const { id, steps } of jobs(file)) {
                const builds = steps.some(step =>
                    BUILD_PATTERNS.some(pattern => pattern.test(stepText(step)))
                );

                if (!builds) {
                    continue;
                }

                if (!steps.some(step => stepText(step).includes(PREFETCH))) {
                    unseeded.push(`${file}:${id}`);
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

    it('points every seeded image at the directory it seeds', () => {
        // Seeding is useless unless the Dockerfile copies ./prebuilds in and
        // tells prebuild-install to look there. A Dockerfile that copies the
        // directory without setting the env var silently falls back to the
        // network -- the failure this all exists to prevent.
        const mismatched: string[] = [];

        for (const name of readdirSync('docker').filter(f => f.startsWith('Dockerfile.'))) {
            const source = readFileSync(join('docker', name), 'utf-8');
            const copies = /COPY\s+prebuilds\//.test(source);
            const points = /_local_prebuilds=/.test(source);

            if (copies !== points) {
                mismatched.push(`${name} (copies=${copies}, points=${points})`);
            }
        }

        expect(mismatched).toStrictEqual([]);
    });
});
