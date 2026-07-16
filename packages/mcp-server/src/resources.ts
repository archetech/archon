import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { ArchonRuntime, requireKeymaster } from './runtime.js';

// An Archon asset DID is already a URI, so it is the resource URI verbatim -- the same one
// archon_get_asset_file puts in its embedded resource block. Registering this template is
// what makes that URI dereferenceable instead of decorative.
export const ARCHON_ASSET_URI_TEMPLATE = 'did:cid:{id}';

type RegisterableResourceServer = {
    registerResource?: (
        name: string,
        uriOrTemplate: unknown,
        config: Record<string, unknown>,
        readCallback: (uri: URL, variables: unknown, extra: unknown) => Promise<ReadResourceResult>
    ) => void;
};

async function readAsset(runtime: ArchonRuntime, uri: URL): Promise<ReadResourceResult> {
    const keymaster = requireKeymaster(runtime);
    const did = uri.href;

    // getFile first, and deliberately: it covers image assets too (an image asset stores
    // { file, image }, so asset.file is present for both), and binary assets are the ones
    // clients actually arrive here holding a URI for -- get_asset_file's resource block is
    // where these URIs come from. That costs one resolve for the common case; the JSON
    // fallback below pays a second.
    const file = await keymaster.getFile(did);

    if (file) {
        // getFile returns the file WITHOUT data when the gatekeeper cannot fetch its CID,
        // and returns null only when the asset is not a file asset at all. Those are
        // different failures and must not collapse: falling back to JSON here would answer
        // a request for bytes with metadata, reporting an unavailable CID as a success.
        if (!file.data) {
            throw new Error(`Asset data is unavailable for ${did}`);
        }

        return {
            contents: [{
                uri: did,
                mimeType: file.type ?? 'application/octet-stream',
                blob: Buffer.from(file.data).toString('base64'),
            }],
        };
    }

    // Not a file or image asset. Any other asset is readable as its JSON data, so a did:cid
    // URI resolves to something sensible rather than erroring on the flavour of asset.
    const asset = await keymaster.resolveAsset(did);

    return {
        contents: [{
            uri: did,
            mimeType: 'application/json',
            text: JSON.stringify(asset),
        }],
    };
}

export function registerArchonResources(server: RegisterableResourceServer, runtime: ArchonRuntime): void {
    if (!server.registerResource) {
        throw new Error('MCP server does not support resource registration');
    }

    server.registerResource(
        'archon-asset',
        // `list: undefined` is the SDK's explicit opt-out, not an oversight: enumerating
        // every asset in the wallet would hand its whole contents to any connected client,
        // read or not. Reads are by URI you already hold, so nothing is disclosed that
        // resolving the DID would not already reveal. Deciding what a filtered list should
        // expose is left open.
        new ResourceTemplate(ARCHON_ASSET_URI_TEMPLATE, { list: undefined }),
        {
            title: 'Archon asset',
            description: 'Read an Archon asset by its DID. File and image assets return their bytes; any other asset returns its JSON data.',
        },
        (uri: URL) => readAsset(runtime, uri)
    );
}
