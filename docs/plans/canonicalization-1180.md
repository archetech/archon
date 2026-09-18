# RFC 8785 upgrade exposure audit — #1180

Read-only local Redis export, 2026-09-18 18:19:53–18:19:57 UTC.
No live history, operation, candidate, queue, or service was changed. The source
node runs Rust Gatekeeper. Its stored canonical operation IDs therefore already
match RFC 8785 for the numeric-key cases below; TypeScript-generated references
remain inside signed operations.

## Population and findings

- 25,356 accepted DIDs: 1,629 agents and 23,727 assets.
- 39,876 accepted event rows; 40,207 candidate rows across 25,956 journal DIDs.
- Zero accepted genesis identifiers differ from RFC 8785-derived identifiers.
- Zero accepted or candidate signing inputs differ between the current Rust
  serializer and RFC 8785. TypeScript signing already uses canonicalize directly.
- Zero accepted or candidate operation encodings differ between current Rust
  canonical JSON and RFC 8785 in this snapshot. This does not negate the known
  synthetic Rust number-formatting and Unicode-ordering discrepancies.
- Three updates on two asset DIDs differ between current TypeScript CID encoding
  and RFC 8785, because numeric object keys are reordered by the JSON codec.
- One accepted successor uses a TypeScript predecessor CID rather than its
  RFC 8785 counterpart. No affected agent history or genesis was found.

## Affected assets

1. `did:cid:bagaaieraasg7rfc776qrbyteqt24tgshsybi5imbvyqpcxl64t4l6cwlqq7q`
   has three accepted operations: genesis plus two updates. Both updates have
   numeric-key payloads. Version 3 signs the legacy TypeScript CID of version 2
   as its predecessor. This is the original #1176 case.
2. `did:cid:bagaaieraxm5r375oykcmtcmtk6x6c3bfxsd7tetemrb4djery4xlvp57bzpa`
   has two accepted operations: genesis plus one numeric-key update. The update
   references the unaffected genesis and remains accepted under strict matching.

Both belong to the unaffected agent
`did:cid:bagaaieraxykqfatg5w3l6gytq2wrgfvkxjgx7amnsoea6ddy2oo43me5hm4q`.

## Replay experiment

Replayed the two complete asset histories plus their controller using ordinary
TypeScript Gatekeeper startup recovery and verified resolution, in an isolated
in-memory database. Copied the candidate evidence and referenced operation cache
from the export. Temporary runtime overrides changed only CID generation to hash
canonicalize output directly with JSON codec 0x0200, and, for the strict experiment,
disabled canonicalReference alias resolution. No repository implementation was
changed, and no signed operation was rewritten.

| Mode | First asset | Second asset | Controller |
| --- | --- | --- | --- |
| Current TypeScript | version 3 | version 2 | version 1 |
| RFC 8785 with existing cached-content alias handling | version 3 | version 2 | version 1 |
| RFC 8785 with alias handling disabled | version 2 | version 2 | version 1 |

With existing alias handling, signed operations and resolved DID/document data
match baseline. Operation version IDs change as expected for affected TypeScript
updates. Without aliases, the first asset's last update is no longer accepted;
its genesis and first update survive. No DID disappears in either experiment.
The affected histories and controller were reread from live Redis afterward and
still matched the exported records exactly.

## Method and limits

Export used only SCAN, HGETALL, HGET, LRANGE and MGET, preserving raw JSON strings.
A standalone helper copied canonical_json verbatim from the Rust implementation
and used its pinned serde_json 1.0.149. It processed all accepted and candidate
operations, comparing complete operation encoding and separate proof signing
inputs against the installed TypeScript canonicalize library. SHA-256 and JSON
multicodec 0x0200 were retained when deriving corrected CIDs. Genesis checks used
actual DID suffixes; predecessor checks used the complete accepted prefix.

The export includes 39,884 referenced cache IDs, one unavailable. Every accepted
and candidate operation itself was available and audited; an absent cached
predecessor does not imply an omitted operation in the audit.

This is evidence about this node's current stored histories, not every operation
that may ever arrive from a peer. The replay checks are a focused TypeScript
migration experiment, not an implemented upgrade, cross-port end-to-end migration,
or cold synchronization proof. Existing cached aliases preserved the one legacy
predecessor locally; a fresh node without that content still needs a defined
retrieval/alias policy. Unreferenced historical operations and external clients'
saved operation-version references were not inventoried.

## Implication

The observed data does not justify broad legacy-genesis or legacy-signature
compatibility machinery. Correcting new serialization need not sacrifice any
existing DID in this snapshot. Keeping the already-existing cached-content alias
path also preserves the one affected successor. If that path is deliberately
removed, the demonstrated loss is one asset update, not an entire asset DID.
The maintainer subsequently authorized implementing the RFC 8785 correction while retaining existing content-backed aliases.

## Implementation

- Rust uses `serde_json_canonicalizer` 0.3.2, replacing the hand-written serializer.
  `serde_json` enables `float_roundtrip` explicitly: the shared RFC number example
  `333333333.33333329` exposed a parsing difference without this feature.
- TypeScript continues using `canonicalize`; operation CID generation and IPFS
  block storage now preserve its bytes, with the existing JSON multicodec and
  SHA-256. Generic JSON uploads are unchanged.
- TypeScript derives numeric-key predecessor aliases from content at evidence
  retention, matching the Rust mechanism introduced in #1179. Both fresh and
  upgraded nodes recover the existing signed predecessor without peer claims.
- There is no new legacy-genesis or legacy-signature policy. Signatures, operation
  fields, and DID identifiers are not rewritten. RFC 8785 applies to version 1.
- Shared vectors cover nested numeric keys, index boundaries, input order, UTF-16
  ordering, string escaping, negative zero, exponent boundaries, binary64 integer
  rounding, and both proof suites through generation, import, and replay.

## Validation

- Root package build and root TypeScript typecheck passed.
- Rust: 107 tests passed; 3 existing tests ignored.
- Gatekeeper/IPFS TypeScript: 770 of 772 passed in the initial full run; two
  disk-backed recovery tests timed out while Rust tests were also running.
  The entire affected recovery suite passed alone (83/83). The final canonical
  and predecessor suites, including the added disk migration test, passed (14/14).
- Complete HTTP parity passed against the production TypeScript server and Rust
  release binary using isolated JSON stores and Kubo. This includes canonical
  byte/CID fixtures, both proof suites, fresh-node legacy predecessor recovery,
  and the pre-existing authorization/history/identity checks.
- Shared fixtures regenerate identically. `git diff --check` passed.

Populated startup results are recorded below. All benchmark writes used isolated
Redis with AOF enabled; live services and Redis were untouched. Each run restored
the same accepted histories and candidate journal. The Rust measurement reaches
HTTP readiness; the TypeScript measurement runs the service's `initialize()`
sequence with in-memory IPFS, excluding HTTP/IPFS connection setup. Compare each
implementation with its own baseline, not the two timing definitions.


| Implementation | Main baseline | RFC 8785 change |
| --- | ---: | ---: |
| Rust HTTP readiness | 50.8 s | 52.9 s |
| TypeScript initialization | 44.6 s | 47.9 s |

These are single runs on a shared host, not statistical performance estimates.
Both revisions recovered 25,296 DIDs and 39,816 events, with identical status,
search, and query results within each port. Rust persisted histories are exactly
equal before/after. TypeScript's only history differences are the three expected
operation IDs; after mapping those audited IDs, all four history hashes match.
Signed operation fields, predecessor references, ordering, and metadata match.
The benchmark ran later than the exposure audit; its baseline and revised counts
are compared against the same restored snapshot and replay time window.
