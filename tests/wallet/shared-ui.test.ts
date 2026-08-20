import { readdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';

// react-wallet and browser-extension were two full copies of the same UI (#894).
// Components move into packages/wallet-ui one at a time; these guard the parts
// already moved, because the failure mode is silent: someone adds a local
// component with a shared name, both trees drift again, and nothing complains
// until a bug is fixed in one and not the other.

const SHARED_DIR = 'packages/wallet-ui/src';
const APPS = ['apps/react-wallet/src', 'apps/browser-extension/src'];

function sharedNames(): string[] {
    return ['components', 'contexts']
        .flatMap(dir => {
            const path = join(SHARED_DIR, dir);
            return existsSync(path) ? readdirSync(path) : [];
        })
        .filter(name => name.endsWith('.tsx'));
}

describe('shared wallet UI', () => {
    it('has something in it', () => {
        // Guard the guard: an empty shared package would make every check below
        // vacuously true.
        expect(sharedNames().length).toBeGreaterThan(0);
    });

    it('is not shadowed by a same-named component in either app', () => {
        const shadowed: string[] = [];

        for (const name of sharedNames()) {
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

        for (const dir of ['components', 'contexts']) {
            const path = join(SHARED_DIR, dir);
            if (!existsSync(path)) continue;

            for (const name of readdirSync(path).filter(f => f.endsWith('.tsx'))) {
                const source = readFileSync(join(path, name), 'utf-8');
                if (/@capacitor|@capawesome|\bchrome\./.test(source)) {
                    offenders.push(name);
                }
            }
        }

        expect(offenders).toStrictEqual([]);
    });
});
