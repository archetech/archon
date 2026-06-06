import { z, ZodTypeAny } from 'zod';
import { McpServerConfig } from './config.js';
import { ArchonRuntime } from './runtime.js';
import { errorMessage } from './redact.js';

type ToolHandler<T> = (args: T) => Promise<unknown>;

type RegisterableServer = {
    registerTool?: (name: string, config: any, handler: (args: unknown) => Promise<unknown>) => void;
    tool?: (name: string, description: string, schema: unknown, handler: (args: unknown) => Promise<unknown>) => void;
};

const EmptySchema = z.object({});
const ResolveOptionsSchema = z.object({
    confirm: z.boolean().optional(),
    verify: z.boolean().optional(),
    versionTime: z.string().optional(),
    versionSequence: z.number().int().optional(),
});

const JsonObjectSchema = z.record(z.unknown());
const AssetOptionsSchema = z.object({
    alias: z.string().optional(),
    registry: z.string().optional(),
    controller: z.string().optional(),
    validUntil: z.string().optional(),
});

function jsonResult(result: unknown) {
    return {
        content: [
            {
                type: 'text',
                text: JSON.stringify(result),
            },
        ],
    };
}

function ok(result: unknown) {
    return jsonResult({ ok: true, result });
}

function fail(error: unknown) {
    return jsonResult({ ok: false, error: errorMessage(error) });
}

function requireKeymaster(runtime: ArchonRuntime) {
    if (!runtime.keymaster) {
        throw new Error('ARCHON_PASSPHRASE is required for wallet-backed MCP tools');
    }

    return runtime.keymaster;
}

function registerTool<T>(
    server: RegisterableServer,
    name: string,
    description: string,
    schema: z.ZodType<T>,
    handler: ToolHandler<T>,
    options: { mutates?: boolean; readOnly?: boolean } = {}
) {
    const wrapped = async (rawArgs: unknown) => {
        try {
            const args = schema.parse(rawArgs ?? {});
            if (options.mutates && options.readOnly) {
                throw new Error('Tool disabled by ARCHON_MCP_READ_ONLY=true');
            }
            return ok(await handler(args));
        } catch (error) {
            return fail(error);
        }
    };

    if (server.registerTool) {
        server.registerTool(name, { description, inputSchema: schema }, wrapped);
        return;
    }

    if (server.tool && schema instanceof z.ZodObject) {
        server.tool(name, description, schema.shape, wrapped);
        return;
    }

    throw new Error('MCP server does not support tool registration');
}

function compactOptions<T extends Record<string, unknown>>(options: T): Partial<T> | undefined {
    const entries = Object.entries(options).filter(([, value]) => value !== undefined);
    return entries.length > 0 ? Object.fromEntries(entries) as Partial<T> : undefined;
}

