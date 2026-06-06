import { jest } from '@jest/globals';
import { registerArchonTools, McpServerConfig } from '@didcid/mcp-server';

type ToolHandler = (args?: unknown) => Promise<any>;

class FakeServer {
    tools = new Map<string, { config: any; handler: ToolHandler }>();

    registerTool(name: string, config: any, handler: ToolHandler) {
        this.tools.set(name, { config, handler });
    }
}

const baseConfig: McpServerConfig = {
    nodeUrl: 'http://localhost:4224',
    walletType: 'json',
    walletPath: './wallet.json',
    passphrase: 'secret',
    defaultRegistry: undefined,
    readOnly: false,
};

const mutatingTools = [
    'archon_add_address',
    'archon_add_alias',
    'archon_create_asset_json',
    'archon_create_id',
    'archon_publish_address',
    'archon_remove_address',
    'archon_remove_alias',
    'archon_transfer_asset',
    'archon_unpublish_address',
    'archon_update_asset_json',
    'archon_use_id',
];

const readTools = [
    'archon_check_address',
    'archon_get_alias',
    'archon_get_asset',
    'archon_get_current_id',
    'archon_get_status',
    'archon_get_version',
    'archon_list_addresses',
    'archon_list_aliases',
    'archon_list_assets',
    'archon_list_ids',
    'archon_list_registries',
    'archon_resolve_did',
    'archon_resolve_id',
];

function parseToolResult(response: any) {
    return JSON.parse(response.content[0].text);
}

function mockRuntime(overrides: Record<string, unknown> = {}) {
    const keymaster = {
        listIds: jest.fn().mockResolvedValue(['alice']),
        getCurrentId: jest.fn().mockResolvedValue('alice'),
        setCurrentId: jest.fn().mockResolvedValue(true),
        createId: jest.fn().mockResolvedValue('did:cid:new'),
        resolveDID: jest.fn().mockResolvedValue({ didDocument: { id: 'did:cid:alice' } }),
        listAliases: jest.fn().mockResolvedValue({ me: 'did:cid:alice' }),
        addAlias: jest.fn().mockResolvedValue(true),
        getAlias: jest.fn().mockResolvedValue('did:cid:alice'),
        removeAlias: jest.fn().mockResolvedValue(true),
        listAddresses: jest.fn().mockResolvedValue({}),
        checkAddress: jest.fn().mockResolvedValue({ available: true }),
        addAddress: jest.fn().mockResolvedValue(true),
        removeAddress: jest.fn().mockResolvedValue(true),
        publishAddress: jest.fn().mockResolvedValue(true),
        unpublishAddress: jest.fn().mockResolvedValue(true),
        listAssets: jest.fn().mockResolvedValue(['asset']),
        createAsset: jest.fn().mockResolvedValue('did:cid:asset'),
        resolveAsset: jest.fn().mockResolvedValue({ hello: 'world' }),
        mergeData: jest.fn().mockResolvedValue(true),
        transferAsset: jest.fn().mockResolvedValue(true),
        ...overrides,
    };

    return {
        node: {
            getVersion: jest.fn().mockResolvedValue({ version: '0.10.0', commit: 'abc123' }),
            getStatus: jest.fn().mockResolvedValue({ ready: true }),
            listRegistries: jest.fn().mockResolvedValue(['hyperswarm']),
        },
        keymaster,
    };
}

describe('mcp server tools', () => {
    it('registers the v1 tool surface', () => {
        const server = new FakeServer();
        registerArchonTools(server, mockRuntime() as any, baseConfig);

        expect([...server.tools.keys()].sort()).toStrictEqual([...mutatingTools, ...readTools].sort());
    });

    it('calls read tools and returns compact JSON payloads', async () => {
        const server = new FakeServer();
        const runtime = mockRuntime();
        registerArchonTools(server, runtime as any, baseConfig);

        const response = await server.tools.get('archon_list_registries')!.handler({});

        expect(parseToolResult(response)).toStrictEqual({ ok: true, result: ['hyperswarm'] });
        expect(runtime.node.listRegistries).toHaveBeenCalledTimes(1);
    });

    it('does not advertise mutating tools in read-only mode', () => {
        const server = new FakeServer();
        const runtime = mockRuntime();
        registerArchonTools(server, runtime as any, { ...baseConfig, readOnly: true });

        expect([...server.tools.keys()].sort()).toStrictEqual(readTools.sort());
        for (const tool of mutatingTools) {
            expect(server.tools.has(tool)).toBe(false);
        }
        expect(runtime.keymaster.createId).not.toHaveBeenCalled();
    });

    it('returns a clear passphrase error for wallet-backed tools without keymaster runtime', async () => {
        const server = new FakeServer();
        registerArchonTools(server, { node: mockRuntime().node } as any, { ...baseConfig, passphrase: undefined });

        const response = await server.tools.get('archon_list_ids')!.handler({});

        expect(parseToolResult(response)).toStrictEqual({
            ok: false,
            error: 'ARCHON_PASSPHRASE is required for wallet-backed MCP tools',
        });
    });

    it('validates required inputs', async () => {
        const server = new FakeServer();
        const runtime = mockRuntime();
        registerArchonTools(server, runtime as any, baseConfig);

        const response = await server.tools.get('archon_create_id')!.handler({});
        const result = parseToolResult(response);

        expect(result.ok).toBe(false);
        expect(result.error).toContain('Required');
        expect(runtime.keymaster.createId).not.toHaveBeenCalled();
    });

    it('passes optional inputs to keymaster calls', async () => {
        const server = new FakeServer();
        const runtime = mockRuntime();
        registerArchonTools(server, runtime as any, baseConfig);

        const response = await server.tools.get('archon_create_asset_json')!.handler({
            data: { hello: 'world' },
            alias: 'hello',
            registry: 'hyperswarm',
        });

        expect(parseToolResult(response)).toStrictEqual({ ok: true, result: 'did:cid:asset' });
        expect(runtime.keymaster.createAsset).toHaveBeenCalledWith(
            { hello: 'world' },
            { alias: 'hello', registry: 'hyperswarm' }
        );
    });

    it('redacts secrets from tool errors', async () => {
        const server = new FakeServer();
        const runtime = mockRuntime({
            listIds: jest.fn().mockRejectedValue(
                new Error('failed ARCHON_PASSPHRASE="my secret phrase" https://user:pass@bitcoin-mainnet.g.alchemy.com/v3/api-token?api_key=123')
            ),
        });
        registerArchonTools(server, runtime as any, baseConfig);

        const response = await server.tools.get('archon_list_ids')!.handler({});
        const result = parseToolResult(response);

        expect(result.ok).toBe(false);
        expect(result.error).toContain('ARCHON_PASSPHRASE=<redacted>');
        expect(result.error).toContain('https://<redacted>@bitcoin-mainnet.g.alchemy.com/v3/<redacted>?api_key=<redacted>');
        expect(result.error).not.toContain('secret');
        expect(result.error).not.toContain('phrase');
        expect(result.error).not.toContain('api-token');
    });
});
