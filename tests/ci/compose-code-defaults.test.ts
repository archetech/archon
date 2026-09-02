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

// Every runtime flavor, so a default cannot drift between the ports that are
// meant to be interchangeable.
const CONFIGS = [
    'services/gatekeeper/server/src/config.js',
    'services/keymaster/server/src/config.js',
    'services/mediators/hyperswarm/src/config.js',
    'rust/services/gatekeeper/src/config.rs',
    'python/keymaster_service/src/keymaster_service/config.py',
];

type Declaration = { path: string, value: string };

function collect(): Map<string, Declaration[]> {
    return new Map<string, Declaration[]>();
}

function record(into: Map<string, Declaration[]>, name: string, value: string, path: string): void {
    into.set(name, [...(into.get(name) ?? []), { path, value }]);
}

// One entry per declaration rather than one per variable: the fragments repeat
// the same default across flavors on purpose, so collapsing them would hide a
// mismatch in every file but the last one scanned.
function composeDefaults(): Map<string, Declaration[]> {
    const defaults = collect();

    for (const path of COMPOSE) {
        const text = readFileSync(path, 'utf-8');
        for (const [, name, value] of text.matchAll(/\$\{([A-Z][A-Z0-9_]*):-([^}]*)\}/g)) {
            record(defaults, name, value, path);
        }
    }

    expect(defaults.size).toBeGreaterThan(0);
    return defaults;
}

function codeDefaults(): Map<string, Declaration[]> {
    const defaults = collect();

    for (const path of CONFIGS) {
        const text = readFileSync(path, 'utf-8');

        // process.env.VAR || 'value'      env_var_or_default("VAR", "value")
        // os.environ.get("VAR", "value")
        for (const [, a, b, c, value] of text.matchAll(
            /(?:process\.env\.([A-Z][A-Z0-9_]*)\s*\|\||env_var_or_default\(\s*"([A-Z][A-Z0-9_]*)"\s*,|os\.environ\.get\(\s*"([A-Z][A-Z0-9_]*)"\s*,)\s*['"]([^'"]*)['"]/g)) {
            record(defaults, (a ?? b ?? c)!, value, path);
        }

        // VAR ? parseInt(VAR) : 60        env_parse("VAR", 60)
        for (const [, name, value] of text.matchAll(
            /parseInt\(process\.env\.([A-Z][A-Z0-9_]*)\)\s*:\s*(\d+)/g)) {
            record(defaults, name, value, path);
        }
        for (const [, name, value] of text.matchAll(/env_parse\(\s*"([A-Z][A-Z0-9_]*)"\s*,\s*(\d+)\s*\)/g)) {
            record(defaults, name, value, path);
        }

        // VAR ? VAR === 'true' : false    — booleans, whose default is the else branch
        for (const [, name, value] of text.matchAll(
            /process\.env\.([A-Z][A-Z0-9_]*)\s*\?[^:;,\n]*:\s*(true|false)/g)) {
            record(defaults, name, value, path);
        }
        // os.environ.get("VAR", "false").lower() == "true"
        for (const [, name, value] of text.matchAll(
            /os\.environ\.get\(\s*"([A-Z][A-Z0-9_]*)"\s*,\s*"(true|false)"\s*\)\s*\.lower\(\)/g)) {
            record(defaults, name, value, path);
        }
    }

    expect(defaults.size).toBeGreaterThan(0);
    return defaults;
}

describe('compose defaults', () => {
    const compose = composeDefaults();
    const code = codeDefaults();

    it('agree with the service defaults for the same variable', () => {
        const divergent = [...compose]
            // An empty compose default means "leave it unset", not a value.
            .flatMap(([name, declarations]) => declarations
                .filter(declared => declared.value !== '')
                .flatMap(declared => (code.get(name) ?? [])
                    .filter(actual => actual.value !== declared.value)
                    .map(actual => `${name}: ${declared.path}=${declared.value} ${actual.path}=${actual.value}`)));

        expect([...new Set(divergent)].sort()).toEqual([]);
    });

    it('cover the variables the minimal sample stopped carrying', () => {
        // These left minimal-sample.env because a default took over. If a
        // matcher above stops recognising one, it silently goes unchecked.
        const defaulted = [
            'ARCHON_GATEKEEPER_DB', 'ARCHON_GATEKEEPER_DID_PREFIX', 'ARCHON_GATEKEEPER_FALLBACK_URL',
            'ARCHON_GATEKEEPER_FALLBACK_TIMEOUT', 'ARCHON_GATEKEEPER_UPLOAD_LIMIT',
            'ARCHON_GATEKEEPER_GC_INTERVAL', 'ARCHON_GATEKEEPER_STATUS_INTERVAL',
            'ARCHON_KEYMASTER_DB', 'ARCHON_KEYMASTER_UPLOAD_LIMIT', 'ARCHON_WALLET_CACHE',
            'ARCHON_PROTOCOL', 'ARCHON_HYPR_EXPORT_INTERVAL', 'ARCHON_GATEKEEPER_PORT',
        ];

        const unchecked = defaulted.filter(name => !(compose.has(name) && code.has(name)));
        expect(unchecked.sort()).toEqual([]);
    });
});
