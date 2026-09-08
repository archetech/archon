import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// The SQLite wallet exists so one machine holds one wallet: `keymaster` and the
// Python CLI open the same file. Nothing at runtime checks that -- the Python
// suite has no Node and the Jest suite has no Python -- so the two stores agree
// only as long as their SQL does. A column renamed on one side would leave each
// CLI a wallet the other cannot see, and both suites would stay green.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function readSource(relativePath: string): string {
    return readFileSync(path.join(REPO_ROOT, relativePath), 'utf-8');
}

// Both files hold their SQL in string literals, written across several lines
// and indented to their own nesting depth.
function statements(source: string): string[] {
    const literals = source.matchAll(/`([^`]*)`|"""([\s\S]*?)"""|'([^']*)'|"([^"]*)"/g);

    return [...literals]
        .map(match => (match[1] ?? match[2] ?? match[3] ?? match[4]).replace(/\s+/g, ' ').trim())
        .filter(literal => /^(CREATE TABLE|SELECT|INSERT INTO|DELETE FROM)\b/.test(literal))
        .filter(literal => /\bwallet\b/.test(literal))
        .sort();
}

describe('SQLite wallet store', () => {
    const typescript = statements(readSource('packages/keymaster/src/db/sqlite.ts'));
    const python = statements(readSource('python/keymaster/src/keymaster/wallet_store.py'));

    it('finds the statements it means to compare', () => {
        expect(typescript.length).toBeGreaterThanOrEqual(4);
        expect(typescript).toContain('CREATE TABLE IF NOT EXISTS wallet ( id INTEGER PRIMARY KEY, data TEXT NOT NULL )');
    });

    it('issues the same SQL from both ports', () => {
        expect(python).toStrictEqual(typescript);
    });
});
