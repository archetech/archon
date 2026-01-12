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
| `ARCHON_PROTOCOL`        | /ARCHON/v0.1      | Archon network topic to join    |
| `ARCHON_HYPR_EXPORT_INTERVAL` |  2                     | Seconds between export cycles |
