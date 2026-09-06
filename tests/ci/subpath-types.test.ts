import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

// A published package reaches consumers as `dist` alone, so TypeScript's
// legacy `node` resolution finds a subpath's declarations only through
// typesVersions -- the `types` condition inside `exports` is invisible to it.
// A subpath with no entry compiles for everyone in this repo, which resolves
// through source, and fails with TS2307 for a consumer on that setting.

interface Manifest {
    name?: string;
    exports?: Record<string, unknown>;
    typesVersions?: Record<string, Record<string, string[]>>;
}

function manifests(): { file: string, pkg: Manifest }[] {
    return readdirSync('packages')
        .map(name => join('packages', name, 'package.json'))
        .map(file => ({ file, pkg: JSON.parse(readFileSync(file, 'utf-8')) as Manifest }));
}

// The root export needs no entry: `types` at the top level already covers it.
// Subpaths that ship no declarations at all (CSS, assets) are not TypeScript's
// business either.
function typedSubpaths(pkg: Manifest): string[] {
    return Object.entries(pkg.exports ?? {})
        .filter(([subpath, target]) => subpath !== '.' && typeof target === 'object' && target !== null && 'types' in target)
        .map(([subpath]) => subpath.replace(/^\.\//, ''));
}

describe('package subpath declarations', () => {
    it.each(manifests().filter(({ pkg }) => typedSubpaths(pkg).length > 0).map(({ file, pkg }) => [file, pkg] as const))(
        '%s maps every typed subpath in typesVersions',
        (_file, pkg) => {
            const mapped = Object.keys(pkg.typesVersions?.['*'] ?? {});
            const unmapped = typedSubpaths(pkg).filter(subpath => !mapped.includes(subpath));

            expect(unmapped).toStrictEqual([]);
        }
    );
});
