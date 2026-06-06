#!/usr/bin/env node
import dotenv from 'dotenv';
import { main } from './index.js';
import { redactSecretText } from './redact.js';

dotenv.config();

main().catch((error) => {
    console.error(`Archon MCP server failed: ${redactSecretText(error)}`);
    process.exit(1);
});
