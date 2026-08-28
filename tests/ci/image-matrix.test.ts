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
// share a matrix between workflows -- so it is asserted here instead.

const BUILD = '.github/workflows/docker-build.yml';
const PUBLISH = '.github/workflows/docker-publish.yml';

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

    it('gives every image a distinct name', () => {
        // The cache scope is keyed on matrix.image, so a duplicate would make
        // two legs evict each other's layers.
        for (const matrix of [build, publish]) {
            const names = matrix.map(e => e.image);
            expect(names.length).toBe(new Set(names).size);
        }
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
        // sat-mediator is carried so pulls from before the rename keep working.
        // A new alias is almost certainly a mistake: two package names for one
        // service is the confusion this test exists to prevent.
        const aliases = publish.filter(e => e.alias).map(e => `${e.image} <- ${e.alias}`);

        expect(aliases).toStrictEqual(['satoshi-mediator <- sat-mediator']);
    });
});
