import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFileSync } from 'child_process';
import { ARCHON_MCP_TOOL_DEFINITIONS } from '@didcid/mcp-server';

function parseToolResult(response: any) {
    return JSON.parse(response.content[0].text);
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

            const readResult = parseToolResult(await client.callTool({
                name: 'archon_list_ids',
                arguments: {},
            }));
            expect(readResult).toStrictEqual({
                ok: false,
                error: 'ARCHON_PASSPHRASE is required for wallet-backed MCP tools',
            });

            const writeResult = parseToolResult(await client.callTool({
                name: 'archon_create_id',
                arguments: { name: 'alice' },
            }));
            expect(writeResult).toStrictEqual({
                ok: false,
                error: 'ARCHON_PASSPHRASE is required for wallet-backed MCP tools',
            });
        } finally {
            await client.close();
        }
    }, 30000);
});
