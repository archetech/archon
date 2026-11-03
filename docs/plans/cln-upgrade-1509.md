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
- **One Tor node.** CLN uses the node's existing `tor` service
  (`ghcr.io/archetech/tor`) for its SOCKS proxy and onion service instead of
  running its own Tor.

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
`docker-build.yml`, `docker-publish.yml` and `docker-multiplatform.yml`
matrices, which `tests/ci/image-matrix.test.ts` requires to agree (amd64 and
arm64; the base image publishes both). Bumping CLN is a one-line change to the
`FROM` tag; a Dependabot `docker` entry for `/docker`, allowing only
`elementsproject/lightningd`, proposes those bumps.

`ARCHON_CLN_VERSION` is removed. Its values are cl-hive tags (`sample.env`
still says `3.1.0`), so keeping the name with a new meaning would make every
existing `.env` pull a tag that does not exist.

### Entrypoint: `docker/cln/entrypoint.sh`

It replaces the official `/entrypoint.sh` rather than wrapping it. That
script starts `lightningd --network=…` without `--lightning-dir`, so the daemon
would use `/root/.lightning` and ignore our config and wallet. It also blocks
on an `inotifywait` for the RPC socket, so a `lightningd` that exits before
creating it (bad config, failed migration) leaves the container running.

On every start:

1. Map `NETWORK` to the lightning dir exactly as cl-hive does
   (`bitcoin` → `/data/lightning/bitcoin`, `testnet`, `signet`, `regtest`
   likewise).
2. **Refuse to start** if `<dir>/<network>/hsm_secret` exists but
   `<dir>/lightningd.sqlite3` does not, with a message naming both paths. This
   is the guard for trap 1; it must never fall through to a fresh database.
3. Set `umask 077`. The config holds `bitcoin-rpcpassword`, so it and its
   backup must be owner-only from creation, as cl-hive's `chmod 600` made them.
4. If an existing `config` is present and has no
   `# generated by archon cln-entrypoint` header, copy it once to
   `config.cl-hive.bak` for reference.
5. Write `config` from the environment (table below), with the header, to a
   temporary file renamed into place.
6. In `tor` and `hybrid` modes:
   - Fail immediately if `tor` does not resolve, with a message saying to add
     `tor` to `COMPOSE_PROFILES`.
   - Start `socat TCP-LISTEN:9050,bind=127.0.0.1,fork,reuseaddr TCP:tor:9050`
     and give `lightningd` `proxy=127.0.0.1:9050`. With `always-use-proxy`,
     v26.06.9 rejects a proxy hostname ("Needed DNS, but lookups suppressed"),
     and a numeric address taken at startup would break when `tor` is
     recreated on another address. `socat` (in the base image) resolves `tor`
     per connection.
   - Wait (bounded, default 300 s) for `/tor-hostname/cln/hostname` and add
     `announce-addr=<onion>:<port>`. Fail with a clear message on timeout
     rather than start unannounced.
7. Run `lightningd --lightning-dir=<dir> --network=<network>` as a child,
   forward `TERM` and `INT` to it, and exit with its status when it exits. If
   `socat` exits first, stop `lightningd` and exit non-zero, so Docker's restart
   policy brings both back.

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

CLN uses the node's `tor` service (`docker/compose/drawbridge.yml`, profile
`tor`) rather than a Tor of its own.

- Hosting both onion services in one Tor process makes the Drawbridge and CLN
  onions linkable, since they go up and down together. They are linked
  already: every invoice Drawbridge issues names the CLN node as payee.
- Outbound circuits stay separate. Tor's default `IsolateClientAddr` keeps
  streams from different containers on different circuits, so CLN's
  connections never share a circuit with Herald or DIDComm egress.

Changes to `docker/tor/entrypoint.sh`:

- It serves a list of onion services, `TOR_SERVICES`, each given as
  `name:host:port[:mode]`. The default is `drawbridge:drawbridge:4222`,
  matching what the existing `TOR_SERVICE_HOST`/`TOR_SERVICE_PORT` defaults
  produce, and those two variables keep working for a single service.
