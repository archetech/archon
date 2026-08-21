import { readdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';

// react-wallet and browser-extension were two full copies of the same UI (#894).
// Components move into packages/wallet-ui one at a time; these guard the parts
// already moved, because the failure mode is silent: someone adds a local
// component with a shared name, both trees drift again, and nothing complains
// until a bug is fixed in one and not the other.

const SHARED_DIR = 'packages/wallet-ui/src';
const APPS = ['apps/react-wallet/src', 'apps/browser-extension/src'];

// Walk the whole package rather than a list of directories. An earlier version
// named components/ and contexts/, and the very next change added hooks/ --
// which meant the file carrying the most logic sat outside the guard.
function sharedFiles(dir = SHARED_DIR): string[] {
    if (!existsSync(dir)) {
        return [];
    }

    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            return sharedFiles(path);
        }
        return /\.tsx?$/.test(entry.name) ? [path] : [];
    });
}

// Only components can be shadowed by an app-local copy, so index.ts and other
// bare .ts modules are excluded from that particular check.
function sharedComponentNames(): string[] {
    return sharedFiles()
        .map(path => path.split('/').pop() as string)
        .filter(name => name.endsWith('.tsx'));
}

describe('shared wallet UI', () => {
    it('has something in it', () => {
        // Guard the guard: an empty shared package would make every check below
        // vacuously true.
        expect(sharedFiles().length).toBeGreaterThan(0);
    });

    it('is not shadowed by a same-named component in either app', () => {
        const shadowed: string[] = [];

        for (const name of sharedComponentNames()) {
            for (const app of APPS) {
                for (const dir of ['components', 'contexts', 'modals']) {
                    const candidate = join(app, dir, name);
                    if (existsSync(candidate)) {
                        shadowed.push(candidate);
                    }
                }
            }
        }

        expect(shadowed).toStrictEqual([]);
    });

    it('reaches for no platform capability the other wallet lacks', () => {
        // The wallets differ in what their host can do: Capacitor (camera, safe
        // area) on one side, chrome.* on the other. A shared component that
        // imports either cannot compile for both, so capabilities are injected --
        // SnackbarProvider takes topOffset rather than reading a safe-area context.
        const offenders: string[] = [];

        for (const path of sharedFiles()) {
            // Comments stripped first: these files explain what each host does
            // differently, so naming chrome.storage in prose is expected and
            // only a real reference should fail.
            const source = readFileSync(path, 'utf-8')
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/\/\/.*$/gm, '');

            if (/@capacitor|@capawesome|\bchrome\./.test(source)) {
                offenders.push(path);
            }
        }

        expect(offenders).toStrictEqual([]);
    });
});
