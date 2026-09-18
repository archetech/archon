# Protocol hardening after #1173

Current status (2026-09-18): #1158 and #1159 are complete. #1156 is paused at
the maintainer's request. #1149 is complete through #1186. #1185 controller-version references were
closed as not planned; #1180 RFC 8785 alignment is in progress. Keep
independent work in separate PRs from main; do not merge without instruction.

## Work and acceptance criteria

- [x] #1158: Shared predecessor and registration validation merged in #1174 and
  #1181. Production audit supported the approved version-1 registration checks.
- [x] #1159: Rust size counting aligned with existing TypeScript in #1184; issue
  closed. Preserve the legacy UTF-16 code-unit rule. TypeScript `maxOpBytes`,
  transport settings, and protocol-version activation were explicitly left alone.
- [ ] #1156: Paused after the key-permission audit. 276 active agents lacked
  `capabilityInvocation`; migration/enforcement remains undecided. Do not resume
  implementation or activate a new protocol version without instruction.
- [x] #1149 (merged in #1186): Use each Hyperswarm operation's
  `proof.created` for historical cutoffs and update/deletion metadata, keeping
  `previd` ordering, operation bytes, and ordinals. Correct event envelopes in
  the mediator and Gatekeeper import/recovery, keeping resolution registry-neutral. Cover controller rotation/deletion,
  asset genesis and successors, arrival order, restart, and both proof formats in
  both ports. Keep chain/local behavior unchanged; add no speculative safeguards.
  See [the decision and production replay results](hyperswarm-time-1149.md).
- [ ] #1160: Consolidate established transition rules. Update relevant timing
  documentation with #1149, without inventing additional acceptance restrictions.
- [ ] #1180 (implementation in progress): RFC 8785 in both ports, including
  UTF-16 code-unit ordering. Production audit found no affected genesis or
  signing bytes, and three numeric-key updates on two assets. Preserve existing
  content-backed aliases and test fresh-node import. See [audit and validation](canonicalization-1180.md).
- [x] #1185: Closed as not planned after #1186 addressed the motivating defect.
  Explicit controller-version references can be reconsidered for a concrete need.

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

At the initial assessment, five issues were open: #1149, #1156, #1158, #1159, #1160. #1158's original
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

The 2026-09-18 Hyperswarm decision separately changes historical time selection
under version 1: replay uses proof times and may revise accepted asset history.
The [#1149 replay report](hyperswarm-time-1149.md) records the observed additions
and invalidated deletions. This does not authorize stricter key permissions,
new size limits, or a controller-version protocol change.

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
- Subsequently, #1156 was paused and #1159 closed through the narrow Rust parity
  repair in #1184. No new protocol version was enabled.
- On 2026-09-18 the maintainer selected proof-time resolution for Hyperswarm
  (#1149), retaining predecessor order. #1185 records that explicit controller
  references are a separate option. Legacy unsigned proof times remain accepted;
  this is a shared historical-selection rule, not a new trusted chronology claim.
