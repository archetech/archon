# Stage: `add-tor`

Enable a local Tor SOCKS proxy for outbound clearnet privacy (used by mediators reaching public RPCs, gossip peers, mempool oracles).

## Security note

Per gondor incident history: **bind Tor SOCKS to 127.0.0.1**, never `0.0.0.0`. A publicly exposed Tor SOCKS is an open proxy — will be abused within hours (documented in archon issue #589, fixed upstream as #590 `be1dc357`).

The template splices this default; do not override it without explicit operator direction.

## Procedure

1. **Splice** into `.env`:
   ```
   ARCHON_TOR_SOCKS_PORT=127.0.0.1:9050
   ```
   Append `tor` to `COMPOSE_PROFILES`.

2. **Bring up** the tor container. Wait ~30s for circuit bootstrap.

3. **Verify** local binding: `docker port archon-tor-1` should show `9050/tcp -> 127.0.0.1:9050`. If it shows `0.0.0.0:9050`, refuse to proceed and print instructions to fix.

4. **Verify** functional: `docker exec archon-tor-1 curl --socks5 127.0.0.1:9050 https://check.torproject.org/api/ip` should return a Tor exit IP.

5. **Report** — exit IP observed, mediators now capable of clearnet-via-Tor egress.

## Rollback

`remove-tor` — remove profile, `.env` line, tear down container.
