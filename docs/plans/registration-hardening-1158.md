# Registration transition hardening (#1158)

Status: implemented for version 1 in PR #1181, following the predecessor fix in
#1174. Version 2 remains disabled. This supersedes the earlier versioned-only
registration proposal with the user's approval after auditing production history.
Key permissions (#1156), byte limits (#1159), CID consistency (#1180), receipt-clock
ordering (#1149), and retry classification (#1178) remain separate work.

## Compatibility decision

The read-only production audit on 2026-09-17 found 25,593 accepted DIDs, 40,107
accepted events, and 14,418 updates, including 289 registration replacements.
There were no malformed genesis or update registrations under the rules below.
The candidate journal contained four unique candidate-only updates, including two
registration replacements; none violated these rules either. All operations were
available, and repeated reads detected no changed, added, or removed histories.
The user confirmed that the other production nodes share this database and approved
version-1 enforcement. Previously permissive cases were synthetic test inputs.

Malformed registration histories that were previously accepted are now rejected
on replay. No such history was found in the audited production database. This is
an explicit registration-only compatibility decision, not a general authorization
to tighten key permissions or byte limits without their own compatibility policy.

## Enforced registration rules

| Field or component | Version-1 rule |
| --- | --- |
| Registration component | Genesis requires an object. An update may omit it to retain the previous component; if supplied, it must be an object and replaces the entire component. Null, arrays, and scalar replacements are invalid. |
| `version` | Required integer `1`; every replacement must match immutable genesis. Editing metadata cannot activate another protocol version. |
| `type` | Required `agent` or `asset`, matching immutable genesis. Existing self-control and agent-owner rules continue to apply. |
| `registry` | Required string of 1–128 characters matching `[A-Za-z0-9][A-Za-z0-9:_-]*`. May change under existing registry-migration rules. This is not a chain allowlist. |
| `prefix` | Optional at creation. Replacements preserve its genesis presence and value. No additional creation-prefix grammar is introduced. |
| `validUntil` | Optional string using the shared RFC 3339 timestamp grammar. Null, numbers, empty strings, and malformed timestamps are invalid. Omission in a complete replacement removes expiry; a valid value may change. |
| Extension members | Allowed; this change adds no restriction on unknown members. |

JavaScript optional members set to `undefined` serialize as omission. Local SDK
calls retain that behavior for optional expiry, prefix, and registration components. Registration omission is distinct
from a partial replacement: `{ "registry": "hyperswarm" }` drops required fields
and is invalid.

Configured registry support remains a local submission/distribution constraint;
imports may use well-formed registry names that the node does not support locally.
Migration authorization and confirmation ordering are unchanged. Expiry syntax
validation adds no wall-clock, proof-time, or anchor-time enforcement and does not
redefine garbage collection.

## Validation placement and evidence

Validation runs at the shared operation/event authorization boundary before
acceptance, using the existing genesis lookup for immutable version, kind, and
prefix. Direct malformed updates fail before operation storage or queue writes.
Import and startup recovery keep candidate evidence and use the same validation;
missing predecessor recovery and competing-branch selection remain intact.
Cryptographic proof verification gains no history lookup responsibilities.

Shared signed fixtures cover omission, complete replacement, expiry removal and
syntax, invalid field types, version/kind/prefix changes, extension members, and
registry migration. Both ports exercise direct submission, import, verified and
ordinary resolution, restart, and repair of pre-existing malformed projections.
Rejected direct submissions are checked for database side effects. Older migration
and controller fixtures now supply complete registrations; deterministic synthetic
fixture generators are checked in so future updates can be reproduced.

Production replay uses a read-only exported copy and isolated storage, comparing
accepted histories before and after enforcement in each port. No live-node writes
or restart are needed for this check.

The 2026-09-17 before/after runs produced identical accepted histories for all
25,593 DIDs and 40,107 events in each port. TypeScript's isolated Redis DB check
was 45.2s before and 45.7s after with identical storage-call counts; Rust's
unoptimized startup test was 281.4s before and 268.4s after. These local timings
are observational, not deployment-time guarantees. The TypeScript Gatekeeper
suite passed 681 tests; the Rust library suite passed 67 tests (three benchmarks
ignored). Build, root typecheck, and focused lint passed; lint retains one existing
startup-loop warning. Two tests exceeded their default five-second timeout during
concurrent benchmarking; the complete TypeScript rerun with a 20-second allowance
passed without changing repository timeout configuration.
