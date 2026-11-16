# Memeplex sizing

What a node costs when it holds Memeplex objects (`docs/plans/memeplex-1436.md`): the
first milestone of that plan, begun at a small size to find out what the full sizes
need.

- `objects.mjs` builds signed operations: users, the clients they publish through, a
  grant for each user, and objects of every kind in a fixed mix. A DID is the CID of
  its create operation, so the operations name each other before any is submitted.
- `load.mjs` submits them to a Gatekeeper at `POST /api/v1/did`, the route a
  Keymaster uses, checks that the node gives each the DID computed here, and records
  the rate.
- `measure.mjs` times resolving an object and the design's two main queries, by
  author and by target.
- `pilot.sh` runs on a machine with a node on it. It loads in stages and after each
  records memory, storage, the times above and how long the Gatekeeper takes to be
  ready after a restart.

The mix, in a thousand objects: 330 short posts, 300 reactions, 170 replies, 80 tags,
70 ratings, 30 boosts, 17 articles and 3 papers, with about a hundred objects for each
author. A response aims at an earlier post, article or paper, chosen so that a few
collect most of the responses. Articles and papers name content by CID without
storing it. There are no edits, deletions or revocations.

`load.mjs` and `measure.mjs` need the `@didcid` packages, so they run in the
repository or in a node's `cli` container.

## First run

2026-11-16: one stock v0.14.1 node (Rust Gatekeeper, Redis) on an 8-core, 32 GB boxd
machine, objects on the `hyperswarm` registry, four loaders at once.

| Objects | Gatekeeper memory after a restart | Redis memory | Data on disk | Restart until ready | Query by author | Query by target | Resolve | Created a second |
|---|---|---|---|---|---|---|---|---|
| 10,000 | 544 MB | 70 MB | 55 MB | 5.8 s | 21 ms | 18 ms | 0.6 ms | 733 |
| 100,000 | 4.7 GB | 490 MB | 524 MB | 44.5 s | 206 ms | 197 ms | 0.6 ms | 622 |
| 300,000 | 11.1 GB | 1.3 GB | 1.6 GB | 130 s | 528 ms | 533 ms | 0.6 ms | 736 |

Times are medians. The node also held the authors' DIDs, three for each author, so it
had 11,373, 104,085 and 310,097 DIDs at the three sizes. A create operation averaged
945 bytes.

- **The Gatekeeper held 36 to 48 KB of memory for each DID** (#1642). A million
  objects would need about 36 GB, which is why the run stopped at 300,000.
- **A query took time in proportion to the node's size,** whatever it matched
  (#1643).
- **Restart time grew with the node,** at about 0.4 ms for each DID.
- **Resolving an object did not grow.**
- **The Hyperswarm mediator ran out of memory** during the third stage and exited
  (#1644). From then on nothing drained the registry's queue, so the Redis and disk
  figures at 300,000 include it.

The third stage was measured by hand: the script of the time stopped when it could
not read the memory of the exited mediator. The run cost an estimated $0.12.

Not measured: the TypeScript Gatekeeper, propagation to a second node, anchoring on a
chain, edits and deletions, and anything an indexer does.
