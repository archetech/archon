# Archon MCP Server

`@didcid/mcp-server` lets MCP clients work with Archon identities, aliases, addresses, and JSON assets from a local wallet. It runs as a stdio server on the user's machine, so agents can use Archon from local MCP-compatible tools.

The server uses the same wallet files and passphrase flow as the Keymaster CLI, then connects to an Archon node through Gatekeeper/Drawbridge for registry reads and writes.

## Usage

```bash
npx @didcid/mcp-server
```

Example MCP client config:

```json
{
  "mcpServers": {
    "archon": {
      "command": "npx",
      "args": ["-y", "@didcid/mcp-server"],
      "env": {
        "ARCHON_NODE_URL": "https://archon.technology",
        "ARCHON_WALLET_PATH": "./wallet.json",
        "ARCHON_PASSPHRASE": "your-wallet-passphrase"
      }
    }
  }
}
```

## Environment

| Variable | Default | Description |
| --- | --- | --- |
| `ARCHON_NODE_URL` | `https://archon.technology` | Archon Gatekeeper/Drawbridge node URL |
| `ARCHON_GATEKEEPER_URL` | unset | Legacy fallback when `ARCHON_NODE_URL` is unset |
| `ARCHON_WALLET_TYPE` | `json` | Local wallet backend: `json` or `sqlite` |
| `ARCHON_WALLET_PATH` | `./wallet.json` | Wallet file path |
| `ARCHON_PASSPHRASE` | unset | Required for wallet-backed tools; node health tools work without it |
| `ARCHON_DEFAULT_REGISTRY` | Keymaster default | Default registry for new DIDs |
| `ARCHON_MCP_READ_ONLY` | `false` | Set to `true` to omit mutating tools from `tools/list` |

## Tools

The MCP server maps every Keymaster CLI command to one MCP tool. Tool names use the CLI command with `archon_` prefixed and hyphens changed to underscores.

MCP-only helper tools:

- `archon_get_version`
- `archon_get_status`
- `archon_get_current_id`

CLI file commands use inline data instead of arbitrary local paths. Binary/text payloads use:

```json
{
  "name": "example.txt",
  "mimeType": "text/plain",
  "encoding": "base64",
  "data": "aGVsbG8="
}
```

