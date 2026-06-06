#!/usr/bin/env node
import dotenv from 'dotenv';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { redactSecretText } from './redact.js';
import { createArchonRuntime } from './runtime.js';
import { registerArchonTools } from './tools.js';

dotenv.config();

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

main().catch((error) => {
    console.error(`Archon MCP server failed: ${redactSecretText(error)}`);
    process.exit(1);
});
