# node-runner

node-runner is a web app for operating an Archon node. It shows every
container's state and health and the node's logs, edits the node's
configuration, starts, stops and restarts services or the whole node, and
updates the node. [The plan](../../docs/plans/node-runner-1554.md) records the
design decisions.

## Running it

node-runner runs as its own Compose project, `archon-node-runner`, so stopping
the node does not stop node-runner. From the node directory:

```bash
./node-runner up -d --build     # start or update node-runner
./node-runner logs              # its log, which shows the setup code
./node-runner down              # stop node-runner; the node keeps running
```

It listens on `127.0.0.1:4280`. Set `ARCHON_NODE_RUNNER_HOST_BIND` and
`ARCHON_NODE_RUNNER_PORT` in `.env` to change that.

node-runner holds the Docker socket, which is root-equivalent on the host. Keep
it on loopback and reach it through an SSH tunnel
(`ssh -L 4280:127.0.0.1:4280 <host>`), a VPN, or your own reverse proxy with
TLS. Do not expose it through Drawbridge or Tor.

## First run

On its first start node-runner creates a one-time setup code. It writes the
code to `data/node-runner/setup-code` and to its log. The first visit to the
page asks for that code and then for the admin password. node-runner stores
only a scrypt hash of the password, in `data/node-runner/admin-password`, and
the setup code stops working once the password is set.

To reset a forgotten password, delete `data/node-runner/admin-password`. Every
session ends, and the setup page returns with a new code.

## Configuration

The Configuration page edits `.env`. Profiles are switches; settings are
grouped by the sections of `sample.env`, with its comments as their
descriptions. Settings that look like credentials are write-only: the page
shows whether one is set and lets you replace it, but never shows its value.
`COMPOSE_PROJECT_NAME` cannot be changed here, since that would orphan every
running container.

Edits stay a draft until you review them. The review shows the `.env` diff and
what applying it will do, worked out the way Compose decides it:

- **Rebuild:** a build argument changed. `up` alone would reuse the old image.
- **Create / Recreate / Start:** what `docker compose up -d` will do.
- **Stop:** services of a profile you turned off, which `up` would leave running.

Interrupting a stateful service (a database, IPFS, a Lightning node) needs an
extra confirmation. Applying runs as a job: node-runner backs up `.env` to
`data/node-runner/env-backups/`, writes the new file, builds, stops and runs
`up -d`, then waits for the touched services' health checks. Builds wait while
the host's load is above its core count. One job runs at a time, and the Jobs
page keeps the output of the last 20.

## Starting and stopping

A service's detail panel can start, stop or restart it, and Overview can do the
same for the whole node. Each action is reviewed first, with the command it
runs and the services it affects, and runs as a job. Stopping or restarting a
stateful service needs an extra confirmation.

Stopping the node runs `docker compose stop`, which keeps its containers.
`docker compose down`, which removes the containers and the network, runs only
when you ask for it on the review page. Neither removes volumes or anything in
`data/`. Starting the node runs `docker compose up -d` with the current
configuration.

## Updates

The Updates page follows one of two channels: **Releases**, the newest `v*`
tag, or **main**, the head of `origin/main`. It fetches, shows the commits an
update brings and the host's load, and refuses to run while tracked files have
local changes.

An update checks out the target (a detached tag, or a fast-forward of `main`),
runs `docker compose build` with `GIT_COMMIT` set (waiting while the host is
busy), and recreates the containers whose image or configuration changed. A
stateful service built from this repository, such as Core Lightning, is
restarted only if its image changed and you confirmed it beforehand. Otherwise
the update stops after building, and you finish it with **Start node**, which
shows exactly what will be recreated.

If the update changed node-runner itself, it starts a short-lived helper
container (`archon-node-runner-updater`) that runs `./node-runner up -d
--build` and replaces node-runner; the page reconnects when it is back.
Sessions do not survive the restart, so you sign in again.

## What it reads

- **Containers** of the node's Compose project: the `COMPOSE_PROJECT_NAME` in
  `.env`, or the node directory's name.
- **Health** from Docker. A service with a healthcheck reports healthy,
  unhealthy or starting, with the last check's output; a service without one
  reports running. node-runner runs on its own Docker network, so it does not
  call service endpoints itself.
- **Logs** from Docker, merged across services in time order.

The node directory is mounted at the path the host uses, so `docker compose`
inside node-runner resolves its relative paths as it does in a shell, and runs
with only `PATH`, `HOME` and the node's commit in its environment so nothing
of node-runner's own overrides the node's `.env`.
