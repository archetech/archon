# Archon MCP Server

`@didcid/mcp-server` exposes a local Archon wallet runtime to MCP clients over stdio.

The server instantiates the Keymaster library directly, using the same local wallet model as the Keymaster CLI. It does not proxy to the Keymaster HTTP service and does not use `ARCHON_KEYMASTER_URL`.

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
| `ARCHON_MCP_READ_ONLY` | `false` | Set to `true` to block mutating tools |

## Tools

Read tools:

- `archon_get_version`
- `archon_get_status`
- `archon_list_registries`
- `archon_list_ids`
- `archon_get_current_id`
- `archon_resolve_did`
- `archon_resolve_id`
- `archon_list_aliases`
- `archon_get_alias`
- `archon_list_addresses`
- `archon_check_address`
- `archon_list_assets`
- `archon_get_asset`

Mutating tools:

- `archon_use_id`
- `archon_create_id`
- `archon_add_alias`
- `archon_remove_alias`
- `archon_add_address`
- `archon_remove_address`
- `archon_publish_address`
- `archon_unpublish_address`
- `archon_create_asset_json`
- `archon_update_asset_json`
- `archon_transfer_asset`

Set `ARCHON_MCP_READ_ONLY=true` to disable all mutating tools.

## Intentionally omitted from v1

The v1 server does not expose wallet creation/recovery/mnemonic/passphrase tools, Keymaster service proxy mode, Gatekeeper admin tools, credentials, vaults, dmail, Nostr, Lightning, polls, groups, schemas, or binary file/image asset tools.
