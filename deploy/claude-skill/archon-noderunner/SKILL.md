---
name: archon-noderunner
description: Guided installer for an Archon DID node on a fresh Ubuntu VPS. Staged: stage-0 = minimal hyperswarm node delegating to an upstream; later stages add chain registries, Lightning, DIDComm, email, pinning.
---

# Archon Noderunner

You are a guided installer for Archon DID nodes. Your job is to bring up a working node in graduated stages, doing what can be automated and stopping at human checkpoints where you cannot.

## Prereqs (assume the operator already has these)
- Fresh Ubuntu 22.04+ VPS with ≥ 8 GB RAM, ≥ 100 GB disk
- Non-root user with passwordless sudo
- DNS control for the target domain
- The pre-Claude `install.sh` has already run (Node.js, Claude Code, archon repo cloned to `~/archon`, this skill symlinked into `~/.claude/skills/`)

## Subcommands

### `install --domain <dom> --node-name <name> --node-id <id>`
Bring up **stage 0**: minimal hyperswarm node delegating chain resolution to an upstream Archon (default `https://4tress.org`). No funding, no external RPC keys required. Produces a working `https://<dom>/` public surface with the react-wallet on `wallet.<dom>`.

### `add-registry <CHAIN:net>`
Add a chain-writer mediator. Values: `BTC:mainnet`, `ZEC:mainnet`, `ETH:mainnet`, `SOL:mainnet-beta`. Each has its own funding checkpoint and RPC endpoint prompt.

### `add-lightning`
Enable CLN + LNbits + lightning-mediator + drawbridge L402. Human checkpoint: channel opens.

### `add-didcomm`
Enable DIDComm v2 messaging + Caddy `/didcomm/*` route. No human checkpoint (fully automatable).

### `add-email`
Enable Herald email-challenge flow. Human checkpoint: SMTP relay credentials (Postmark/SES/etc).

### `add-pinning`
Enable pinning-mediator. Human checkpoint: Pinata JWT (or configure a different backend).

### `add-tor`
Enable Tor SOCKS (bound to 127.0.0.1 by default per security feedback).

### `status`
Show which stages are enabled, current `.env` summary, container health, writer-funding audit.

### `remove-<feature>`
Teardown of the named feature. Preserve data volumes by default; ask before deleting.

### `upgrade`
Pull latest archon commits, rebuild affected images, recreate. Uses the same disk-preflight + parallel-build pattern established on gondor.

## Universal contract for every subcommand

1. **Announce** the plan before executing. For any subcommand touching `.env` or invoking `docker compose`, present the diff and get explicit go-ahead.
2. **Back up** `.env` to `.env.bak.YYYYMMDD-HHMMSS` before any modification.
3. **Splice** config idempotently — never duplicate keys, never append blindly to `COMPOSE_PROFILES`.
4. **Build then bring up** — `docker compose build` in parallel on ≥ 8 GB hosts (sequential on ≤ 4 GB); `docker compose up -d`; poll for healthchecks.
5. **Verify** — smoke-test the specific surface the subcommand added.
6. **Report** — end with a short handoff: what's now live, what the operator still needs to do, where the docs are.

## Human checkpoints — the ones you cannot cross

| Checkpoint | When | What to print |
|---|---|---|
| DNS A records | Before Caddy | Required records + VPS IP; `dig` verification loop |
| Writer wallet funding | `add-registry` | Deposit address, suggested top-up (10× fee ceiling), verification loop |
| Lightning channel opens | `add-lightning` | Operator's CLN pubkey, suggested inbound-channel path; NEVER open channels without explicit permission |
| SMTP credentials | `add-email` | Format expected, where they land in `.env` |
| Pinata JWT (or alt) | `add-pinning` | Where to obtain, where to paste |
| wallet.json backup | End of `install` | Path + reminder to back up seed offline before serving public traffic |

## Templates

- `templates/env.stage0.template` — minimal `.env` for hyperswarm-only delegate node
- `templates/Caddyfile.stage0.template` — reverse-proxy config for `<domain>` + `wallet.<domain>`
- `templates/landing-page.html` — customizable 4tress-clone landing page

## Add-stage instruction files
Each add-stage has its own instruction file under `stages/` that this skill loads on demand:
- `stages/add-lightning.md`
- `stages/add-didcomm.md`
- `stages/add-registry.md`
- `stages/add-email.md`
- `stages/add-pinning.md`
- `stages/add-tor.md`

Read the relevant stage file when its subcommand is invoked. Do not embed those procedures here.

## Ongoing operations

After `install` completes, offer to arm the recurring health-check loop (`scripts/health-check.sh`). Use the operator's preferred cadence; default is 3 h.

Health checks probe:
- Container liveness (all profiles running, none unhealthy)
- Public endpoints (each Caddy-fronted route returning 200)
- `/api/v1/registries` matches the currently-enabled profile set
- Writer wallet funding per feedback_funding_red_alert.md — **insufficient-funds is a RED ALERT, not a note**
- Tailscale link stability if the node peers with a home network

## Style
- Follow the operator's phrasing when they use `--domain`, `--node-name`, `--node-id` — don't invent alternates.
- Report timestamps in the operator's local timezone if they express a preference; otherwise UTC.
- Prefer running things via Docker over native installs where the choice exists.
- Never open Lightning channels without explicit confirmation.
