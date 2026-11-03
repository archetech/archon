# Plan: replace the cl-hive image with plain Core Lightning (#1509)

## Problem

The `lightning` profile runs Core Lightning v25.12.1 inside
`ghcr.io/lightning-goats/cl-hive-node:3.4.0`. That project was sunset on
2026-07-16 and will publish no further images or security patches. Upstream CLN
is at v26.06.9; the releases since v25.12.1 include fixes for unauthenticated
`clnrest` crashes (oversized bodies, nested XML, YAML aliases), and our
`clnrest` listens on `0.0.0.0:3001` inside the Docker network.

## Decisions

- **Plain CLN.** The node runs CLN with its built-in plugins only. The
  cl-hive image also runs cl-hive/cl-mycelium, cl-revenue-ops (automatic fees
  and rebalancing, live by default), boltzd and vitality. Archon uses none of
  them, so they are removed. Operators who want automatic fee management add it
  themselves.
- **The upgrade changes the image, not node policy.** Every CLN-core option
  the cl-hive entrypoint sets today keeps its current effective value (table
  below). The only behaviour removed is the plugins'.
- **Existing nodes keep their identity, channels and onion address.** The
  data layout, wallet database path and Tor hidden-service key are reused in
  place; no data is moved.

## Facts the design depends on

Read from cl-hive v3.4.0 (`docker/docker-entrypoint.sh`, `supervisord.conf`)
and the official image `elementsproject/lightningd:v26.06.9`.

| | cl-hive v3.4.0 | official v26.06.9 |
|---|---|---|
| Base | Ubuntu 24.04, supervisord, everything as root | Debian bookworm-slim, `lightningd` as root |
| Lightning dir | `/data/lightning/<network>` (`bitcoin` for mainnet) | `$LIGHTNINGD_DATA`, default `/root/.lightning` |
| Network files | `<lightning dir>/bitcoin/` (`hsm_secret`, `lightning-rpc`, `ca.pem`, `server.pem`) | same, under `$LIGHTNINGD_DATA/$LIGHTNINGD_NETWORK` |
| Wallet DB | **`<lightning dir>/lightningd.sqlite3`**, replicated to `/backups/database/` | default `<lightning dir>/<network>/lightningd.sqlite3` |
| Config | `<lightning dir>/config`, rewritten on every start | none; the entrypoint passes `"$@"` to `lightningd` |
| Tor | in-container Tor under supervisord; hidden service in `/var/lib/tor/cln-service` | none |
| Tools | `lightning-cli`, `python3`, `jq` | `lightning-cli`, `jq`, `socat`, `inotifywait`; **no `python3`** |
| Plugins | CLN built-ins + cl-hive, cl-revenue-ops, vitality, boltzd | CLN built-ins, including `clnrest`, `chanbackup`, `xpay`, `funder` |

Three of these facts are traps:

1. **Wallet path.** cl-hive keeps the database at
   `/data/lightning/bitcoin/lightningd.sqlite3`, not CLN's default in the
   network directory. A config that omits `wallet=` starts CLN on an empty
   database next to the real `hsm_secret`: a node with the right identity and
   no channels.
2. **Config rewrite.** The existing `config` file contains `hive-*` and
   `revenue-ops-*` options. Plain `lightningd` refuses to start with unknown
   options, so the file has to be regenerated, not reused.
3. **Replica.** The `/backups` replica target is not mounted by
   `docker/compose/lightning.yml`, so it lives in the container's writable
   layer and is discarded whenever the container is recreated. Dropping it
   loses nothing durable.

Archon itself calls only `invoice` and `listinvoices` (lightning-mediator via
`clnrest`). None of the RPCs CLN removed in 26.04 or 26.06 (`decodepay`,
`close` `tx`/`txid`, `listpeers` `option_anchors_zero_fee_htlc_tx`,
`max_total_htlc_in_msat`) appear in Archon code. The compose environment
variables `HIVE_GOVERNANCE_MODE`, `HIVE_COMMS_ENABLED`, `HIVE_ARCHON_ENABLED`
and `HIVE_ARCHON_VERSION` are not read by the v3.4.0 entrypoint at all.

## Design

### Image: `ghcr.io/archetech/cln`

`docker/Dockerfile.cln`:

```dockerfile
FROM elementsproject/lightningd:v26.06.9
COPY docker/cln/entrypoint.sh /usr/local/bin/cln-entrypoint
RUN chmod 755 /usr/local/bin/cln-entrypoint
ENTRYPOINT ["/usr/local/bin/cln-entrypoint"]
```

Built and published like `ghcr.io/archetech/tor`: added to the
`docker-multiplatform.yml` and `docker-publish.yml` matrices (amd64 and
arm64; the base image publishes both). Bumping CLN is a one-line change to the
`FROM` tag; a Dependabot `docker` entry for `/docker`, allowing only
`elementsproject/lightningd`, proposes those bumps.

