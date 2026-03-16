# Name Service Agent Guide

A guide for AI agents to authenticate and register using curl commands.

> Replace `https://your-domain.example` below with the actual deployment URL.

## Prerequisites

- A DID controlled by your keymaster
- Ability to sign challenges (via your keymaster)
- `curl` and `jq` available

## Quick Start (Stateless API)

The fastest way to claim a name — just 2 HTTP calls, no cookies or sessions needed.

### 1. Get a Challenge

```bash
SERVICE_URL="https://your-domain.example"

CHALLENGE=$(curl -s $SERVICE_URL/api/challenge | jq -r '.challenge')
```

### 2. Sign the Challenge

Use your keymaster to create a response to the challenge:

```bash
RESPONSE=$(npx @didcid/keymaster create-response $CHALLENGE)
```

### 3. Claim Your Name

Use the response DID as a Bearer token:

```bash
curl -s -X PUT $SERVICE_URL/api/name \
  -H "Authorization: Bearer $RESPONSE" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-agent"}' | jq .

# Returns: { ok, name, did, credential: { credentialDid, credential, ... } }
```

The credential is automatically issued with the name.

### Delete Your Name

```bash
curl -s -X DELETE $SERVICE_URL/api/name \
  -H "Authorization: Bearer $RESPONSE" | jq .
```

## Complete Example

```bash
#!/bin/bash
set -e

NAME="my-agent"
SERVICE_URL="https://your-domain.example"

# 1. Get challenge
CHALLENGE=$(curl -s $SERVICE_URL/api/challenge | jq -r '.challenge')

# 2. Sign challenge with your keymaster
RESPONSE=$(npx @didcid/keymaster create-response $CHALLENGE)

# 3. Claim name (credential is auto-issued)
curl -s -X PUT $SERVICE_URL/api/name \
  -H "Authorization: Bearer $RESPONSE" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$NAME\"}" | jq .
```

## Public Endpoints (No Auth Required)

### Resolve a Name to DID

```bash
curl -s $SERVICE_URL/api/name/some-name | jq .
# Returns: {"name":"some-name","did":"did:cid:..."}
```

### Get Member's DID Document

```bash
curl -s $SERVICE_URL/member/some-name | jq .
```

### Get Full Registry

```bash
curl -s $SERVICE_URL/api/registry | jq .
```

## Session-Based API (Browser Flow)

For browser-based clients, the session-based flow is also available:

1. `GET /api/challenge` — get challenge
2. `POST /api/login` — submit response, get session cookie
3. `PUT /api/profile/:did/name` — set name (with cookie)
4. `GET /api/credential` — view credential (with cookie)

## API Reference

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/config` | GET | No | Get service config (name, URL) |
| `/api/challenge` | GET | No | Get login challenge |
| `/api/name` | PUT | Bearer | Claim or update name (stateless) |
| `/api/name` | DELETE | Bearer | Delete name and revoke credential |
| `/api/name/:name` | GET | No | Resolve name to DID |
| `/api/login` | POST | No | Submit challenge response (session) |
| `/api/logout` | POST | Session | End session |
| `/api/check-auth` | GET | Session | Check auth status |
| `/api/profile/:did` | GET | Session | Get user profile |
| `/api/profile/:did/name` | PUT | Session | Set your name |
| `/api/credential` | GET | Session | Get your credential |
| `/api/registry` | GET | No | Full name registry |
| `/member/:name` | GET | No | Member DID document |

Name requirements:
- 3-32 characters
- Lowercase alphanumeric, hyphens, underscores only
- Must be unique (case-insensitive)

---

Built on Archon Protocol
