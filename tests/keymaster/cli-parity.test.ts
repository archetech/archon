import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// AGENTS.md requires the three CLIs to stay in parity:
//
//   packages/keymaster/src/cli.ts        (library-backed)
//   python/keymaster/src/keymaster/cli.py (library-backed, pure-Python port)
//   scripts/archon-cli.js                (service-backed; this is the `archon` command)
//
// That rule used to be enforced by memory alone, and scripts/archon-cli.js had
// drifted 40 commands behind before anyone noticed. These tests enforce it
// instead.

// Commands that are deliberately not mirrored, with the reason. Anything else
// appearing on one CLI and not the others is a failure, not an exception.
const SCRIPT_ONLY = new Set([
    // Times round trips through the Keymaster *service*. The other two CLIs use
    // the library directly and so have no service round trip to measure.
    'perf-test',
]);

// Resolve from this file, not process.cwd(). cwd is process-global and the unit
// suite runs --runInBand, so any test that chdirs -- and fails or times out
// before restoring -- would otherwise make this suite fail with an ENOENT that
// names an unrelated temp directory.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function readSource(relativePath: string): string {
    return readFileSync(path.join(REPO_ROOT, relativePath), 'utf-8');
}

const packageCli = readSource('packages/keymaster/src/cli.ts');
const scriptCli = readSource('scripts/archon-cli.js');
const pythonCli = readSource('python/keymaster/src/keymaster/cli.py');

// commander: .command('name <required> [optional]')
function commanderSignatures(source: string): Map<string, string> {
    const signatures = new Map<string, string>();
    for (const match of source.matchAll(/\.command\('([^']+)'/g)) {
        const [name, ...args] = match[1].split(' ');
        signatures.set(name, args.join(' '));
    }
    return signatures;
}

