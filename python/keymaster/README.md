# Python Keymaster Library

Reusable Python implementation of the Archon Keymaster business logic.

This package is intended to hold the core wallet, DID, crypto, and asset
behaviors independent of any specific HTTP service runtime. It also exposes
the Python `keymaster` CLI, which mirrors the TypeScript Keymaster CLI command
surface while using this library in-process against a Gatekeeper HTTP endpoint
and local wallet file.

## Install

```bash
pip install archon-keymaster
```

For local development from a repo checkout:

```bash
pip install -e python/keymaster
```

## CLI usage

Configuration comes from the environment, or from a `.env` in the directory you
run from, as with the JS CLI. A variable already exported wins over the file.

```bash
cat > .env <<'ENV'
ARCHON_PASSPHRASE=your-passphrase
ARCHON_GATEKEEPER_URL=http://localhost:4224
ARCHON_WALLET_PATH=./wallet.json
ENV

keymaster --help
keymaster create-wallet
keymaster create-id alice
keymaster list-ids
```

## CLI environment variables

| Variable | Default | Description |
|---|---|---|
| `ARCHON_NODE_URL` / `ARCHON_GATEKEEPER_URL` | `http://localhost:4224` | Gatekeeper HTTP endpoint |
| `ARCHON_WALLET_PATH` | `~/.archon/wallet.json` (`wallet.db` for sqlite), or `./wallet.json` if one is already there | Path to wallet file. The default follows you between directories |
| `ARCHON_PASSPHRASE` | *(asked for)* | Wallet passphrase. For automation; the environment is a poor place for a secret |
| `ARCHON_PASSPHRASE_FILE` | `~/.archon/passphrase` | File holding the passphrase. Read if it exists, so answering the CLI's offer to save ends the asking |
| `ARCHON_DEFAULT_REGISTRY` | `hyperswarm` | Default registry for new DIDs |
