import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import ts from 'typescript';

// #919 added DIDComm credential exchange to the wallets and left the standalone
// clients without it. Nothing went red: eslint did not read .jsx (#939), tsc does
// not either (#923), and the render tests cover the wallets only (#914). The gap
// was found weeks later by someone opening the app and looking for a button.
//
// This asserts that a capability reaching one UI reaches the other, or that its
// absence is written down here with a reason. The allowlists below are the point
// of the test: the clients are demos and need not carry every wallet feature, but
// each omission should be a decision someone made rather than one nobody noticed.

// A UI surface is the shared component package plus the apps that mount it --
// not the package alone. getNodeCapabilities is the reason: the clients call it
// in their App.jsx and pass the answer to KeymasterUI as props, so scanning only
// packages/keymaster-ui reports it missing when it is merely one level up.
const SURFACES = {
    wallets: ['packages/wallet-ui/src', 'apps/react-wallet/src', 'apps/browser-extension/src'],
    clients: ['packages/keymaster-ui/src', 'apps/keymaster-client/src', 'apps/gatekeeper-client/src'],
};

// The implementations a UI is handed: the class in-process for the wallets, the
// HTTP client for the standalone clients. Their union is every name that can
// legitimately appear as a capability.
const IMPLEMENTATIONS = [
    'packages/keymaster/src/keymaster.ts',
    'packages/clients/src/keymaster-client.ts',
];

// Identifiers that hold a Keymaster. `keymaster` is almost all of it; the other
// two are locals in WalletProvider and App.jsx, where a fresh instance is built
// and used before it reaches state -- which is exactly where wallet creation and
// capability probing happen, so missing them loses real calls.
const KEYMASTER_RECEIVERS = new Set(['keymaster', 'instance', 'km']);

// Identifiers that are NOT a Keymaster but whose methods collide by name. The
// wallet stores genuinely have loadWallet/saveWallet, and a gatekeeper client
// has its own connect and getVersion. Counting these as capabilities would
// silently close a gap that is really still open.
const NOT_KEYMASTER = new Set([
    'walletStore', 'walletWeb', 'walletMemory', 'walletChrome', 'gatekeeper', 'cipher',
]);

// Capabilities one surface uses and the other deliberately does not.
// Removing a name here without the gap actually closing fails the test, and so
// does closing a gap without removing its name -- a stale reason is worse than
// none, because it reads as a decision that still holds.
const ABSENT_FROM_WALLETS: Record<string, string> = {
    connect: 'Wiring for a remote keymaster service. The wallets embed Keymaster in-process, so there is no endpoint to point at.',
    getVersion: 'Reports the version of that remote service in the client header. Nothing to report where there is no server.',
    saveWallet: 'The clients restore an uploaded backup by writing the whole wallet back. The wallets own their storage through walletStore and go through it instead.',
    sendCredential: 'The notice-based send. Both surfaces have sendCredentialDidComm; this older path was never built into the wallets.',
};

const ABSENT_FROM_CLIENTS: Record<string, string> = {
    fetchIdInfo: 'A convenience getter over what the clients already assemble from getCurrentId and resolveDID. Same information, fewer calls.',
    loadOrCreateWallet: 'Provisioning a local store. A client talks to a service that already has one, and provisions over REST with POST /wallet/new.',
    getDmailMessage: 'The clients resolve the message DID directly rather than asking for it by name.',
    getGroup: 'The clients read groups through resolveAsset, which returns the same document.',
    getSchema: 'The clients read schemas through resolveAsset, as they do groups.',
    signNostrEvent: 'The NIP-07 approval flow in the browser extension, which signs on behalf of a visited page. A client demo has no page asking it to sign.',
};

function sourceFiles(dir: string, found: string[] = []): string[] {
    // A missing root yields nothing here so that the surface-root test below
    // can report it by name. Letting readdirSync throw instead would abort the
    // whole suite at module scope, before any test runs, and an ENOENT stack is
    // a poor way to learn that a directory moved.
    if (!existsSync(dir)) {
        return found;
    }

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);

        if (entry.isDirectory()) {
            // Test scaffolding is not part of what a UI offers anybody. The
            // directory needs excluding as well as the filename pattern:
            // apps/browser-extension/src/test/setup.ts is named like ordinary
            // source, and a helper there that drove a Keymaster would read as a
            // capability the UI ships.
            if (!['node_modules', 'dist', 'build', 'test', 'tests', '__tests__', '__mocks__'].includes(entry.name)) {
                sourceFiles(path, found);
            }
            continue;
        }

        if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
            found.push(path);
        }
    }

    return found;
}

function scriptKind(file: string): ts.ScriptKind {
    if (file.endsWith('.tsx')) {
        return ts.ScriptKind.TSX;
    }
    if (file.endsWith('.ts')) {
        return ts.ScriptKind.TS;
    }
    if (file.endsWith('.jsx')) {
        return ts.ScriptKind.JSX;
    }
    return ts.ScriptKind.JS;
}