export function registerArchonTools(server: RegisterableServer, runtime: ArchonRuntime, config: McpServerConfig): void {
    const mutating = { mutates: true, readOnly: config.readOnly };

    registerTool(server, 'archon_get_version', 'Get Archon node version information.', EmptySchema, async () => runtime.node.getVersion());
    registerTool(server, 'archon_get_status', 'Get Archon node status.', EmptySchema, async () => runtime.node.getStatus());
    registerTool(server, 'archon_list_registries', 'List registries supported by the connected Archon node.', EmptySchema, async () => runtime.node.listRegistries());

    registerTool(server, 'archon_list_ids', 'List IDs in the local Keymaster wallet.', EmptySchema, async () => requireKeymaster(runtime).listIds());
    registerTool(server, 'archon_get_current_id', 'Get the current local Keymaster wallet ID name.', EmptySchema, async () => requireKeymaster(runtime).getCurrentId());
    registerTool(server, 'archon_use_id', 'Set the current local Keymaster wallet ID name.', z.object({ name: z.string() }), async ({ name }) => requireKeymaster(runtime).setCurrentId(name), mutating);
    registerTool(
        server,
        'archon_create_id',
        'Create a new local Keymaster wallet ID.',
        z.object({ name: z.string(), registry: z.string().optional() }),
        async ({ name, registry }) => requireKeymaster(runtime).createId(name, compactOptions({ registry })),
        mutating
    );
    registerTool(
        server,
        'archon_resolve_did',
        'Resolve a DID or DID-like Archon identifier.',
        z.object({ did: z.string() }).merge(ResolveOptionsSchema),
        async ({ did, ...options }) => requireKeymaster(runtime).resolveDID(did, compactOptions(options))
    );
    registerTool(
        server,
        'archon_resolve_id',
        'Resolve a local ID name, alias, DID, or the current ID when id is omitted.',
        z.object({ id: z.string().optional() }).merge(ResolveOptionsSchema),
        async ({ id, ...options }) => {
            const keymaster = requireKeymaster(runtime);
            const resolvedId = id ?? await keymaster.getCurrentId();
            if (!resolvedId) {
                throw new Error('No current ID');
            }
            return keymaster.resolveDID(resolvedId, compactOptions(options));
        }
    );

    registerTool(server, 'archon_list_aliases', 'List DID aliases in the local Keymaster wallet.', EmptySchema, async () => requireKeymaster(runtime).listAliases());
    registerTool(server, 'archon_add_alias', 'Add a DID alias to the local Keymaster wallet.', z.object({ alias: z.string(), did: z.string() }), async ({ alias, did }) => requireKeymaster(runtime).addAlias(alias, did), mutating);
    registerTool(server, 'archon_get_alias', 'Get the DID assigned to a local alias.', z.object({ alias: z.string() }), async ({ alias }) => requireKeymaster(runtime).getAlias(alias));
    registerTool(server, 'archon_remove_alias', 'Remove a DID alias from the local Keymaster wallet.', z.object({ alias: z.string() }), async ({ alias }) => requireKeymaster(runtime).removeAlias(alias), mutating);

    registerTool(server, 'archon_list_addresses', 'List wallet addresses claimed through Herald domains.', EmptySchema, async () => requireKeymaster(runtime).listAddresses());
    registerTool(server, 'archon_check_address', 'Check whether a Herald address is available.', z.object({ address: z.string() }), async ({ address }) => requireKeymaster(runtime).checkAddress(address));
    registerTool(server, 'archon_add_address', 'Claim a Herald address for the current ID.', z.object({ address: z.string() }), async ({ address }) => requireKeymaster(runtime).addAddress(address), mutating);
    registerTool(server, 'archon_remove_address', 'Remove a Herald address from the current ID.', z.object({ address: z.string() }), async ({ address }) => requireKeymaster(runtime).removeAddress(address), mutating);
    registerTool(server, 'archon_publish_address', 'Publish a stored Herald address on a DID document.', z.object({ address: z.string().optional(), id: z.string().optional() }), async ({ address, id }) => requireKeymaster(runtime).publishAddress(address, id), mutating);
    registerTool(server, 'archon_unpublish_address', 'Remove a published Herald address from a DID document.', z.object({ id: z.string().optional() }), async ({ id }) => requireKeymaster(runtime).unpublishAddress(id), mutating);

    registerTool(server, 'archon_list_assets', 'List assets owned by the current local ID.', EmptySchema, async () => requireKeymaster(runtime).listAssets());
    registerTool(
        server,
        'archon_create_asset_json',
        'Create a JSON asset DID from inline JSON data.',
        z.object({ data: JsonObjectSchema }).merge(AssetOptionsSchema),
        async ({ data, ...options }) => requireKeymaster(runtime).createAsset(data, compactOptions(options)),
        mutating
    );
    registerTool(
        server,
        'archon_get_asset',
        'Resolve an asset by local name, alias, or DID.',
        z.object({ id: z.string() }).merge(ResolveOptionsSchema),
        async ({ id, ...options }) => requireKeymaster(runtime).resolveAsset(id, compactOptions(options))
    );
    registerTool(
        server,
        'archon_update_asset_json',
        'Merge JSON object data into an existing asset.',
        z.object({ id: z.string(), data: JsonObjectSchema }),
        async ({ id, data }) => requireKeymaster(runtime).mergeData(id, data),
        mutating
    );
    registerTool(server, 'archon_transfer_asset', 'Transfer an asset to a new controller DID.', z.object({ id: z.string(), controller: z.string() }), async ({ id, controller }) => requireKeymaster(runtime).transferAsset(id, controller), mutating);
}

export const testExports = {
    fail,
    ok,
    requireKeymaster,
    schemas: {
        EmptySchema,
        ResolveOptionsSchema: ResolveOptionsSchema as ZodTypeAny,
        JsonObjectSchema: JsonObjectSchema as ZodTypeAny,
        AssetOptionsSchema: AssetOptionsSchema as ZodTypeAny,
    },
};
