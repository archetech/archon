# Stage: `add-didcomm`

Enable DIDComm v2 messaging + mailbox relay + Caddy public route.

No human checkpoint required — this is the smoothest add-stage. Free to run without further prompts.

## Procedure

1. **Splice** into `.env`:
   ```
   ARCHON_DIDCOMM_URL=http://didcomm:4236
   ARCHON_DIDCOMM_PORT=4236
   ARCHON_DIDCOMM_HOST_BIND=127.0.0.1
   ARCHON_DIDCOMM_DB=redis
   ```
   Append `didcomm` to `COMPOSE_PROFILES`.

2. **Caddy** — append handler inside the `{{DOMAIN}}` block. The published endpoint is the bare `https://<domain>/didcomm`, and senders POST to it exactly as published, so the matcher must cover `/didcomm` itself as well as the paths under it. `handle /didcomm/*` does not match `/didcomm`, and every delivery to the node then fails with 404.

   - **If drawbridge is enabled** (post-add-lightning): drawbridge strips the `/didcomm` prefix itself.
     ```
     @didcomm path /didcomm /didcomm/*
     handle @didcomm {
         reverse_proxy localhost:4222
     }
     ```
   - **If not** (stage 0 only, no lightning yet): the didcomm container serves `/`, `/health` and `/api/v1/*` on its direct port, so Caddy strips the prefix.
     ```
     @didcomm path /didcomm /didcomm/*
     handle @didcomm {
         uri strip_prefix /didcomm
         reverse_proxy localhost:4236
     }
     ```
   Back up the Caddyfile as `Caddyfile.bak-pre-didcomm-<timestamp>`. Reload with `sudo systemctl reload caddy`.

   If the operator later runs `add-lightning`, that stage switches this route to the drawbridge form above.

3. **Bring up** the didcomm container. Wait for `GET /didcomm/health` → 200, and confirm the published endpoint itself reaches the relay: `curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/didcomm-encrypted+json' --data '{}' https://$DOMAIN/didcomm` must print `400` (the relay rejecting an empty message), not `404`.

4. **Verify** — service endpoint should appear in DID resolution:
   ```
   curl https://$DOMAIN/1.0/identifiers/<local-DID> | jq '.didDocument.service[]|select(.type=="DIDCommMessaging")'
   ```
   Should return a service entry with `serviceEndpoint: https://<domain>/didcomm`.

5. **Report** — endpoint URL, how to send a test message (`keymaster send-didcomm <recipient-DID> "<text>"`), where mailbox state lives.

## Related bug history

Two upstream bugs from prior sessions worth being aware of:
- `#639` / `#640` (fixed): drawbridge advertised its onion address instead of the public domain. Fixed upstream in `1fb32722`.
- Capability manifest simplification: `/api/v1/capabilities` in newer versions returns `{didcomm, lightning, names}` flags — no longer the verbose nodeName/nodeVersion/registries payload. Registry list moved to `/api/v1/registries`.

Both are already handled in the mainline archon this skill installs.
