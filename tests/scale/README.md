# Scale tests

Runs many Archon nodes on hosted machines and measures how they behave together.
The plan is [docs/plans/scale-testing-1627.md](../../docs/plans/scale-testing-1627.md).
This is its harness and the first of its experiments.

It runs on [boxd](https://boxd.sh), never beside a live node: each node is a machine
of its own, made from one snapshot, on a private swarm that exists for one run.

## What is here

- `golden.mjs` makes the snapshot every node starts from: the repository at the
  release tag and the release's images, pulled by digest, on a machine where no node
  has ever started. Machines made from it are distinct nodes. `--mediator <directory>`
  lays compiled mediator files over the release's image, to try a change to the
  mediator with everything else the release's.
- `run.mjs` is experiment A: N nodes with empty histories, a stream of new identities
  into one of them, and how long each takes to reach the rest. `--wait <seconds>`
  begins the load after that long, whatever the nodes' connections are doing.
- `sweep.mjs` runs experiment A at several sizes, several times each, and writes one
  table. It stops if the account's usage passes a spending limit, or if the host
  refuses to create a machine.
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
node sweep.mjs --sizes 2,5,10 --repeats 3    # each size three times, one table
node teardown.mjs                            # only after an interrupted run
```

A run removes its machines when it ends, and every machine is created with a deletion
timer (`--ttl`, three hours by default) in case the run never gets that far. Machines
are named `archon-scale-…` and labelled `purpose=archon-scale`; nothing else in the
account is touched. `--keep yes` leaves a run's machines up for inspection.

Five nodes for the six minutes of a run cost a few cents, and forty nodes for
fifteen minutes about thirty.

## What a run measures

`results/<run>.json`, and a summary on the terminal:

- **Time to reach every node.** For each identity, from the moment it was submitted
  to the moment the slowest node first resolved that version of it.
- **Messages for each operation.** The mediators' relayed, received and duplicate
  counts over the run, summed across the nodes.
- **Connections.** What each node's mediator reported when the load began, and how
  long the nodes took to get there. A run does not wait for every node to hold every
  peer: it goes on once no node's count has changed for two minutes. The count can
  exceed the number of peers, because a mediator that rejoins the swarm does so as a
  new peer.
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

The exception is the network of the Hyperswarm mediator. Machines on one boxd host
reach the internet through one public address. Hyperswarm connects two peers behind
one address over their local network, each choosing the other's local address that
most resembles its own. A stock node's mediator sits on a Docker bridge, so the
address it offers is a bridge address, which is the same on every machine, and the
two never connect. `node/configure.sh` therefore runs the mediator on the host's
network and gives each machine's bridge a subnet of its own.

This is not peculiar to boxd. Two stock nodes behind any one public address, such as
two on one office network, are in the same position (#1631).

## A run must be on one host

boxd places the machines of a region on several hosts, each with a private network
and a public address of its own, and the placement cannot be chosen. Machines on
different hosts do not connect to each other over Hyperswarm. A script with nothing
of Archon in it shows the same, with the mediator's network changed or stock: two
machines on one host connect in two seconds, and two on different hosts had not
connected after seven minutes.

A run spread over two hosts therefore comes up as two networks, and looks as if the
network had split. Every run records its nodes' addresses in `addresses`, counts the
hosts in `hosts` and says so in its summary. A run with more than one host measures
the placement and nothing about the node.

## Results so far

Experiment A on 2026-11-16: v0.14.1, region `fra`, 60 identities at one a second into
the first node, three runs at each size. Results files are not kept in the repository.

| Nodes | Nodes reached | Reached every node | p50 | p95 | Relayed per operation | Duplicate batches per operation | Connections per node |
|---|---|---|---|---|---|---|---|
| 2 | 2 | 60 of 60 | 0.6 s | 1.6 s | 0.5 | 0.0 | 1 |
| 2 | 2 | 60 of 60 | 0.9 s | 1.7 s | 0.5 | 0.0 | 1 |
| 2 | 2 | 60 of 60 | 1.1 s | 2.1 s | 0.5 | 0.0 | 1 |
| 5 | 5 | 60 of 60 | 1.2 s | 2.0 s | 5.4 | 3.1 | 2 to 4 |
| 5 | 5 | 60 of 60 | 1.1 s | 2.1 s | 3.3 | 1.0 | 1 to 3 |
| 5 | 5 | 60 of 60 | 1.2 s | 2.2 s | 6.3 | 4.0 | 3 to 4 |
| 10 | 10 | 60 of 60 | 1.3 s | 2.1 s | 11.0 | 6.0 | 1 to 8 |
| 10 | 10 | 60 of 60 | 1.0 s | 1.8 s | 29.6 | 22.7 | 5 to 11 |
| 10 | 10 | 60 of 60 | 1.1 s | 2.0 s | 14.1 | 9.0 | 2 to 8 |
| 40 | 40 | 60 of 60 | 1.3 s | 2.3 s | 198.5 | 172.0 | 4 to 21 |

"Nodes reached" counts the first node and every node that saw the identities. The
message counts are summed over all the nodes of a run.

Five more runs, three at twenty nodes and two at forty, reached only part of the
network: 10, 9 and 10 of 20 nodes, and 15 and 12 of 40. They were made before the
harness recorded hosts, and they are left out of the table because they were almost
certainly spread over two hosts. A later forty-node run that reached 25 nodes had 25
on one host and 15 on another.

The same day, with the mediator of #1637 laid over the release and a fixed
five-minute wait, three runs at each of twenty and forty nodes reached every node:

| Nodes | Reached every node | p50 | Relayed per operation | Duplicate batches per operation | Connections per node |
|---|---|---|---|---|---|
| 20 | 60 of 60 | 0.7 s | 172.6 | 157.1 | 14 to 19 |
| 20 | 60 of 60 | 1.3 s | 149.6 | 135.0 | 11 to 19 |
| 20 | 60 of 60 | 1.0 s | 160.0 | 145.0 | 15 to 18 |
| 40 | 60 of 60 | 1.3 s | 739.5 | 689.9 | 33 to 39 |
| 40 | 60 of 60 | 1.3 s | 706.9 | 658.9 | 31 to 39 |
| 40 | 60 of 60 | 1.4 s | 738.6 | 688.8 | 33 to 39 |

- **Every identity reached every node** in every run that is known or presumed to
  have been on one host, from two nodes to forty.
- **Time did not grow with size.** The median stayed near one second.
- **Messages grew with the square of the network.** A nearly complete mesh of twenty
  nodes relayed about 160 messages for each operation and one of forty about 730,
  more than nine in ten of them duplicates (#1639).
- **Messages follow the connections.** The earlier forty-node run, with 4 to 21
  connections a node, relayed 198.5.
- **Identical starts gave different meshes.**

All of the runs above cost an estimated $2.85 on boxd.
