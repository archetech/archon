import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { ArchonRuntime, requireKeymaster } from './runtime.js';

// An Archon asset DID is already a URI, so it is the resource URI verbatim -- the same one
// archon_get_asset_file puts in its embedded resource block. Registering this template is
// what makes that URI dereferenceable instead of decorative.
export const ARCHON_ASSET_URI_TEMPLATE = 'did:cid:{id}';

// A vault item has no DID of its own -- it is a named entry inside a vault, keyed by
// (container DID, name) -- so it is addressed as a DID URL fragment. Item names allow
// anything printable (validateAlias only rejects control characters), including '#' and
// spaces, so the fragment must be percent-encoded.
export const ARCHON_VAULT_ITEM_URI_TEMPLATE = 'did:cid:{id}#{item}';

export function vaultItemUri(containerDid: string, name: string): string {
    return `${containerDid}#${encodeURIComponent(name)}`;
}

// Shared by the tools and the resource reader so one failure reads the same everywhere.
// The message names the CID, as keymaster's own getVaultItem error does: it is the detail
// that makes the failure diagnosable -- unpinned data, or a gateway that is down -- and it
// is not a secret, being already in the DID document.
export function assetDataUnavailable(id: string, cid?: string): Error {
    const which = cid ? ` (CID: ${cid})` : '';

    return new Error(`Asset data is unavailable for ${id}${which}`);
}

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
            throw assetDataUnavailable(did, file.cid);
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

// A dmail attachment is a vault item: addDmailAttachment delegates to addVaultItem and
// getDmailAttachment to getVaultItem, so a dmail IS a vault as far as items go. One
// template and one reader therefore cover both surfaces.
async function readVaultItem(runtime: ArchonRuntime, variables: { id: string; item: string }): Promise<ReadResourceResult> {
    const keymaster = requireKeymaster(runtime);
    const did = `did:cid:${variables.id}`;
    const name = decodeURIComponent(variables.item);
    const uri = vaultItemUri(did, name);

    const buffer = await keymaster.getVaultItem(did, name);

    if (!buffer) {
        throw new Error(`Vault item not found: ${uri}`);
    }

    // The recorded type, not a re-sniff of the bytes: addVaultItem stores what getMimeType
    // detected at write time and list_vault_items reports that value, so deriving it again
    // here risks two surfaces disagreeing about one item. Costs a second vault decrypt.
    const items = await keymaster.listVaultItems(did);

    return {
        contents: [{
            uri,
            mimeType: items?.[name]?.type ?? 'application/octet-stream',
            blob: Buffer.from(buffer).toString('base64'),
        }],
    };
}

export function registerArchonResources(server: RegisterableResourceServer, runtime: ArchonRuntime): void {
    if (!server.registerResource) {
        throw new Error('MCP server does not support resource registration');
    }

    // Registered BEFORE the asset template, and the order is load-bearing: the SDK returns
    // the first template whose URI matches, and 'did:cid:{id}' matches greedily -- it would
    // otherwise swallow 'did:cid:vault#item' as id='vault#item' and fail inside the asset
    // reader. The reverse cannot happen: this template does not match a bare DID.
    server.registerResource(
        'archon-vault-item',
        new ResourceTemplate(ARCHON_VAULT_ITEM_URI_TEMPLATE, { list: undefined }),
        {
            title: 'Archon vault item',
            description: 'Read an item stored in a vault, or an attachment on a dmail, by the container DID plus the item name as a percent-encoded fragment.',
        },
        (_uri: URL, variables: unknown) => readVaultItem(runtime, variables as { id: string; item: string })
    );

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
