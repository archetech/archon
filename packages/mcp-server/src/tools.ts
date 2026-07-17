import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { McpServerConfig } from './config.js';
import { ArchonRuntime, requireKeymaster } from './runtime.js';
import { vaultItemUri } from './resources.js';
import { errorMessage } from './redact.js';

type RegisterableServer = {
    registerTool?: (name: string, config: any, handler: (args: unknown) => Promise<unknown>) => void;
    tool?: (name: string, description: string, schema: unknown, handler: (args: unknown) => Promise<unknown>) => void;
};

type ToolDefinitionBase = {
    name: string;
    cliCommand?: string;
    description: string;
    // Declaring this is a promise the MCP spec enforces: the SDK rejects the call, on
    // both the server and the client, if structuredContent is absent or does not match.
    // Only tools that always return a JSON object may declare one -- see README.
    outputSchema?: z.ZodTypeAny;
    mutates?: boolean;
};

// What tool() accepts: the handler's args are tied to this tool's own input schema.
type TypedToolDefinition<S extends z.ZodTypeAny> = ToolDefinitionBase & {
    schema: S;
    handler: (runtime: ArchonRuntime, args: z.infer<S>, config: McpServerConfig) => Promise<unknown> | unknown;
};

// What the registry holds. The per-tool arg type can't survive into a homogeneous list
// (handlers are contravariant in their args), so the generic is erased here and enforced
// at authoring time by tool() instead. Args reaching a handler are schema.parse() output.
export type ArchonToolDefinition = ToolDefinitionBase & {
    schema: z.ZodTypeAny;
    handler: (runtime: ArchonRuntime, args: any, config: McpServerConfig) => Promise<unknown> | unknown;
};

const EmptySchema = z.object({});
const IdSchema = z.object({ id: z.string() });
const DidSchema = z.object({ did: z.string() });
const AliasOptionsSchema = z.object({ alias: z.string().optional(), registry: z.string().optional() });
const AssetOptionsSchema = AliasOptionsSchema.extend({
    controller: z.string().optional(),
    validUntil: z.string().optional(),
});
const VaultOptionsSchema = AliasOptionsSchema.extend({ secretMembers: z.boolean().optional() });
const ResolveOptionsSchema = z.object({
    confirm: z.boolean().optional(),
    verify: z.boolean().optional(),
    versionTime: z.string().optional(),
    versionSequence: z.number().int().optional(),
});
const ConfirmSchema = z.object({ confirm: z.literal(true) });
const RevealSchema = z.object({ reveal: z.literal(true) });
const ConfirmPaymentSchema = z.object({ confirmPayment: z.literal(true) });
const JsonObjectSchema = z.record(z.unknown());

// Input schemas for tools whose keymaster method needs a specific shape. Two rules learned
// the hard way, both about .passthrough():
//
//   1. Where the source type declares an index signature (`[key: string]: any`), the schema
//      MUST passthrough. Zod STRIPS unknown keys on parse, so a plain object here would
//      silently delete a wallet's custom metadata on restore, or a credential's claims on
//      update -- data loss, not a validation error. Passthrough is used exactly where the
//      source type declares an extension point, and omitted where the type is closed
//      (PollConfig, DmailMessage), so junk fields are dropped rather than stored.
//   2. Never be stricter than the keymaster method behind the tool, or the tool rejects
//      input the rest of the codebase accepts. Deadlines stay z.string() rather than
//      .datetime() because keymaster accepts anything `new Date()` parses ('2026-12-01').
//
// Semantic rules that JSON Schema cannot express (a deadline in the future, a recipient
// resolving to an agent) stay in keymaster, which is authoritative and enforces them for
// CLI and REST callers too. What is mirrored here is only what a client can act on before
// calling; keymaster re-validates everything regardless.
// keymaster's isWalletEncFile/isWalletFile guards (db/typeGuards.ts) are what actually gate
// a restore, and they are the contract mirrored here -- not the WalletFile type, which
// disagrees with them (it marks `version` optional; the guards require it). Both guards
// demand version 1|2 and seed.mnemonicEnc, so requiring those rejects at the boundary
// exactly what keymaster would reject with "Unsupported wallet version.".
const WalletVersionSchema = z.union([z.literal(1), z.literal(2)]);
const SeedSchema = z.object({
    mnemonicEnc: z.object({ salt: z.string(), iv: z.string(), data: z.string() }).passthrough(),
}).passthrough();
const WalletEncFileSchema = z.object({
    version: WalletVersionSchema,
    seed: SeedSchema,
    enc: z.string(),
}).passthrough();
const WalletFileSchema = z.object({
    version: WalletVersionSchema,
    seed: SeedSchema,
    // The one place stricter than the runtime guard, which checks neither: the WalletFile
    // type declares both, and newWallet always writes them, so a wallet without them is
    // malformed regardless. A v1 wallet's `names` (renamed to `aliases` by upgradeWallet)
    // survives via passthrough.
    counter: z.number(),
    ids: z.record(z.object({
        did: z.string(),
        account: z.number(),
        index: z.number(),
    }).passthrough()),
    current: z.string().optional(),
    aliases: z.record(z.string()).optional(),
}).passthrough();
// StoredWallet is a union: restore accepts an encrypted backup (WalletEncFile) or a wallet
// whose metadata is unencrypted (WalletFile), and saveWallet decrypts the former. Neither
// form carries a plaintext secret -- both guards require seed.mnemonicEnc, the
// passphrase-encrypted mnemonic; `enc` covers only counter/ids/aliases.
// The branches are NOT disjoint -- both passthrough, so an
// object carrying `enc` alongside `counter`/`ids` satisfies either. Order therefore matters
// and encrypted must come first, which is what keymaster does too: isWalletEncFile keys on
// `enc` being a string, and isWalletFile explicitly requires !('enc' in obj). So a hybrid
// is treated as encrypted by both this schema and the method behind it.
const StoredWalletSchema = z.union([WalletEncFileSchema, WalletFileSchema]);
const VerifiableCredentialSchema = z.object({
    '@context': z.array(z.string()),
    type: z.array(z.string()),
    issuer: z.string(),
    validFrom: z.string(),
    validUntil: z.string().optional(),
    credentialSchema: z.object({ id: z.string(), type: z.literal('JsonSchema') }).optional(),
    // Required here even though the type marks it optional: updateCredential rejects a
    // credential without credentialSubject.id, and it replaces rather than merges, so a
    // partial credential would overwrite a good one with a broken one. Passthrough because
    // the claims live here as arbitrary keys -- stripping them would erase the credential.
    credentialSubject: z.object({ id: z.string() }).passthrough(),
    // `proof` is deliberately unconstrained rather than modelled: updateCredential deletes
    // it and re-signs, so any proof is acceptable and typing it would reject credentials
    // keymaster accepts. Passthrough carries it in, keymaster drops it.
}).passthrough();
const PollConfigSchema = z.object({
    version: z.literal(2),
    name: z.string().min(1),
    description: z.string().min(1),
    // 2..10 mirrors keymaster, which re-checks it. Worth stating because it is the one
    // constraint a client cannot guess and JSON Schema can express (minItems/maxItems).
    options: z.array(z.string()).min(2).max(10),
    deadline: z.string(),
});
const DmailMessageSchema = z.object({
    to: z.array(z.string()).min(1),
    // Defaulted rather than required: keymaster throws InvalidParameterError('list') when
    // cc is absent, which is a confusing failure for an omitted optional-looking field.
    cc: z.array(z.string()).default([]),
    subject: z.string().min(1),
    body: z.string().min(1),
    reference: z.string().optional(),
});
const JsonValueSchema = z.unknown();
const DidCommEncSchema = z.enum(['A256CBC-HS512', 'XC20P', 'A256GCM']);
const InlineDataSchema = z.object({
    name: z.string().optional(),
    mimeType: z.string().optional(),
    encoding: z.enum(['base64', 'utf8']).optional(),
    data: z.string(),
});

