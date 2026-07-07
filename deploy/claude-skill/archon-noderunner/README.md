# Archon Noderunner

A Claude Code skill for provisioning an Archon DID node on a fresh Ubuntu VPS in graduated stages.

## Install (on a fresh VPS)

```
curl -fsSL https://4tress.org/install.sh | bash
```

The bootstrap script installs Node.js, Claude Code, clones this repo, and symlinks the skill into `~/.claude/skills/`. Then:

```
claude                                              # auth via URL
/archon-noderunner install --domain example.org --node-name Node1 --node-id Op1
```

## Stages

Stage 0 (`install`) brings up a **minimal delegated node**: hyperswarm mediator + gatekeeper + keymaster + react-wallet, no chain writers, no Lightning. Chain-anchored DID resolution is delegated to an upstream Archon (defaults to `https://4tress.org`). This node participates in the mesh and can host DIDs but doesn't anchor them itself.

Later stages, added one at a time:

| Stage | Adds |
|---|---|
| `add-registry BTC:mainnet` | Bitcoin mainnet anchor writer |
| `add-registry ZEC:mainnet` | Zcash mainnet anchor writer |
| `add-registry ETH:mainnet` | Ethereum mainnet anchor writer |
| `add-registry SOL:mainnet-beta` | Solana mainnet anchor writer |
| `add-lightning` | CLN + LNbits + Lightning-mediator + drawbridge L402 |
| `add-didcomm` | DIDComm v2 messaging |
| `add-email` | Herald email-challenge flow (needs SMTP) |
| `add-pinning` | IPFS pinning-mediator (needs Pinata JWT or alt backend) |

Tor SOCKS (127.0.0.1:9050) and drawbridge's onion hidden service ship as part of stage 0's `drawbridge` profile — no separate add-stage.

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
    └── add-pinning.md
```

## Status

This skill is scaffolded but not yet field-tested end-to-end. Stage 0 and `add-lightning` are the first two paths targeted for validation on a scratch DigitalOcean droplet.
