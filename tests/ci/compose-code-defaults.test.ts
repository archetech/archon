import { readFileSync } from 'fs';
import { globSync } from 'fs';

// A compose fragment writing ${VAR:-x} and the service reading VAR with its own
// default are two copies of the same number. They disagreed for the gatekeeper
// GC and status intervals (#1019): the code said 15 and 5 while every composed
// node ran 60 and 1, because sample.env had always supplied the latter and the
// code default was only ever reached by a bare `node` or `cargo run`.

// gatekeeper-parity.yml runs both implementations side by side for the parity
// CI job; its values are test fixtures rather than deployment defaults.
const COMPOSE = globSync('docker/compose/*.yml')
    .concat(globSync('docker-compose*.yml'))
    .filter(path => !path.endsWith('gatekeeper-parity.yml'));

const CONFIGS = [
    'services/gatekeeper/server/src/config.js',
    'services/keymaster/server/src/config.js',
    'services/mediators/hyperswarm/src/config.js',
    'rust/services/gatekeeper/src/config.rs',
];

function composeDefaults(): Map<string, string> {
    const defaults = new Map<string, string>();

    for (const path of COMPOSE) {
        const text = readFileSync(path, 'utf-8');
        for (const [, name, value] of text.matchAll(/\$\{([A-Z][A-Z0-9_]*):-([^}]*)\}/g)) {
            defaults.set(name, value);
        }
    }

    expect(defaults.size).toBeGreaterThan(0);
    return defaults;
}

// Keyed by variable, one entry per config file that declares a default: a
// single map would let the last file scanned mask an earlier disagreement,
// including one between the TypeScript and Rust ports.
function codeDefaults(): Map<string, { path: string, value: string }[]> {
    const defaults = new Map<string, { path: string, value: string }[]>();

    const add = (name: string, value: string, path: string) => {
        defaults.set(name, [...(defaults.get(name) ?? []), { path, value }]);
    };

    for (const path of CONFIGS) {
        const text = readFileSync(path, 'utf-8');

        // process.env.VAR || 'value'   and   env_var_or_default("VAR", "value")
        for (const [, a, b, value] of text.matchAll(
            /(?:process\.env\.([A-Z][A-Z0-9_]*)\s*\|\||env_var_or_default\(\s*"([A-Z][A-Z0-9_]*)"\s*,)\s*['"]([^'"]*)['"]/g)) {
            add((a ?? b)!, value, path);
        }

        // ternary numbers:  X ? parseInt(X) : 60      rust:  env_parse("X", 60)
        for (const [, name, value] of text.matchAll(
            /parseInt\(process\.env\.([A-Z][A-Z0-9_]*)\)\s*:\s*(\d+)/g)) {
            add(name, value, path);
        }
        for (const [, name, value] of text.matchAll(/env_parse\(\s*"([A-Z][A-Z0-9_]*)"\s*,\s*(\d+)\s*\)/g)) {
            add(name, value, path);
        }
    }

    expect(defaults.size).toBeGreaterThan(0);
    return defaults;
}

describe('compose defaults', () => {
    it('agree with the service defaults for the same variable', () => {
        const compose = composeDefaults();
        const code = codeDefaults();

        const divergent = [...compose]
            // An empty compose default means "leave it unset", not a value.
            .filter(([, value]) => value !== '')
            .flatMap(([name, value]) => (code.get(name) ?? [])
                .filter(entry => entry.value !== value)
                .map(entry => `${name}: compose=${value} ${entry.path}=${entry.value}`));

        expect(divergent.sort()).toEqual([]);
    });
});
