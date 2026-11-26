# Memeplex Indexer

Serves what has been published under [Memeplex](../../plans/memeplex-1436.md): publications, timelines, threads, ratings and tags. It reads a Gatekeeper and nothing else, applies Memeplex's rules to what the Gatekeeper resolves, and holds the result in memory.

A client reads publication state from an indexer it runs or chooses, as it reads DIDs from a Gatekeeper it trusts. Anyone can run one over the same Gatekeeper and compare: an index built from nothing equals one that has been kept up to date.

## 1. Running it

It is optional and off by default. Add `memeplex` to `COMPOSE_PROFILES`:

```
COMPOSE_PROFILES=hyperswarm,drawbridge,memeplex
```

With `drawbridge` also listed, the node offers the index publicly at `<node>/memeplex/api/v1/...` and `GET /api/v1/capabilities` reports `memeplex: true`. Without `memeplex`, the capability is `false` and the route answers 501.

The service has no volume and no database. At each start it reads every DID the Gatekeeper has, then follows the Gatekeeper's changes.

| Setting | Default | Meaning |
| --- | --- | --- |
| `ARCHON_MEMEPLEX_INDEXER_PORT` | `4233` | Port the service listens on. |
| `ARCHON_MEMEPLEX_INDEXER_HOST_BIND` | `127.0.0.1` | Host interface the port is published on. Expose the index through Drawbridge, not directly. |
| `ARCHON_MEMEPLEX_INDEXER_POLL_INTERVAL` | `5` | Seconds between polls of the Gatekeeper's changes. |
| `ARCHON_MEMEPLEX_INDEXER_GATEKEEPER_TIMEOUT` | `120` | Seconds a request to the Gatekeeper may take. |
| `ARCHON_GATEKEEPER_URL` | `http://gatekeeper:4224` | The Gatekeeper to read. Set by the compose file. |
| `ARCHON_MEMEPLEX_INDEXER_URL` | *(from the profile)* | Read by Drawbridge. Set it only to offer an indexer on another host. |

## 2. How it follows a Gatekeeper

1. It notes where the Gatekeeper's changes stand (`GET /api/v1/changes`).
2. It lists every DID (`POST /api/v1/dids`) and reads every version of each (`POST /api/v1/dids/versions`), keeping those that are Memeplex objects or grants.
3. Every poll, it asks for the DIDs changed since the last one it took in, and reads their versions again.
4. When the Gatekeeper reports a different epoch, which it does after it restarts, the indexer goes back to step 1.

Until step 2 has finished once, `GET /api/v1/ready` is `false` and every view answers 503: an index that is partly filled would report as unpublished what it has not read yet. On a node with many DIDs the first read takes a while, and the container is healthy as soon as it is listening.

What a version of a DID is, and where it was anchored, is the Gatekeeper's to say. The indexer needs a Gatekeeper that has both routes above, in either implementation.

## 3. API

All routes are `GET` and return JSON. A publication is the result of attribution for one object: its `state` (`published` or `withdrawn`), its `did`, the object as shown (`memeplex`), and the outcome of each of its versions.

| Path | Returns |
| --- | --- |
| `/api/v1/ready` | `true` once the index has read every DID the node has. |
| `/api/v1/version` | `{ version, commit }`. |
| `/api/v1/status` | `{ ready, dids, publications, lastPoll, lastRebuild }`. |
| `/api/v1/publications/:did` | The publication of an object. 404 when it has no attributed version. With `?versionId=`, the object as it was at that version, which is what a response to it cites: `current` is that version and `memeplex` what it said, with the object's own `state`. A version that is not in the history, is not attributed, or is the deletion answers 404 with `reason: "no-revision"`, and never with another version. |
| `/api/v1/timeline?author=<did>&author=…&kind=&titled=&limit=&offset=` | `{ total, publications }`: the posts, papers and replies of up to 1000 authors that are published, newest first. With `kind` parameters, only those kinds among `post`, `paper` and `reply`: an author's posts without the replies, or the replies alone. A boost is a post. With `titled=true`, of the posts only those with a title, which are articles; with `titled=false`, only those without. `limit` is 1 to 500, default 50. |
| `/api/v1/threads/:did` | The replies to an object and the replies to those, as a flat list in reading order, each with its `depth`. A withdrawn reply stays as a tombstone. |
| `/api/v1/boosts/:did` | The posts that name the object as their target. |
| `/api/v1/ratings/:did` | `{ ratings, mean }`: the rating that counts for each author, and their mean on the scale from 0 to 1. |
| `/api/v1/tags/:did` | `[{ tag, authors, applied }]`: each tag others have applied, with who applied it. `applied` is each object that applies it, `{ did, author, grant, version }`, which is what its author withdraws to take the tag away; `version` is the version of the object it was put on. |
| `/api/v1/coauthors/:did` | For a paper, how each listed coauthor stands towards the revision shown: `confirmed`, `confirmed-other` or `listed`. |
| `/metrics` | Prometheus exposition. Not reachable through Drawbridge. |

An object with no attributed version appears in no view: a claim is not a publication.

## 4. Metrics

- `service_version_info{version, commit}`
- `memeplex_indexer_dids`: DIDs the index holds.
- `memeplex_indexer_publications`: objects with an attributed version.
- `memeplex_indexer_sync_duration_seconds`: time for a poll to bring the index up to date.
- `memeplex_indexer_sync_errors_total`: polls that failed. A poll that fails is tried again at the next interval.
