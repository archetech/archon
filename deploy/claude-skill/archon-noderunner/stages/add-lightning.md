# Stage: `add-lightning`

Enable CLN + LNbits + lightning-mediator + drawbridge L402 authentication.

**Note on profile coupling:** the `drawbridge` compose profile shares service declarations with `lightning` in upstream archon (`profiles: ['lightning', 'drawbridge']`). This stage enables BOTH profiles, which is why it also brings up Herald, drawbridge, drawbridge-client, and the Tor SOCKS daemon in addition to the Lightning-proper services. Stage 0 deliberately does not enable drawbridge, so this stage is the first place any of those come online.

Once this stage completes:
- Caddy's `/api/*` and `/1.0/*` handlers switch from `localhost:4224` (gatekeeper direct) to `localhost:4222` (drawbridge → gatekeeper). Public API calls now go through drawbridge's L402 auth layer.
- `/invoice/*` is added at `localhost:4222` for Lightning invoice endpoints.
- Tor SOCKS becomes available at `127.0.0.1:9050` for mediator outbound.
- Drawbridge publishes an onion hostname at `data/tor-drawbridge/drawbridge/hostname`.

## Prereqs

- `BTC:mainnet` registry MUST already be enabled (`add-registry BTC:mainnet` first). CLN needs a bitcoind backing source. If BTC isn't enabled, refuse and instruct the operator to add it first.

## Procedure

1. **Announce.** Show which services will start (cln, lnbits, lightning-mediator), which `.env` keys will be added, and which drawbridge routes (`/invoice/*`, L402-guarded prefixes) will come online.

2. **Back up** `.env`.

3. **Prompt** the operator:
   - CLN alias (defaults to `ARCHON_NODE_NAME`)
   - Whether to enable public inbound connections (default: yes, opens port 9735)
   - LNbits admin credentials (auto-generate a strong random password, offer to store in `.env`)

4. **Splice** config into `.env`:
   ```
   ARCHON_LIGHTNING_MEDIATOR_URL=http://lightning-mediator:4235
   ARCHON_LIGHTNING_MEDIATOR_CLN_REST_URL=https://cln:3001
   ARCHON_LIGHTNING_MEDIATOR_LNBITS_URL=http://lnbits:5000
   ARCHON_LIGHTNING_MEDIATOR_LNBITS_ADMIN_KEY={{generated}}
   ```
   Append `lightning` to `COMPOSE_PROFILES`.

5. **Build & bring up** — CLN takes 5-15 minutes on first start (chain sync from bitcoind). Show live progress. Wait for CLN `getinfo` to return warmly.

6. **Verify LNbits reachable** on internal port; smoke `/invoice/` route via Caddy.

7. **🛑 Human checkpoint — channel opens.** This is the hard one.

   Per the durable feedback rule: **NEVER open Lightning channels without explicit permission**. Do not run `fundchannel` or `connect` without a specific operator directive naming the peer pubkey and channel size.

   Instead, print:
   - Operator's CLN public key (`getinfo` output)
   - Public IP + port 9735
   - Suggested inbound options: request a channel from a routing node (Amboss, LN+, LNBIG), or ask the operator to arrange it out-of-band
   - Command they can run manually to open outbound: `docker exec archon-cln-mainnet-node-1 lightning-cli --lightning-dir=/data/lightning/bitcoin --network=bitcoin fundchannel <pubkey> <amount>` — **but do not run it**

   Wait for the operator to confirm at least one active channel exists (`num_active_channels: ≥1`), then proceed.

8. **Verify end-to-end.** Ask the operator for a test lnurl or invoice; pay it via `keymaster lightning-send` and confirm settlement.

9. **Report** — CLN pubkey, channel count, LNbits admin URL (Tailscale-only if user prefers admin on private overlay per their preferences memory), current archon LN wallet balance.

## Common failures

- **CLN stuck on chain sync**: usually bitcoind isn't caught up. Point them at BTC mediator status.
- **LNbits 500 on first hit**: race between LNbits startup and CLN readiness. `docker restart archon-lnbits-1` after CLN is fully up.
- **L402 challenges failing**: check that drawbridge sees LNBits admin key; missing key silently 401s.

## Rollback

`remove-lightning` — tears down CLN/LNbits/lightning-mediator containers, restores pre-add `.env`. **Preserves channel state** (`data/lightning/`) by default so channels can be recovered on a future re-enable. Ask before deleting channel state.
