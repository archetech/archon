# Name Service – Server (Express)

### Overview
This folder contains the Express server for the name service, providing DID-based authentication using Keymaster and Gatekeeper. It exposes `/api` routes for login, profile management, name registration, and credential issuance.

### Setup

1. **Install dependencies**:
    - `npm install`

2. **.env configuration**
    - `ARCHON_HERALD_PORT=4230`
    - `ARCHON_HERALD_SESSION_SECRET=<random secret>` (required)
    - Additional variables like `ARCHON_KEYMASTER_URL`, `ARCHON_GATEKEEPER_URL`, `ARCHON_HERALD_WALLET_URL` for Keymaster/Gatekeeper integration.

3. **Run**:
    - `npm start`
      Starts the server at `http://localhost:4230`.

### CORS and Sessions
- This server uses `express-session` for session-based logins. Make sure to keep `credentials: true` if you want cross-origin cookies from your React dev server.
- `ARCHON_HERALD_SESSION_SECRET` is required and must not be left on a placeholder value.

### API Endpoints

**Authentication**
- `/api/challenge` – Creates a DID challenge for the user to scan or respond to.
- `/api/login` – Receives a DID response and logs the user in.
- `/api/check-auth` – Checks if the user is logged in.
- `/api/logout` – Logs the user out.

**Stateless Agent API (Bearer token auth)**
- `PUT /api/name` – Claim or update name (credential auto-issued).
- `DELETE /api/name` – Delete name and revoke credential.

**Profile & Names (session auth)**
- `/api/profile/:did` – Get user profile.
- `/api/profile/:did/name` – Get/set user's name.
- `/api/name/:name` – Resolve a name to DID.

**Credentials**
- `/api/credential` – Get user's credential status.
- Credentials are automatically issued/updated when a name is set.

**Registry**
- `/api/registry` – Get full name→DID registry.
- `/api/member/:name` – Get member's DID document by name.
- `/directory.json` – Public registry JSON.

**Lightning Address (LUD16)**
- `/.well-known/lnurlp/:name` – LUD16 discovery (resolves name → DID → Lightning endpoint).
- `/api/lnurlp/:name/callback` – Invoice callback (proxies to user's Lightning service).

**Admin (owner only)**
- `/api/admin` – Get full database.
- `/api/admin/publish` – Publish registry to IPNS.
