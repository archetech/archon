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
code to `data/node-runner/setup-code` and to its log (`./node-runner logs`).
The first visit to the page asks for that code and then for an admin password
of at least 12 characters. node-runner stores only a scrypt hash of the
password, in `data/node-runner/admin-password`, and the setup code stops
working once the password is set.

## Signing in

Password and setup-code guesses are checked one at a time, and each failure
doubles the delay before the next check, up to 30 seconds. A session lasts
until 12 hours pass without a request, until you log out, or until the
password is reset. Sessions are held in memory, so restarting node-runner ends
them too.

To reset a forgotten password, delete `data/node-runner/admin-password`. Every
session ends, and the setup page returns with a new code.

## Configuration

The Configuration page edits `.env`. Profiles are switches; settings are
grouped by the sections of `sample.env`, with its comments as their
descriptions. Settings that look like credentials are write-only: the page
shows whether one is set and lets you replace it, but never shows its value.
These are names containing `API_KEY`, `SECRET`, `PASSPHRASE`, `PASSWORD`,
`TOKEN`, `MNEMONIC`, `PRIVATE_KEY`, `MACAROON` or `SEED`, names ending in
`_PASS`, `_RUNE` or `_RPC_URL`, and any value that is a URL with a user and
password in it. A name ending in `_URL`, `_FILE`, `_PATH` or `_NAME` is shown
even if it contains one of those words (`ARCHON_SECRET_FILE`, say), unless it
ends in `_RPC_URL` or its value is a URL with a user and password.
`COMPOSE_PROJECT_NAME` cannot be changed here, since that would orphan every
running container.

If Compose rejects the current `.env`, the page still loads, shows Compose's
error, and lets you repair the file.

Edits stay a draft until you review them. The review shows the `.env` diff and
what applying it will do, worked out the way Compose decides it:

- **Rebuild:** a build argument changed, or a service built from this
  repository has no current image. `up` alone would reuse the old image.
- **Create / Recreate / Start:** what `docker compose up -d` will do.
- **Stop:** services of a profile you turned off, which `up` would leave running.

Interrupting a stateful service needs an extra confirmation. Applying works
out the plan again from `.env` as it is when you apply, so your edits go onto
the current file: if `.env` was edited elsewhere while you were reviewing,
review again to see what applying will now do. Applying then runs as a job:
node-runner refuses if `.env` changes between Apply and the job writing it,
backs up `.env` to `data/node-runner/env-backups/` (keeping the last 20),
writes the new file,
builds the changed or missing images, stops the services of disabled profiles,
runs `docker compose up -d --no-build`, then waits for the touched services'
health checks. Builds wait while the host's load is above its core count, and
give up if it stays there for 10 minutes. One job runs at a time, and the Jobs
page keeps the output of the last 20.

## Starting and stopping

A service's detail panel can start, stop or restart it, and Overview can do the
same for the whole node. Each action is reviewed first, with the command it
runs and the services it affects, and runs as a job.

Stateful services are the databases (Redis, MongoDB), IPFS, LNbits, Core
Lightning, and the blockchain nodes (the `*-node` services). Stopping or
restarting one, or recreating one while starting the node, needs an extra
confirmation.

Starting the node builds missing or changed images first, under the host-load
check, then runs `docker compose up -d --no-build` with the current
configuration. Restarting the node restarts the services that are running, and
leaves stopped ones stopped. Stopping the node runs `docker compose stop`,
which keeps its containers. `docker compose down`, which removes the
containers and the network, runs only when you ask for it on the review page.
Neither removes volumes or anything in `data/`.

## Updates

The Updates page follows one of two channels: **Releases**, the newest `v*`
tag, or **main**, the head of `origin/main`. It fetches, shows the commits an
update brings and the host's load, and refuses to run while tracked files have
local changes. A node installed with `deploy/install.sh` starts from a shallow
clone; the first check for updates fetches its full history. The main channel
offers nothing while the local `main` branch has commits that `origin/main`
lacks.

An update checks out the target (a detached tag, or a fast-forward of `main`),
builds every image the node builds from this repository with `GIT_COMMIT` set
(waiting while the host is busy), and runs `docker compose up -d --no-build`
to recreate the containers whose image or configuration changed.

The page lists the stateful services the update may recreate, each with its
own checkbox. One is restarted only if you ticked it. If the update would
recreate a stateful service you did not allow, it stops after building and
restarts nothing; tick the service and choose **Finish the update** on the
Updates page.

node-runner records an update in `data/node-runner/update.json` once it has
checked out the target. If the update stops after that, for example because a
build failed, the host stayed busy, or a stateful service needed consent, the Updates page
offers to finish it at the same target rather than look for a newer one.

If the update changed node-runner itself, it starts a short-lived helper
container (`archon-node-runner-updater`) that runs `./node-runner up -d
--build` and replaces node-runner. The update job stays running until the
helper finishes; the restarted node-runner takes the job over, adds the
helper's output to it, and settles it on the helper's exit status. The page
reconnects when node-runner is back. Sessions do not survive the restart, so
you sign in again.

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
