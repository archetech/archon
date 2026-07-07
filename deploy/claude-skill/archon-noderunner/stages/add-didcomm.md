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

2. **Caddy** — append handler inside the `{{DOMAIN}}` block:
   ```
   handle /didcomm/* {
       reverse_proxy localhost:4222
   }
   ```
   Back up the Caddyfile as `Caddyfile.bak-pre-didcomm-<timestamp>`. Reload with `sudo systemctl reload caddy`.

3. **Bring up** the didcomm container. Wait for `GET /didcomm/health` → 200.

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
