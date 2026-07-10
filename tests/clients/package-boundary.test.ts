import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import GatekeeperClient from '@didcid/clients/gatekeeper';
import DrawbridgeClient from '@didcid/clients/drawbridge';
import KeymasterClient from '@didcid/clients/keymaster';
import LegacyGatekeeperClient from '@didcid/gatekeeper/client';
import LegacyDrawbridgeClient from '@didcid/gatekeeper/drawbridge';
import LegacyKeymasterClient from '@didcid/keymaster/client';

interface PackageManifest {
    dependencies?: Record<string, string>;
}

function packageManifest(relativePath: string): PackageManifest {
    return JSON.parse(readFileSync(resolve(process.cwd(), relativePath), 'utf8')) as PackageManifest;
}

describe('@didcid/clients package boundary', () => {
    test('has only lightweight runtime dependencies', () => {
        const clients = packageManifest('packages/clients/package.json');

        expect(Object.keys(clients.dependencies ?? {}).sort()).toEqual(['axios', 'buffer']);
    });

    test('removes the Gatekeeper runtime from Keymaster and MCP', () => {
        const keymaster = packageManifest('packages/keymaster/package.json');
        const mcpServer = packageManifest('packages/mcp-server/package.json');

        expect(keymaster.dependencies).not.toHaveProperty('@didcid/gatekeeper');
        expect(mcpServer.dependencies).not.toHaveProperty('@didcid/gatekeeper');
        expect(keymaster.dependencies).toHaveProperty('@didcid/clients');
        expect(mcpServer.dependencies).toHaveProperty('@didcid/clients');
    });

    test('keeps compatibility type modules runtime-empty', () => {
        const gatekeeperTypes = readFileSync(resolve(process.cwd(), 'packages/gatekeeper/src/types.ts'), 'utf8');
        const keymasterTypes = readFileSync(resolve(process.cwd(), 'packages/keymaster/src/types.ts'), 'utf8');

        expect(gatekeeperTypes).toContain("export type * from '@didcid/clients/gatekeeper-types';");
        expect(keymasterTypes).toContain("export type * from '@didcid/clients/keymaster-types';");
    });

    test('preserves legacy client entry points', () => {
        expect(LegacyGatekeeperClient).toBe(GatekeeperClient);
        expect(LegacyDrawbridgeClient).toBe(DrawbridgeClient);
        expect(LegacyKeymasterClient).toBe(KeymasterClient);
    });
});
