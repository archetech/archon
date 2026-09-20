# Agent receipt-view audit (A3)

This correction advances A3 of the [fixed completion contract](protocol-convergence-completion.md).
It does not complete the agent-state/stopping theorem or the B1 controller-selection proof.

## Demonstrated failure

A signed Hyperswarm agent migrates to `ZEC:testnet` while rotating its key, then
publishes an unconfirmed update. Nodes receive the same gossip and wrong-registry
`BTC:signet` receipts in different orders. Both settle to the same operation IDs,
DID document, data, registration, and confirmed prefix. One keeps a gossip receipt
for the unconfirmed update; the other keeps its wrong-registry chain receipt.

Previously, `isAnchored` examined every non-local/non-Hyperswarm stored receipt,
including that suffix. One node therefore selected the controller at an asset's
block time; the other used the asset's earlier proof time. The real signed asset
was rejected on one and accepted on the other, even after repeat delivery and
restart. This disproves treating all differing first-observation metadata as
harmless without checking its authorization consumers.

## Correction to the existing rule

The scheme already requires the controller's **confirmed history** to be
chain-anchored. Both implementations now walk that prefix with each version's
expected registry and stop at the first unconfirmed successor. `pin` receipts are followed as expected-registry confirmations but carry no
chain anchoring requirement or authority. Matching chain
receipts within the prefix must all carry registration metadata, with at least
one such receipt to establish anchoring. Genesis is admitted separately, but a
wrong-registry genesis receipt does not establish anchoring.

An unconfirmed suffix can retain different physical receipts without toggling
this eligibility decision. This fix does not turn an unconfirmed update into a
confirmed one, reject its operation, rewrite any signature/CID, or claim missing
history is complete. It adds no database reads and replaces the existing full
history filter with a prefix scan.

## Evidence

`controller-view-vectors.json` contains both proof formats and five cases:
wrong-registry suffix (proof-time fallback), genuine confirming chain receipt
(chain cutoff), a matching receipt missing registration metadata (fallback), wrong-registry
genesis (fallback), and a pin-to-chain migration (chain cutoff). The latter
uses ordinary pin receipts without registration metadata; before excluding pin
from the chain scan, those receipts incorrectly forced proof-time fallback even
after a genuine Zcash confirmation. Both signed formats reproduced that failure.
TypeScript and Rust import the same signed events in opposite dependency orders,
repeat them, reconstruct state, and check controller history, confirmed prefix,
resolved components, and asset authorization. Raw suffix receipt identity is
intentionally not asserted equal.

The general Lean result must still compose this confirmed-prefix view with
integrated agent selection and prove full modeled stopping. The signed cases are
translation/regression evidence, not universal runtime refinement.
