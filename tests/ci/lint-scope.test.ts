import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

// `eslint .` expands a directory only to extensions it knows about: .js by
// default, plus any named in an `overrides.files` pattern. eslint-config-react-app
// contributes `**/*.ts?(x)`, so .ts and .tsx were linted and .jsx silently was
// not -- 15 files, two of them 8400-line KeymasterUI copies, outside every
// automated check in the repo. A whole feature went missing in one of them for
// weeks without anything going red (#919, #935).
//
// This asserts the extension stays in scope. It reads the config rather than
// running eslint, which would cost minutes for a fact that is one line of JSON.

const CONFIG = '.eslintrc.json';

// The extensions this repo actually ships source in. Anything here must be
// reachable by `eslint .`, whether through the default, a preset, or an override.
const REQUIRED = ['.js', '.jsx', '.ts', '.tsx'];

function sourceExtensions(dir: string, found = new Set<string>()): Set<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build') {
            continue;
        }

        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            sourceExtensions(path, found);
        }
        else {
            const match = /\.(js|jsx|ts|tsx)$/.exec(entry.name);
            if (match) {
                found.add(`.${match[1]}`);
            }
        }
    }

    return found;
}

// Read as text, deliberately not parsed. .eslintrc.json permits JavaScript-style
// comments that JSON.parse rejects, and stripping them with a regex is a trap
// here: a glob like `**\/*.ts?(x)` contains `/*`, and `"**\/*.jsx"` contains `*/`,
// so a block-comment stripper matches from one to the other and deletes the very
// override this file exists to check. Found the hard way, by writing it.
function overridesSection(): string {
    const source = readFileSync(CONFIG, 'utf-8');
    const start = source.indexOf('"overrides"');

    expect(start).toBeGreaterThan(-1);

    return source.slice(start);
}

describe('lint scope', () => {
    it('has a config to read', () => {
        // Guard the guard: a rename to flat config (eslint.config.js) would make
        // every check below vacuous, and is exactly when this needs re-deciding.
        expect(statSync(CONFIG).isFile()).toBe(true);
    });

    it('names .jsx in an override, since nothing else brings it into scope', () => {
        expect(overridesSection()).toContain('.jsx');
    });

    it('covers every extension this repo has source in', () => {
        // If a fifth extension appears -- .mjs, .cjs -- it needs the same
        // treatment, and this fails rather than letting it in unlinted.
        const present = [...sourceExtensions('apps'), ...sourceExtensions('packages')];

        expect([...new Set(present)].sort()).toStrictEqual(REQUIRED.slice().sort());
    });
});
