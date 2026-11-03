# Stage: `add-lightning`

Enable CLN + LNbits + lightning-mediator + drawbridge L402 authentication.

**Note on profiles:** upstream has split these into independent profiles, so `drawbridge` no longer implies the Lightning stack. This stage enables `drawbridge,lightning`, which brings up drawbridge, drawbridge-client, `lightning-mediator`, and the Lightning rail. It does **not** bring up Herald (`add-email` owns it). It brings up Tor only when the operator keeps CLN in its default `tor` network mode, which needs the shared `tor` service (step 3). Stage 0 deliberately does not enable drawbridge, so this stage is still the first place the front-door proxy comes online.

Because Drawbridge derives its capabilities from the `ARCHON_*_URL` values rather than the profiles, `ARCHON_LIGHTNING_MEDIATOR_URL` must be set in the same step as the profile — enabling one without the other yields connection errors instead of a clean 501.

Once this stage completes:
- Caddy's `/api/*` and `/1.0/*` handlers switch from `localhost:4224` (gatekeeper direct) to `localhost:4222` (drawbridge → gatekeeper). Public API calls now go through drawbridge's L402 auth layer.
- `/invoice/*` is added at `localhost:4222` for Lightning invoice endpoints.
- If `add-didcomm` already ran, its `@didcomm` handler switches from the relay's direct port to drawbridge: drop `uri strip_prefix /didcomm` and change `reverse_proxy localhost:4236` to `localhost:4222`, since drawbridge strips the prefix itself. Keep the `@didcomm path /didcomm /didcomm/*` matcher.

In `clearnet` mode the stage does not enable the `tor` profile: there is no Tor SOCKS listener on `127.0.0.1:9050` and no onion hostname at `data/tor-drawbridge/drawbridge/hostname`, so do not probe for either. In `tor` mode both exist, and CLN's onion key is in `data/cln-mainnet/tor/cln-service`.

## Prereqs

- `BTC:mainnet` registry MUST already be enabled (`add-registry BTC:mainnet` first). CLN needs a bitcoind backing source. If BTC isn't enabled, refuse and instruct the operator to add it first.

## Procedure

1. **Announce.** Show which services will start (cln, lnbits, lightning-mediator), which `.env` keys will be added, and which drawbridge routes (`/invoice/*`, L402-guarded prefixes) will come online.

2. **Back up** `.env`.

3. **Prompt** the operator:
   - CLN alias (defaults to `ARCHON_NODE_NAME`)
   - CLN network mode:
     - `tor` (default): reachable only through its onion, all outbound through Tor. Needs the `tor` profile; without it CLN refuses to start.
     - `clearnet`: public inbound on port 9736. Needs the operator's public IP or domain, and the port opened in the host firewall.
   - LNbits admin credentials (auto-generate a strong random password, offer to store in `.env`)

4. **Splice** config into `.env`:
   ```
   ARCHON_LIGHTNING_MEDIATOR_URL=http://lightning-mediator:4235
   ARCHON_LIGHTNING_MEDIATOR_CLN_REST_URL=https://cln:3001
   ARCHON_LIGHTNING_MEDIATOR_LNBITS_URL=http://lnbits:5000
   ARCHON_LIGHTNING_MEDIATOR_LNBITS_ADMIN_KEY={{generated}}
   ```
   Then, by network mode:
   - `tor`: append `drawbridge,lightning,tor` to `COMPOSE_PROFILES`. Leave `ARCHON_CLN_P2P_BIND` unset; CLN refuses to start in `tor` mode with the P2P port published beyond loopback.
   - `clearnet`: append `drawbridge,lightning`, and splice
     ```
     ARCHON_CLN_NETWORK_MODE=clearnet
     ARCHON_CLN_P2P_BIND=0.0.0.0
     ARCHON_CLN_ANNOUNCE_ADDR={{public ip or domain}}:9736
     # Explicitly empty: the tor profile is off. The compose default is
     # `${ARCHON_LIGHTNING_MEDIATOR_TOR_PROXY-tor:9050}` (single dash), so leaving
     # the key UNSET still resolves to tor:9050 and the mediator would dial a
     # container that isn't running. Only an explicit empty value disables it.
     ARCHON_LIGHTNING_MEDIATOR_TOR_PROXY=
     ```

   Append idempotently: `drawbridge` or `tor` may already be present.

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
