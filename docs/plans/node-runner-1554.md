# Node-runner: manage a node from a web app (#1554)

Status: implemented.

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
  - It has a dedicated admin password in its own configuration, independent
    of the node's `.env` and of every node service.
  - The first run asks for that password, gated by a one-time setup code so
    whoever reaches the page first cannot claim it. Node-runner generates the
    code at first start, writes it to its data directory and its log, and
    `deploy/install.sh` prints it. The code stops working once the password is
    set, and only a hash of the password is stored. Deleting that hash on the
    host resets the password and brings back the setup page with a new code.
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

## Interface

React and MUI with the wallet's theme, usable at phone width. Status is shown
with an icon and text, never color alone.

- **Top bar:** node name, running version and update channel, overall health,
  and a running-job indicator.
- **Overview:** a one-line verdict (all healthy, or which service is unhealthy
  and for how long), then service cards grouped by role: core, chains,
  Lightning, gateway, storage, observability, apps. Each card shows state, the
  health source (Docker healthcheck or none), uptime and
  restarts, and marks stateful services. Selecting a card opens its detail:
  image, profile, ports, the settings that affect it, a log tail, and start,
  stop and restart.
- **Logs:** one service or several merged, with per-service colors, follow
  mode, search, a time range and download.
- **Configuration:** a Profiles tab with one switch per profile and inline
  pairing warnings, each with a fix where there is an obvious one; and a
  Settings tab grouped by the `sample.env` sections, with search and a
  changed-from-default filter. Build settings are marked. Secrets show only
  whether they are set and can be replaced. Edits stay a draft until reviewed.
- **Review:** one page for configuration changes, updates and service
  actions. It shows the `.env` diff (secrets masked) or the incoming commits,
  then the plan grouped as Rebuild, Create, Recreate, Restart and Stop.
  Touching a stateful service needs an explicit confirmation before Apply.
- **Updates:** the channel switch, the running and available versions, host
  load, and the incoming commits, leading to the review page.
- **Jobs:** the running job's live output and the job history.

## Phases

Each phase is one PR.

| Phase | Delivers |
|---|---|
| 1 | Container, separate Compose project, first-run password setup with a setup code, login, loopback binding. Per-service state and Docker health, with services that have no healthcheck shown as such. node-runner is on its own Docker network and cannot reach service endpoints, so it does not probe `/ready` itself; the services' healthchecks already do. Live, searchable logs per service and merged. A Grafana link when the `observability` profile is on. |
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
