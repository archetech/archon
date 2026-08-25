import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import ts from 'typescript';

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

// Module specifiers read from the AST, which sees two things the previous
// scanner could not.
//
// It stripped comments with a regex first. Three files here carry a JSX
// attribute reading accept="image/*", and a block-comment regex takes that
// `/*` as an opener and runs to the next `*/`. None of the three currently has
// a block comment anywhere after the attribute, so no match forms and nothing
// is deleted -- appending one ordinary comment to ImageTab.tsx is enough to
// make it swallow 132 lines. The same pattern silently deleted 47% of
// KeymasterUI.jsx on the other surface, which does have comments below its
// attributes (#941). A parser knows a string from a comment.
//
// And it matched only `from '...'`, so a dynamic import() was invisible to it
// however the file was laid out.
function importedPackages(): string[] {
    const found = new Set<string>();

    for (const file of sourceFiles(SRC)) {
        const source = ts.createSourceFile(
            file,
            readFileSync(file, 'utf-8'),
            ts.ScriptTarget.Latest,
            false,
            file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
        );

        function specifierOf(node: ts.Node): string | undefined {
            // `import x from 'p'` and `export { x } from 'p'`.
            if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
                && node.moduleSpecifier
                && ts.isStringLiteral(node.moduleSpecifier)) {
                return node.moduleSpecifier.text;
            }

            // `await import('p')`, which the old `from` pattern never saw.
            if (ts.isCallExpression(node)
                && node.expression.kind === ts.SyntaxKind.ImportKeyword
                && node.arguments.length > 0
                && ts.isStringLiteral(node.arguments[0])) {
                return node.arguments[0].text;
            }

            // `import('p').Type` in a type position, likewise.
            if (ts.isImportTypeNode(node)
                && ts.isLiteralTypeNode(node.argument)
                && ts.isStringLiteral(node.argument.literal)) {
                return node.argument.literal.text;
            }

            return undefined;
        }

        function visit(node: ts.Node): void {
            const specifier = specifierOf(node);

            if (specifier && !specifier.startsWith('.') && !specifier.startsWith('node:')) {
                found.add(packageOf(specifier));
            }

            ts.forEachChild(node, visit);
        }

        visit(source);
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
