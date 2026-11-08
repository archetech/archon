# node-runner

node-runner is a web app for operating an Archon node. It shows every
container's state and health, and the node's logs, live or downloaded.
Configuration, starting and stopping, and updates come in later phases of
[the plan](../../docs/plans/node-runner-1554.md).

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

## What it reads

- **Containers** of the node's Compose project: the `COMPOSE_PROJECT_NAME` in
  `.env`, or the node directory's name.
- **Health** from Docker. A service with a healthcheck reports healthy,
  unhealthy or starting, with the last check's output; a service without one
  reports running. node-runner runs on its own Docker network, so it does not
  call service endpoints itself.
- **Logs** from Docker, merged across services in time order.

The node directory is mounted read-only, apart from `data/node-runner`.