// Output schemas are declared only where a caller benefits from knowing the result shape
// *before* calling: the result is chained into another tool and its nesting is not obvious
// from the description. They are deliberately not universal. Two reasons:
//
//   1. Declaring one is binding. The SDK rejects the call on both ends when
//      structuredContent is absent or does not conform, so a tool that can return null, an
//      array, or a scalar must not declare one -- MCP requires structuredContent to be a
//      JSON object, and most tools here return a DID string, a boolean, or a string array.
//   2. Every declared schema is paid for in every client's context window on every
//      listTools call, whether or not that client ever chains anything.
//
// So leaves stay loose on purpose: the schema exists to describe the nesting a caller must
// navigate to find a DID, not to re-specify each field. Where the source type says
// `unknown` it must stay unknown -- an asset's didDocumentData is routinely not an object,
// and a wrong promise here is a runtime failure, not a lint warning.
const DidDocumentOutputSchema = z.object({
    didDocument: z.object({
        id: z.string().optional(),
        controller: z.string().optional(),
        verificationMethod: z.array(z.unknown()).optional(),
        authentication: z.array(z.unknown()).optional(),
        assertionMethod: z.array(z.unknown()).optional(),
        keyAgreement: z.array(z.unknown()).optional(),
        service: z.array(z.unknown()).optional(),
    }).passthrough().optional(),
    didDocumentMetadata: z.record(z.unknown()).optional(),
    didResolutionMetadata: z.record(z.unknown()).optional(),
    didDocumentData: z.unknown().optional(),
    didDocumentRegistration: z.unknown().optional(),
}).passthrough();
const CheckWalletOutputSchema = z.object({
    checked: z.number(),
    invalid: z.number(),
    deleted: z.number(),
}).passthrough();
const FixWalletOutputSchema = z.object({
    idsRemoved: z.number(),
    ownedRemoved: z.number(),
    heldRemoved: z.number(),
    aliasesRemoved: z.number(),
}).passthrough();
const ViewPollOutputSchema = z.object({
    description: z.string(),
    options: z.array(z.string()),
    deadline: z.string(),
    isOwner: z.boolean(),
    isEligible: z.boolean(),
    voteExpired: z.boolean(),
    hasVoted: z.boolean(),
    ballots: z.array(z.unknown()).optional(),
    results: z.record(z.unknown()).optional(),
}).passthrough();
const ViewBallotOutputSchema = z.object({
    poll: z.string(),
    voter: z.string().optional(),
    vote: z.number().optional(),
    option: z.string().optional(),
}).passthrough();

function isJsonObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const CONTENT_RESULT = Symbol('archon.contentResult');

type ContentResult = {
    [CONTENT_RESULT]: true;
    content: CallToolResult['content'];
    structuredContent?: Record<string, unknown>;
};

// Lets a handler emit MCP content blocks (image, resource) directly instead of the
// JSON text block ok() builds for every other tool. Metadata is round-tripped through
// JSON so structuredContent is exactly the payload the text block carries -- keys with
// undefined values are dropped by both, not one, as in ok().
function contentResult(content: CallToolResult['content'], metadata: Record<string, unknown>): ContentResult {
    const json = JSON.stringify(metadata);

    return {
        [CONTENT_RESULT]: true,
        content: [...content, { type: 'text', text: json }],
        structuredContent: JSON.parse(json),
    };
}

function isContentResult(value: unknown): value is ContentResult {
    return isJsonObject(value) && (value as any)[CONTENT_RESULT] === true;
}

// MCP requires structuredContent to be a JSON object, so array and scalar results
// are carried by the text block alone rather than in an invented wrapper object.
function ok(result: unknown): CallToolResult {
    if (isContentResult(result)) {
        const response: CallToolResult = { content: result.content };

        if (result.structuredContent !== undefined) {
            response.structuredContent = result.structuredContent;
        }

        return response;
    }

    const json = result === undefined ? undefined : JSON.stringify(result);
    const response: CallToolResult = {
        content: [
            {
                type: 'text',
                text: json ?? '',
            },
        ],
    };

    if (json !== undefined) {
        // Gate on the serialized payload rather than the raw result: a value can be a JS
        // object yet serialize to a JSON scalar (a Date, or any toJSON() returning a
        // non-object). This also keeps structuredContent exactly the JSON mirrored in the
        // text block -- keys with undefined values are dropped by both, not one.
        const payload = JSON.parse(json);

        if (isJsonObject(payload)) {
            response.structuredContent = payload;
        }
    }

    return response;
}

function fail(error: unknown): CallToolResult {
    return {
        content: [
            {
                type: 'text',
                text: errorMessage(error),
            },
        ],
        isError: true,
    };
}

function compactOptions<T extends Record<string, unknown>>(options: T): Partial<T> | undefined {
    const entries = Object.entries(options).filter(([, value]) => value !== undefined);
    return entries.length > 0 ? Object.fromEntries(entries) as Partial<T> : undefined;
}

function bufferFromInlineData(input: z.infer<typeof InlineDataSchema>): Buffer {
    return Buffer.from(input.data, input.encoding === 'utf8' ? 'utf8' : 'base64');
}

// Shared by the vault-item and dmail-attachment tools: a dmail attachment IS a vault item
// (addDmailAttachment/getDmailAttachment delegate to the vault ones), so both produce the
// same resource block. `containerDid` must already be resolved -- callers look it up once
// and pass the DID down, so the keymaster calls below skip their own alias resolution.
async function vaultItemResult(
    keymaster: any,
    containerDid: string,
    name: string,
    buffer: Buffer,
    options?: Record<string, unknown>
) {
    // The recorded type rather than a re-sniff of the bytes: addVaultItem stores what
    // getMimeType detected at write time, and list_vault_items reports that value. Deriving
    // it again here would risk two surfaces disagreeing about the same item.
    const items = await keymaster.listVaultItems(containerDid, options);
    const mimeType = items?.[name]?.type ?? 'application/octet-stream';

    return contentResult(
        [{
            type: 'resource',
            resource: { uri: vaultItemUri(containerDid, name), mimeType, blob: buffer.toString('base64') },
        }],
        { name, mimeType }
    );
}

function signableJson(input: unknown): object {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('object must be a JSON object');
    }
    return input as object;
}

// Generic so each handler's args are inferred from that tool's own input schema,
// letting tsc catch schema/handler drift instead of silently passing `any` through.
function tool<S extends z.ZodTypeAny>(definition: TypedToolDefinition<S>): ArchonToolDefinition {
    return definition as ArchonToolDefinition;
}

