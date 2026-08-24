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

// Extensions `eslint .` must reach, whether through its default, a preset, or an
// override in the config.
const LINTED = ['.js', '.jsx', '.mjs', '.ts', '.tsx'];

// Extensions present in the source trees that are deliberately not JavaScript to
// lint -- assets, config, docs, and the Android build. Each entry is a decision
// someone made; an extension in neither list fails the test rather than slipping
// in unlinted, which is the whole point.
const NOT_LINTABLE = [
    '.css', '.env', '.html', '.ico', '.json', '.md', '.png', '.sh', '.svg',
    '.txt', '.webmanifest', '.webp', '.xml',
];

// Build output, dependencies, and the native project trees. The Android and iOS
// directories are whole Gradle/Xcode projects -- their .java, .gradle and .jar
// files are not JavaScript anyone would lint, and enumerating them would bury
// the extensions this test is actually asking about.
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'android', 'ios', 'public', 'static']);

// Collects whatever extensions are there, deliberately without reference to
// LINTED. An earlier version matched only /\.(js|jsx|ts|tsx)$/ -- so it could
// never discover a fifth extension, which is exactly what it claimed to guard
// against, while two unlinted .mjs files sat in the tree it was scanning.
function extensionsIn(dir: string, found = new Set<string>()): Set<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_DIRS.has(entry.name)) {
            continue;
        }

        const path = join(dir, entry.name);

        if (entry.isDirectory()) {
            extensionsIn(path, found);
            continue;
        }

        // Dotfiles are configuration, never lintable source, and their names do
        // not decompose the same way: .env.android would otherwise be read as an
        // ".android" extension, which is not a thing.
        if (entry.name.startsWith('.')) {
            continue;
        }

        const dot = entry.name.lastIndexOf('.');
        if (dot > 0) {
            found.add(entry.name.slice(dot));
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

    it('has decided about every extension in the source trees', () => {
        // A new one -- .cjs, .vue, .svelte -- lands here as a failure asking
        // whether it is JavaScript that needs linting. That question going
        // unasked is how .jsx stayed invisible.
        const present = [
            ...extensionsIn('apps'),
            ...extensionsIn('packages'),
            ...extensionsIn('scripts'),
        ];

        const decided = new Set([...LINTED, ...NOT_LINTABLE]);
        const undecided = [...new Set(present)].filter(extension => !decided.has(extension)).sort();

        expect(undecided).toStrictEqual([]);
    });

    it('names every lintable extension the default does not cover', () => {
        // eslint's default is .js; eslint-config-react-app adds **/*.ts?(x).
        // Everything else has to be named explicitly or it is silently skipped.
        const overrides = overridesSection();

        for (const extension of ['.jsx', '.mjs']) {
            expect(overrides).toContain(extension);
        }
    });
});
