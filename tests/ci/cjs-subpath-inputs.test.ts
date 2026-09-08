import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// A subpath declaring a `require` condition promises a CommonJS file, and that
// file exists only if the package's rollup config has an input for it. Nothing
// in the repo consumes the CJS build, so a missing input is invisible here and
// fails at `require()` for whoever installed the package.

const PACKAGES = ['cipher', 'clients', 'common', 'gatekeeper', 'ipfs', 'keymaster'];

interface Manifest {
    exports?: Record<string, unknown>;
}

// The config is a literal object of name: 'dist/esm/....js' pairs. Keys are
// quoted only where they have to be, so both forms appear.
function rollupInputs(source: string): string[] {
    const block = source.slice(source.indexOf('input:'), source.indexOf('output:'));

    return [...block.matchAll(/(?:'([^']+)'|([\w$-]+))\s*:\s*'[^']+'/g)].map(match => match[1] ?? match[2]);
}

// Both shapes in use: a flat entry, and one nested under a `node` condition.
function requireTargets(exports: Record<string, unknown>): string[] {
    return Object.values(exports).flatMap(target => {
        if (!target || typeof target !== 'object') {
            return [];
        }

        const entry = target as Record<string, any>;

        return [entry.require, entry.node?.require].filter((value): value is string => typeof value === 'string');
    });
}

describe.each(PACKAGES.filter(name => existsSync(join('packages', name, 'rollup.cjs.config.js'))))('packages/%s', name => {
    it('builds a CommonJS file for every subpath that promises one', () => {
        const pkg = JSON.parse(readFileSync(join('packages', name, 'package.json'), 'utf-8')) as Manifest;
        const inputs = rollupInputs(readFileSync(join('packages', name, 'rollup.cjs.config.js'), 'utf-8'));

        const unbuilt = requireTargets(pkg.exports ?? {})
            .map(target => target.replace(/^\.\/dist\/cjs\//, '').replace(/\.cjs$/, ''))
            .filter(entry => !inputs.includes(entry));

        expect(unbuilt).toStrictEqual([]);
    });
});
