# Stage: `add-pinning`

Enable the pinning-mediator so this node can pin content-addressed blobs to IPFS.

Current supported backends: **Pinata** (default). Others (Web3.Storage, self-hosted IPFS cluster) require code paths that may or may not exist upstream — check `services/mediators/pinning/` before offering.

## Procedure

1. **🛑 Human checkpoint — Pinata JWT.** Ask the operator to:
   - Sign up at pinata.cloud (free tier is fine for small nodes)
   - Create an API key with pinning permissions
   - Paste the JWT

2. **Splice** into `.env`:
   ```
   ARCHON_PIN_PROVIDER=pinata
   ARCHON_PIN_API_URL=https://api.pinata.cloud
   ARCHON_PIN_JWT={{jwt}}
   ```
   Append `pinning` to `COMPOSE_PROFILES`. Add `pin` to `ARCHON_GATEKEEPER_REGISTRIES_PIN` (existing chain-registry pins remain).

3. **Bring up** the pinning-mediator. Wait for readiness.

4. **Verify** — trigger a small test pin (e.g. update a test DID's `#service` property), watch `pin queue` in redis drop back to 0, confirm the CID resolves via a public IPFS gateway.

5. **Report** — provider in use, current queue depth, gateway URL for spot checks.

## Cost note

Pinata's free tier caps at ~1 GB / 1000 files. Warn the operator to monitor usage before enabling `add-pinning` on a high-traffic node.

## Rollback

`remove-pinning` — remove JWT from `.env`, tear down container. **Data already pinned to Pinata stays pinned** until unpinned via Pinata's dashboard.
