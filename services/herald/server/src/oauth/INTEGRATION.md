# OAuth Integration Guide

> Replace `https://your-domain.example` below with your actual deployment URL.

## Add to index.ts

### 1. Import the OAuth module

At the top of `index.ts`, add:

```typescript
import { createOAuthRoutes } from './oauth/index.js';
```

### 2. Create helper function to get member by DID

```typescript
async function getMemberByDID(did: string): Promise<any> {
    const currentDb = db.loadDb();
    if (currentDb.users && currentDb.users[did]) {
        return {
            ...currentDb.users[did],
            did,
            handle: currentDb.users[did].name
        };
    }
    return null;
}
```

### 3. Mount the OAuth routes

After setting up other routes (after the CORS setup), add:

```typescript
// OAuth routes
const oauthRouter = createOAuthRoutes(keymaster, getMemberByDID);
app.use('/oauth', oauthRouter);

// OIDC discovery (must be at root)
app.get('/.well-known/openid-configuration', (req, res) => {
    const issuer = process.env.ARCHON_HERALD_PUBLIC_URL || `http://localhost:${process.env.ARCHON_HERALD_PORT || 3300}`;
    res.json({
        issuer,
        authorization_endpoint: `${issuer}/oauth/authorize`,
        token_endpoint: `${issuer}/oauth/token`,
        userinfo_endpoint: `${issuer}/oauth/userinfo`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['none'],
        scopes_supported: ['openid', 'profile'],
        claims_supported: ['sub', 'name', 'preferred_username', 'picture']
    });
});
```

## Test the OAuth flow

### 1. Get authorization challenge

```bash
curl "https://your-domain.example/oauth/authorize?client_id=demo-client&redirect_uri=http://localhost:4000/callback&response_type=code&scope=openid%20profile&state=xyz123"
```

### 2. User responds with wallet

```bash
keymaster create-response <challenge-did>
```

### 3. Wallet posts response

```bash
curl -X POST https://your-domain.example/oauth/callback \
  -H "Content-Type: application/json" \
  -d '{"response": "did:cid:..."}'
```

### 4. Exchange code for token

```bash
curl -X POST https://your-domain.example/oauth/token \
  -H "Content-Type: application/json" \
  -d '{
    "grant_type": "authorization_code",
    "code": "<auth-code>",
    "redirect_uri": "http://localhost:4000/callback",
    "client_id": "demo-client",
    "client_secret": "demo-secret"
  }'
```

### 5. Get user info

```bash
curl https://your-domain.example/oauth/userinfo \
  -H "Authorization: Bearer <access-token>"
```

## Registered Demo Client

```json
{
  "client_id": "demo-client",
  "client_secret": "demo-secret",
  "name": "Demo Application",
  "redirect_uris": [
    "http://localhost:3001/callback",
    "http://localhost:4000/callback"
  ]
}
```
