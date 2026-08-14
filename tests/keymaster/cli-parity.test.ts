import { readFileSync } from 'fs';
import path from 'path';

// The repo ships two CLI entry points: the package CLI (packages/keymaster/src/cli.ts)
// and the standalone script (scripts/archon-cli.js). They have drifted apart in
// general -- the script is missing whole families (dmail, lightning, address,
// nostr) -- so this does not assert wholesale parity.
//
// It does assert parity for DIDComm, because that surface is mirrored in both
// and a command added to one but not the other stays invisible until a user of
// the other entry point goes looking for it. That is exactly how `ack-didcomm`
// and `receive-didcomm --no-ack` were first missed.

function readSource(relativePath: string): string {
    return readFileSync(path.join(process.cwd(), relativePath), 'utf-8');
}

function didcommCommands(source: string): string[] {
    const matches = source.matchAll(/\.command\('([a-z0-9-]*didcomm[a-z0-9-]*)/g);
    return [...matches].map(match => match[1]).sort();
}

function optionsFor(source: string, command: string): string[] {
    // Everything between this .command(...) and the next one is its definition.
    const start = source.indexOf(`.command('${command}`);
    if (start === -1) {
        return [];
    }
    const next = source.indexOf('.command(', start + 1);
    const block = source.slice(start, next === -1 ? undefined : next);
    return [...block.matchAll(/\.option\('([^']+)'/g)]
        .map(match => match[1].split(',').map(part => part.trim()).pop() as string)
        .sort();
}

describe('DIDComm CLI parity between entry points', () => {
    const packageCli = readSource('packages/keymaster/src/cli.ts');
    const scriptCli = readSource('scripts/archon-cli.js');

    it('exposes the same DIDComm commands in both CLIs', () => {
        const fromPackage = didcommCommands(packageCli);

        expect(fromPackage.length).toBeGreaterThan(0);
        expect(didcommCommands(scriptCli)).toEqual(fromPackage);
    });

    it('exposes the same options on each DIDComm command in both CLIs', () => {
        const mismatches: string[] = [];

        for (const command of didcommCommands(packageCli)) {
            const fromPackage = optionsFor(packageCli, command);
            const fromScript = optionsFor(scriptCli, command);

            if (JSON.stringify(fromPackage) !== JSON.stringify(fromScript)) {
                mismatches.push(`${command}: package ${JSON.stringify(fromPackage)} vs script ${JSON.stringify(fromScript)}`);
            }
        }

        expect(mismatches).toEqual([]);
    });
});
