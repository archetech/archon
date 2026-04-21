# keymaster-cli

Python port of `packages/keymaster/src/cli.ts`. Exposes a `keymaster`
command that runs the Keymaster library in-process against a gatekeeper
HTTP endpoint and a local wallet file — same architecture as the
TypeScript CLI.

## Install

```bash
pip install -e python/keymaster        # archon-keymaster library
pip install -e python/keymaster_service  # wallet store + gatekeeper client
pip install -e python/keymaster_cli
```

## Usage

```bash
export ARCHON_PASSPHRASE=your-passphrase
export ARCHON_GATEKEEPER_URL=http://localhost:4224
export ARCHON_WALLET_PATH=./wallet.json

keymaster --help
keymaster create-wallet
keymaster create-id alice
keymaster list-ids
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `ARCHON_NODE_URL` / `ARCHON_GATEKEEPER_URL` | `http://localhost:4224` | Gatekeeper HTTP endpoint |
| `ARCHON_WALLET_PATH` | `./wallet.json` | Path to wallet file |
| `ARCHON_PASSPHRASE` | *(required)* | Wallet passphrase |
| `ARCHON_DEFAULT_REGISTRY` | `hyperswarm` | Default registry for new DIDs |
