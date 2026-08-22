import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

// packages/wallet-ui is consumed as source by both wallets and declared nothing
// (#928). It worked only because each app happened to have every package
// installed and its bundler resolved from the app -- which meant each consumer
// carried config to make it work, in a different shape (webpack
// `resolve.modules`, vite `dedupe`), and a new import broke whichever consumer
// nobody remembered to update.
//
// `axios` was the sharpest case: imported by AuthTab and declared by nobody at
// all -- not this package, not either app, not the root. It resolved purely as
// somebody else's transitive.

const PACKAGE_DIR = 'packages/wallet-ui';
const SRC = join(PACKAGE_DIR, 'src');

// Siblings in this monorepo. Each consumer aliases these to built output, so
// they are not part of the external contract this test is about.
const WORKSPACE_SCOPE = '@didcid/';

function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            return sourceFiles(path);
        }
        return /\.tsx?$/.test(entry.name) ? [path] : [];
    });
}

// "@mui/material/styles" -> "@mui/material", "qrcode.react" -> "qrcode.react"
function packageOf(specifier: string): string {
    const parts = specifier.split('/');
    return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function importedPackages(): string[] {
    const found = new Set<string>();

    for (const file of sourceFiles(SRC)) {
        // Comments stripped first: these files name packages in prose, and only
        // a real import should count.
        const source = readFileSync(file, 'utf-8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/.*$/gm, '');

        for (const match of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
            const specifier = match[1];
            if (specifier.startsWith('.') || specifier.startsWith('node:')) {
                continue;
            }
            found.add(packageOf(specifier));
        }
    }

    return [...found].sort();
}

function declaredPeers(): string[] {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf-8'));
    return Object.keys(manifest.peerDependencies ?? {}).sort();
}

describe('wallet-ui dependency declaration', () => {
    it('finds imports to check', () => {
        // Guard the guard: a regex that stopped matching would make the checks
        // below vacuous.
        expect(importedPackages().length).toBeGreaterThan(3);
    });

    it('declares every package it imports', () => {
        const declared = new Set(declaredPeers());
        const undeclared = importedPackages()
            .filter(name => !name.startsWith(WORKSPACE_SCOPE))
            .filter(name => !declared.has(name));

        expect(undeclared).toStrictEqual([]);
    });

    it('declares nothing it does not import', () => {
        // The other direction: a peer nobody imports is a constraint on every
        // consumer for no reason. react-dom was declared here at first and is
        // never imported -- rendering into a DOM is the host's job.
        const imported = new Set(importedPackages());
        const unused = declaredPeers().filter(name => !imported.has(name));

        expect(unused).toStrictEqual([]);
    });

    it('does not import itself', () => {
        // A self-import resolves only through each consumer's alias for the
        // package, so it works in the apps and nowhere else.
        const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf-8'));

        expect(importedPackages()).not.toContain(manifest.name);
    });

    it('is still consumed as source', () => {
        // The whole argument above rests on this: peers rather than
        // dependencies is right because the consumer's bundler resolves them.
        // If this package ever gains a build and ships its own output, revisit.
        const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf-8'));

        expect(manifest.exports['.']).toMatch(/^\.\/src\//);
        expect(existsSync(join(PACKAGE_DIR, 'dist'))).toBe(false);
    });
});
