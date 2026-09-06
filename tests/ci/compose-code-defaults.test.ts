import { readFileSync } from 'fs';
import { globSync } from 'fs';
import ts from 'typescript';

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

// Every service that reads its own environment, and every runtime flavor of the
// ones with more than one, so a default cannot drift between ports meant to be
// interchangeable. Globbed rather than listed: a config file nothing here
// matches is a file whose defaults nothing compares against.
const CONFIGS = globSync('services/*/server/src/config.*')
    .concat(globSync('services/mediators/*/src/config.*'))
    .concat([
        'rust/services/gatekeeper/src/config.rs',
        'python/keymaster_service/src/keymaster_service/config.py',
    ]);

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

// A default that is not a literal -- a call, another variable, a nested
// ternary -- is not a second copy of anything a compose file writes, so it goes
// unrecorded rather than recorded wrong.
function literalValue(node: ts.Node): string | null {
    if (ts.isStringLiteral(node)) {
        return node.text;
    }

    if (ts.isNumericLiteral(node)) {
        // 10_000 in code is 10000 in compose.
        return node.getText().replace(/_/g, '');
    }

    if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
        return node.getText();
    }

    return null;
}

// process.env.NAME, and nothing else that looks like it.
function envVarName(node: ts.Node): string | null {
    return ts.isPropertyAccessExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === 'process'
        && node.expression.name.text === 'env'
        ? node.name.text
        : null;
}

// The four shapes the services read an environment variable in:
//
//   process.env.VAR || 'value'
//   process.env.VAR ? parseInt(process.env.VAR) : 60
//   process.env.VAR === 'true'     — absent means false
//   process.env.VAR !== 'false'    — absent means true
//
// Parsed rather than matched by pattern, because the last two appear inside the
// first two: a regex recognising the bare comparison also fires on the one
// nested in a ternary, and records false for a variable whose default is true.
function jsDefaults(path: string, into: Map<string, Declaration[]>): void {
    const source = ts.createSourceFile(path, readFileSync(path, 'utf-8'), ts.ScriptTarget.Latest, true);

    function unwrap(node: ts.Expression): ts.Expression {
        return ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;
    }

    function visit(node: ts.Node): void {
        const declared = ts.isPropertyAssignment(node) || ts.isVariableDeclaration(node);
        const initializer = declared && node.initializer ? unwrap(node.initializer) : undefined;

        if (initializer && ts.isConditionalExpression(initializer)) {
            const name = envVarName(unwrap(initializer.condition));
            const value = literalValue(unwrap(initializer.whenFalse));

            if (name && value !== null) {
                record(into, name, value, path);
            }
        }

        if (initializer && ts.isBinaryExpression(initializer)) {
            const name = envVarName(unwrap(initializer.left));
            const right = unwrap(initializer.right);
            const operator = initializer.operatorToken.kind;

            if (name && operator === ts.SyntaxKind.BarBarToken) {
                const value = literalValue(right);

                if (value !== null) {
                    record(into, name, value, path);
                }
            }

            if (name && operator === ts.SyntaxKind.EqualsEqualsEqualsToken && literalValue(right) === 'true') {
                record(into, name, 'false', path);
            }

            if (name && operator === ts.SyntaxKind.ExclamationEqualsEqualsToken && literalValue(right) === 'false') {
                record(into, name, 'true', path);
            }
        }

        ts.forEachChild(node, visit);
    }

    visit(source);
}

function codeDefaults(): Map<string, Declaration[]> {
    const defaults = collect();

    for (const path of CONFIGS) {
        if (path.endsWith('.ts') || path.endsWith('.js')) {
            jsDefaults(path, defaults);
            continue;
        }

        const text = readFileSync(path, 'utf-8');

        // env_var_or_default("VAR", "value")   os.environ.get("VAR", "value")
        for (const [, a, b, value] of text.matchAll(
            /(?:env_var_or_default\(\s*"([A-Z][A-Z0-9_]*)"\s*,|os\.environ\.get\(\s*"([A-Z][A-Z0-9_]*)"\s*,)\s*['"]([^'"]*)['"]/g)) {
            record(defaults, (a ?? b)!, value, path);
        }

        // env_parse("VAR", 60)
        for (const [, name, value] of text.matchAll(/env_parse\(\s*"([A-Z][A-Z0-9_]*)"\s*,\s*(\d+)\s*\)/g)) {
            record(defaults, name, value, path);
        }

        // os.environ.get("VAR", "false").lower() == "true"
        for (const [, name, value] of text.matchAll(
            /os\.environ\.get\(\s*"([A-Z][A-Z0-9_]*)"\s*,\s*"(true|false)"\s*\)\s*\.lower\(\)/g)) {
            record(defaults, name, value, path);
        }
    }

    // An empty code default is the absence of one, the same way an empty
    // compose default means "leave it unset" rather than "set it to nothing".
    for (const [name, declarations] of defaults) {
        const values = declarations.filter(declaration => declaration.value !== '');

        if (values.length) {
            defaults.set(name, values);
        }
        else {
            defaults.delete(name);
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
