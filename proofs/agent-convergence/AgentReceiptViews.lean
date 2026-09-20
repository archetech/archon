import AgentColdRecords
import ReceiptViews

set_option warningAsError true
namespace Archon

/-- The fields of an authoritative chain receipt read by controller-history
selection. Transaction labels and arrival bookkeeping do not participate. -/
structure ChainReceiptView where
  registry : Nat
  ordinal : List Nat
  time : Int
  registration : Bool
  deriving DecidableEq

/-- A matching unanchored receipt uses the operation's intrinsic clock. Chain
receipts use the agreed chain facts for their normalized receipt class. -/
inductive ReceiptCutoffView where
  | unconfirmed
  | unanchored (registry : Option Nat) (time : Int)
  | chain (receipt : ChainReceiptView)
  deriving DecidableEq

structure AgentReceiptView where
  operation : Nat
  matching : Bool
  cutoff : ReceiptCutoffView
  deriving DecidableEq

/-- Headers belong to the agreed source facts, indexed by normalized receipt
class; payload is the remaining first-observation bookkeeping. A provisional
representative is not an additional chain receipt. -/
def agentReceiptView (a : AnchorModel) (expected : Nat → Option Nat)
    (operationTime : Nat → Int) (chainFacts : Nat → ChainReceiptView)
    (record : EventRecord α) : AgentReceiptView where
  operation := chainOwner a record.opid
  matching := record.expected
  cutoff := if record.expected then
      if record.opid < a.size then .chain (chainFacts record.opid)
      else .unanchored (expected (chainOwner a record.opid))
        (operationTime (chainOwner a record.opid))
    else .unconfirmed

theorem agent_receipt_view_class (a : AnchorModel) (expected : Nat → Option Nat)
    (operationTime : Nat → Int) (chainFacts : Nat → ChainReceiptView)
    (left right : EventRecord α) (rank : left.opid = right.opid)
    (flag : left.expected = right.expected) :
    agentReceiptView a expected operationTime chainFacts left =
      agentReceiptView a expected operationTime chainFacts right := by
  simp only [agentReceiptView, rank, flag]

/-- Root admission is separate; every later receipt must remain in the
confirmed prefix. The root's matching flag is retained for anchoring eligibility. -/
def confirmedReceiptView : List AgentReceiptView → List AgentReceiptView
  | [] => []
  | root :: rest => root :: rest.takeWhile AgentReceiptView.matching

/-- Integrated cold reconciliation converges on the authorization-relevant
source view as well as operation/component state. Same first-observation payloads
are not a premise. Source projection must bind the chain and operation-clock tables
to authoritative anchors and complete operation content, respectively. -/
theorem component_cold_same_receipt_view [DecidableEq α] (g : DocumentGraph)
    (patch : Nat → ComponentPatch D R) (registry : R → Nat) (initial : R)
    (r : RegistryReceipts) (operationTime : Nat → Int) (chainFacts : Nat → ChainReceiptView)
    (ordered : AncestryOrdered (documentAgent g)) (bounded : DepthBounded (documentAgent g))
    (xs ys : List (EventRecord α))
    (sameRanks : ∀ i, i ∈ recordIds xs ↔ i ∈ recordIds ys)
    (sameMatching : ∀ i, i ∈ matchingRanks xs ↔ i ∈ matchingRanks ys) :
    let a := componentAnchors g patch registry initial r
    let m := coldComponentEvents g a
    let view := agentReceiptView a (expectedRegistry (componentRegistry g patch registry initial))
      operationTime chainFacts
    (stopWhenStable (rankedPass m (chainOwner a) g.size xs) (m.size + 3) []).map
        (fun records => confirmedReceiptView (records.map view)) =
      (stopWhenStable (rankedPass m (chainOwner a) g.size ys) (m.size + 3) []).map
        (fun records => confirmedReceiptView (records.map view)) := by
  let a := componentAnchors g patch registry initial r
  let view := agentReceiptView a (expectedRegistry (componentRegistry g patch registry initial))
    operationTime chainFacts (α := α)
  have equal := cold_ranked_same_view (coldComponentEvents g a) (chainOwner a) g.size xs ys
    view (cold_component_descending g a ordered bounded) sameRanks sameMatching
    (fun left _ right _ rank flag => agent_receipt_view_class a _ _ _ left right rank flag)
  have projected := congrArg (Option.map confirmedReceiptView) equal
  simpa only [Option.map_map, Function.comp_def, coldComponentEvents, withGenesis,
    ↓reduceIte, Nat.add_assoc] using projected

end Archon
