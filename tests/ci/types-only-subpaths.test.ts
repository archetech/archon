import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

// A subpath whose export declares only `types` has no runtime entry, so a value
// imported from it resolves to nothing once a bundler enforces the exports map.
// Neither tsc nor jest notices -- tsc needs only the declarations, and jest's
// moduleNameMapper rewrites these to source -- so it surfaces in the wallet and
// extension builds, several steps downstream of the change that caused it.
//
// Checked at the source rather than at the import: a module reachable only as
// types must not export a value in the first place, which is the property that
// was violated. Whether a given import elides is a question about the type
// checker; whether a value exists to import is not.

interface Manifest {
    name?: string;
    exports?: Record<string, { types?: string, import?: string, require?: string }>;
}

// Anything that survives to runtime. `export type`, `export interface` and
// `export type { ... } from` do not.
const VALUE_DECLARATION = /^export\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|var|class|enum)\s+(\w+)/gm;

// A re-export emits an import of the module it names unless it is type-only,
// so `export { x } from './m.js'` and `export * from './m.js'` both put a
// runtime dependency in a module that is supposed to have none. Only
// `export type { ... } from` and `export type * from` are erased.
const RE_EXPORT = /^export\s+(?!type\s)(\{[^}]*\}|\*(?:\s+as\s+\w+)?)\s+from\s+['"][^'"]+['"]/gm;

function valueExports(source: string): string[] {
    const declared = [...source.matchAll(VALUE_DECLARATION)].map(match => match[1]);
    const reExported = [...source.matchAll(RE_EXPORT)].flatMap(match => {
        // `export { type A, B } from` is partly erased; B is the problem.
        if (match[1].startsWith('*')) {
            return [match[0].trim()];
        }

        return match[1]
            .replace(/^\{|\}$/g, '')
            .split(',')
            .map(part => part.trim())
            .filter(part => part && !part.startsWith('type '));
    });

    return [...declared, ...reExported];
}

function typesOnlyModules(): { specifier: string, source: string }[] {
    const modules: { specifier: string, source: string }[] = [];

    for (const dir of execSync('ls packages', { encoding: 'utf-8' }).split('\n').filter(Boolean)) {
        const file = join('packages', dir, 'package.json');

        if (!existsSync(file)) {
            continue;
        }

        const pkg: Manifest = JSON.parse(readFileSync(file, 'utf-8'));

        for (const [subpath, target] of Object.entries(pkg.exports ?? {})) {
            if (!target || typeof target !== 'object' || !target.types || target.import || target.require) {
                continue;
            }

            // ./dist/types/keymaster-types.d.ts -> packages/<dir>/src/keymaster-types.ts
            const source = join('packages', dir, 'src', target.types.replace(/^.*\//, '').replace(/\.d\.ts$/, '.ts'));

            if (existsSync(source)) {
                modules.push({ specifier: `${pkg.name}${subpath.replace(/^\./, '')}`, source });
            }
        }
    }

    return modules;
}

describe('types-only subpaths', () => {
    const modules = typesOnlyModules();

    it('finds the modules it means to check', () => {
        const specifiers = modules.map(module => module.specifier);

        expect(specifiers).toContain('@didcid/clients/keymaster-types');
        expect(specifiers).toContain('@didcid/clients/gatekeeper-types');
    });

    it.each(modules.map(module => [module.specifier, module.source]))('%s exports no runtime value', (_specifier, source) => {
        expect(valueExports(readFileSync(source, 'utf-8'))).toStrictEqual([]);
    });
});