`ARCHON_CLN_VERSION` is removed. Its values are cl-hive tags (`sample.env`
still says `3.1.0`), so keeping the name with a new meaning would make every
existing `.env` pull a tag that does not exist.

### Entrypoint: `docker/cln/entrypoint.sh`

Runs on every start, then `exec /entrypoint.sh` (the official script, which
starts `lightningd` and forwards `TERM`):

1. Map `NETWORK` to the lightning dir exactly as cl-hive does
   (`bitcoin` → `/data/lightning/bitcoin`, `testnet`, `signet`, `regtest`
   likewise), and export `LIGHTNINGD_DATA` and `LIGHTNINGD_NETWORK` for the
   official script.
2. **Refuse to start** if `<dir>/<network>/hsm_secret` exists but
   `<dir>/lightningd.sqlite3` does not, with a message naming both paths. This
   is the guard for trap 1; it must never fall through to a fresh database.
3. If an existing `config` is present and has no
   `# generated by archon cln-entrypoint` header, copy it once to
   `config.cl-hive.bak` for reference.
4. Write `config` from the environment (table below), with the header.
5. In `tor` and `hybrid` modes, wait (bounded, default 300 s) for the onion
   hostname published by `cln-tor` and add `announce-addr=<onion>:<port>`;
   fail with a clear message on timeout rather than start unannounced.

| Option | Value | Source today |
|---|---|---|
| `network`, `alias`, `rgb` | from `NETWORK`, `ALIAS`, `RGB` | same env |
| `bitcoin-rpc*` | from `BITCOIN_RPC*` | same env |
| `wallet` | `sqlite3://<dir>/lightningd.sqlite3` | same path, without the replica |
| `log-level` | `LOG_LEVEL` | same |
| `log-file` | `<dir>/lightningd.log` and `-` (stdout) | file only today; stdout added for `docker logs` |
| `clnrest-port`, `clnrest-protocol`, `clnrest-host` | `3001`, `https`, `0.0.0.0` | same |
| `min-capacity-sat` | `MIN_CAPACITY_SAT`, default 50000 (compose) | same |
| `fee-base`, `fee-per-satoshi`, `htlc-minimum-msat` | `0`, `100`, `1000` unless overridden by `FEE_BASE`, `FEE_PER_SATOSHI`, `HTLC_MINIMUM_MSAT` | same defaults |
| `experimental-dual-fund`, `funder-policy`, `funder-policy-mod`, `funder-lease-requests-only` | on, `match`, `100`, `false`, unless `DUAL_FUND_ENABLED=false` | same defaults |
| Network mode | see Tor below | same modes |

Not carried over: `grpc-port` (not published and unused), every `hive-*`,
`revenue-ops-*` and vitality option, and `experimental-splicing` (deprecated in
26.04; splicing is on by default).

Existing per-channel fees live in the database (`setchannel`, including the
values cl-revenue-ops set), so they are unchanged. They stay fixed from then
on, because nothing adjusts them any more.

### Tor

A second instance of `ghcr.io/archetech/tor`, `cln-tor`, in the `lightning`
profile, so `lightning` stays independent of the `tor` profile.

- `docker/tor/entrypoint.sh` gains `TOR_SERVICE_NAME` (default `drawbridge`)
  for the hidden-service directory name. Drawbridge's paths are unchanged.
- `cln-tor` sets `TOR_SERVICE_HOST=cln-mainnet-node` and
  `TOR_SERVICE_PORT=${ARCHON_CLN_PORT}` (both already supported), and mounts
  `data/cln-mainnet/tor/cln-service` as its hidden-service
  directory. That is where the cl-hive Tor kept its key, so the onion address
  does not change. The entrypoint already `chown`s the directory to its own
  `tor` user.
- It publishes the hostname to a `cln-tor-hostname` volume that the CLN
  container mounts read-only.

| Mode | `lightningd` options |
|---|---|
| `tor` | `proxy=cln-tor:9050`, `always-use-proxy=true`, `bind-addr=0.0.0.0:<port>`, `announce-addr=<onion>:<port>` |
| `hybrid` | `proxy=cln-tor:9050`, `bind-addr=0.0.0.0:<port>`, `announce-addr=<ANNOUNCE_ADDR>` and the onion |
| `clearnet` | `bind-addr=0.0.0.0:<port>`, `announce-addr=<ANNOUNCE_ADDR>` if set; `cln-tor` is not needed |

