# Scale tests

Runs many Archon nodes on hosted machines and measures how they behave together.
The plan is [docs/plans/scale-testing-1627.md](../../docs/plans/scale-testing-1627.md).
This is its harness and the first of its experiments.

It runs on [boxd](https://boxd.sh), never beside a live node: each node is a machine
of its own, made from one snapshot, on a private swarm that exists for one run.

## What is here

- `golden.mjs` makes the snapshot every node starts from: the repository at the
  release tag and the release's images, pulled by digest, on a machine where no node
  has ever started. Machines made from it are distinct nodes.
- `run.mjs` is experiment A: N nodes with empty histories, a stream of new identities
  into one of them, and how long each takes to reach the rest.
- `teardown.mjs` removes the harness's machines, for when a run is interrupted.
- `node/` holds what runs on the machines: `configure.sh` writes a node's settings,
  `pin-images.mjs` pins the images, `generate.mjs` creates the identities and
  `watch.mjs` records when each one arrives.

Experiments B, C and D of the plan are not built.

## Run it

Needs Node 22 or later and the boxd CLI, signed in or with `BOXD_TOKEN` set. `BOXD`
names the CLI if it is not on the path, and `BOXD_REGION` the region (default `fra`).

```sh
node golden.mjs                              # once for each release: about a minute
node run.mjs --nodes 5 --ops 30 --rate 1     # about six minutes
node teardown.mjs                            # only after an interrupted run
```

A run removes its machines when it ends, and every machine is created with a deletion
timer (`--ttl`, three hours by default) in case the run never gets that far. Machines
are named `archon-scale-…` and labelled `purpose=archon-scale`; nothing else in the
account is touched. `--keep yes` leaves a run's machines up for inspection.

Five nodes for the six minutes of a run cost a few cents.

## What a run measures

`results/<run>.json`, and a summary on the terminal:

- **Time to reach every node.** For each identity, from the moment it was submitted
  to the moment the slowest node first resolved that version of it.
- **Messages for each operation.** The mediators' relayed, received and duplicate
  counts over the run, summed across the nodes.
- **Connections.** How many peers each node held when the load began.
- **Memory and CPU** of every container at the end, and the image references the
  nodes ran, each Archon image by digest.

Read the times with these in mind:

- Each node is asked four times a second, so a time is good to a quarter of a second.
- The mediator sends what it has every two seconds (`ARCHON_HYPR_EXPORT_INTERVAL`),
  which sets most of the delay at this size.
- Times compare one machine's clock with another's. The run records each machine's
  offset from NTP; on boxd they have been within a millisecond.
- A version that a node passed through between two polls is counted as missing. That
  cannot happen with newly created identities, which is all experiment A sends.

## One thing the harness changes about a node

Nodes are otherwise stock: the release's Compose files, the `hyperswarm` and `cli`
profiles, the Rust Gatekeeper and the TypeScript Keymaster.

The exception is the network of the Hyperswarm mediator. Machines in one boxd region
reach the internet through one public address. Hyperswarm connects two peers behind
one address over their local network, each choosing the other's local address that
most resembles its own. A stock node's mediator sits on a Docker bridge, so the
address it offers is a bridge address, which is the same on every machine, and the
two never connect. `node/configure.sh` therefore runs the mediator on the host's
network and gives each machine's bridge a subnet of its own.

This is not peculiar to boxd. Two stock nodes behind any one public address, such as
two on one office network, are in the same position.

## Results so far

| Run | Nodes | Operations | Reached every node | p50 | p95 |
|---|---|---|---|---|---|
| 2026-11-16, v0.14.1, `fra` | 5 | 30 at 1/s | 30 of 30 | 1.0 s | 2.0 s |

Each operation cost 6.6 relayed messages and 4.3 duplicate batches across the five
nodes. One of the five held four peers and four held three, four minutes after
starting.
