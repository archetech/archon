# Scale testing (#1627)

Status: plan for review. The four decisions at the end are open.

Archon has benchmarks for one Gatekeeper and integration tests for one node, and no
test that runs many nodes together or one node under sustained load. Scaling problems
have so far been found in production (#1332, #1188). This plan describes a set of
experiments and the harness to run them on hosted machines, away from any live node.

A first check has been made. On 2026-11-16 two nodes on [boxd](https://boxd.sh), one
in New York and one in Frankfurt, connected over Hyperswarm and each resolved a DID
the other had created within about two seconds. The details are in #1627. That
settles whether hosted machines can carry the peer-to-peer traffic; it says nothing
about scale.

## What the code suggests

Two things in `services/mediators/hyperswarm/src/hyperswarm-mediator.ts` predict where
growth will cost most. They are readings of the code, not measurements, and the
experiments are aimed at them first.

- **A new connection asks for the peer's whole database.** On connecting, a node
  sends its peer a `sync` message. The peer answers by exporting every DID it knows
  (`shareDb`), in batches of 1,000, from a queue that serves one peer at a time. The
  cost of a node joining, or rejoining, therefore grows with the size of the history,
  and is paid once for each peer it connects to.
- **Operations are flooded.** A `queue` message is forwarded to every connected peer
  not yet on its relay list (`relayMsg`). In a well-connected network the messages
  sent for one operation grow with roughly the square of the number of nodes, and
  most arrive as duplicates.

## Experiments

Cheapest first. Each varies one thing.

| | Question | Varied | Measured |
|---|---|---|---|
| A | How does the network behave as it grows? | 2, 5, 10, 20 and 40 nodes, each with an empty history | Time for an operation to resolve on every node; messages relayed and duplicate batches per operation; CPU and memory per node; how many peers each node holds |
| B | What does a write load do? | 1, 10, 50 and 100 operations a second, into one node and then spread over all | Import queue depth over time; the rate at which nodes stop keeping up; which service saturates first |
| C | What does history cost? | 10 thousand, 100 thousand and 1 million preloaded operations | Time for a new node to join and catch up; Gatekeeper startup time and memory; resolution latency |
| D | What does churn cost? | Restarting one node, then a quarter of them, during a run | Traffic and time until every node agrees again |

A and B need no preparation and fit in an afternoon. C is the expensive one, because
a large history has to be created or imported before each run. D reuses the setup of
A or C.

### What is already measurable

The services export Prometheus metrics that cover most of the table.

- **Hyperswarm mediator:** `mediator_active_connections`, the import, export and sync
  queue depths, `mediator_messages_received_total`, `mediator_messages_relayed_total`,
  `mediator_operations_imported_total`, `mediator_operations_exported_total`,
  `mediator_duplicate_batches_total`, `mediator_import_batch_duration_seconds` and
  `mediator_export_db_duration_seconds`.
- **Gatekeeper:** `http_request_duration_seconds`, `http_requests_total`,
  `did_operations_total` and the `gatekeeper_dids_*` gauges.

The time for an operation to reach every node is not exported anywhere. The harness
measures it from outside, by asking each node for a DID until it resolves.

## Harness

Under `tests/scale/`, driving the host's command line.

1. **A golden machine.** A machine with the repository cloned and the images present,
   saved as a snapshot before the node is first started. A node generates its
   identity, wallet and swarm key on first start, so machines made from the snapshot
   are distinct nodes and not copies of one.
2. **A launcher.** Creates N machines from the snapshot, gives each its own node ID
   and the run's protocol name, and starts them.
3. **A load generator.** Runs on a controller machine and creates and updates DIDs
   through chosen nodes at a set rate.
4. **A collector.** Scrapes every node's metrics during the run, records the
   propagation times, and writes one results file for each experiment.
5. **Teardown.** Deletes every machine the run made, found by label.

It starts with a five-node run of experiment A, to prove the harness, before anything
larger.

## Guardrails

- **A private swarm for every run.** Each run sets `ARCHON_PROTOCOL` to a random name,
  so a test node can never join the real network.
- **Nothing from a live node.** No keys, wallets or data are copied to a test machine.
  A history for experiment C is generated, or taken from the public network's
  operations, and never from a node's private state.
- **Not on a host that runs a node.** On 2026-11-14 an image rebuild beside a mainnet
  node made its Lightning container fail its health check for about 17 minutes.
- **Machines that clean themselves up.** Every machine is created with a deletion
  timer as well as a label, so a harness that dies leaves nothing running.
- **A spending limit agreed before each run.** The two-node check cost about $0.01.
  Experiment A at 40 nodes for three hours is estimated at €5 to €20 on boxd, whose
  price depends on how busy the machines are.

## Limits of what this can show

- **No chain anchoring.** The chain mediators need their chains' nodes. Runs use the
  `local` and `hyperswarm` registries.
- **One provider's network.** Machines in one region share a private network on boxd,
  which is kinder than the internet. Some runs should span regions.
- **IPFS peering is unverified.** In the two-node check one mediator reported an IPFS
  peer and the other reported none. That needs settling before experiment C, where
  operations may be fetched by reference.
- **Synthetic load.** Generated identities and updates do not have the shape of real
  use: no credentials, no assets, no long controller chains.

## Decisions needed

1. **Which experiments first.** Proposed: A and B together, then D, then C.
2. **What scale matters.** The top of the range in A, 40 nodes, is a guess. The size
   of the real network today and the size it should be able to reach set that number.
3. **Released images or `main`.** The first check ran the released v0.14.1 images.
   Proposed: build `main` once on a hosted machine and snapshot it, so results describe
   current code.
4. **Which implementations.** Proposed: the Rust Gatekeeper first, since that is what
   the live node runs, with the TypeScript one as a second pass once the harness works.
