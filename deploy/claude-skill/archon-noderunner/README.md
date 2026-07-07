# Archon Noderunner

A Claude Code skill for provisioning an Archon DID node on a fresh Ubuntu VPS in graduated stages.

## Install (on a fresh VPS)

```
curl -fsSL https://4tress.org/install.sh | bash
```

The canonical source lives in this repo at [`deploy/install.sh`](../install.sh); `https://4tress.org/install.sh` mirrors it for the pre-Claude bootstrap URL. The script installs Node.js, Claude Code, clones this repo, and symlinks the skill into `~/.claude/skills/`. Then:

```
claude                                              # auth via URL
/archon-noderunner install --domain example.org --node-name Node1 --node-id Op1
```

## Stages

Stage 0 (`install`) brings up a **minimal delegated node** (7 containers): hyperswarm mediator + react-wallet + core (gatekeeper, keymaster, redis, mongodb, ipfs). Caddy proxies public traffic directly to gatekeeper on port 4224. No chain writers, no Lightning, no drawbridge/L402, no Tor, no admin SPAs. Chain-anchored DID resolution is delegated to an upstream Archon (defaults to `https://4tress.org`). This node participates in the mesh and can host DIDs but doesn't anchor them itself.

Later stages, added one at a time:

| Stage | Adds |
|---|---|
| `add-registry BTC:mainnet` | Bitcoin mainnet anchor writer |
| `add-registry ZEC:mainnet` | Zcash mainnet anchor writer |
| `add-registry ETH:mainnet` | Ethereum mainnet anchor writer |
| `add-registry SOL:mainnet-beta` | Solana mainnet anchor writer |
| `add-lightning` | CLN + LNbits + Lightning-mediator + drawbridge + Herald + Tor SOCKS (drawbridge profile shares services with lightning) |
| `add-didcomm` | DIDComm v2 messaging |
| `add-email` | Herald email-challenge flow (needs SMTP) |
| `add-pinning` | IPFS pinning-mediator (needs Pinata JWT or alt backend) |
| `add-observability` | Prometheus + Grafana (Tailscale-only exposure) |

Drawbridge, Herald, and Tor SOCKS ride along with `add-lightning` — the `drawbridge` compose profile shares service declarations with `lightning`, so enabling one enables the other. If you don't want Lightning, you don't get drawbridge/L402/onion either. Stage 0 without add-lightning is Caddy-direct-to-gatekeeper.

Each add-stage has its own human checkpoints (funding, credentials, channel opens). The skill will not cross them without explicit confirmation.

## Prereqs the operator brings

- Ubuntu 22.04+ VPS, ≥ 8 GB RAM, ≥ 100 GB disk
- Non-root sudo user (passwordless)
- Registered domain with DNS control
- Anthropic account for Claude Code login
- Per added stage: RPC keys, funding, SMTP creds, etc.

## Layout

```
archon-noderunner/
├── SKILL.md                     — skill instructions (what Claude reads)
├── README.md                    — this file (for humans)
├── templates/
│   ├── env.stage0.template
│   ├── Caddyfile.stage0.template
│   └── landing-page.html
├── scripts/
│   ├── bootstrap-ubuntu.sh      — installs docker + caddy (invoked by skill)
│   ├── verify-dns.sh
│   ├── smoke-endpoints.sh
│   └── health-check.sh          — the recurring probe
└── stages/
    ├── add-registry.md
    ├── add-lightning.md
    ├── add-didcomm.md
    ├── add-email.md
    ├── add-pinning.md
    └── add-observability.md
```

## Status

This skill is scaffolded but not yet field-tested end-to-end. Stage 0 and `add-lightning` are the first two paths targeted for validation on a scratch DigitalOcean droplet.