- An entry whose `mode` is `clearnet` is not served. Without that, a
  `clearnet` node would still get a reachable onion service, under the old
  address if a key exists. Switching a node to `clearnet` therefore removes the
  service from the torrc on the next start; the key stays on disk.
- Each served entry is added to the torrc once its host resolves, and is
  re-resolved on the existing loop. That is how Drawbridge is handled today,
  so the `cln` entry is harmless on nodes without the `lightning` profile.
- Hidden-service directories are `/var/lib/tor/hidden_service/<name>`.
  Drawbridge's is unchanged (`data/tor-drawbridge/drawbridge`).
- Each hostname is published to `/tor-hostname/<name>/hostname` once this Tor
  is serving it. On start, the entrypoint first removes the files it
  publishes, so a file left by an earlier run cannot satisfy CLN's wait.
  Drawbridge's existing `/tor-hostname/hostname` is still written, because
  Drawbridge reads that path.

Compose changes to the `tor` service:

- `TOR_SERVICES=drawbridge:drawbridge:4222 cln:cln-mainnet-node:${ARCHON_CLN_PORT:-9736}:${ARCHON_CLN_NETWORK_MODE:-tor}`
- An added bind mount of `data/cln-mainnet/tor/cln-service` at
  `/var/lib/tor/hidden_service/cln`. That is where the cl-hive Tor kept its
  key, so the onion address does not change. The entrypoint already `chown`s
  the directory to its `tor` user. On nodes without Lightning the mount creates
  an empty directory, and no key is generated, because the target never
  resolves.

A published hostname shows the onion service is configured, not that peers
can reach it (see AGENTS.md on Tor hostname files). The node's healthcheck
therefore makes a bounded SOCKS connection through `tor` to
`<onion>:<port>` once `lightningd` is listening, and reports unreachability
as unhealthy. That keeps reachability separate from whether the node started.

| Mode | `lightningd` options |
|---|---|
| `tor` | `proxy=127.0.0.1:9050` (the `socat` relay), `always-use-proxy=true`, `bind-addr=0.0.0.0:<port>`, `announce-addr=<onion>:<port>` |
| `hybrid` | `proxy=127.0.0.1:9050` (the `socat` relay), `bind-addr=0.0.0.0:<port>`, `announce-addr=<ANNOUNCE_ADDR>` only if set (CLN rejects an empty value as a wildcard), and `announce-addr=<onion>:<port>` |
| `clearnet` | `bind-addr=0.0.0.0:<port>`, `announce-addr=<ANNOUNCE_ADDR>` only if set; the `tor` profile is not needed |

In `tor` mode, cl-hive bound `lightningd` to `127.0.0.1` inside the container,
so the published host port reached nothing. Now that `lightningd` binds the
container interface for `tor` to reach it, the host publication becomes
`${ARCHON_CLN_P2P_BIND:-127.0.0.1}:${ARCHON_CLN_PORT:-9736}:${ARCHON_CLN_PORT:-9736}`
(keeping the current default for nodes that leave the port unset), like
`ARCHON_RTL_BIND`. Without it, a `tor`-mode node would accept clearnet
connections on the host's address. `clearnet` and `hybrid` operators set
`ARCHON_CLN_P2P_BIND=0.0.0.0`. This is a required step in the upgrade notes.

### Compose (`docker/compose/lightning.yml`)

- `x-cln-image: &cln-image ghcr.io/archetech/cln`, still shared by the node and
  the three init containers.
- Node: remove the four `HIVE_*` variables; mount `data/cln-mainnet` at
  `/data/lightning` (unchanged); add `tor-hostname:/tor-hostname:ro`;
  `stop_grace_period: 120s`, the time cl-hive's supervisord allowed, instead of
  Docker's 10-second default; `restart: unless-stopped`, so an exit from the
  entrypoint's supervision restarts it; the onion healthcheck above; the P2P
  publication above.
