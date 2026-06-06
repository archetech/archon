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
});