// argparse: add("name", "description", handler)
function pythonCommands(source: string): string[] {
    return [...source.matchAll(/\badd\("([a-z0-9-]+)"/g)].map(match => match[1]).sort();
}

function commandNames(source: string): string[] {
    return [...commanderSignatures(source).keys()].sort();
}

// Argument shape, not argument names: '<did> <registry>' and '<id> <registry>'
// describe the same interface, and one CLI calling it `did` where another calls
// it `id` is cosmetic. A differing count, or required where the other is
// optional, is not.
function argumentShape(args: string): string {
    return args
        .split(' ')
        .filter(Boolean)
        .map(arg => (arg.startsWith('<') ? '<>' : arg.startsWith('[') ? '[]' : arg))
        .join(' ');
}

// The source of one commander command: from its .command( to the next.
function commandBlock(source: string, command: string): string {
    const start = source.indexOf(`.command('${command}`);
    if (start === -1) {
        return '';
    }
    const next = source.indexOf('.command(', start + 1);
    return source.slice(start, next === -1 ? undefined : next);
}

function optionsFor(source: string, command: string): string[] {
    const block = commandBlock(source, command);
    return [...block.matchAll(/\.option\('([^']+)'/g)]
        .map(match => match[1].split(',').map(part => part.trim()).pop() as string)
        .sort();
}

describe('CLI parity across entry points', () => {
    const expected = commandNames(packageCli).filter(name => !SCRIPT_ONLY.has(name));

    it('has commands to compare', () => {
        expect(expected.length).toBeGreaterThan(100);
    });

    it('exposes the same commands in the script CLI as the package CLI', () => {
        expect(commandNames(scriptCli).filter(name => !SCRIPT_ONLY.has(name))).toEqual(expected);
    });

    it('exposes the same commands in the Python CLI as the package CLI', () => {
        expect(pythonCommands(pythonCli).filter(name => !SCRIPT_ONLY.has(name))).toEqual(expected);
    });

    it('declares the same options on each command in both JS CLIs', () => {
        const mismatches: string[] = [];

        for (const command of expected) {
            const fromPackage = optionsFor(packageCli, command);
            const fromScript = optionsFor(scriptCli, command);

            if (JSON.stringify(fromPackage) !== JSON.stringify(fromScript)) {
                mismatches.push(`${command}: package ${JSON.stringify(fromPackage)} vs script ${JSON.stringify(fromScript)}`);
            }
        }

        expect(mismatches).toEqual([]);
    });

    it('takes the same argument shape on each command in both JS CLIs', () => {
        const fromPackage = commanderSignatures(packageCli);
        const fromScript = commanderSignatures(scriptCli);
        const mismatches: string[] = [];

        for (const command of expected) {
            const packageShape = argumentShape(fromPackage.get(command) ?? '');
            const scriptShape = argumentShape(fromScript.get(command) ?? '');

            if (packageShape !== scriptShape) {
                mismatches.push(`${command}: package '${packageShape}' vs script '${scriptShape}'`);
            }
        }

        expect(mismatches).toEqual([]);
    });

    it('does not let a script-only command quietly become a general exception', () => {
        // If a SCRIPT_ONLY command ever does appear in the other CLIs, the
        // exception is stale and should be deleted rather than left to hide drift.
        for (const command of SCRIPT_ONLY) {
            expect(commandNames(packageCli)).not.toContain(command);
            expect(pythonCommands(pythonCli)).not.toContain(command);
            expect(commandNames(scriptCli)).toContain(command);
        }
    });

    // The rule covered commands and options only, so the three could differ in
    // how they are configured without anything noticing. The Python CLI read
    // nothing but os.environ while the other two loaded a .env, which made any
    // documentation recommending one false for Python users (#1016).
    it('all read a .env from the working directory', () => {
        expect(packageCli).toMatch(/dotenv\.config\(\)/);
        expect(scriptCli).toMatch(/dotenv\.config\(\)/);
        // Matching `load_dotenv(` alone is satisfied by the definition of the
        // wrapper, so this requires main to actually call it.
        expect(pythonCli).toMatch(/def main\([^)]*\)[^:]*:\n\s+_load_dotenv\(\)/);
    });

    it('does not let the Python CLI search parent directories for one', () => {
        // load_dotenv() with no argument resolves from the installed package's
        // location rather than the caller's, so it would not find the user's
        // .env at all. The other two read the working directory only.
        expect(pythonCli).toMatch(/load_dotenv\(Path\.cwd\(\) \/ "\.env", override=False\)/);
    });
});

// Which commands may run before a wallet exists is policy, held as an allowlist
// in each CLI. The two lists have to agree, and each entry has to be honest:
// a command on the list either creates or replaces a wallet in its own handler,
// provisions explicitly, or never touches one. An entry that does none of those
// reaches loadWallet on an empty store and fails with 'Wallet not found' -- the
// regression #1050's review caught on the MCP surface.
describe('wallet-optional command policy', () => {
    const jsAllowlist = [...packageCli.matchAll(/walletOptionalCommands = \[([^\]]+)\]/g)]
        .flatMap(m => m[1].split(',').map(part => part.trim().replace(/^'|'$/g, '')))
        .filter(Boolean)
        .sort();
    const pyAllowlist = (() => {
        const start = pythonCli.indexOf('WALLET_OPTIONAL_COMMANDS = {');
        const end = pythonCli.indexOf('}', start);
        return [...pythonCli.slice(start, end).matchAll(/"([a-z-]+)"/g)].map(m => m[1]).sort();
    })();

    it('is declared in both CLIs', () => {
        expect(jsAllowlist.length).toBeGreaterThan(0);
        expect(pyAllowlist.length).toBeGreaterThan(0);
    });

    it('is the same list in both CLIs', () => {
        expect(pyAllowlist).toEqual(jsAllowlist);
    });

    // What each allowlisted handler does about the wallet, by name. A command
    // that creates, replaces or provisions has a positive pattern; a command
    // that needs no wallet is marked null and is checked for the absence of a
    // read instead -- the defect this guard exists to catch is a wallet read
    // creeping into a handler that runs before one exists.
    const HANDLES_ITS_OWN_WALLET: Record<string, RegExp | null> = {
        'create-wallet': /loadOrCreateWallet\(/,
        'new-wallet': /newWallet\(/,
        'create-id': /loadOrCreateWallet\(/,
        'import-wallet': /newWallet\(/,
        'restore-wallet-file': /saveWallet\(/,
        'list-registries': null,
    };
    const READS_THE_WALLET = /\.(loadWallet|mutateWallet|decryptMnemonic)\(/;

    // argparse: handlers are `async def cmd_<name>` with hyphens as underscores;
    // the block runs to the next top-level def.
    function pythonCommandBlock(source: string, command: string): string {
        const name = `cmd_${command.replace(/-/g, '_')}`;
        const start = source.indexOf(`async def ${name}(`);
        if (start === -1) {
            return '';
        }
        const next = source.slice(start + 1).search(/\n(?:async )?def /);
        return next === -1 ? source.slice(start) : source.slice(start, start + 1 + next);
    }

    const PY_HANDLES_ITS_OWN_WALLET: Record<string, RegExp | null> = {
        'create-wallet': /load_or_create_wallet\(/,
        'new-wallet': /new_wallet\(/,
        'create-id': /load_or_create_wallet\(/,
        'import-wallet': /new_wallet\(/,
        'restore-wallet-file': /save_wallet\(/,
        'list-registries': null,
    };
    const PY_READS_THE_WALLET = /\.(load_wallet|decrypt_mnemonic)\(/;

    it.each(pyAllowlist)('%s handles the wallet itself in the Python CLI', (command) => {
        expect(PY_HANDLES_ITS_OWN_WALLET).toHaveProperty(command);
        const pattern = PY_HANDLES_ITS_OWN_WALLET[command];
        const handler = pythonCommandBlock(pythonCli, command);
        expect(handler).not.toBe('');

        if (pattern === null) {
            expect(handler).not.toMatch(PY_READS_THE_WALLET);
        } else {
            expect(handler).toMatch(pattern);
        }
    });

    it.each(jsAllowlist)('%s handles the wallet itself in the package CLI', (command) => {
        expect(HANDLES_ITS_OWN_WALLET).toHaveProperty(command);
        const pattern = HANDLES_ITS_OWN_WALLET[command];
        const handler = commandBlock(packageCli, command);

        if (pattern === null) {
            expect(handler).not.toMatch(READS_THE_WALLET);
        } else {
            expect(handler).toMatch(pattern);
        }
    });
});