In `tor` mode, cl-hive bound `lightningd` to `127.0.0.1` inside the container,
so the published host port reached nothing. Now that `lightningd` binds the
container interface for `cln-tor` to reach it, the host publication becomes
`${ARCHON_CLN_P2P_BIND:-127.0.0.1}:${ARCHON_CLN_PORT}:${ARCHON_CLN_PORT}`, like
`ARCHON_RTL_BIND`. Without it, a `tor`-mode node would accept clearnet
connections on the host's address. `clearnet` and `hybrid` operators set
`ARCHON_CLN_P2P_BIND=0.0.0.0`. This is a required step in the upgrade notes.

### Compose (`docker/compose/lightning.yml`)

- `x-cln-image: &cln-image ghcr.io/archetech/cln`, still shared by the node and
  the three init containers.
- Node: remove the four `HIVE_*` variables; mount `data/cln-mainnet` at
  `/data/lightning` (unchanged); add `cln-tor-hostname:/tor-hostname:ro`;
  `stop_grace_period: 120s`, the time cl-hive's supervisord allowed, instead of
  Docker's 10-second default; the P2P publication above.
- `cln-tor` service as above, with `depends_on` from the node.
- Init containers: replace the `python3 -c "…['rune']"` pipelines with
  `jq -r .rune`.
- `/var/lib/tor` is no longer mounted into the node.

### Documentation

- `sample.env`: remove `ARCHON_CLN_VERSION`, `ARCHON_CLN_GOVERNANCE_MODE` and
  `ARCHON_CLN_ARCHON_VERSION`; add `ARCHON_CLN_P2P_BIND`.
- `docs/deployment.md` §9: same table changes; describe the node as plain CLN;
  add an **Upgrading from the cl-hive image** section:
  1. Stop the stack and copy `data/cln-mainnet` (including `tor/`).
  2. In `clearnet` or `hybrid` mode, set `ARCHON_CLN_P2P_BIND=0.0.0.0`.
  3. Pull and start. CLN migrates the database to the v26.06 schema on first
     start.
  4. Check `getinfo` (same `id`, same onion in `address`), `listpeerchannels`
     (same channels, `CHANNELD_NORMAL`), and an invoice through Drawbridge.
  5. **Rollback** is restoring the copy and the old image, and is safe only
     if no channel state has changed since the upgrade. An older database
     broadcast after a channel update is a revoked state, and the peer can
     claim the whole channel. Once a payment or forward has gone through on
     the new node, there is no going back.
- `docs/plans/cashu-1058.md`'s mint uses this CLN's RPC socket; no change
  needed there.

## Tests

- **Entrypoint unit tests** (`tests/cln/entrypoint.test.ts`, running the
  script against temporary directories with `bash`). Cover:
  - config generation for each network mode
  - the wallet guard (`hsm_secret` present, database absent → non-zero exit,
    no `config` written)
  - one-time backup of a cl-hive config
  - preservation of the cl-hive defaults in the table
  - the onion-wait timeout
- **Image smoke test** in `docker-build-test.yml`: build `Dockerfile.cln`,
  start it on regtest against a `bitcoind -regtest` container, and check
  `getinfo` and an `invoice` over `clnrest` with a rune.
- **Migration rehearsal**, `scripts/cln-migration-rehearsal.sh`, run by hand
  and recorded in the PR (it pulls the old image and takes minutes):
  1. On regtest, start two nodes on `cl-hive-node:3.4.0`.
  2. Open a channel and pay an invoice.
  3. Switch node A to the new image with the same data directory.
  4. Assert the same node id, the channel still `CHANNELD_NORMAL`, and the
     wallet path unchanged.
  5. Pay in both directions.
  6. Also run it in `tor` mode to confirm the onion address survives.

## Delivery

| PR | Content |
|---|---|
| 1 | `TOR_SERVICE_NAME` in the Tor image (no behaviour change for Drawbridge) |
| 2 | `Dockerfile.cln`, entrypoint, unit tests, smoke test, CI matrices, Dependabot entry |
| 3 | Compose switch, `cln-tor`, init containers, docs, upgrade notes; the rehearsal script and its recorded run |

PR 3 carries the release note, because it is the one that changes running
nodes.

## Risks

- **Database migration is one-way.** Covered by the backup step and the
  rollback warning; the rehearsal is the evidence the migration preserves
  channels.
- **RTL 0.15.1 against CLN 26.06.** RTL talks to `clnrest`; the rehearsal
  checks the RTL dashboard loads. If it doesn't, an RTL bump is a separate
  issue.
- **LNbits' read-only rune includes `summary`,** a method neither image
  provides. That's unchanged and harmless, and out of scope.
- **Root.** Both images run `lightningd` as root, and the data files are
  root-owned. Moving to `${ARCHON_UID}` would mean changing ownership of a
  live channel database, so it is left out of this change.
