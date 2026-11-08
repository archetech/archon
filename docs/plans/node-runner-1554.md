# Node-runner: manage a node from a web app (#1554)

Status: planned.

Node-runner is a web app for operating an Archon node: its configuration,
starting, stopping and updating, logs and health. Today each of these needs a
shell on the host and knowledge of Docker Compose.

## Constraints

- The full stack runs about 30 services from the Compose fragments under
  `docker/compose/`, and only some of them define a healthcheck.
- `sample.env` documents over 250 `ARCHON_*` settings. Some only work together
  with a profile in `COMPOSE_PROFILES`, such as `didcomm` with
  `ARCHON_DIDCOMM_URL`, or the Drawbridge upstream URLs with the `lightning`,
  `herald` and `explorer` profiles.
- Compose resolves `./data`, build contexts and `include:` files relative to
  the project directory, so a tool that runs `docker compose` must see the repo
  at the path the host sees.
- Some services hold state that is costly to interrupt: CLN, bitcoind, the
  databases and IPFS.
- Node-runner is needed most when the node is broken, so it must not depend on
  Gatekeeper, Keymaster or Drawbridge being up.

## Decisions

- **Its own Compose project.** Node-runner runs as a container in a separate
  Compose project (`archon-node-runner`), not as a profile of the node, so
  `docker compose down` on the node does not stop it. It mounts the Docker
  socket, and mounts the repo at the same absolute path inside the container
  as on the host, the arrangement Dockge uses for the same reason.
- **Compose CLI for actions, Engine API for reading.** Lifecycle actions run
  the real `docker compose` CLI, so profiles, includes and interpolation behave
  as they do in a shell. Status and logs come from the Docker Engine API,
  filtered by the `com.docker.compose.project` label.
- **Security.** The Docker socket is root-equivalent on the host.
  - Node-runner binds to `127.0.0.1` by default. Operators reach it through an
    SSH tunnel, a VPN or their own reverse proxy, never through Drawbridge or
    Tor.
  - It has a dedicated login credential in its own configuration, independent
    of the node's `.env` and of every node service.
  - Secret settings are write-only: once set, the UI and API never return them.
- **Configuration preserves `.env`.**
  - Edits keep comments, ordering and unknown keys.
  - Every write keeps a timestamped backup.
  - The catalog of settings (section, description, default, related profile)
    is parsed from `sample.env`; there is no second source of truth.
  - Validation checks the catalog, then the profile and URL pairing rules, and
    finally `docker compose config`.
- **Preview before acting.** Applying a change first shows what it will do,
  flagging stateful services, and runs only after confirmation. No action runs
  `docker compose down` first, as `./start-node` does. The preview covers:
  - containers that would be recreated, from `docker compose up -d --dry-run`;
  - services to rebuild, because a changed setting is a build argument (for
    example `ARCHON_REACT_WALLET_GATEKEEPER_URL`, which is compiled into the
    wallet). `up -d` reuses an existing image, so these get a scoped
    `docker compose build <service>` first;
  - services to stop, because their profile is no longer enabled. `up -d`
    leaves those containers running (see the Tor note in
    `docs/deployment.md`), so they are stopped explicitly, without taking down
    the rest of the node or touching their data.
- **One long job at a time.** Builds and updates are serialised, check host
  load before starting, stream their output, and survive a browser disconnect.
- **Two update channels.** The operator chooses to follow releases (the latest
  `v*` tag) or `main`. Either way node-runner fetches, lists the incoming
  commits, checks out, builds with `GIT_COMMIT` set, and runs `up -d`.

## Phases

Each phase is one PR.

| Phase | Delivers |
|---|---|
| 1 | Container, separate Compose project, login, loopback binding. Per-service state, Docker health and `/ready` probes, with services that have no healthcheck shown as such. Live, searchable logs per service and merged. A Grafana link when the `observability` profile is on. |
| 2 | Configuration: catalog view by section, editing with validation, a diff and a backup, then applying through the preview, including scoped rebuilds and stopping services whose profile was removed. |
| 3 | Lifecycle: start, stop and restart a service; stop and start the whole node. A whole-node stop uses `stop`, not `down`, unless the operator asks for `down`. |
| 4 | Updates on the release or `main` channel. Self-update through a short-lived helper container, since a container cannot recreate itself while serving the request. |

## Tests

- `.env` round trip with comments, ordering and unknown keys.
- A CI check that every `ARCHON_*` variable referenced by the Compose files
  appears in the catalog.
- API tests against a fake Compose runner.
- An end-to-end run against a throwaway Compose project.

## Out of scope

- Keeping logs beyond what Docker retains, which would need a log store such as Loki.
- Managing more than one node.
- Replacing `deploy/install.sh`, which can install node-runner as one of its steps.
