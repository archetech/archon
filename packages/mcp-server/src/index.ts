import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createArchonRuntime } from './runtime.js';
import { registerArchonTools } from './tools.js';

export { loadConfig, walletLocation } from './config.js';
export type { McpServerConfig, WalletType } from './config.js';
export { createArchonRuntime, createWallet } from './runtime.js';
export type { ArchonRuntime } from './runtime.js';
export { registerArchonTools } from './tools.js';

export async function main(): Promise<void> {
    const config = loadConfig();
    const runtime = await createArchonRuntime(config);
    const server = new McpServer({
        name: '@didcid/mcp-server',
        version: '0.1.0',
    });

    registerArchonTools(server as any, runtime, config);

    const transport = new StdioServerTransport();
    await server.connect(transport);
}
