import { archon } from './helpers';

describe('help', () => {
    test('help output contains expected commands', async () => {
        const output = await archon('help');

        // Validate header
        expect(output).toContain('Archon CLI tool');
        expect(output).toContain('Commands:');

        // Validate key commands are present
        const expectedCommands = [
            'accept-credential',
            'add-alias',
            'add-group-member',
            'backup-id',
            'bind-credential',
            'check-wallet',
            'create-id',
            'create-schema',
            'create-vault',
            'decrypt-did',
            'encrypt-file',
            'encrypt-message',
            'fix-wallet',
            'get-alias',
            'import-wallet',
            'issue-credential',
            'list-aliases',
            'list-assets',
            'list-credentials',
            'list-groups',
            'list-ids',
            'list-issued',
            'list-schemas',
            'new-wallet',
            'publish-credential',
            'recover-id',
            'remove-alias',
            'remove-id',
            'resolve-did',
            'resolve-id',
            'revoke-credential',
            'rotate-keys',
            'show-mnemonic',
            'show-wallet',
            'use-id',
            'verify-file',
            'view-credential',
        ];

        for (const cmd of expectedCommands) {
            expect(output).toContain(cmd);
        }
    });

    test('help output lists commands in alphabetical order', async () => {
        const output = await archon('help');

        // Extract command names from lines that match the "  command-name  " pattern
        const commandLines = output.split('\n').filter(line => /^\s{2}\w/.test(line));
        const commands = commandLines
            .map(line => line.trim().split(/\s+/)[0])
            .filter(cmd => cmd && !cmd.startsWith('-'));

        const sorted = [...commands].sort();
        expect(commands).toEqual(sorted);
    });
});