export const ARCHON_MCP_TOOL_DEFINITIONS: ArchonToolDefinition[] = [
    tool({ name: 'archon_get_version', description: 'Get Archon node version information.', schema: EmptySchema, handler: runtime => runtime.node.getVersion() }),
    tool({ name: 'archon_get_status', description: 'Get Archon node status.', schema: EmptySchema, handler: runtime => runtime.node.getStatus() }),

    tool({ name: 'archon_create_wallet', cliCommand: 'create-wallet', description: 'Create or load the local wallet.', schema: EmptySchema, mutates: true, handler: runtime => requireKeymaster(runtime).loadWallet() }),
    tool({ name: 'archon_new_wallet', cliCommand: 'new-wallet', description: 'Create a new local wallet, replacing the existing wallet.', schema: ConfirmSchema, mutates: true, handler: runtime => requireKeymaster(runtime).newWallet('', true) }),
    tool({ name: 'archon_change_passphrase', cliCommand: 'change-passphrase', description: 'Re-encrypt the local wallet with a new passphrase.', schema: z.object({ newPassphrase: z.string() }).merge(ConfirmSchema), mutates: true, handler: (runtime, { newPassphrase }) => requireKeymaster(runtime).changePassphrase(newPassphrase) }),
    tool({ name: 'archon_check_wallet', cliCommand: 'check-wallet', description: 'Validate DIDs in the local wallet.', schema: EmptySchema, outputSchema: CheckWalletOutputSchema, handler: runtime => requireKeymaster(runtime).checkWallet() }),
    tool({ name: 'archon_fix_wallet', cliCommand: 'fix-wallet', description: 'Remove invalid DIDs from the local wallet.', schema: ConfirmSchema, outputSchema: FixWalletOutputSchema, mutates: true, handler: runtime => requireKeymaster(runtime).fixWallet() }),
    tool({ name: 'archon_import_wallet', cliCommand: 'import-wallet', description: 'Create a new wallet from a recovery phrase.', schema: z.object({ recoveryPhrase: z.string() }).merge(ConfirmSchema), mutates: true, handler: (runtime, { recoveryPhrase }) => requireKeymaster(runtime).newWallet(recoveryPhrase, true) }),
    tool({ name: 'archon_show_wallet', cliCommand: 'show-wallet', description: 'Show the decrypted local wallet.', schema: RevealSchema, handler: runtime => requireKeymaster(runtime).loadWallet() }),
    tool({ name: 'archon_backup_wallet_file', cliCommand: 'backup-wallet-file', description: 'Return the encrypted wallet backup payload.', schema: RevealSchema, handler: runtime => requireKeymaster(runtime).exportEncryptedWallet() }),
    tool({ name: 'archon_restore_wallet_file', cliCommand: 'restore-wallet-file', description: 'Restore the local wallet from a wallet payload, either an encrypted backup or a wallet whose metadata is unencrypted. The seed is passphrase-encrypted in both, and the current passphrase must match.', schema: z.object({ wallet: StoredWalletSchema }).merge(ConfirmSchema), mutates: true, handler: (runtime, { wallet }) => requireKeymaster(runtime).saveWallet(wallet, true) }),
    tool({ name: 'archon_show_mnemonic', cliCommand: 'show-mnemonic', description: 'Reveal the wallet recovery phrase.', schema: RevealSchema, handler: runtime => requireKeymaster(runtime).decryptMnemonic() }),
    tool({ name: 'archon_backup_wallet_did', cliCommand: 'backup-wallet-did', description: 'Backup wallet to an encrypted DID and seed bank.', schema: ConfirmSchema, mutates: true, handler: runtime => requireKeymaster(runtime).backupWallet() }),
    tool({ name: 'archon_recover_wallet_did', cliCommand: 'recover-wallet-did', description: 'Recover wallet from seed bank or encrypted DID.', schema: z.object({ did: z.string().optional() }).merge(ConfirmSchema), mutates: true, handler: (runtime, { did }) => requireKeymaster(runtime).recoverWallet(did) }),

    tool({ name: 'archon_create_id', cliCommand: 'create-id', description: 'Create a new local Keymaster wallet ID.', schema: z.object({ name: z.string(), registry: z.string().optional() }), mutates: true, handler: (runtime, { name, registry }) => requireKeymaster(runtime).createId(name, compactOptions({ registry })) }),
    tool({ name: 'archon_resolve_id', cliCommand: 'resolve-id', description: 'Resolve a local ID name, alias, DID, or the current ID when id is omitted.', schema: z.object({ id: z.string().optional() }).merge(ResolveOptionsSchema), handler: async (runtime, { id, ...options }) => {
        const keymaster = requireKeymaster(runtime);
        const resolvedId = id ?? await keymaster.getCurrentId();
        if (!resolvedId) throw new Error('No current ID');
        return keymaster.resolveDID(resolvedId, compactOptions(options));
    } }),
    tool({ name: 'archon_backup_id', cliCommand: 'backup-id', description: 'Backup the current or selected ID.', schema: z.object({ id: z.string().optional() }), mutates: true, handler: (runtime, { id }) => requireKeymaster(runtime).backupId(id) }),
    tool({ name: 'archon_recover_id', cliCommand: 'recover-id', description: 'Recover an ID from a backup DID.', schema: DidSchema, mutates: true, handler: (runtime, { did }) => requireKeymaster(runtime).recoverId(did) }),
    tool({ name: 'archon_remove_id', cliCommand: 'remove-id', description: 'Remove a local ID from the wallet.', schema: z.object({ name: z.string() }).merge(ConfirmSchema), mutates: true, handler: (runtime, { name }) => requireKeymaster(runtime).removeId(name) }),
    tool({ name: 'archon_rename_id', cliCommand: 'rename-id', description: 'Rename a local ID.', schema: z.object({ oldName: z.string(), newName: z.string() }), mutates: true, handler: (runtime, { oldName, newName }) => requireKeymaster(runtime).renameId(oldName, newName) }),
    tool({ name: 'archon_list_ids', cliCommand: 'list-ids', description: 'List IDs in the local Keymaster wallet.', schema: EmptySchema, handler: runtime => requireKeymaster(runtime).listIds() }),
    tool({ name: 'archon_list_registries', cliCommand: 'list-registries', description: 'List registries supported by the connected Archon node.', schema: EmptySchema, handler: runtime => runtime.node.listRegistries() }),
    tool({ name: 'archon_get_current_id', description: 'Get the current local Keymaster wallet ID name.', schema: EmptySchema, handler: runtime => requireKeymaster(runtime).getCurrentId() }),
    tool({ name: 'archon_use_id', cliCommand: 'use-id', description: 'Set the current local Keymaster wallet ID name.', schema: z.object({ name: z.string() }), mutates: true, handler: (runtime, { name }) => requireKeymaster(runtime).setCurrentId(name) }),
    tool({ name: 'archon_rotate_keys', cliCommand: 'rotate-keys', description: 'Generate and publish new keys for the current ID.', schema: ConfirmSchema, mutates: true, handler: runtime => requireKeymaster(runtime).rotateKeys() }),

    tool({ name: 'archon_resolve_did', cliCommand: 'resolve-did', description: 'Resolve a DID or DID-like Archon identifier.', schema: DidSchema.merge(ResolveOptionsSchema), outputSchema: DidDocumentOutputSchema, handler: (runtime, { did, ...options }) => requireKeymaster(runtime).resolveDID(did, compactOptions(options)) }),
    tool({ name: 'archon_resolve_did_version', cliCommand: 'resolve-did-version', description: 'Resolve a specific DID version.', schema: DidSchema.extend({ version: z.number().int() }), outputSchema: DidDocumentOutputSchema, handler: (runtime, { did, version }) => requireKeymaster(runtime).resolveDID(did, { versionSequence: version }) }),
    tool({ name: 'archon_revoke_did', cliCommand: 'revoke-did', description: 'Permanently revoke a DID.', schema: DidSchema.merge(ConfirmSchema), mutates: true, handler: (runtime, { did }) => requireKeymaster(runtime).revokeDID(did) }),
    tool({ name: 'archon_change_registry', cliCommand: 'change-registry', description: 'Change the registry for an existing DID.', schema: IdSchema.extend({ registry: z.string() }).merge(ConfirmSchema), mutates: true, handler: (runtime, { id, registry }) => requireKeymaster(runtime).changeRegistry(id, registry) }),

    tool({ name: 'archon_encrypt_message', cliCommand: 'encrypt-message', description: 'Encrypt a message for a DID.', schema: z.object({ message: z.string(), did: z.string() }), mutates: true, handler: (runtime, { message, did }) => requireKeymaster(runtime).encryptMessage(message, did) }),
    tool({ name: 'archon_encrypt_file', cliCommand: 'encrypt-file', description: 'Encrypt inline text data for a DID.', schema: z.object({ file: InlineDataSchema, did: z.string() }), mutates: true, handler: (runtime, { file, did }) => requireKeymaster(runtime).encryptMessage(bufferFromInlineData(file).toString('utf8'), did) }),
    tool({ name: 'archon_decrypt_did', cliCommand: 'decrypt-did', description: 'Decrypt an encrypted message DID.', schema: DidSchema.merge(RevealSchema), handler: (runtime, { did }) => requireKeymaster(runtime).decryptMessage(did) }),
    tool({ name: 'archon_decrypt_json', cliCommand: 'decrypt-json', description: 'Decrypt an encrypted JSON DID.', schema: DidSchema.merge(RevealSchema), handler: (runtime, { did }) => requireKeymaster(runtime).decryptJSON(did) }),
    tool({ name: 'archon_sign_file', cliCommand: 'sign-file', description: 'Sign an inline JSON object.', schema: z.object({ object: JsonObjectSchema }), handler: (runtime, { object }) => requireKeymaster(runtime).addProof(signableJson(object)) }),
    tool({ name: 'archon_verify_file', cliCommand: 'verify-file', description: 'Verify the proof in an inline JSON object.', schema: z.object({ object: JsonObjectSchema }), handler: (runtime, { object }) => requireKeymaster(runtime).verifyProof(object) }),

    tool({ name: 'archon_create_challenge', cliCommand: 'create-challenge', description: 'Create a challenge DID.', schema: z.object({ challenge: JsonObjectSchema.optional(), alias: z.string().optional(), registry: z.string().optional() }), mutates: true, handler: (runtime, { challenge, alias, registry }) => requireKeymaster(runtime).createChallenge(challenge, compactOptions({ alias, registry })) }),
    tool({ name: 'archon_create_challenge_cc', cliCommand: 'create-challenge-cc', description: 'Create a challenge from a credential DID.', schema: z.object({ did: z.string(), alias: z.string().optional(), registry: z.string().optional() }), mutates: true, handler: (runtime, { did, alias, registry }) => requireKeymaster(runtime).createChallenge({ credentials: [{ schema: did }] }, compactOptions({ alias, registry })) }),
    tool({ name: 'archon_create_response', cliCommand: 'create-response', description: 'Create a response to a challenge.', schema: z.object({ challenge: z.string(), registry: z.string().optional(), validUntil: z.string().optional() }), mutates: true, handler: (runtime, { challenge, registry, validUntil }) => requireKeymaster(runtime).createResponse(challenge, compactOptions({ registry, validUntil })) }),
    tool({ name: 'archon_verify_response', cliCommand: 'verify-response', description: 'Decrypt and validate a response to a challenge.', schema: z.object({ response: z.string() }), handler: (runtime, { response }) => requireKeymaster(runtime).verifyResponse(response) }),

    tool({ name: 'archon_bind_credential', cliCommand: 'bind-credential', description: 'Create a bound credential for a subject.', schema: z.object({ schema: z.string(), subject: z.string(), claims: JsonObjectSchema.optional(), validFrom: z.string().optional(), validUntil: z.string().optional() }), handler: (runtime, { subject, schema, claims, validFrom, validUntil }) => requireKeymaster(runtime).bindCredential(subject, compactOptions({ schema, claims, validFrom, validUntil })) }),
    tool({ name: 'archon_issue_credential', cliCommand: 'issue-credential', description: 'Sign and encrypt a bound credential.', schema: z.object({ credential: JsonObjectSchema, alias: z.string().optional(), registry: z.string().optional() }), mutates: true, handler: (runtime, { credential, alias, registry }) => requireKeymaster(runtime).issueCredential(credential, compactOptions({ alias, registry })) }),
    tool({ name: 'archon_list_issued', cliCommand: 'list-issued', description: 'List issued credentials.', schema: z.object({ issuer: z.string().optional() }), handler: (runtime, { issuer }) => requireKeymaster(runtime).listIssued(issuer) }),
    tool({ name: 'archon_update_credential', cliCommand: 'update-credential', description: 'Update an issued credential.', schema: z.object({ did: z.string(), credential: VerifiableCredentialSchema }), mutates: true, handler: (runtime, { did, credential }) => requireKeymaster(runtime).updateCredential(did, credential) }),
    tool({ name: 'archon_revoke_credential', cliCommand: 'revoke-credential', description: 'Revoke a verifiable credential.', schema: DidSchema.merge(ConfirmSchema), mutates: true, handler: (runtime, { did }) => requireKeymaster(runtime).revokeCredential(did) }),
    tool({ name: 'archon_accept_credential', cliCommand: 'accept-credential', description: 'Save a verifiable credential for the current ID.', schema: DidSchema.extend({ alias: z.string().optional() }), mutates: true, handler: async (runtime, { did, alias }) => {
        const keymaster = requireKeymaster(runtime);
        const accepted = await keymaster.acceptCredential(did);
        if (accepted && alias) await keymaster.addAlias(alias, did);
        return accepted;
    } }),
    tool({ name: 'archon_list_credentials', cliCommand: 'list-credentials', description: 'List credentials held by an ID.', schema: z.object({ id: z.string().optional() }), handler: (runtime, { id }) => requireKeymaster(runtime).listCredentials(id) }),
    tool({ name: 'archon_get_credential', cliCommand: 'get-credential', description: 'Get a credential by DID.', schema: DidSchema, handler: (runtime, { did }) => requireKeymaster(runtime).getCredential(did) }),
    tool({ name: 'archon_view_credential', cliCommand: 'view-credential', description: 'Get a credential with proof validity.', schema: DidSchema, handler: async (runtime, { did }) => {
        const keymaster = requireKeymaster(runtime);
        const credential = await keymaster.getCredential(did);
        return { credential, proofValid: credential ? await keymaster.verifyProof(credential) : false };
    } }),
    tool({ name: 'archon_publish_credential', cliCommand: 'publish-credential', description: 'Publish the existence of a credential to the current user manifest.', schema: DidSchema, mutates: true, handler: (runtime, { did }) => requireKeymaster(runtime).publishCredential(did, { reveal: false }) }),
    tool({ name: 'archon_reveal_credential', cliCommand: 'reveal-credential', description: 'Reveal a credential to the current user manifest.', schema: DidSchema.merge(RevealSchema), mutates: true, handler: (runtime, { did }) => requireKeymaster(runtime).publishCredential(did, { reveal: true }) }),
    tool({ name: 'archon_unpublish_credential', cliCommand: 'unpublish-credential', description: 'Remove a credential from the current user manifest.', schema: DidSchema, mutates: true, handler: (runtime, { did }) => requireKeymaster(runtime).unpublishCredential(did) }),

    tool({ name: 'archon_add_alias', cliCommand: 'add-alias', description: 'Add a DID alias to the local Keymaster wallet.', schema: z.object({ alias: z.string(), did: z.string() }), mutates: true, handler: (runtime, { alias, did }) => requireKeymaster(runtime).addAlias(alias, did) }),
    tool({ name: 'archon_get_alias', cliCommand: 'get-alias', description: 'Get the DID assigned to a local alias.', schema: z.object({ alias: z.string() }), handler: (runtime, { alias }) => requireKeymaster(runtime).getAlias(alias) }),
    tool({ name: 'archon_remove_alias', cliCommand: 'remove-alias', description: 'Remove a DID alias from the local wallet.', schema: z.object({ alias: z.string() }), mutates: true, handler: (runtime, { alias }) => requireKeymaster(runtime).removeAlias(alias) }),
    tool({ name: 'archon_list_aliases', cliCommand: 'list-aliases', description: 'List DID aliases in the local wallet.', schema: z.object({ includeIds: z.boolean().optional() }), handler: (runtime, { includeIds }) => requireKeymaster(runtime).listAliases(includeIds === undefined ? undefined : { includeIDs: includeIds }) }),

    tool({ name: 'archon_list_addresses', cliCommand: 'list-addresses', description: 'List wallet addresses claimed through Herald domains.', schema: EmptySchema, handler: runtime => requireKeymaster(runtime).listAddresses() }),
    tool({ name: 'archon_get_address', cliCommand: 'get-address', description: 'Get the current address for a domain.', schema: z.object({ domain: z.string() }), handler: (runtime, { domain }) => requireKeymaster(runtime).getAddress(domain) }),
    tool({ name: 'archon_import_address', cliCommand: 'import-address', description: 'Import an existing address for the current ID from a domain.', schema: z.object({ domain: z.string() }), mutates: true, handler: (runtime, { domain }) => requireKeymaster(runtime).importAddress(domain) }),
    tool({ name: 'archon_check_address', cliCommand: 'check-address', description: 'Check whether a Herald address is available.', schema: z.object({ address: z.string() }), handler: (runtime, { address }) => requireKeymaster(runtime).checkAddress(address) }),
    tool({ name: 'archon_add_address', cliCommand: 'add-address', description: 'Claim a Herald address for the current ID.', schema: z.object({ address: z.string() }), mutates: true, handler: (runtime, { address }) => requireKeymaster(runtime).addAddress(address) }),
    tool({ name: 'archon_remove_address', cliCommand: 'remove-address', description: 'Remove a Herald address from the current ID.', schema: z.object({ address: z.string() }), mutates: true, handler: (runtime, { address }) => requireKeymaster(runtime).removeAddress(address) }),
    tool({ name: 'archon_publish_address', cliCommand: 'publish-address', description: 'Publish a stored Herald address on a DID document.', schema: z.object({ address: z.string().optional(), id: z.string().optional() }), mutates: true, handler: (runtime, { address, id }) => requireKeymaster(runtime).publishAddress(address, id) }),
    tool({ name: 'archon_unpublish_address', cliCommand: 'unpublish-address', description: 'Remove a published Herald address from a DID document.', schema: z.object({ id: z.string().optional() }), mutates: true, handler: (runtime, { id }) => requireKeymaster(runtime).unpublishAddress(id) }),

    tool({ name: 'archon_add_nostr', cliCommand: 'add-nostr', description: 'Derive and add Nostr keys to an agent DID.', schema: z.object({ id: z.string().optional() }), mutates: true, handler: (runtime, { id }) => requireKeymaster(runtime).addNostr(id) }),
    tool({ name: 'archon_import_nostr', cliCommand: 'import-nostr', description: 'Import Nostr keys from an nsec private key.', schema: z.object({ nsec: z.string(), id: z.string().optional() }).merge(ConfirmSchema), mutates: true, handler: (runtime, { nsec, id }) => requireKeymaster(runtime).importNostr(nsec, id) }),
    tool({ name: 'archon_remove_nostr', cliCommand: 'remove-nostr', description: 'Remove Nostr keys from an agent DID.', schema: z.object({ id: z.string().optional() }).merge(ConfirmSchema), mutates: true, handler: (runtime, { id }) => requireKeymaster(runtime).removeNostr(id) }),

    tool({ name: 'archon_add_lightning', cliCommand: 'add-lightning', description: 'Create a Lightning wallet for a DID.', schema: z.object({ id: z.string().optional() }), mutates: true, handler: (runtime, { id }) => requireKeymaster(runtime).addLightning(id) }),
    tool({ name: 'archon_remove_lightning', cliCommand: 'remove-lightning', description: 'Remove Lightning wallet from a DID.', schema: z.object({ id: z.string().optional() }).merge(ConfirmSchema), mutates: true, handler: (runtime, { id }) => requireKeymaster(runtime).removeLightning(id) }),
    tool({ name: 'archon_lightning_balance', cliCommand: 'lightning-balance', description: 'Check Lightning wallet balance.', schema: z.object({ id: z.string().optional() }), handler: (runtime, { id }) => requireKeymaster(runtime).getLightningBalance(id) }),
    tool({ name: 'archon_lightning_decode', cliCommand: 'lightning-decode', description: 'Decode a Lightning BOLT11 invoice.', schema: z.object({ bolt11: z.string() }), handler: (runtime, { bolt11 }) => requireKeymaster(runtime).decodeLightningInvoice(bolt11) }),
    tool({ name: 'archon_lightning_invoice', cliCommand: 'lightning-invoice', description: 'Create a Lightning invoice.', schema: z.object({ amount: z.number().int().positive(), memo: z.string(), id: z.string().optional() }), mutates: true, handler: (runtime, { amount, memo, id }) => requireKeymaster(runtime).createLightningInvoice(amount, memo, id) }),
    tool({ name: 'archon_lightning_pay', cliCommand: 'lightning-pay', description: 'Pay a Lightning invoice.', schema: z.object({ bolt11: z.string(), id: z.string().optional() }).merge(ConfirmPaymentSchema), mutates: true, handler: (runtime, { bolt11, id }) => requireKeymaster(runtime).payLightningInvoice(bolt11, id) }),
    tool({ name: 'archon_lightning_check', cliCommand: 'lightning-check', description: 'Check status of a Lightning payment.', schema: z.object({ paymentHash: z.string(), id: z.string().optional() }), handler: (runtime, { paymentHash, id }) => requireKeymaster(runtime).checkLightningPayment(paymentHash, id) }),
    tool({ name: 'archon_publish_lightning', cliCommand: 'publish-lightning', description: 'Publish Lightning service endpoint for a DID.', schema: z.object({ id: z.string().optional() }), mutates: true, handler: (runtime, { id }) => requireKeymaster(runtime).publishLightning(id) }),
    tool({ name: 'archon_unpublish_lightning', cliCommand: 'unpublish-lightning', description: 'Remove Lightning service endpoint from a DID.', schema: z.object({ id: z.string().optional() }), mutates: true, handler: (runtime, { id }) => requireKeymaster(runtime).unpublishLightning(id) }),
    tool({ name: 'archon_lightning_zap', cliCommand: 'lightning-zap', description: 'Send sats via Lightning to a DID, alias, or Lightning address.', schema: z.object({ recipient: z.string(), amount: z.number().int().positive(), memo: z.string().optional(), id: z.string().optional() }).merge(ConfirmPaymentSchema), mutates: true, handler: (runtime, { recipient, amount, memo, id }) => requireKeymaster(runtime).zapLightning(recipient, amount, memo, id) }),
    tool({ name: 'archon_lightning_payments', cliCommand: 'lightning-payments', description: 'Show Lightning payment history.', schema: z.object({ id: z.string().optional() }), handler: (runtime, { id }) => requireKeymaster(runtime).getLightningPayments(id) }),

    tool({ name: 'archon_create_group', cliCommand: 'create-group', description: 'Create a new group.', schema: z.object({ groupName: z.string() }).merge(AliasOptionsSchema), mutates: true, handler: (runtime, { groupName, alias, registry }) => requireKeymaster(runtime).createGroup(groupName, compactOptions({ alias, registry })) }),
    tool({ name: 'archon_list_groups', cliCommand: 'list-groups', description: 'List groups owned by an ID.', schema: z.object({ owner: z.string().optional() }), handler: (runtime, { owner }) => requireKeymaster(runtime).listGroups(owner) }),
    tool({ name: 'archon_get_group', cliCommand: 'get-group', description: 'Get a group by DID.', schema: DidSchema, handler: (runtime, { did }) => requireKeymaster(runtime).getGroup(did) }),
    tool({ name: 'archon_add_group_member', cliCommand: 'add-group-member', description: 'Add a member to a group.', schema: z.object({ group: z.string(), member: z.string() }), mutates: true, handler: (runtime, { group, member }) => requireKeymaster(runtime).addGroupMember(group, member) }),
    tool({ name: 'archon_remove_group_member', cliCommand: 'remove-group-member', description: 'Remove a member from a group.', schema: z.object({ group: z.string(), member: z.string() }).merge(ConfirmSchema), mutates: true, handler: (runtime, { group, member }) => requireKeymaster(runtime).removeGroupMember(group, member) }),
    tool({ name: 'archon_test_group', cliCommand: 'test-group', description: 'Determine if a member is in a group.', schema: z.object({ group: z.string(), member: z.string().optional() }), handler: (runtime, { group, member }) => requireKeymaster(runtime).testGroup(group, member) }),

    tool({ name: 'archon_create_schema', cliCommand: 'create-schema', description: 'Create a schema DID from inline JSON.', schema: z.object({ schema: JsonObjectSchema, alias: z.string().optional(), registry: z.string().optional() }), mutates: true, handler: (runtime, { schema, alias, registry }) => requireKeymaster(runtime).createSchema(schema, compactOptions({ alias, registry })) }),
    tool({ name: 'archon_list_schemas', cliCommand: 'list-schemas', description: 'List schemas owned by an ID.', schema: z.object({ owner: z.string().optional() }), handler: (runtime, { owner }) => requireKeymaster(runtime).listSchemas(owner) }),
    tool({ name: 'archon_get_schema', cliCommand: 'get-schema', description: 'Get a schema by DID.', schema: DidSchema, handler: (runtime, { did }) => requireKeymaster(runtime).getSchema(did) }),
    tool({ name: 'archon_create_schema_template', cliCommand: 'create-schema-template', description: 'Create a JSON template from a schema.', schema: z.object({ schema: z.string() }), handler: (runtime, { schema }) => requireKeymaster(runtime).createTemplate(schema) }),

    tool({ name: 'archon_create_asset', cliCommand: 'create-asset', description: 'Create an empty JSON asset.', schema: AssetOptionsSchema, mutates: true, handler: (runtime, options) => requireKeymaster(runtime).createAsset({}, compactOptions(options)) }),
    tool({ name: 'archon_create_asset_json', cliCommand: 'create-asset-json', description: 'Create a JSON asset DID from inline JSON data.', schema: z.object({ data: JsonObjectSchema }).merge(AssetOptionsSchema), mutates: true, handler: (runtime, { data, ...options }) => requireKeymaster(runtime).createAsset(data, compactOptions(options)) }),
    tool({ name: 'archon_create_asset_image', cliCommand: 'create-asset-image', description: 'Create an image asset DID from an inline base64 payload.', schema: z.object({ file: InlineDataSchema }).merge(AssetOptionsSchema), mutates: true, handler: (runtime, { file, ...options }) => requireKeymaster(runtime).createImage(bufferFromInlineData(file), compactOptions({ ...options, filename: file.name })) }),
    tool({ name: 'archon_create_asset_file', cliCommand: 'create-asset-file', description: 'Create a file asset DID from an inline payload.', schema: z.object({ file: InlineDataSchema }).merge(AssetOptionsSchema), mutates: true, handler: (runtime, { file, ...options }) => requireKeymaster(runtime).createFile(bufferFromInlineData(file), compactOptions({ ...options, filename: file.name, contentType: file.mimeType })) }),
    tool({ name: 'archon_get_asset', cliCommand: 'get-asset', description: 'Resolve an asset by local name, alias, or DID.', schema: IdSchema.merge(ResolveOptionsSchema), handler: (runtime, { id, ...options }) => requireKeymaster(runtime).resolveAsset(id, compactOptions(options)) }),
    tool({ name: 'archon_get_asset_json', cliCommand: 'get-asset-json', description: 'Return a JSON asset as an inline object.', schema: IdSchema.merge(ResolveOptionsSchema), handler: (runtime, { id, ...options }) => requireKeymaster(runtime).resolveAsset(id, compactOptions(options)) }),
    tool({ name: 'archon_get_asset_image', cliCommand: 'get-asset-image', description: 'Return an image asset as an image content block.', schema: IdSchema, handler: async (runtime, { id }) => {
        const image = await requireKeymaster(runtime).getImage(id);

        if (!image?.file?.data) {
            return null;
        }

        const mimeType = image.file.type ?? 'application/octet-stream';
        return contentResult(
            [{ type: 'image', data: Buffer.from(image.file.data).toString('base64'), mimeType }],
            { name: image.file.filename, mimeType, image: image.image }
        );
    } }),
    tool({ name: 'archon_get_asset_file', cliCommand: 'get-asset-file', description: 'Return a file asset. Small files come back as an embedded resource block; larger ones as a resource_link the client can read on demand.', schema: IdSchema, handler: async (runtime, { id }, config) => {
        const keymaster = requireKeymaster(runtime);
        // Resolve once and hand the DID down: each call resolves internally too, and for an
        // alias that decrypts the wallet. lookupDID short-circuits on a DID.
        // The asset DID is itself a URI, so the resource block is named by a real
        // identifier rather than an invented scheme.
        const uri = await keymaster.lookupDID(id);

        // Size first, from the DID document, before fetching anything: a file asset records
        // `bytes` alongside its CID, so a large asset can be linked without ever pulling
        // data we would only discard. That costs small assets a second resolve, which is
        // the cheaper mistake -- the alternative is fetching megabytes to then measure them.
        const asset = await keymaster.resolveAsset(uri) as { file?: { cid?: string; filename?: string; type?: string; bytes?: number } };
        const summary = asset?.file;

        if (!summary?.cid) {
            return null;
        }

        const mimeType = summary.type ?? 'application/octet-stream';
        const name = summary.filename ?? 'file';

        // Unknown size counts as too large: guessing "small" risks inlining something that
        // buries the conversation, and a link costs the client only a resources/read.
        if (summary.bytes === undefined || summary.bytes > config.inlineLimit) {
            // MCP's `size` is documented for exactly this -- hosts use it to display file
            // sizes and estimate context window usage before fetching.
            return contentResult(
                [{ type: 'resource_link', uri, name, mimeType, ...(summary.bytes !== undefined && { size: summary.bytes }) }],
                { name, mimeType, ...(summary.bytes !== undefined && { bytes: summary.bytes }), linked: true }
            );
        }

        const file = await keymaster.getFile(uri);

        if (!file?.data) {
            return null;
        }

        return contentResult(
            [{
                type: 'resource',
                resource: { uri, mimeType, blob: Buffer.from(file.data).toString('base64') },
            }],
            { name: file.filename, mimeType }
        );
    } }),
    tool({ name: 'archon_update_asset_json', cliCommand: 'update-asset-json', description: 'Merge JSON object data into an existing asset.', schema: IdSchema.extend({ data: JsonObjectSchema }), mutates: true, handler: (runtime, { id, data }) => requireKeymaster(runtime).mergeData(id, data) }),
    tool({ name: 'archon_update_asset_image', cliCommand: 'update-asset-image', description: 'Update an image asset from an inline payload.', schema: IdSchema.extend({ file: InlineDataSchema }), mutates: true, handler: (runtime, { id, file }) => requireKeymaster(runtime).updateImage(id, bufferFromInlineData(file), compactOptions({ filename: file.name })) }),
    tool({ name: 'archon_update_asset_file', cliCommand: 'update-asset-file', description: 'Update a file asset from an inline payload.', schema: IdSchema.extend({ file: InlineDataSchema }), mutates: true, handler: (runtime, { id, file }) => requireKeymaster(runtime).updateFile(id, bufferFromInlineData(file), compactOptions({ filename: file.name, contentType: file.mimeType })) }),
    tool({ name: 'archon_transfer_asset', cliCommand: 'transfer-asset', description: 'Transfer an asset to a new controller DID.', schema: IdSchema.extend({ controller: z.string() }), mutates: true, handler: (runtime, { id, controller }) => requireKeymaster(runtime).transferAsset(id, controller) }),
    tool({ name: 'archon_clone_asset', cliCommand: 'clone-asset', description: 'Clone an asset.', schema: IdSchema.merge(AliasOptionsSchema), mutates: true, handler: (runtime, { id, alias, registry }) => requireKeymaster(runtime).cloneAsset(id, compactOptions({ alias, registry })) }),
    tool({ name: 'archon_get_property', cliCommand: 'get-property', description: 'Get a property from a DID document data object.', schema: IdSchema.extend({ key: z.string() }), handler: async (runtime, { id, key }) => {
        // didDocumentData is `unknown` and is routinely not an object -- an asset's data can
        // be an array or a scalar, which has no property to get. Guarding also stops an
        // index into a string or array returning a nonsense "property".
        const { didDocumentData } = await requireKeymaster(runtime).resolveDID(id);
        return isJsonObject(didDocumentData) ? didDocumentData[key] : undefined;
    } }),
    tool({ name: 'archon_set_property', cliCommand: 'set-property', description: 'Set a property on a DID document data object.', schema: IdSchema.extend({ key: z.string(), value: JsonValueSchema.nullable().optional() }), mutates: true, handler: (runtime, { id, key, value }) => requireKeymaster(runtime).mergeData(id, { [key]: value ?? null }) }),
    tool({ name: 'archon_list_assets', cliCommand: 'list-assets', description: 'List assets owned by an ID.', schema: z.object({ owner: z.string().optional() }), handler: (runtime, { owner }) => requireKeymaster(runtime).listAssets(owner) }),

    tool({ name: 'archon_create_poll_template', cliCommand: 'create-poll-template', description: 'Create a poll config template.', schema: EmptySchema, handler: runtime => requireKeymaster(runtime).pollTemplate() }),
    tool({ name: 'archon_create_poll', cliCommand: 'create-poll', description: 'Create a poll from inline JSON config.', schema: z.object({ config: PollConfigSchema }).merge(VaultOptionsSchema), mutates: true, handler: (runtime, { config, ...options }) => requireKeymaster(runtime).createPoll(config, compactOptions(options)) }),
    tool({ name: 'archon_add_poll_voter', cliCommand: 'add-poll-voter', description: 'Add a voter to a poll.', schema: z.object({ poll: z.string(), member: z.string() }), mutates: true, handler: (runtime, { poll, member }) => requireKeymaster(runtime).addPollVoter(poll, member) }),
    tool({ name: 'archon_remove_poll_voter', cliCommand: 'remove-poll-voter', description: 'Remove a voter from a poll.', schema: z.object({ poll: z.string(), member: z.string() }).merge(ConfirmSchema), mutates: true, handler: (runtime, { poll, member }) => requireKeymaster(runtime).removePollVoter(poll, member) }),
    tool({ name: 'archon_list_poll_voters', cliCommand: 'list-poll-voters', description: 'List eligible voters in a poll.', schema: z.object({ poll: z.string() }), handler: (runtime, { poll }) => requireKeymaster(runtime).listPollVoters(poll) }),
    tool({ name: 'archon_view_poll', cliCommand: 'view-poll', description: 'View poll details.', schema: z.object({ poll: z.string() }), outputSchema: ViewPollOutputSchema, handler: (runtime, { poll }) => requireKeymaster(runtime).viewPoll(poll) }),
    tool({ name: 'archon_vote_poll', cliCommand: 'vote-poll', description: 'Vote in a poll.', schema: z.object({ poll: z.string(), vote: z.number().int(), registry: z.string().optional(), validUntil: z.string().optional() }), mutates: true, handler: (runtime, { poll, vote, registry, validUntil }) => requireKeymaster(runtime).votePoll(poll, vote, compactOptions({ registry, validUntil })) }),
    tool({ name: 'archon_send_poll', cliCommand: 'send-poll', description: 'Send a poll notice to voters.', schema: z.object({ poll: z.string() }), mutates: true, handler: (runtime, { poll }) => requireKeymaster(runtime).sendPoll(poll) }),
    tool({ name: 'archon_send_ballot', cliCommand: 'send-ballot', description: 'Send a ballot to the poll owner.', schema: z.object({ ballot: z.string(), poll: z.string() }), mutates: true, handler: (runtime, { ballot, poll }) => requireKeymaster(runtime).sendBallot(ballot, poll) }),
    tool({ name: 'archon_view_ballot', cliCommand: 'view-ballot', description: 'View ballot details.', schema: z.object({ ballot: z.string() }), outputSchema: ViewBallotOutputSchema, handler: (runtime, { ballot }) => requireKeymaster(runtime).viewBallot(ballot) }),
    tool({ name: 'archon_update_poll', cliCommand: 'update-poll', description: 'Add a ballot to a poll.', schema: z.object({ ballot: z.string() }), mutates: true, handler: (runtime, { ballot }) => requireKeymaster(runtime).updatePoll(ballot) }),
    tool({ name: 'archon_publish_poll', cliCommand: 'publish-poll', description: 'Publish poll results without revealing ballots.', schema: z.object({ poll: z.string() }), mutates: true, handler: (runtime, { poll }) => requireKeymaster(runtime).publishPoll(poll) }),
    tool({ name: 'archon_reveal_poll', cliCommand: 'reveal-poll', description: 'Publish poll results and reveal ballots.', schema: z.object({ poll: z.string() }).merge(RevealSchema), mutates: true, handler: (runtime, { poll }) => requireKeymaster(runtime).publishPoll(poll, { reveal: true }) }),
    tool({ name: 'archon_unpublish_poll', cliCommand: 'unpublish-poll', description: 'Remove results from a poll.', schema: z.object({ poll: z.string() }), mutates: true, handler: (runtime, { poll }) => requireKeymaster(runtime).unpublishPoll(poll) }),

    tool({ name: 'archon_create_vault', cliCommand: 'create-vault', description: 'Create a vault.', schema: VaultOptionsSchema, mutates: true, handler: (runtime, options) => requireKeymaster(runtime).createVault(compactOptions(options)) }),
    tool({ name: 'archon_list_vault_items', cliCommand: 'list-vault-items', description: 'List items in a vault.', schema: IdSchema.merge(ResolveOptionsSchema), handler: (runtime, { id, ...options }) => requireKeymaster(runtime).listVaultItems(id, compactOptions(options)) }),
    tool({ name: 'archon_add_vault_member', cliCommand: 'add-vault-member', description: 'Add a member to a vault.', schema: IdSchema.extend({ member: z.string() }), mutates: true, handler: (runtime, { id, member }) => requireKeymaster(runtime).addVaultMember(id, member) }),
    tool({ name: 'archon_remove_vault_member', cliCommand: 'remove-vault-member', description: 'Remove a member from a vault.', schema: IdSchema.extend({ member: z.string() }).merge(ConfirmSchema), mutates: true, handler: (runtime, { id, member }) => requireKeymaster(runtime).removeVaultMember(id, member) }),
    tool({ name: 'archon_list_vault_members', cliCommand: 'list-vault-members', description: 'List members of a vault.', schema: IdSchema, handler: (runtime, { id }) => requireKeymaster(runtime).listVaultMembers(id) }),
    tool({ name: 'archon_add_vault_item', cliCommand: 'add-vault-item', description: 'Add an inline item to a vault.', schema: IdSchema.extend({ item: InlineDataSchema }), mutates: true, handler: (runtime, { id, item }) => requireKeymaster(runtime).addVaultItem(id, item.name ?? 'item', bufferFromInlineData(item)) }),
    tool({ name: 'archon_remove_vault_item', cliCommand: 'remove-vault-item', description: 'Remove an item from a vault.', schema: IdSchema.extend({ item: z.string() }).merge(ConfirmSchema), mutates: true, handler: (runtime, { id, item }) => requireKeymaster(runtime).removeVaultItem(id, item) }),
    tool({ name: 'archon_get_vault_item', cliCommand: 'get-vault-item', description: 'Return a vault item as an embedded resource content block.', schema: IdSchema.extend({ item: z.string() }).merge(ResolveOptionsSchema), handler: async (runtime, { id, item, ...options }) => {
        const keymaster = requireKeymaster(runtime);
        // Resolve once so the URI names a real DID rather than an alias, and so the calls
        // below skip their own lookups.
        const vault = await keymaster.lookupDID(id);
        // One options object for both calls: the item read and the metadata read must see
        // the same resolve options, or they could look at different versions of the vault.
        const resolveOptions = compactOptions(options);
        const buffer = await keymaster.getVaultItem(vault, item, resolveOptions);
        return buffer ? vaultItemResult(keymaster, vault, item, Buffer.from(buffer), resolveOptions) : null;
    } }),

    tool({ name: 'archon_create_dmail', cliCommand: 'create-dmail', description: 'Create a dmail from inline JSON.', schema: z.object({ message: DmailMessageSchema }).merge(VaultOptionsSchema), mutates: true, handler: (runtime, { message, ...options }) => requireKeymaster(runtime).createDmail(message, compactOptions(options)) }),
    tool({ name: 'archon_update_dmail', cliCommand: 'update-dmail', description: 'Update an existing dmail from inline JSON.', schema: DidSchema.extend({ message: DmailMessageSchema }), mutates: true, handler: (runtime, { did, message }) => requireKeymaster(runtime).updateDmail(did, message) }),
    tool({ name: 'archon_send_dmail', cliCommand: 'send-dmail', description: 'Send a dmail and return the notice DID.', schema: DidSchema, mutates: true, handler: (runtime, { did }) => requireKeymaster(runtime).sendDmail(did) }),
    tool({ name: 'archon_get_dmail', cliCommand: 'get-dmail', description: 'Get a dmail message by DID.', schema: DidSchema.merge(ResolveOptionsSchema), handler: (runtime, { did, ...options }) => requireKeymaster(runtime).getDmailMessage(did, compactOptions(options)) }),
    tool({ name: 'archon_list_dmail', cliCommand: 'list-dmail', description: 'List dmails for the current ID.', schema: EmptySchema, handler: runtime => requireKeymaster(runtime).listDmail() }),
    tool({ name: 'archon_file_dmail', cliCommand: 'file-dmail', description: 'Assign tags to a dmail.', schema: DidSchema.extend({ tags: z.array(z.string()) }), mutates: true, handler: (runtime, { did, tags }) => requireKeymaster(runtime).fileDmail(did, tags) }),
    tool({ name: 'archon_refresh_dmail', cliCommand: 'refresh-dmail', description: 'Check for new dmails and clean up expired notices.', schema: EmptySchema, mutates: true, handler: runtime => requireKeymaster(runtime).refreshNotices() }),
    tool({ name: 'archon_import_dmail', cliCommand: 'import-dmail', description: 'Import a dmail into the inbox.', schema: DidSchema, mutates: true, handler: (runtime, { did }) => requireKeymaster(runtime).importDmail(did) }),
    tool({ name: 'archon_remove_dmail', cliCommand: 'remove-dmail', description: 'Delete a dmail from the local list.', schema: DidSchema.merge(ConfirmSchema), mutates: true, handler: (runtime, { did }) => requireKeymaster(runtime).removeDmail(did) }),
    tool({ name: 'archon_add_dmail_attachment', cliCommand: 'add-dmail-attachment', description: 'Add an inline attachment to a dmail.', schema: DidSchema.extend({ attachment: InlineDataSchema }), mutates: true, handler: (runtime, { did, attachment }) => requireKeymaster(runtime).addDmailAttachment(did, attachment.name ?? 'attachment', bufferFromInlineData(attachment)) }),
    tool({ name: 'archon_remove_dmail_attachment', cliCommand: 'remove-dmail-attachment', description: 'Remove an attachment from a dmail.', schema: DidSchema.extend({ name: z.string() }).merge(ConfirmSchema), mutates: true, handler: (runtime, { did, name }) => requireKeymaster(runtime).removeDmailAttachment(did, name) }),
    tool({ name: 'archon_get_dmail_attachment', cliCommand: 'get-dmail-attachment', description: 'Return a dmail attachment as an embedded resource content block.', schema: DidSchema.extend({ name: z.string() }), handler: async (runtime, { did, name }) => {
        const keymaster = requireKeymaster(runtime);
        const dmail = await keymaster.lookupDID(did);
        const buffer = await keymaster.getDmailAttachment(dmail, name);
        return buffer ? vaultItemResult(keymaster, dmail, name, Buffer.from(buffer)) : null;
    } }),
    tool({ name: 'archon_list_dmail_attachments', cliCommand: 'list-dmail-attachments', description: 'List attachments of a dmail.', schema: DidSchema.merge(ResolveOptionsSchema), handler: (runtime, { did, ...options }) => requireKeymaster(runtime).listDmailAttachments(did, compactOptions(options)) }),

    tool({ name: 'archon_publish_didcomm', cliCommand: 'publish-didcomm', description: 'Publish an X25519 key-agreement key (and optional DIDCommMessaging service) to the current ID.', schema: z.object({ endpoint: z.string().optional(), name: z.string().optional(), routingKeys: z.array(z.string()).optional() }), mutates: true, handler: (runtime, { endpoint, name, routingKeys }) => requireKeymaster(runtime).publishDidComm(endpoint, name, routingKeys) }),
    tool({ name: 'archon_unpublish_didcomm', cliCommand: 'unpublish-didcomm', description: 'Remove the DIDComm key-agreement key and service from the current ID.', schema: z.object({ name: z.string().optional() }), mutates: true, handler: (runtime, { name }) => requireKeymaster(runtime).unpublishDidComm(name) }),
    tool({ name: 'archon_pack_didcomm', cliCommand: 'pack-didcomm', description: 'Pack a DIDComm v2 message (encrypted, optionally signed) for one or more recipient DIDs.', schema: z.object({ message: JsonObjectSchema, to: z.union([z.string(), z.array(z.string())]), sign: z.boolean().optional(), anoncrypt: z.boolean().optional(), encryption: DidCommEncSchema.optional(), name: z.string().optional() }), handler: (runtime, { message, to, sign, anoncrypt, encryption, name }) => requireKeymaster(runtime).packDidComm(message, to, compactOptions({ sign, anoncrypt, encryption, name })) }),
    tool({ name: 'archon_unpack_didcomm', cliCommand: 'unpack-didcomm', description: 'Unpack (decrypt and verify) a DIDComm v2 message addressed to the current ID.', schema: z.object({ packed: z.string(), name: z.string().optional() }), handler: (runtime, { packed, name }) => requireKeymaster(runtime).unpackDidComm(packed, compactOptions({ name })) }),
    tool({ name: 'archon_send_didcomm', cliCommand: 'send-didcomm', description: 'Pack a DIDComm message and deliver it to each recipient DID\'s mailbox.', schema: z.object({ message: JsonObjectSchema, to: z.union([z.string(), z.array(z.string())]), sign: z.boolean().optional(), anoncrypt: z.boolean().optional(), encryption: DidCommEncSchema.optional(), name: z.string().optional() }), mutates: true, handler: (runtime, { message, to, sign, anoncrypt, encryption, name }) => requireKeymaster(runtime).sendDidComm(message, to, compactOptions({ sign, anoncrypt, encryption, name })) }),
    tool({ name: 'archon_receive_didcomm', cliCommand: 'receive-didcomm', description: 'Fetch and unpack queued DIDComm messages from the current ID\'s mailbox.', schema: z.object({ name: z.string().optional(), endpoint: z.string().optional() }), mutates: true, handler: (runtime, { name, endpoint }) => requireKeymaster(runtime).receiveDidComm(compactOptions({ name, endpoint })) }),
    tool({ name: 'archon_mediate_didcomm', cliCommand: 'mediate-didcomm', description: 'Relay queued Forward envelopes from this ID\'s mailbox to their recipients (mediator role).', schema: z.object({ name: z.string().optional(), endpoint: z.string().optional() }), mutates: true, handler: (runtime, { name, endpoint }) => requireKeymaster(runtime).mediateDidComm(compactOptions({ name, endpoint })) }),
];

