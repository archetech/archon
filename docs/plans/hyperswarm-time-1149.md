# Hyperswarm historical time (#1149)

## Decision

On 2026-09-18 the maintainer selected operation proof times, rather than node-local
receipt times, for Hyperswarm historical selection. Implement this in both ports
without introducing controller-version fields, consensus, timestamp-signing
requirements, backdating safeguards, or a new protocol version. #1185 remains an
optional design proposal; #1156 remains paused.

For each event whose registry is `hyperswarm`, use `operation.proof.created` for
`versionTime` comparison and resolved `updated`/`deleted` metadata. Keep creation
metadata, local events, and anchored registry timestamps/ordinal rules unchanged.
Proof timestamps are compared at millisecond precision with offsets accounted for;
the existing accepted RFC 3339 leap-second grammar is supported in both ports.

`previd` still determines predecessor order. Historical resolution stops at the
first operation past the cutoff and never applies a successor while omitting its
predecessor. It does not sort by proof time. Stored event timestamps and signed
operation bytes are not rewritten. Existing candidate recovery revises projections;
there is no additional full-history pass or new per-operation history scan.

This applies to legacy and modern proofs. Legacy proof times remain unsigned.
The rule makes historical selection independent of receipt clocks for the same
accepted history; it does not resolve competing branches or establish trusted
wall-clock chronology.

## Observed production impact

Isolated replay used the saved read-only snapshot completed on
2026-09-17T23:49:28Z, including its candidate journal. It did not import into,
rewrite, or restart the live node.

Compared with replay under the prior receipt-time rule:

- Accepted histories increase from 25,533 to 25,536 DIDs.
- Accepted event count increases from 40,048 to 40,054.
- Eleven asset histories change: eleven operations become accepted and five
  previously accepted deletions become invalid.
- The eleven added operations include the three blocked asset creations in #1149
  and their five deferred successors, plus three other asset deletions.
- Each of the five removed deletions has a proof time **after** its controller's
  deletion proof time. Receipt-time selection previously authorized it. Those
  assets now resolve to their preceding states; candidate evidence is retained.
- Rust replay of the affected 18-DID/42-event subset (assets plus controllers)
  produces exactly the same accepted operation sequences as TypeScript.

Local audit artifacts: `/tmp/1149-replay/changes.json`, `before.json`, `after.json`,
and `rust-affected.json`. These counts compare two replays of the same snapshot,
not a claim that the live node has already changed.

## Regression coverage

Shared signed legacy/modern fixtures cover controller deletion and rotation,
asset creation/update/deletion, late asset deletion after controller deletion,
controller-first/asset-first/reversed arrival, direct submission followed by gossip,
restart, verified and ordinary resolution, inclusive millisecond boundaries,
offsets, and leap-second proof times. Other-registry tests retain local/chain
behavior and chain-ordinal precedence. A nonmonotonic proof-time case establishes
that resolution follows a predecessor prefix rather than sorting timestamps.

Temporarily restoring receipt-time selection makes the authorization regressions
fail. Isolated live TypeScript/Rust HTTP services agree on all 24 timing scenarios.
