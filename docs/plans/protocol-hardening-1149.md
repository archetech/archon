# Protocol hardening after #1173

Approved implementation order: #1158, then #1156, then #1159. Update the relevant
#1160 transition documentation with each change. Investigate #1149 separately
before proposing new unanchored-history semantics. Use separate branches/PRs
from main for independently reviewable work; do not merge without instruction.

## Work and acceptance criteria

- [ ] #1158 (in progress): Reproduce current direct-submission behavior; share predecessor and
  resulting-state validation across direct submission, import, and verified
  replay. Reject invalid direct transitions before storage/queue side effects.
  Preserve candidate predecessor selection, competing branches, cached retrieval
  aliases, self-controlled agents, agent-owned assets, and registry migration.
  Decide historical compatibility before adding new registration restrictions.
- [ ] #1156: Enforce operation-key authorization relationships in both ports;
  distinguish key publication from permission to control a DID. Specify legacy
  proof/document compatibility and cover encryption-only and signing-only keys.
- [ ] #1159: Specify a common serialization and UTF-8 byte limit including proof;
  separate protocol validity from configurable transport/resource limits. Cover
  ASCII, multibyte, supplementary, escaped, exact-limit and over-limit vectors.
  Decide replay compatibility for previously accepted oversized operations.
- [ ] #1160: Consolidate normative transition rules as the implementations settle:
  identity/predecessor, immutable fields, component replacement/omission,
  authorization, migration, deletion/revalidation, protocol version and expiry.
  Do not invent restrictions just to reconcile old prose.
- [ ] #1149: Reproduce historical hyperswarm resolution divergence on current
  code with identical operations and differing node receipt clocks. Evaluate
  explicit unanchored-history policies; signed time alone cannot prevent
  backdating by a retired key. Do not silently choose a protocol change.

## Validation and constraints

Use shared signed regression cases across TypeScript and Rust, test direct
submission/import/restart and verified resolution, and keep authorization at the
operation/event boundary rather than in cryptographic proof verification. Run
focused checks before broader suites; build packages before root typechecking.
Preserve the sovereign-node policy: unavailable batches are skipped and retried,
authorization is revisable with available evidence, and agents are self-controlled.
Keep populated-node startup/sync costs bounded; no new full-history scans in the
per-operation path. User confirmed #1173 DB check at 37.607 seconds on Redis.

## Initial assessment (2026-09-17)

Five issues remain open: #1149, #1156, #1158, #1159, #1160. #1158's original
accepted-until-restart description needs refreshing: direct updates now trigger
immediate reconciliation, but still append/queue before predecessor validation.
Closed #1150–#1152, #1157, #1164, #1166, #1168 and #1170 are covered by merged work.

## Approved compatibility policy

Preserve historical acceptance and explicitly version stricter rules. Registration
version 1 must not acquire new registration, key-relationship, or byte-limit
rejections during replay. The new policy should be activated by immutable creation
version, not a mutable registration field, local receipt time, or node configuration.
Reserve version 2 for a cohesive set of stricter rules; do not enable a partially
specified version and tighten it in subsequent patches.

## First implementation step

A shared predecessor check enforces an existing rule before direct submission
writes/queues. Signed modern-suite regressions reproduce false success for missing,
malformed, unknown, and stale predecessors on main. Imports must still retain
successors whose predecessors are not yet available and reconsider them later.
This step does not activate version 2 or close the registration-validation portion
of #1158. Registration, key permissions, and byte limits belong to the coordinated
versioned follow-up, with #1160 documenting the complete contract before activation.

## Numeric-key identity repair (#1176)

Hash/store canonical JSON bytes directly. Derive historical TypeScript numeric-key
references from complete operations; preserve old genesis identifiers and signed
successors while generating canonical identifiers for new genesis records. Repair
uses the existing candidate preparation pass and bounded per-operation work.

The serializer audit also demonstrated Rust/JCS number formatting and UTF-16 key
ordering gaps (examples in the Gatekeeper service specification §4.1). Include
these in #1159's serialization work, with explicit compatibility for historical
proof hashes and CIDs before changing the shared Rust serializer. Numeric-key
fixtures alone are not evidence of full JCS conformance.
