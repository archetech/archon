import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { load } from 'js-yaml';

// The build and publish workflows carry the same list of images in separate
// matrices, and they drifted: publishing had split into two workflows, one
// shipping 6 images on a release tag and one shipping 15 from the pre-release
// branch, while the build matrix covered 14 of 26 Dockerfiles. A release
// therefore published a quarter of the services, and the same Dockerfile went
// out under two different package names (#954).
//
// Nothing structural stops that happening again -- GitHub Actions has no way to
// share a matrix between workflows -- so it is asserted here instead. Three
// copies exist: build, publish, and the nightly multi-platform run.

const BUILD = '.github/workflows/docker-build.yml';
const PUBLISH = '.github/workflows/docker-publish.yml';
const MULTIPLATFORM = '.github/workflows/docker-multiplatform.yml';

type Entry = { dockerfile: string, image: string, alias?: string };

function matrixOf(path: string, job: string): Entry[] {
    const doc = load(readFileSync(path, 'utf-8')) as any;
    const include = doc?.jobs?.[job]?.strategy?.matrix?.include;

    // Guard the guard: a renamed job would otherwise make every check below
    // pass by comparing two empty lists.
    expect(Array.isArray(include)).toBe(true);
    expect(include.length).toBeGreaterThan(20);

    return include;
}

const build = matrixOf(BUILD, 'build_test_images');
const publish = matrixOf(PUBLISH, 'publish_images');
const multiplatform = matrixOf(MULTIPLATFORM, 'build_multiplatform');

describe('docker image matrices', () => {
    it('builds every Dockerfile in the repo', () => {
        // Twelve were compiled by nothing at all, including the DIDComm relay,
        // the Python keymaster and the Rust gatekeeper. A change breaking one
        // of them passed every check.
        const tracked: string[] = execSync('git ls-files', { encoding: 'utf-8' })
            .split('\n')
            .filter((f: string) => f.includes('Dockerfile'));

        const covered = new Set(build.map(e => e.dockerfile));
        const missing = tracked.filter(f => !covered.has(f)).sort();

        expect(missing).toStrictEqual([]);
    });

    it('publishes exactly what it builds', () => {
        const asPairs = (m: Entry[]) => m.map(e => `${e.dockerfile} -> ${e.image}`).sort();

        expect(asPairs(publish)).toStrictEqual(asPairs(build));
    });

    it('checks both architectures for exactly what it builds', () => {
        // The nightly arm64 run carries a third copy of the same list (#957).
        // An image added to the other two and missed here would not be compiled
        // for a foreign architecture until a release, which is the gap that
        // workflow exists to close.
        const asPairs = (m: Entry[]) => m.map(e => `${e.dockerfile} -> ${e.image}`).sort();

        expect(asPairs(multiplatform)).toStrictEqual(asPairs(build));
    });

    it('gives every image a distinct name', () => {
        // The cache scope is keyed on matrix.image, so a duplicate would make
        // two legs evict each other's layers.
        for (const matrix of [build, publish]) {
            const names = matrix.map(e => e.image);
            expect(names.length).toBe(new Set(names).size);
        }
    });

    it('marks a language-specific image with its language', () => {
        // Two implementations of the gatekeeper and two of the keymaster, so a
        // bare name is ambiguous about which one it is. The suffix is the same
        // one the Dockerfile carries.
        const names = new Set(publish.map(e => e.image));

        for (const pair of [['gatekeeper-ts', 'gatekeeper-rs'], ['keymaster-ts', 'keymaster-py']]) {
            for (const n of pair) {
                expect(names.has(n)).toBe(true);
            }
        }

        // And the ambiguous forms survive only as aliases, never as the name a
        // new image is published under.
        expect(names.has('gatekeeper')).toBe(false);
        expect(names.has('keymaster')).toBe(false);
    });

    it('names images for the service, not the deployment', () => {
        // Compose picks the network -- eth-sepolia, sol-devnet, zcash-mainnet --
        // and one image serves all of them. A `zcash-mainnet-mediator` image
        // could not serve testnet, and would read as though it were pinned.
        const networked = publish
            .map(e => e.image)
            .filter(n => /mainnet|testnet|sepolia|devnet|signet/.test(n));

        expect(networked).toStrictEqual([]);
    });

    it('keeps an alias only where one was already published', () => {
        // Both are carried so pulls from before the rename keep working. A new
        // alias is almost certainly a mistake: two package names for one
        // service is the confusion this test exists to prevent.
        const aliases = publish.filter(e => e.alias).map(e => `${e.image} <- ${e.alias}`).sort();

        expect(aliases).toStrictEqual([
            'gatekeeper-ts <- gatekeeper',
            'keymaster-ts <- keymaster',
            'satoshi-mediator <- sat-mediator',
        ]);
    });

    it('takes the commit from the checkout, not from the event', () => {
        // The publish workflow can be dispatched against a ref other than the
        // branch carrying the workflow file, so `github.sha` there is the
        // dispatching branch rather than the code being built. Using it stamped
        // a v0.12.0 backfill with main's commit, in both GIT_COMMIT and the OCI
        // revision label -- an image reporting a commit it was not built from,
        // which is exactly the provenance confusion this repo has spent time
        // untangling elsewhere.
        const publishYaml = readFileSync(PUBLISH, 'utf-8');

        // The expression, not the word: the comment explaining why this rule
        // exists necessarily mentions github.sha.
        const expressions = publishYaml.match(/\$\{\{[^}]*\}\}/g) ?? [];

        expect(expressions.filter(e => e.includes('github.sha'))).toStrictEqual([]);
        expect(publishYaml).toMatch(/GIT_COMMIT=\$\{\{ steps\.source\.outputs\.sha \}\}/);
        expect(publishYaml).toMatch(/org\.opencontainers\.image\.revision=\$\{\{ steps\.source\.outputs\.sha \}\}/);
    });

    it('publishes every image the compose files pull', () => {
        // The compose files under docker/compose are the consumers, so they
        // decide the names. An image published as something else cannot be
        // pulled by anyone following the repo's own deployment files -- which
        // is how `keymaster-py` and `gatekeeper` came to be published under
        // names no compose file references.
        const composed = new Set(
            execSync("grep -rhoE 'ghcr\\.io/archetech/[a-z0-9-]+' docker/compose", { encoding: 'utf-8' })
                .split('\n')
                .filter(Boolean)
                .map(ref => ref.split('/').pop() as string),
        );

        // Hosted in the org but not built from a Dockerfile in this repo.
        const foreign = new Set(['bitcoin-core', 'lnbits']);

        const publishable = new Set(publish.flatMap(e => e.alias ? [e.image, e.alias] : [e.image]));
        const unpullable = [...composed].filter(n => !foreign.has(n) && !publishable.has(n)).sort();

        expect(unpullable).toStrictEqual([]);
    });
});