export const ARCHON_MCP_CLI_COMMANDS = ARCHON_MCP_TOOL_DEFINITIONS
    .map(definition => definition.cliCommand)
    .filter((command): command is string => !!command);

function registerToolDefinition(
    server: RegisterableServer,
    runtime: ArchonRuntime,
    config: McpServerConfig,
    definition: ArchonToolDefinition
) {
    if (definition.mutates && config.readOnly) {
        return;
    }

    const wrapped = async (rawArgs: unknown) => {
        try {
            if (definition.mutates && config.readOnly) {
                throw new Error('Tool disabled by ARCHON_MCP_READ_ONLY=true');
            }
            const args = definition.schema.parse(rawArgs ?? {});
            return ok(await definition.handler(runtime, args, config));
        } catch (error) {
            return fail(error);
        }
    };

    if (server.registerTool) {
        const config: Record<string, unknown> = { description: definition.description, inputSchema: definition.schema };

        if (definition.outputSchema) {
            config.outputSchema = definition.outputSchema;
        }

        server.registerTool(definition.name, config, wrapped);
        return;
    }

    if (server.tool && definition.schema instanceof z.ZodObject) {
        server.tool(definition.name, definition.description, definition.schema.shape, wrapped);
        return;
    }

    throw new Error('MCP server does not support tool registration');
}

export function registerArchonTools(server: RegisterableServer, runtime: ArchonRuntime, config: McpServerConfig): void {
    for (const definition of ARCHON_MCP_TOOL_DEFINITIONS) {
        registerToolDefinition(server, runtime, config, definition);
    }
}