- Node `depends_on: tor` with `required: false`, the pattern Drawbridge uses,
  because `tor` is a separate profile. When Drawbridge is also enabled, `tor`
  waits for it to be healthy, so a Tor-mode CLN starts after Drawbridge.
- Init containers: replace the `python3 -c "…['rune']"` pipelines with
  `set -euo pipefail` and `jq -er '.rune | select(type == "string" and length > 0)'`,
  so a failed `createrune` or a missing field stops the container instead of
  becoming an empty or `null` credential. Each init container writes its file
  to a temporary name and renames it only after every rune it needs has
  validated, so the "already exists, skipping" check never accepts a partial
  file.
- `/var/lib/tor` is no longer mounted into the node.

### Documentation

- `sample.env`: remove `ARCHON_CLN_VERSION`, `ARCHON_CLN_GOVERNANCE_MODE` and
  `ARCHON_CLN_ARCHON_VERSION`; add `ARCHON_CLN_P2P_BIND`.
- `docs/deployment.md` §9: same table changes; describe the node as plain CLN;
  add an **Upgrading from the cl-hive image** section:
  1. Stop the stack and copy `data/cln-mainnet` (including `tor/`).
  2. In `tor` or `hybrid` mode, add `tor` to `COMPOSE_PROFILES`. In
     `clearnet` or `hybrid` mode, set `ARCHON_CLN_P2P_BIND=0.0.0.0`.
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
  - config generation for each network mode, including the missing-`tor`
    failure
  - the wallet guard (`hsm_secret` present, database absent → non-zero exit,
    no `config` written)
  - one-time backup of a cl-hive config
  - owner-only permissions on the config and backup in a fresh data directory
  - preservation of the cl-hive defaults in the table, and no `announce-addr`
    line when `ANNOUNCE_ADDR` is empty in `hybrid` and `clearnet`
  - the onion-wait timeout
  - supervision: a `lightningd` stub that exits before creating its socket
    makes the entrypoint exit with its status; a `socat` exit stops
    `lightningd` and exits non-zero
- **Tor entrypoint tests** (new, `tests/tor/entrypoint.test.ts`, running the
  script's torrc generation with a stubbed resolver). Cover: the default
  single Drawbridge service, two services with one unresolvable, a `clearnet`
  entry (not served) and a switch from `tor` to `clearnet`, stale hostname
  files removed on start, and the hostname published at Drawbridge's old path
  as well as the new one.
- **Image smoke test** in `docker-build-test.yml`: build `Dockerfile.cln`,
  start it on regtest against a `bitcoind -regtest` container, and check:
  - `getinfo` and an `invoice` over `clnrest` with a rune
  - that the RPC socket, `hsm_secret` and wallet are at the planned paths
  - a startup in `tor` mode with a `tor` container, which exercises the `socat`
    proxy
  - a startup failure (an invalid option) against an existing network
    directory, where the container must exit rather than hang
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
| 1 | `TOR_SERVICES` in the Tor image and compose, including the CLN key mount (no behaviour change for Drawbridge) |
| 2 | `Dockerfile.cln`, entrypoint, unit tests, smoke test, CI matrices, Dependabot entry |
| 3 | Compose switch, init containers, docs, upgrade notes; the rehearsal script and its recorded run |

PR 3 carries the release note, because it is the one that changes running
nodes.

Compose refers to the untagged images, which resolve to `latest`, and
`latest` is published only from `v*` tags. A release therefore delivers the
images and the compose change together. Nodes that run from `main` in
between would pull a Tor image without `TOR_SERVICES` and find no
`ghcr.io/archetech/cln` at all. So PR 3 merges only after PRs 1 and 2 are
published through `docker-publish.yml`'s `workflow_dispatch` on the
`pre-release` channel, and after the rehearsal has run against those
published images rather than local builds.

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
