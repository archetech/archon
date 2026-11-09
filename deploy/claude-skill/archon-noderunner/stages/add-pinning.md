# Stage: `add-pinning`

Enable the pinning-mediator so this node can pin content-addressed blobs to IPFS.

The mediator speaks the standard IPFS Pinning Service API, so any compatible provider works; `docs/deployment.md` §8 gives Filebase and Pinata settings. This stage uses **Pinata**.

## Procedure

1. **🛑 Human checkpoint — Pinata JWT.** Ask the operator to:
   - Sign up at pinata.cloud (free tier is fine for small nodes)
   - Create an API key with pinning permissions
   - Paste the JWT

2. **Splice** into `.env`:
   ```
   ARCHON_PIN_PROVIDER=pinata
   ARCHON_PIN_API_URL=https://api.pinata.cloud/psa
   ARCHON_PIN_API_TOKEN={{jwt}}
   ```
   Append `pinning` to `COMPOSE_PROFILES`. Set `ARCHON_GATEKEEPER_REGISTRIES_PIN` to the chain registries whose operations should be pinned, e.g. `BTC:mainnet` (comma-separated, dedup); with it empty, nothing is queued for pinning.

3. **Bring up** the pinning-mediator. Wait for readiness.

4. **Verify** — trigger a small test pin (e.g. update a test DID's `#service` property), watch `pin queue` in redis drop back to 0, confirm the CID resolves via a public IPFS gateway.

5. **Report** — provider in use, current queue depth, gateway URL for spot checks.

## Cost note

Pinata's free tier caps at ~1 GB / 1000 files. Warn the operator to monitor usage before enabling `add-pinning` on a high-traffic node.

## Rollback

`remove-pinning` — remove `ARCHON_PIN_API_TOKEN` from `.env`, tear down container. **Data already pinned to Pinata stays pinned** until unpinned via Pinata's dashboard.
