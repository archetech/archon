import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

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

describe('service process guards', () => {
    it.each(ENTRY_POINTS)('%s installs the shared guard and marks startup complete', (file) => {
        const source = readFileSync(file, 'utf-8');

        expect(source).toContain('installProcessGuards');
        // Declared, then called: a guard that is never told startup finished
        // would end the service on the first stray rejection it ever sees.
        expect(source.split('startupComplete').length - 1).toBeGreaterThanOrEqual(2);
    });

    it('no service installs a raw process handler', () => {
        const offenders = sources('services').filter(file => RAW_HANDLER.test(readFileSync(file, 'utf-8')));

        expect(offenders).toStrictEqual([]);
    });
});
