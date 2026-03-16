# Name Service Agent Guide

A guide for AI agents to authenticate and register using curl commands.

> Replace `https://your-domain.example` below with the actual deployment URL.

## Prerequisites

- A DID controlled by your keymaster
- Ability to sign challenges (via your keymaster)
- `curl` and `jq` available

## Authentication Flow

### 1. Get a Challenge

```bash
# Configuration - set to your deployment URL
SERVICE_URL="https://your-domain.example"

# Request a challenge and save session cookies
CHALLENGE=$(curl -s -c cookies.txt $SERVICE_URL/api/challenge | jq -r '.challenge')
echo "Challenge: $CHALLENGE"
```

### 2. Sign the Challenge

Use your keymaster to create a response to the challenge. This step varies depending on your keymaster setup.

```bash
# The response is a DID representing your signed challenge
RESPONSE="did:cid:your-response-did"
```

### 3. Login

```bash
curl -s -b cookies.txt -c cookies.txt \
  -X POST $SERVICE_URL/api/login \
  -H "Content-Type: application/json" \
  -d "{\"response\":\"$RESPONSE\"}"

# Returns: {"authenticated":true}
```

### 4. Verify Authentication

```bash
AUTH=$(curl -s -b cookies.txt $SERVICE_URL/api/check-auth)
echo $AUTH | jq .

# Extract your DID
DID=$(echo $AUTH | jq -r '.userDID')
```

## Profile Management

### Check Name Availability

```bash
curl -s $SERVICE_URL/api/name/desired-name/available | jq .
# Returns: {"name":"desired-name","available":true}
```

### Set Your @name

```bash
curl -s -b cookies.txt \
  -X PUT "$SERVICE_URL/api/profile/$DID/name" \
  -H "Content-Type: application/json" \
  -d '{"name":"your-name"}'

# Returns: {"ok":true,"message":"name set to your-name"}
```

Name requirements:
- 3-32 characters
- Lowercase alphanumeric, hyphens, underscores only
- Must be unique (case-insensitive)

### Get Your Profile

```bash
curl -s -b cookies.txt "$SERVICE_URL/api/profile/$DID" | jq .
```

## Verifiable Credentials

### Request a Credential

After setting your name, request a verifiable credential proving ownership:

```bash
curl -s -b cookies.txt \
  -X POST $SERVICE_URL/api/credential/request | jq .
```

### View Your Credential

```bash
curl -s -b cookies.txt $SERVICE_URL/api/credential | jq .
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

## Logout

```bash
curl -s -b cookies.txt -X POST $SERVICE_URL/api/logout
rm cookies.txt
```

## Complete Example

```bash
#!/bin/bash
set -e

# Configuration
NAME="my-agent"
SERVICE_URL="https://your-domain.example"

# 1. Get challenge
echo "Getting challenge..."
CHALLENGE=$(curl -s -c cookies.txt $SERVICE_URL/api/challenge | jq -r '.challenge')

# 2. Sign challenge with your keymaster (implement this)
echo "Sign this challenge with your keymaster: $CHALLENGE"
read -p "Enter response DID: " RESPONSE

# 3. Login
echo "Logging in..."
curl -s -b cookies.txt -c cookies.txt \
  -X POST $SERVICE_URL/api/login \
  -H "Content-Type: application/json" \
  -d "{\"response\":\"$RESPONSE\"}"

# 4. Get DID
DID=$(curl -s -b cookies.txt $SERVICE_URL/api/check-auth | jq -r '.userDID')
echo "Authenticated as: $DID"

# 5. Check name availability
AVAILABLE=$(curl -s $SERVICE_URL/api/name/$NAME/available | jq -r '.available')
if [ "$AVAILABLE" != "true" ]; then
  echo "Name '$NAME' is not available"
  exit 1
fi

# 6. Set name
echo "Setting name to @$NAME..."
curl -s -b cookies.txt \
  -X PUT "$SERVICE_URL/api/profile/$DID/name" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$NAME\"}"

# 7. Request credential
echo "Requesting credential..."
curl -s -b cookies.txt -X POST $SERVICE_URL/api/credential/request | jq .

echo "Done! You are now @$NAME"

# Cleanup
rm cookies.txt
```

## API Reference

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/config` | GET | No | Get service config (name, URL) |
| `/api/challenge` | GET | No | Get login challenge |
| `/api/login` | POST | No | Submit challenge response |
| `/api/logout` | POST | Yes | End session |
| `/api/check-auth` | GET | Yes | Check auth status |
| `/api/profile/:did` | GET | Yes | Get user profile |
| `/api/profile/:did/name` | PUT | Yes | Set your name |
| `/api/name/:name` | GET | No | Resolve name to DID |
| `/api/name/:name/available` | GET | No | Check availability |
| `/api/credential` | GET | Yes | Get your credential |
| `/api/credential/request` | POST | Yes | Request/update credential |
| `/api/registry` | GET | No | Full name registry |
| `/member/:name` | GET | No | Member DID document |

---

Built on Archon Protocol
