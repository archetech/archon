# Stage: `add-observability`

Enable Prometheus + Grafana for metrics collection and dashboards.

Two containers only, no funding, no external credentials. But per operator preference, admin UIs go on **Tailscale only** — never publish Grafana or Prometheus on the public Caddyfile.

## Procedure

1. **Splice** into `.env`:
   ```
   ARCHON_GRAFANA_ADMIN_PASSWORD={{generated-strong-password}}
   ```
   Append `observability` to `COMPOSE_PROFILES`.

2. **Bring up** — `docker compose up -d prometheus grafana`. Wait for both healthchecks to pass.

3. **🛑 Tailscale-only exposure checkpoint.** Confirm the operator has Tailscale installed and the node is joined to their tailnet. If not, offer to install (via the official `curl -fsSL https://tailscale.com/install.sh | sh`) or defer this stage until Tailscale is up.

4. **Reverse-proxy on Tailscale IP only.** Do NOT add public Caddy handles. Options:
   - **A. Tailscale Serve** — `tailscale serve https / http://localhost:3000` binds Grafana to the node's Tailscale HTTPS hostname; only tailnet members reach it.
   - **B. Local caddy on the Tailscale interface** — bind an internal Caddyfile block to the Tailscale IP explicitly. More config, more control.

5. **Verify not-public.** From outside the tailnet, `curl -k https://<domain>:3000` and `curl -k https://<domain>:9090` should both fail. Only from a tailnet peer should Grafana / Prometheus resolve.

6. **Prometheus targets.** Archon mediators expose `/metrics` on their internal container ports. Prometheus's default scrape config discovers them via docker labels. Verify by hitting `http://prometheus:9090/targets` (from a tailnet peer) — should show gatekeeper, keymaster, and any enabled mediators as UP.

7. **Grafana bootstrap.** Log in with `admin` + the generated password. Add Prometheus as a data source (`http://prometheus:9090`). Load starter dashboards if present at `deploy/observability/grafana-dashboards/` (not yet shipped; deferred to a follow-up).

8. **Report** — Grafana URL (Tailscale hostname), admin credentials, list of prometheus targets currently UP.

## Rollback

`remove-observability` — tears down both containers, removes profile + Grafana admin password from `.env`. **Preserves the Prometheus TSDB volume** by default so historical metrics survive re-enable; ask before deleting.
