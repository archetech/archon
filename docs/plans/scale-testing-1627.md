# Scale testing (#1627)

Status: experiment A is done and its results are below. The harness is in
`tests/scale`. Experiments B, C and D are not built. The path to 1,000 nodes is a
plan for review.

Archon has benchmarks for one Gatekeeper and integration tests for one node, and no
test that runs many nodes together or one node under sustained load. Scaling problems
have so far been found in production (#1332, #1188). This plan describes a set of
experiments and the harness to run them on hosted machines, away from any live node.

A first check has been made. On 2026-11-16 two nodes on [boxd](https://boxd.sh), one
in New York and one in Frankfurt, connected over Hyperswarm and each resolved a DID
the other had created within about two seconds. The details are in #1627. That
settles whether hosted machines can carry the peer-to-peer traffic; it says nothing
about scale.

## What experiment A found

Run on 2026-11-16 with 60 identities created at one a second through one node. Up to
ten nodes the runs were of v0.14.1 as released. The twenty- and forty-node figures
below are from v0.14.1 with the mediator of #1637 laid over the release's image
(`golden.mjs --mediator`), because the stock runs at those sizes were spread over two
hosts, all but one at forty nodes. The tables are in `tests/scale/README.md`.

- **Every identity reached every node,** from two nodes to forty, wherever the nodes
  could connect to each other.
- **Time did not grow with size.** The median stayed near one second.
- **Messages grew with the square of the network.** With 11 to 19 connections a node,
  twenty nodes relayed about 160 messages for each operation. With 31 to 39, forty
  nodes relayed about 730. More than nine in ten of the messages received were
  batches the node already had (#1639). By that curve a well-connected network of
  1,000 nodes would relay several hundred thousand for each operation.
- **Messages follow the connections.** The one stock forty-node run on a single host
  had 4 to 21 connections a node and relayed 198.5.
- **Two nodes behind one public address do not peer** without a change to the
  mediator's network (#1631).
- **Machines on different hosts of one boxd region do not peer at all.** Runs that
  spanned two hosts looked like a network that had split, and were first reported as
  one (#1635, closed). The harness now records each node's host.

The second prediction below is confirmed. The first has not been measured.

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
measures it from outside, by asking each node to resolve the DID at the version the
operation produced: resolution takes a `versionId`, and the operation's CID is that
ID. The operation has arrived when the node answers with that version.

Two simpler checks would give wrong results:

- **Whether the DID resolves.** A node that is behind still answers with the previous
  version, which would count an update as arrived before it had.
- **Whether the latest version is the submitted one.** Under a steady stream of
  updates a node can pass through a version between two polls, so an operation that
  did arrive would never be seen.

## Harness

Under `tests/scale/`, driving the host's command line.

1. **A golden machine.** A machine with the repository cloned at the release tag and
   the release's images pulled by digest, saved as a snapshot before the node is first
   started. A node generates its
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
- **One host's network.** A valid run on boxd has every node on one host's private
  network, with no address translation between nodes and almost no delay. That is
  kinder than the internet, and it measures message counts better than it measures
  how a network forms.
- **No choice of host.** boxd decides where a machine lands. Up to forty machines
  have landed on one host, and eighteen have been split over two. Larger runs will
  span hosts more often, and a run that does is discarded.
- **IPFS peering is unverified.** In the two-node check one mediator reported an IPFS
  peer and the other reported none. That needs settling before experiment C, where
  operations may be fetched by reference.
- **Synthetic load.** Generated identities and updates do not have the shape of real
  use: no credentials, no assets, no long controller chains.

## Toward 1,000 nodes

A thousand nodes is a stress test today and a real size for the network in the medium
term. Running that many against the present mediator would only repeat the result
above at greater cost, so the work is staged.

The design it aims at is one change to the mediator (#1639): a node holds about ten
peers however large the network is, chosen at random from a larger set it has learned
of, replaces the ones it loses, and is connected to every other node through them.

That is what removes the growth with the square of the network. A mediator sends an
operation to each of its peers, so with every node connected to every other the
messages for one operation grow with the square, and with ten peers each they grow
with the number of nodes. Two further changes were considered and left out:

- **Announcing an operation before sending it.** With ten peers a node receives an
  operation about ten times, a kilobyte each. Announcing first would cut that to
  about a fifth, at the cost of a change to the wire protocol, a record of recent
  operations in the mediator and a round trip on every hop. A node cannot import
  more than a few hundred operations a second (#1651), and at that rate the
  repeated copies are a few megabytes a second. A mediator already drops a batch it
  has seen before it reaches the Gatekeeper.
- **Taking a history from one or two peers and not from all of them.** A Gatekeeper
  recognises an event it already holds in under a millisecond, against 2.3 ms for a
  new one, so a second copy of a database costs a fraction of the first: about
  eight minutes for a million DIDs. Every peer's copy also fills in what another
  lacks. With ten peers there are ten copies however large the network is.

Either can be taken up again if a measurement shows the need: larger operations, or
what it costs a busy node to serve its database, which has not been measured.

| Stage | What runs | What it settles |
|---|---|---|
| 1. Model | The gossip rules alone, in one process, at 1,000 to 10,000 nodes, calibrated against experiment A | How many peers, how they are chosen and replaced, how much churn and how many misbehaving nodes the network tolerates |
| 2. Build | The chosen design in the mediator, with real nodes at twenty and forty on boxd | Whether the code behaves as the model does |
| 3. Mediators at 1,000 | A thousand mediator processes, each with a stand-in for its Gatekeeper and Keymaster, about fifty to a machine, on a private network with its own DHT bootstrap node | Delivery, delay, traffic and memory at that size; discovery on a topic with far more peers than a DHT node returns; many nodes joining at once; the cost of a new node's first sync |
| 4. Nodes under real conditions | Several hundred complete nodes on machines with public addresses of their own, on more than one provider and region, some behind address translation, leaving and rejoining | Whether stage 3 hid anything: peers that cannot reach each other directly, real Gatekeeper load, churn |

Stages 1 and 2 need nothing new. Stage 3 leaves boxd, because it needs machines that
can all reach each other. Stage 4 puts address translation back, at a size where a
failure can still be examined.

What a run at 1,000 nodes should show. The figures are estimates to be tested by the
model, not measurements:

| | At 40 nodes today, with #1637 | At 1,000 nodes |
|---|---|---|
| An operation reaches every node | yes, where nodes can connect | yes, with a fifth of the nodes leaving and rejoining |
| Median delay | about 1.3 s | a few seconds |
| Peers per node | 31 to 39 of the other 39 | about ten |
| Messages per operation | about 730, growing with the square | about ten for each node, growing with the number of nodes |

Not yet known:

- **How much memory a mediator needs** with a fixed number of peers, which sets how
  many fit on a machine in stage 3.
- **What peers a node behind strict address translation can keep.** Two such nodes
  reach each other only through a third.
- **What it costs a node to serve its database to a peer that asks for it,** at a
  size where that takes minutes.
- **Which provider and what budget** stages 3 and 4 use. Neither is needed before
  stage 2 is done.

## Decided

- **Runs use the released v0.14.1 images.** Nothing is built. Results describe that
  release, not `main`.
  - One exception so far: the twenty- and forty-node runs of experiment A that the
    findings above cite ran the mediator of #1637, compiled from the v0.14.1 source
    with that change applied and laid over the release's mediator image. Every other
    service was the release's.
  - The Compose files name no version, so on their own they pull `latest`, whatever
    that is on the day. Checking out the v0.14.1 tag does not change that.
  - The registry carries a `v0.14.1` tag for each image. Before anything is pulled,
    the harness resolves that tag to a digest for every image a run uses and writes a
    Compose override naming each image by digest.
  - The golden machine pulls with that override, and every node is started with it,
    so a snapshot made later cannot pick up a newer release. Each results file lists
    the digests.
  - The node's configuration comes from the same tag, so the Compose files and the
    images match.
- **Order: A and B together, then D, then C.** A and B need no preparation. C waits
  until IPFS peering is settled and a way to preload a history exists.
- **Experiment A goes up to 40 nodes.** That is a starting range, not a claim about
  the network's size. The curve was not flat, and larger sizes follow the stages
  above.
- **1,000 nodes is the size to design for:** a stress test now, and a real target
  in the medium term.
- **The Rust Gatekeeper first.** It is what the live node runs. The TypeScript
  Gatekeeper is a second pass over the same experiments once the harness works.
