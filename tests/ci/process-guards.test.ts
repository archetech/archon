import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import ts from 'typescript';

// Every long-running service used to install its own uncaughtException and
// unhandledRejection handlers that logged and returned. Because they all do
// their real startup after binding a port, a startup failure left a process
// that answered /version, failed every real route, and never exited -- and
// each PR that touched startup re-discovered this and added its own
// try/process.exit wrapper (#1048, #1050, #1053).
//
// The shared guard is fatal until a service says it is up. A raw handler
// installed alongside it puts the swallowing behaviour back.

const ENTRY_POINTS = [
    'services/keymaster/server/src/keymaster-api.ts',
    'services/herald/server/src/index.ts',
    'services/gatekeeper/server/src/gatekeeper-api.ts',
    'services/mediators/hyperswarm/src/hyperswarm-mediator.ts',
];

const RAW_HANDLER = /process\.on\(\s*['"](?:uncaughtException|unhandledRejection)['"]/;

function sources(dir: string): string[] {
    return readdirSync(dir).flatMap(entry => {
        if (entry === 'node_modules' || entry === 'dist' || entry === 'build') {
            return [];
        }

        const path = join(dir, entry);

        if (statSync(path).isDirectory()) {
            return sources(path);
        }

        return /\.(ts|js|mjs)$/.test(entry) ? [path] : [];
    });
}

// Parsed rather than grepped: every one of these entry points names
// startupComplete in its comments too, so counting occurrences in the text
// stays green after the call itself is deleted.
function guardUse(file: string): { installs: boolean, completions: number } {
    const parsed = ts.createSourceFile(file, readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, true);

    let installs = false;
    let completions = 0;

    function visit(node: ts.Node): void {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'installProcessGuards') {
            installs = true;
        }

        // Anything but the name it is declared under: called, or handed to
        // whoever calls it. Comments are not identifiers, so they do not count.
        if (ts.isIdentifier(node) && node.text === 'startupComplete') {
            const declaresIt = (ts.isVariableDeclaration(node.parent) || ts.isParameter(node.parent)) && node.parent.name === node;

            if (!declaresIt) {
                completions++;
            }
        }

        ts.forEachChild(node, visit);
    }

    visit(parsed);

    return { installs, completions };
}

describe('service process guards', () => {
    it.each(ENTRY_POINTS)('%s installs the shared guard and marks startup complete', (file) => {
        const { installs, completions } = guardUse(file);

        expect(installs).toBe(true);
        // A guard never told that startup finished would end the service on
        // the first stray rejection it ever saw.
        expect(completions).toBeGreaterThanOrEqual(1);
    });

    it('no service installs a raw process handler', () => {
        const offenders = sources('services').filter(file => RAW_HANDLER.test(readFileSync(file, 'utf-8')));

        expect(offenders).toStrictEqual([]);
    });
});
