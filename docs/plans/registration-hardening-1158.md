# Registration transition hardening (#1158)

Status: proposal for the reserved stricter protocol version. This document does
not activate version 2 or change version-1 acceptance. It completes the
registration investigation following the predecessor fix merged in #1174.

## Verified version-1 behavior

The shared signed fixture `tests/gatekeeper/registration-transition-v1-vectors.json`
covers direct submission, import, ordinary/verified resolution, and startup replay
in TypeScript and Rust. Each case starts from an agent genesis with version 1,
registry `hyperswarm`, and a valid future expiry. These are synthetic cases; they
do not establish that every accepted shape exists in anchored production history.

| Update | Existing outcome |
| --- | --- |
| Omit `didDocumentRegistration` | Retain the previous registration, including expiry. |
| Supply only `{ "registry": "hyperswarm" }` | Replace the entire registration; omit version, kind, and expiry from the resulting component. |
| Supply version `999` and expiry `"not-a-date"` with a supported registry | Accept and retain both values. |
| Supply version `2` on a version-1 DID | Accept that metadata value; it does not create a version-2 genesis or enable a new protocol. |
| Supply string version `"1"` and `null` expiry | Accept and retain those values. |
| Omit registry from the supplied component | Accept the replacement; the resulting registration has no registry. |
| Supply a different prefix | Accept the metadata change; the DID identifier stays unchanged. |
| Change kind from agent to asset | Reject; authorization already derives kind from genesis. |

A new genesis with version 2 is rejected in both ports. The fixtures preserve that
boundary. Unsupported-version metadata in an update must never become an implicit
activation mechanism for future rules.

A supplied registration **replaces the component**; omission preserves the
component. It is not a field-level merge. An omitted registry can consequently
leave a DID without the registry needed by later direct submission. Fixing those
shapes by newly rejecting version-1 replay would violate the approved historical
compatibility policy.

## Proposed stricter registration rules

Apply these rules only after a cohesive version-2 contract is agreed and implemented.
For an existing DID, select policy from the accepted genesis operation's version,
never from a mutable resolved registration field, the controller's version, local
receipt time, or node configuration. Creation selects policy from its own signed
registration. A version-1 update claiming version 2 continues to use version-1 rules.

| Field or component | Proposed version-2 rule |
| --- | --- |
| Registration component | Genesis requires an object. An update may omit it to retain the previous component; if supplied, it must be an object and replaces the entire component. Reject null, arrays, and scalar replacements. |
| `version` | Required integer `2`; cannot change or disappear in a replacement. This describes the immutable genesis-selected protocol, not an upgrade request. |
| `type` | Required `agent` or `asset`; every replacement must match the genesis kind. Existing self-control and agent-owner rules continue to apply. |
| `registry` | Required string satisfying the shared registry-name grammar. It may change under the existing registry-migration rules. It is not a closed chain allowlist. |
| `prefix` | Optional at creation. A replacement must preserve its genesis presence and value; registration edits cannot change the DID namespace. Specify any additional creation-prefix grammar separately rather than inventing it here. |
| `validUntil` | Optional RFC 3339 string, using the shared timestamp grammar. Reject nonstrings and malformed timestamps. Omission in a replacement removes the expiry; a valid value can change. No monotonic-expiry restriction is proposed. |
| Extension members | No new restriction proposed here. Additional constraints require an explicit rule; do not infer them from this table. |

The prefix rule prevents replacement metadata from claiming a namespace different
from the one used to generate the immutable DID; the version-1 fixture demonstrates
that those values can currently disagree. This is a proposed new-version constraint,
not a reason to reject that existing version-1 history.

Registry support configured on a node remains a local submission/distribution
constraint. It must not make an otherwise valid imported registration invalid.
A migration is authorized against the selected predecessor and follows the existing
confirmation ordering; this proposal does not change which chain confirms it.

Expiry syntax is distinct from expiry enforcement. This step introduces no new
rejection based on the current wall clock, proof time, or anchor time, and does not
redefine garbage collection. Those semantics must be stated in the coordinated
#1160 contract before activation.

## Validation placement

Validate the resulting registration at the shared operation/event authorization
boundary, after selecting the predecessor and before accepting the transition.
Direct submission supplies its current head and must reject a malformed new-version
transition before operation storage or queue writes. Import/replay supplies the
candidate predecessor; missing evidence remains deferred and candidates remain
available for later revalidation. Proof verification continues to receive an
explicit authority and must not gain history lookup responsibilities.

A valid replacement must be checked as a whole. Checking only fields present in
the operation would accept a replacement that drops a required field. Omission of
the entire component, in contrast, retains the validated predecessor component.

## Activation and review gates

1. Review the proposed required fields, prefix immutability, replacement semantics,
   and editable expiry. Keep the existing version-1 fixtures passing.
2. Complete the companion version-2 key-permission (#1156) and byte-limit (#1159)
   contracts and consolidate transitions in #1160. Define cross-version authority
   behavior there; this registration-only proposal does not settle it.
3. Implement the selected policy in both ports with signed positive/negative cases
   for submission, import, restart, and competing predecessors. Cover registration
   omission, complete replacement, invalid field types, version/kind/prefix changes,
   registry migration, and expiry syntax. Verify rejection precedes direct writes.
4. Enable version 2 only with the complete contract, cross-port tests, and bounded
   startup/sync validation. Do not progressively tighten a partially enabled version.

CID generation/alignment (#1180), receipt-clock ordering (#1149), and retry
classification (#1178) remain separate work. This proposal does not change their
policies or require a CID migration.
