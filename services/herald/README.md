# Name Service

### Overview
A decentralized naming service built on Archon Protocol. Users can claim `@name` handles, prove DID ownership, and receive verifiable credentials.

This repository is split into two main folders:

- **client/** – A React front-end
- **server/** – An Express/Node back-end

### Features

- **Decentralized Identity** – Login with your DID using challenge-response authentication
- **Name Registration** – Claim your `@name` handle (3-32 characters, alphanumeric + hyphens/underscores)
- **Verifiable Credentials** – Receive credentials proving your name ownership
- **Member Directory** – Browse registered members and view their DID documents
- **IPNS Publication** – Registry published to IPFS for decentralized resolution
- **OAuth/OIDC** – Third-party app integration via standard OAuth 2.0 flows

### Quick Start

1. **Configure** – Copy `server/sample.env` to `server/.env` and set:
   - `ARCHON_HERALD_NAME` – Unique name for this deployment (used for DID identity)
   - `ARCHON_DRAWBRIDGE_PUBLIC_HOST` – The canonical Drawbridge URL (e.g. `https://your-domain.example`)
   - `ARCHON_HERALD_SESSION_SECRET` – A random secret string for sessions

2. **Install** dependencies:
   - `npm run install`

3. **Run** both client and server:
   - `npm start`

4. **Visit** the site at `http://localhost:4230`

### QR Code Authentication

The QR code encodes a URL that includes the challenge DID as a query parameter:

`https://wallet.archon.technology?challenge=did:cid:...`

The wallet URL is specified in the environment variable `ARCHON_HERALD_WALLET_URL`.

The API offers two ways to submit a response to the challenge, GET and POST.

The GET method uses a query parameter for the `response`:

```
curl https://your-domain.example/api/login?response=did:cid:...
```

The POST method takes the same parameter in the body:

```
curl -X POST -H "Content-Type: application/json" -d '{"response":"did:cid:..."}' https://your-domain.example/api/login
```

Both login methods return a JSON object indicating whether the login was successful:
```
{ authenticated: [ true | false ] }
```

### Environment Variables

See `server/sample.env` for all available settings including:
- `ARCHON_HERALD_NAME` – Service identity name (used for DID owner identity)
- `ARCHON_DRAWBRIDGE_PUBLIC_HOST` – Canonical Drawbridge URL; Herald derives its public URL as `${ARCHON_DRAWBRIDGE_PUBLIC_HOST}/names`
- `ARCHON_HERALD_SESSION_SECRET` – Session secret (change from default!)
- `ARCHON_HERALD_WALLET_URL` – Wallet URL for QR codes
- `ARCHON_GATEKEEPER_URL` – Gatekeeper API endpoint
- `ARCHON_HERALD_IPFS_API_URL` – IPFS API for registry publication
- `ARCHON_HERALD_IPNS_KEY_NAME` – IPNS key for publishing

### Docker

```
docker compose up --build
```

Configure via environment variables or a `.env` file in the project root.

### Nginx

See `nginx/name-service.conf.template` for a sample nginx reverse proxy config. Use `envsubst` to fill in your domain:

```
export DOMAIN=your-domain.example
envsubst '${DOMAIN}' < nginx/name-service.conf.template > /etc/nginx/sites-available/name-service.conf
```

### License
MIT
