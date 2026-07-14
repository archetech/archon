import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFileSync } from 'child_process';
import { ARCHON_MCP_TOOL_DEFINITIONS } from '@didcid/mcp-server';

// A spec-compliant client detects failure from isError alone; the message is the text block.
function expectToolError(response: any): string {
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toBeUndefined();

    return (response.content as any[])[0].text;
}

describe('mcp server stdio smoke', () => {
    beforeAll(() => {
        execFileSync('npm', ['run', 'build', '-w', '@didcid/mcp-server'], {
            cwd: process.cwd(),
            stdio: 'pipe',
        });
    }, 30000);

    it('lists tools and calls read and guarded write tools over stdio', async () => {
        const client = new Client({ name: 'archon-mcp-smoke', version: '0.0.0' });
        const transport = new StdioClientTransport({
            command: 'node',
            args: ['packages/mcp-server/dist/cli.js'],
            cwd: process.cwd(),
            stderr: 'pipe',
            env: {
                ARCHON_NODE_URL: 'http://127.0.0.1:1',
                ARCHON_WALLET_PATH: './wallet.json',
            },
        });

        try {
            await client.connect(transport);

            const listed = await client.listTools();
            const toolNames = listed.tools.map(tool => tool.name);

            expect(toolNames).toContain('archon_get_version');
            expect(toolNames).toContain('archon_create_id');
            expect(toolNames.length).toBe(ARCHON_MCP_TOOL_DEFINITIONS.length);

            const readResult = await client.callTool({
                name: 'archon_list_ids',
                arguments: {},
            });
            expect(expectToolError(readResult)).toBe('ARCHON_PASSPHRASE is required for wallet-backed MCP tools');

            const writeResult = await client.callTool({
                name: 'archon_create_id',
                arguments: { name: 'alice' },
            });
            expect(expectToolError(writeResult)).toBe('ARCHON_PASSPHRASE is required for wallet-backed MCP tools');

            const invalidArgsResult = await client.callTool({
                name: 'archon_create_id',
                arguments: {},
            });
            expect(expectToolError(invalidArgsResult)).toContain('Required');
        } finally {
            await client.close();
        }
    }, 30000);
});
