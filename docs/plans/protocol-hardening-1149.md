# Protocol hardening after #1173

Approved implementation order: #1158, then #1156, then #1159. Update the relevant
#1160 transition documentation with each change. Investigate #1149 separately
before proposing new unanchored-history semantics. Use separate branches/PRs
from main for independently reviewable work; do not merge without instruction.

## Work and acceptance criteria

- [x] #1158 (merged in PR #1181): Reproduce current direct-submission behavior; share predecessor and
  resulting-state validation across direct submission, import, and verified
  replay. Reject invalid direct transitions before storage/queue side effects.
  Preserve candidate predecessor selection, competing branches, cached retrieval
  aliases, self-controlled agents, agent-owned assets, and registry migration.
  Decide historical compatibility before adding new registration restrictions.
- [ ] #1156: Enforce operation-key authorization relationships in both ports;
  distinguish key publication from permission to control a DID. Specify legacy
  proof/document compatibility and cover encryption-only and signing-only keys.
- [ ] #1159 (implementation ready for review): Preserve the version-1 UTF-16
  count including proof and align Rust; separate protocol validity from configurable
  submission/transport limits. Shared tests cover ASCII, multibyte, supplementary,
  escaped, exact-limit and over-limit cases. Stricter UTF-8 enforcement is deferred
  to a future version under the explicit compatibility decision.
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

Preserve historical acceptance and explicitly version stricter key-permission and
byte-limit rules. Select any future policy from immutable creation version, not
mutable registration metadata, local receipt time, or node configuration. Version 2
remains reserved and disabled until its contract is complete.

Registration is the approved exception: on 2026-09-17, the user authorized version-1
checks after a clean production audit and confirmed that other nodes share the same
database. See the [registration decision](registration-hardening-1158.md).

## First implementation step

Merged #1174 added a shared predecessor check before direct submission writes/queues.
Signed modern-suite regressions reproduced false success for missing, malformed,
unknown, and stale predecessors before that fix and now verify their rejection.
Imports must still retain successors whose predecessors are not yet available and reconsider them later.
This step does not activate version 2 or close the registration-validation portion
of #1158. Registration is completed by #1181 under the audited version-1 policy above.
Key permissions and byte limits remain separate, with #1160 documenting the contract.

## Progress after #1179

- #1174 merged the shared predecessor check before direct submission writes. The
  historical reproduction in the initial assessment above predates that fix.
- #1179 merged the narrow Rust repair for TypeScript numeric-key predecessor
  references. It did not change generated IDs. Broader CID consistency is tracked
  separately in #1180 and is not a prerequisite for registration enforcement.
- PR #1181 now enforces the [registration contract](registration-hardening-1158.md)
  in version 1 in both ports. A production audit found no malformed registrations;
  the user confirmed the other nodes share the database and approved enforcement
  without introducing version 2. This supersedes the earlier versioned-only
  decision for registration, not for key permissions or byte limits.
- Shared signed fixtures cover submission, import, resolution, restart, and repair
  of malformed old projections. Production-copy replay checks accepted histories
  before/after enforcement. Version 2 remains disabled.
- #1156 is paused at the user's request while authorization/migration alternatives
  are considered. No permission enforcement or protocol-version activation is approved.
- #1159 proceeds independently under the explicit decision to preserve version 1:
  align Rust with TypeScript's historical UTF-16 count, separate local limits from
  protocol validity, and leave strict UTF-8 enforcement for a future version. See
  [the size decision](operation-size-1159.md). Keep CID alignment separate.
