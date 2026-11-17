# Archon Hyperswarm mediator

The Hyperswarm mediator is responsible for distributing unconfirmed Archon operations to the network and for organizing an IPFS peer network for file-sharing.

When a node gets a new connection, it sends the connection a `sync` message and the connection replies with a series of `batch` messages containing all the operations in the connection's DID database. The nodes imports these operations into its Gatekeeper. The Gatekeeper will add any new operations it hasn't seen before, merge any operations it has already seen, and reject invalid operations.

While running the mediator will poll the Gatekeeper's hyperswarm queue for new operations, and relay them to all of its connections with a `queue` message.
When a node receives a `queue` message it will import the operations like during a `batch` but also relay the message to all of its connections, distributing the new operations with a "gossip protocol".

## Environment variables

| variable                  | default                | description                   |
| ------------------------- | ---------------------- | ----------------------------- |
| `ARCHON_GATEKEEPER_URL`       | http://localhost:4224  | Archon gatekeeper service URL   |
| `ARCHON_KEYMASTER_URL`        | http://localhost:4226  | Archon keymaster service URL    |
| `ARCHON_IPFS_URL`             | http://localhost:5001/api/v0  | IPFS RPC URL           |
| `ARCHON_NODE_ID       `       | (no default)           | Keymaster node agent name     |
| `ARCHON_NODE_NAME`            | anon                   | Human-readable name for the node |
| `ARCHON_PROTOCOL`        | set in code | Archon network topic to join |
| `ARCHON_HYPR_EXPORT_INTERVAL` |  2                     | Seconds between export cycles |
| `ARCHON_HYPR_MAX_PEERS`       |  8                     | Peers held before the mediator stops opening connections |

## Two nodes behind one public address

Two nodes that reach the internet through the same public address do not find each
other over Hyperswarm ([#1631](https://github.com/archetech/archon/issues/1631)).
That covers two nodes on one home or office network, and machines that share a
hosting provider's outbound address. Nodes with public addresses of their own, or
behind different ones, are not affected.

Each mediator joins the topic and reports no peers: `Connected nodes: 0` in its log,
and `mediator_active_connections 0` in its metrics, while the other node is running.
The cause is that Hyperswarm connects two such peers over their local network, and
the mediator's container can only offer its Docker bridge address, which is the same
on every host.

There is no fix yet. The workaround below is what the scale tests use
(`tests/scale/node/configure.sh`). It has been run on Linux with Docker Compose 2.24
or later, on hosts that run nothing but the node, and nowhere else. Apply it on every
node that shares the address.

1. Put the mediator on the host's network, and give the node's Compose network a
   subnet no other node uses, in `docker-compose.override.yml`:

   ```yaml
   services:
     hyperswarm-mediator:
       network_mode: host
       ports: !reset []
       environment:
         - ARCHON_GATEKEEPER_URL=http://127.0.0.1:4224
         - ARCHON_KEYMASTER_URL=http://127.0.0.1:4226
         - ARCHON_IPFS_URL=http://127.0.0.1:5001/api/v0
   networks:
     default:
       ipam:
         config:
           - subnet: 10.101.0.0/24
   ```

   Use `10.102.0.0/24` on the second node, and so on. The second number must differ
   on every node and must not be the second number of your local network's own
   addresses.

   Compose reads that file by itself only when `COMPOSE_FILE` is not set and no
   `-f` is given. The minimal stack sets it, so there the override has to be
   named, in every shell that runs `docker compose` or `./archon`:

   ```bash
   export COMPOSE_FILE=docker/compose/minimal.yml:docker-compose.override.yml
   ```

   The three URLs are where a node with default settings publishes those services
   on its host. If you have changed `ARCHON_GATEKEEPER_PORT`, `ARCHON_KEYMASTER_PORT`
   or `ARCHON_KEYMASTER_HOST_BIND`, use the ports and address you chose; a mediator
   that cannot reach them waits for them and never joins the swarm.

2. Take the address off Docker's default bridge, which is also the same on every
   host:

   ```bash
   sudo ip addr flush dev docker0
   ```

   This is the host's bridge, not the node's. Any other container on the host that
   uses Docker's default `bridge` network loses its connectivity, so move those to
   a network of their own first. Docker puts the address back when its daemon
   restarts, and the command has to be repeated then.

3. Stop the node and start it again, so that its network is made anew with the
   subnet. `docker compose up -d` alone keeps a network that already exists:

   ```bash
   docker compose down
   docker compose up -d
   ```

   The node is offline in between. `down` removes the containers and the network
   and leaves the node's data where it is; do not add `-v`.

What the workaround costs:

- **The metrics port is open wider.** On the host's network the mediator's port 4232
  listens on every interface of the host and not only on localhost. Close it in the
  firewall if the host is reachable from outside.
- **The bundled Prometheus loses the mediator.** With the `observability` profile,
  Prometheus scrapes `hyperswarm-mediator:4232`, a name that no longer resolves once
  the mediator has left the Compose network. Its scrape target has to be pointed at
  the host.