Use `"encoding": "utf8"` when passing plain text directly. This inline shape is for tool *arguments*; returned binary data uses MCP content blocks instead — see [Tool results](#tool-results).

Destructive tools require `"confirm": true`, secret-revealing tools require `"reveal": true`, and Lightning payment/broadcast tools require `"confirmPayment": true`.

Set `ARCHON_MCP_READ_ONLY=true` to omit mutating tools from the advertised MCP tool list.

### Structured inputs

Tools whose argument is a specific object — `archon_restore_wallet_file` (a wallet), `archon_update_credential` (a credential), `archon_create_poll` (a poll config), `archon_create_dmail` / `archon_update_dmail` (a message) — declare that object's real shape, so the advertised input schema tells a client what to send and malformed input is rejected at the tool boundary rather than failing deeper inside Keymaster.

Two rules apply when adding or changing one:

- **Passthrough wherever the underlying type has an index signature.** Zod *strips* unknown keys rather than rejecting them, so a schema that omits an extension point silently deletes data — a wallet's custom metadata, or a credential's claims. Use a plain object only where the type is closed (`PollConfig`, `DmailMessage`), so junk fields are dropped instead of stored.
- **Never be stricter than the Keymaster method behind the tool**, or the tool rejects input the CLI and REST API accept. Poll deadlines stay plain strings rather than ISO date-times because Keymaster accepts anything `new Date()` parses.

Keymaster remains authoritative and re-validates everything. Semantic rules it enforces that a JSON Schema cannot express — a deadline must be in the future, a recipient must resolve to an agent — are not duplicated here; only constraints a client can act on before calling are.

## Tool results

Results follow the MCP specification.

On success, the result is serialized as JSON into a text content block. When the result is a JSON object it is also returned in `structuredContent`:

```json
{
  "content": [{ "type": "text", "text": "{\"didDocument\":{\"id\":\"did:cid:alice\"}}" }],
  "structuredContent": { "didDocument": { "id": "did:cid:alice" } }
}
```

MCP requires `structuredContent` to be a JSON object, so tools returning an array or a scalar (for example `archon_list_ids`, or the DID returned by `archon_create_id`) return the text content block only.

Tools returning binary assets use the content block types the protocol defines for them, so clients can render them natively. `archon_get_asset_image` returns an `image` block plus a text block carrying the filename, mimeType, and dimensions:

```json
{
  "content": [
    { "type": "image", "data": "<base64>", "mimeType": "image/png" },
    { "type": "text", "text": "{\"name\":\"image.png\",\"mimeType\":\"image/png\",\"image\":{\"width\":1,\"height\":1}}" }
  ],
  "structuredContent": { "name": "image.png", "mimeType": "image/png", "image": { "width": 1, "height": 1 } }
}
```

`archon_get_asset_file` returns an embedded `resource` block identified by the asset's DID, which is a URI the server also serves as an MCP resource — see [Resources](#resources):

```json
{
  "content": [
    { "type": "resource", "resource": { "uri": "did:cid:file", "mimeType": "text/plain", "blob": "<base64>" } },
    { "type": "text", "text": "{\"name\":\"file.txt\",\"mimeType\":\"text/plain\"}" }
  ],
  "structuredContent": { "name": "file.txt", "mimeType": "text/plain" }
}
```

Both return `null` when the asset carries no data.

Failures — including input validation, a locked wallet, and node errors — are reported as MCP tool execution errors, with `isError: true` and the message in a text content block:

```json
{
  "content": [{ "type": "text", "text": "ARCHON_PASSPHRASE is required for wallet-backed MCP tools" }],
  "isError": true
}
```

Error messages are redacted of secrets (passphrases, recovery phrases, nsec keys, credentialed URLs).

### Output schemas

A few tools declare an `outputSchema`, so a client knows the result shape from `listTools` without having to call the tool first: `archon_resolve_did`, `archon_resolve_did_version`, `archon_check_wallet`, `archon_fix_wallet`, `archon_view_poll`, and `archon_view_ballot`.

They are declared selectively rather than everywhere, by design:

- **Declaring one is binding.** Per the spec, a tool with an output schema MUST return conforming structured results. The SDK enforces it — a mismatch, or a missing `structuredContent`, turns a working call into a failed one.
- **Most tools can't have one.** MCP requires `structuredContent` to be a JSON object, and the majority of these tools return a DID string, a boolean, or a string array. Tools that can return `null` (`archon_get_asset_image`, `archon_get_credential`, and others) are excluded for the same reason.
- **Schemas aren't free.** Every declared schema is sent to every client on every `listTools`, competing for context with the work itself.

So the bar is: the result is an object the tool always returns, and something downstream consumes a field from it. Schemas describe the nesting a caller must navigate — leaves are intentionally loose, and fields typed `unknown` at the source (such as `didDocumentData`) stay unknown.

If you add one, it must be a `.passthrough()` object. A plain zod object serializes to `additionalProperties: false`, which makes clients reject any field the schema doesn't enumerate.

## Resources

The server implements the MCP `resources` capability. An Archon asset DID is already a URI, so it is the resource URI verbatim — the same one `archon_get_asset_file` puts in its embedded `resource` block. `resources/read` on that URI returns the asset:

```json
{
  "uri": "did:cid:z3v8Auah...",
  "contents": [{ "uri": "did:cid:z3v8Auah...", "mimeType": "text/plain", "blob": "<base64>" }]
}
```

File and image assets return their bytes; any other asset returns its JSON data with `mimeType: "application/json"`. URIs that are not `did:cid:` are not matched.

**`resources/list` is empty by design.** Enumerating every asset in the wallet would disclose its contents to any connected client, whether or not it ever reads one. Reads are by a DID the caller already holds, which reveals nothing that resolving that DID wouldn't. `resources/templates/list` advertises `did:cid:{id}`, so the read path is still discoverable. What a filtered list should expose is an open question.

Resource reads are wallet-backed and require `ARCHON_PASSPHRASE`, the same as the equivalent tools. They are reads, so `ARCHON_MCP_READ_ONLY` does not affect them.

## Examples

Create an ID:

```json
{
  "name": "archon_create_id",
  "arguments": {
    "name": "alice",
    "registry": "hyperswarm"
  }
}
```

Rotate the current ID keys:

```json
{
  "name": "archon_rotate_keys",
  "arguments": {
    "confirm": true
  }
}
```

Create a JSON asset:

```json
{
  "name": "archon_create_asset_json",
  "arguments": {
    "data": {
      "title": "Example",
      "status": "draft"
    },
    "alias": "example-asset"
  }
}
```

Create a file asset from inline data:

```json
{
  "name": "archon_create_asset_file",
  "arguments": {
    "file": {
      "name": "hello.txt",
      "mimeType": "text/plain",
      "encoding": "utf8",
      "data": "hello"
    },
    "alias": "hello-file"
  }
}
```

Issue a credential from inline JSON:

```json
{
  "name": "archon_issue_credential",
  "arguments": {
    "credential": {
      "@context": ["https://www.w3.org/ns/credentials/v2"],
      "type": ["VerifiableCredential"],
      "issuer": "did:cid:issuer",
      "credentialSubject": {
        "id": "did:cid:subject"
      }
    }
  }
}
```

Reveal a credential in the current ID manifest:

```json
{
  "name": "archon_reveal_credential",
  "arguments": {
    "did": "did:cid:credential",
    "reveal": true
  }
}
```

Pay a Lightning invoice:

```json
{
  "name": "archon_lightning_pay",
  "arguments": {
    "bolt11": "lnbc...",
    "confirmPayment": true
  }
}
```

### Keymaster CLI mapping

| CLI command | MCP tool |
| --- | --- |
| `create-wallet` | `archon_create_wallet` |
| `new-wallet` | `archon_new_wallet` |
| `change-passphrase` | `archon_change_passphrase` |
| `check-wallet` | `archon_check_wallet` |
| `fix-wallet` | `archon_fix_wallet` |
| `import-wallet` | `archon_import_wallet` |
| `show-wallet` | `archon_show_wallet` |
| `backup-wallet-file` | `archon_backup_wallet_file` |
| `restore-wallet-file` | `archon_restore_wallet_file` |
| `show-mnemonic` | `archon_show_mnemonic` |
| `backup-wallet-did` | `archon_backup_wallet_did` |
| `recover-wallet-did` | `archon_recover_wallet_did` |
| `create-id` | `archon_create_id` |
| `resolve-id` | `archon_resolve_id` |
| `backup-id` | `archon_backup_id` |
| `recover-id` | `archon_recover_id` |
| `remove-id` | `archon_remove_id` |
| `rename-id` | `archon_rename_id` |
| `list-ids` | `archon_list_ids` |
| `list-registries` | `archon_list_registries` |
| `use-id` | `archon_use_id` |
| `rotate-keys` | `archon_rotate_keys` |
| `resolve-did` | `archon_resolve_did` |
| `resolve-did-version` | `archon_resolve_did_version` |
| `revoke-did` | `archon_revoke_did` |
| `change-registry` | `archon_change_registry` |
| `encrypt-message` | `archon_encrypt_message` |
| `encrypt-file` | `archon_encrypt_file` |
| `decrypt-did` | `archon_decrypt_did` |
| `decrypt-json` | `archon_decrypt_json` |
| `sign-file` | `archon_sign_file` |
| `verify-file` | `archon_verify_file` |
| `create-challenge` | `archon_create_challenge` |
| `create-challenge-cc` | `archon_create_challenge_cc` |
| `create-response` | `archon_create_response` |
| `verify-response` | `archon_verify_response` |
| `bind-credential` | `archon_bind_credential` |
| `issue-credential` | `archon_issue_credential` |
| `list-issued` | `archon_list_issued` |
| `update-credential` | `archon_update_credential` |
| `revoke-credential` | `archon_revoke_credential` |
| `accept-credential` | `archon_accept_credential` |
| `list-credentials` | `archon_list_credentials` |
| `get-credential` | `archon_get_credential` |
| `view-credential` | `archon_view_credential` |
| `publish-credential` | `archon_publish_credential` |
| `reveal-credential` | `archon_reveal_credential` |
| `unpublish-credential` | `archon_unpublish_credential` |
| `add-alias` | `archon_add_alias` |
| `get-alias` | `archon_get_alias` |
| `remove-alias` | `archon_remove_alias` |
| `list-aliases` | `archon_list_aliases` |
| `list-addresses` | `archon_list_addresses` |
| `get-address` | `archon_get_address` |
| `import-address` | `archon_import_address` |
| `check-address` | `archon_check_address` |
| `add-address` | `archon_add_address` |
| `remove-address` | `archon_remove_address` |
| `publish-address` | `archon_publish_address` |
| `unpublish-address` | `archon_unpublish_address` |
| `add-nostr` | `archon_add_nostr` |
| `import-nostr` | `archon_import_nostr` |
| `remove-nostr` | `archon_remove_nostr` |
| `add-lightning` | `archon_add_lightning` |
| `remove-lightning` | `archon_remove_lightning` |
| `lightning-balance` | `archon_lightning_balance` |
| `lightning-decode` | `archon_lightning_decode` |
| `lightning-invoice` | `archon_lightning_invoice` |
| `lightning-pay` | `archon_lightning_pay` |
| `lightning-check` | `archon_lightning_check` |
| `publish-lightning` | `archon_publish_lightning` |
| `unpublish-lightning` | `archon_unpublish_lightning` |
| `lightning-zap` | `archon_lightning_zap` |
| `lightning-payments` | `archon_lightning_payments` |
| `create-group` | `archon_create_group` |
| `list-groups` | `archon_list_groups` |
| `get-group` | `archon_get_group` |
| `add-group-member` | `archon_add_group_member` |
| `remove-group-member` | `archon_remove_group_member` |
| `test-group` | `archon_test_group` |
| `create-schema` | `archon_create_schema` |
| `list-schemas` | `archon_list_schemas` |
| `get-schema` | `archon_get_schema` |
| `create-schema-template` | `archon_create_schema_template` |
| `create-asset` | `archon_create_asset` |
| `create-asset-json` | `archon_create_asset_json` |
| `create-asset-image` | `archon_create_asset_image` |
| `create-asset-file` | `archon_create_asset_file` |
| `get-asset` | `archon_get_asset` |
| `get-asset-json` | `archon_get_asset_json` |
| `get-asset-image` | `archon_get_asset_image` |
| `get-asset-file` | `archon_get_asset_file` |
| `update-asset-json` | `archon_update_asset_json` |
| `update-asset-image` | `archon_update_asset_image` |
| `update-asset-file` | `archon_update_asset_file` |
| `transfer-asset` | `archon_transfer_asset` |
| `clone-asset` | `archon_clone_asset` |
| `get-property` | `archon_get_property` |
| `set-property` | `archon_set_property` |
| `list-assets` | `archon_list_assets` |
| `create-poll-template` | `archon_create_poll_template` |
| `create-poll` | `archon_create_poll` |
| `add-poll-voter` | `archon_add_poll_voter` |
| `remove-poll-voter` | `archon_remove_poll_voter` |
| `list-poll-voters` | `archon_list_poll_voters` |
| `view-poll` | `archon_view_poll` |
| `vote-poll` | `archon_vote_poll` |
| `send-poll` | `archon_send_poll` |
| `send-ballot` | `archon_send_ballot` |
| `view-ballot` | `archon_view_ballot` |
| `update-poll` | `archon_update_poll` |
| `publish-poll` | `archon_publish_poll` |
| `reveal-poll` | `archon_reveal_poll` |
| `unpublish-poll` | `archon_unpublish_poll` |
| `create-vault` | `archon_create_vault` |
| `list-vault-items` | `archon_list_vault_items` |
| `add-vault-member` | `archon_add_vault_member` |
| `remove-vault-member` | `archon_remove_vault_member` |
| `list-vault-members` | `archon_list_vault_members` |
| `add-vault-item` | `archon_add_vault_item` |
| `remove-vault-item` | `archon_remove_vault_item` |
| `get-vault-item` | `archon_get_vault_item` |
| `create-dmail` | `archon_create_dmail` |
| `update-dmail` | `archon_update_dmail` |
| `send-dmail` | `archon_send_dmail` |
| `get-dmail` | `archon_get_dmail` |
| `list-dmail` | `archon_list_dmail` |
| `file-dmail` | `archon_file_dmail` |
| `refresh-dmail` | `archon_refresh_dmail` |
| `import-dmail` | `archon_import_dmail` |
| `remove-dmail` | `archon_remove_dmail` |
| `add-dmail-attachment` | `archon_add_dmail_attachment` |
| `remove-dmail-attachment` | `archon_remove_dmail_attachment` |
| `get-dmail-attachment` | `archon_get_dmail_attachment` |
| `list-dmail-attachments` | `archon_list_dmail_attachments` |