// Every `<receiver>.<method>(` in a file, found by parsing rather than by
// matching text. The difference is not cosmetic: a JSX attribute in this very
// tree reads accept="image/*", and a regex that strips block comments takes
// that as an opener and deletes everything up to the next */ -- 2711 lines of
// KeymasterUI.jsx, 47% of the file, silently unscanned. A capability added in
// that region would evade this guard entirely, which is the exact failure it
// exists to prevent. The parser knows a string from a comment; a regex does not.
function callsIn(file: string): Array<{ receiver: string, method: string }> {
    const source = ts.createSourceFile(
        file,
        readFileSync(file, 'utf-8'),
        ts.ScriptTarget.Latest,
        false,
        scriptKind(file),
    );

    const found: Array<{ receiver: string, method: string }> = [];

    function visit(node: ts.Node): void {
        if (
            ts.isCallExpression(node)
            && ts.isPropertyAccessExpression(node.expression)
            && ts.isIdentifier(node.expression.expression)
        ) {
            found.push({
                receiver: node.expression.expression.text,
                method: node.expression.name.text,
            });
        }

        ts.forEachChild(node, visit);
    }

    visit(source);

    return found;
}

function calls(surface: keyof typeof SURFACES): Array<{ receiver: string, method: string }> {
    return SURFACES[surface].flatMap(dir => sourceFiles(dir).flatMap(callsIn));
}

function capabilities(surface: keyof typeof SURFACES): Set<string> {
    return new Set(
        calls(surface)
            .filter(call => KEYMASTER_RECEIVERS.has(call.receiver))
            .map(call => call.method),
    );
}

// Method names declared on the implementation classes, read from the AST for
// the same reason as above.
function implementedMethods(): Set<string> {
    const found = new Set<string>();

    for (const file of IMPLEMENTATIONS) {
        const source = ts.createSourceFile(
            file,
            readFileSync(file, 'utf-8'),
            ts.ScriptTarget.Latest,
            false,
            ts.ScriptKind.TS,
        );

        function visit(node: ts.Node): void {
            if (ts.isClassDeclaration(node)) {
                for (const member of node.members) {
                    if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name)) {
                        found.add(member.name.text);
                    }
                }
            }

            ts.forEachChild(node, visit);
        }

        visit(source);
    }

    return found;
}

const wallets = capabilities('wallets');
const clients = capabilities('clients');
const union = new Set([...wallets, ...clients]);

describe('UI capability parity', () => {
    it('has a surface root for every directory it claims to scan', () => {
        // A misspelled or moved root would otherwise scan as empty, and the
        // aggregate count below would still clear its threshold on the strength
        // of the shared package alone -- so a whole app could drop out of
        // coverage without anything failing.
        const missing = Object.values(SURFACES).flat().filter(dir => !existsSync(dir));

        expect(missing).toStrictEqual([]);
    });

    it('finds capabilities in both surfaces', () => {
        // Guard the guard. A regex or a path that stopped matching would empty
        // both sets, and every check below would pass by finding no gap at all.
        expect(wallets.size).toBeGreaterThan(80);
        expect(clients.size).toBeGreaterThan(80);
    });

    it('scans only real keymaster methods', () => {
        // A name that no implementation has means the scanner is reading
        // something that is not a keymaster call, and the gaps it reports are
        // noise.
        const implemented = implementedMethods();
        const unknown = [...union].filter(name => !implemented.has(name)).sort();

        expect(unknown).toStrictEqual([]);
    });

    it('has classified every receiver that calls a keymaster method', () => {
        // The scan turns on knowing which identifiers hold a Keymaster. A new
        // one lands here as a failure asking that question, rather than as a
        // silently dropped call -- which is how `instance` and `km` were nearly
        // missed, taking wallet creation and capability probing with them.
        const implemented = implementedMethods();
        const unclassified = [...new Set(
            [...calls('wallets'), ...calls('clients')]
                .filter(call => implemented.has(call.method))
                .map(call => call.receiver)
                .filter(receiver => !KEYMASTER_RECEIVERS.has(receiver) && !NOT_KEYMASTER.has(receiver)),
        )].sort();

        expect(unclassified).toStrictEqual([]);
    });

    it('records every capability the wallets do not offer', () => {
        const absent = [...union].filter(name => !wallets.has(name)).sort();

        expect(absent).toStrictEqual(Object.keys(ABSENT_FROM_WALLETS).sort());
    });

    it('records every capability the clients do not offer', () => {
        const absent = [...union].filter(name => !clients.has(name)).sort();

        expect(absent).toStrictEqual(Object.keys(ABSENT_FROM_CLIENTS).sort());
    });

    it('gives a reason for every recorded omission', () => {
        // An empty string would satisfy the key comparison above while
        // recording nothing, which is the state this whole test exists to
        // prevent.
        for (const reasons of [ABSENT_FROM_WALLETS, ABSENT_FROM_CLIENTS]) {
            for (const [capability, reason] of Object.entries(reasons)) {
                expect(reason.length).toBeGreaterThan(20);
                expect(capability).not.toBe('');
            }
        }
    });
});
