# Herald Agent Guide

A guide for AI agents to authenticate and manage names against Archon's Herald service.

In Archon, Herald is:
- served internally as the `herald` backend on port `4230`
- exposed publicly through Drawbridge under `/names`
- paired with a separate `herald-client` frontend on port `4231`

> Replace `https://your-domain.com` below with the actual Drawbridge base URL for your deployment.

## Default URLs

Use these defaults in a local Archon stack:

- Drawbridge base: `http://localhost:4222`
- Herald API base: `http://localhost:4222/names/api`
- Herald web client: `http://localhost:4231`
- Public name discovery: `http://localhost:4222/.well-known/names/<name>`

Examples below assume a deployed Drawbridge URL:

```bash
DRAWBRIDGE_URL="https://your-domain.com"
HERALD_API_URL="$DRAWBRIDGE_URL/names/api"
```

## Prerequisites

- A DID controlled by your keymaster
- Ability to sign challenges with Keymaster
- `curl` and `jq`

## Quick Start (Stateless API)

The stateless API is the simplest way for an agent to claim or delete a name.

### 1. Get a Challenge

```bash
CHALLENGE=$(curl -s "$HERALD_API_URL/challenge" | jq -r '.challenge')
```

### 2. Sign the Challenge

Use Keymaster to create a response:

```bash
RESPONSE=$(npx @didcid/keymaster create-response "$CHALLENGE")
```

### 3. Claim or Update a Name

```bash
curl -s -X PUT "$HERALD_API_URL/name" \
  -H "Authorization: Bearer $RESPONSE" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-agent"}' | jq .
```

Expected response shape:

```json
{
  "ok": true,
  "name": "my-agent",
  "did": "did:cid:...",
  "credentialDid": "did:cid:...",
  "credentialIssuedAt": "2026-03-27T00:00:00.000Z",
  "credential": { "...": "..." }
}
```

Herald issues a verifiable credential for the claimed name using the default membership schema unless overridden by `NS_MEMBERSHIP_SCHEMA_DID`.

### 4. Delete a Name

```bash
curl -s -X DELETE "$HERALD_API_URL/name" \
  -H "Authorization: Bearer $RESPONSE" | jq .
```

This deletes the name and revokes the associated credential.

## Complete Example

```bash
#!/bin/bash
set -euo pipefail

NAME="my-agent"
DRAWBRIDGE_URL="https://your-domain.com"
HERALD_API_URL="$DRAWBRIDGE_URL/names/api"

CHALLENGE=$(curl -s "$HERALD_API_URL/challenge" | jq -r '.challenge')
RESPONSE=$(npx @didcid/keymaster create-response "$CHALLENGE")

curl -s -X PUT "$HERALD_API_URL/name" \
  -H "Authorization: Bearer $RESPONSE" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$NAME\"}" | jq .
```

## Public Endpoints

### Resolve a Name to a DID

```bash
curl -s "$HERALD_API_URL/name/some-name" | jq .
```

Returns:

```json
{
  "name": "some-name",
  "did": "did:cid:..."
}
```

### Resolve via Well-Known Discovery

This is the preferred public discovery path:

```bash
curl -s "$DRAWBRIDGE_URL/.well-known/names/some-name" | jq .
```

### Get the Full Registry

```bash
curl -s "$HERALD_API_URL/registry" | jq .
```

### Get a Member DID Document

```bash
curl -s "$HERALD_API_URL/member/some-name" | jq .
```

## Session-Based API (Browser Flow)

Herald also supports a session flow used by `herald-client`.

1. `GET /names/api/challenge`
2. `POST /names/api/login`
3. `PUT /names/api/profile/:did/name`
4. `DELETE /names/api/profile/:did/name`
5. `GET /names/api/credential`

When calling this flow from a browser app on another origin, requests must include credentials.

## API Reference

| Public Path | Method | Auth | Description |
|-------------|--------|------|-------------|
| `/names/api/config` | GET | No | Get Herald config |
| `/names/api/challenge` | GET | No | Get login challenge |
| `/names/api/name` | PUT | Bearer | Claim or update a name |
| `/names/api/name` | DELETE | Bearer | Delete name and revoke credential |
| `/names/api/name/:name` | GET | No | Resolve name to DID |
| `/names/api/login` | POST | No | Submit challenge response and create session |
| `/names/api/logout` | POST | Session | End session |
| `/names/api/check-auth` | GET | Session | Check current session |
| `/names/api/profile/:did` | GET | Session | Get user profile |
| `/names/api/profile/:did/name` | PUT | Session | Set your name |
| `/names/api/profile/:did/name` | DELETE | Session | Delete your name |
| `/names/api/credential` | GET | Session | Get your credential |
| `/names/api/registry` | GET | No | Full registry export |
| `/names/api/member/:name` | GET | No | Member DID document |
| `/.well-known/names/:name` | GET | No | Public name discovery |
| `/.well-known/lnurlp/:name` | GET | No | Lightning address discovery |
| `/names/api/lnurlp/:name/callback` | GET | No | LNURL-pay callback |

## Lightning Address (LUD16)

If a DID document includes a Lightning service endpoint, `name@domain` can resolve as a Lightning address.

Example service entry:

```json
{
  "service": [{
    "id": "did:cid:...#lightning",
    "type": "Lightning",
    "serviceEndpoint": "https://your-node/invoice/..."
  }]
}
```

The service endpoint must accept:

```text
GET <endpoint>?amount=<millisatoshis>
```

and return:

```json
{
  "pr": "<bolt11 invoice>",
  "routes": []
}
```

## Name Rules

- 3 to 32 characters
- lowercase letters, numbers, hyphens, and underscores only
- unique case-insensitively

## Archon Notes

- Herald stores backend data in `data/herald`
- Herald defaults to the membership schema `did:cid:bagaaieravnv5onsflewvrz6urhwfjixfnwq7bgc3ejhlrj2nekx75ddhdupq`
- In Archon, agents should prefer the Drawbridge-exposed URLs over direct container URLs

Built on Archon Protocol
