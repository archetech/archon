import { ARCHON_MCP_CLI_COMMANDS, ARCHON_MCP_TOOL_DEFINITIONS } from '@didcid/mcp-server';
import fs from 'fs';

function normalizeCliCommand(command: string): string {
    return command.split(/\s+/)[0];
}

describe('mcp server CLI parity', () => {
    it('maps every Keymaster CLI command to one MCP tool', () => {
        const cliSource = fs.readFileSync('packages/keymaster/src/cli.ts', 'utf8');
        const cliCommands = [...cliSource.matchAll(/\.command\('([^']+)'/g)]
            .map(match => normalizeCliCommand(match[1]))
            .sort();
        const mcpCommands = [...ARCHON_MCP_CLI_COMMANDS].sort();

        expect(mcpCommands).toStrictEqual(cliCommands);
    });

    it('uses one MCP tool name per CLI command mapping', () => {
        const mappedCommands = ARCHON_MCP_TOOL_DEFINITIONS
            .filter(definition => definition.cliCommand)
            .map(definition => definition.cliCommand);
        const uniqueCommands = new Set(mappedCommands);
        const uniqueToolNames = new Set(ARCHON_MCP_TOOL_DEFINITIONS.map(definition => definition.name));

        expect(uniqueCommands.size).toBe(mappedCommands.length);
        expect(uniqueToolNames.size).toBe(ARCHON_MCP_TOOL_DEFINITIONS.length);
    });

    it('requires confirmation or reveal arguments for high-risk catalog entries', () => {
        const guardedInputs: Record<string, Record<string, unknown>> = {
            archon_revoke_did: { did: 'did:cid:alice' },
            archon_revoke_credential: { did: 'did:cid:credential' },
            archon_remove_id: { name: 'alice' },
            archon_new_wallet: {},
            archon_import_wallet: { recoveryPhrase: 'seed words' },
            archon_show_mnemonic: {},
            archon_show_wallet: {},
            archon_reveal_credential: { did: 'did:cid:credential' },
            archon_reveal_poll: { poll: 'did:cid:poll' },
            archon_lightning_pay: { bolt11: 'lnbc...' },
            archon_lightning_zap: { recipient: 'alice@example.com', amount: 1 },
        };

        for (const [toolName, args] of Object.entries(guardedInputs)) {
            const definition = ARCHON_MCP_TOOL_DEFINITIONS.find(item => item.name === toolName);
            expect(definition?.schema.safeParse(args).success).toBe(false);
        }

        expect(ARCHON_MCP_TOOL_DEFINITIONS.find(item => item.name === 'archon_revoke_did')?.schema.safeParse({
            did: 'did:cid:alice',
            confirm: true,
        }).success).toBe(true);
        expect(ARCHON_MCP_TOOL_DEFINITIONS.find(item => item.name === 'archon_show_mnemonic')?.schema.safeParse({
            reveal: true,
        }).success).toBe(true);
        expect(ARCHON_MCP_TOOL_DEFINITIONS.find(item => item.name === 'archon_lightning_pay')?.schema.safeParse({
            bolt11: 'lnbc...',
            confirmPayment: true,
        }).success).toBe(true);
    });
});
