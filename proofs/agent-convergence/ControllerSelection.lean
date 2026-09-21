import IntegratedAgentConvergence

set_option warningAsError true
namespace Archon

/-- Only receipt metadata requests the chain path. The complete operation proof
supplies the fallback clock. -/
structure ControllerRequest where
  proofTime : Int
  chain : Option ChainReceiptView
  deriving DecidableEq

inductive ControllerCutoff where
  | proof (time : Int)
  | chain (receipt : ChainReceiptView)
  deriving DecidableEq

def beforeControllerCutoff (cutoff : ControllerCutoff) : ReceiptCutoffView → Bool
  | .unconfirmed => false
  | .unanchored _ time => match cutoff with
    | .proof limit => time ≤ limit
    | .chain receipt => time ≤ receipt.time
  | .chain receipt => match cutoff with
    | .proof limit => receipt.time ≤ limit
    | .chain limit => if receipt.registry = limit.registry then
        compare receipt.ordinal limit.ordinal == .lt
      else receipt.time ≤ limit.time

/-- Genesis is admitted independently of the historical cutoff. Later events
form a prefix, never a time-sorted or filter-selected set. -/
def controllerPrefix (cutoff : ControllerCutoff) : List AgentReceiptView → List AgentReceiptView
  | [] => []
  | root :: rest => root :: rest.takeWhile
      (fun event => event.matching && beforeControllerCutoff cutoff event.cutoff)

/-- Execute the selected confirmed prefix. Missing evidence and failed execution
return none; deletion remains an explicit component state. -/
def controllerAt (g : DocumentGraph) (patch : Nat → ComponentPatch D R)
    (empty initialData : D) (initial : R) (cutoff : ControllerCutoff)
    (history : List AgentReceiptView) : Option (ComponentState D R) :=
  match controllerPrefix cutoff history with
  | [] => none
  | _ :: rest => runComponents g patch empty ⟨.active g.initialDocument, initialData, initial⟩
      (rest.map AgentReceiptView.operation)

/-- Scan the entire confirmed prefix, not the time-bounded prefix. A matching
chain receipt without registration disqualifies anchoring. Unconfirmed genesis
and unanchored receipts neither establish nor disqualify anchoring. -/
def controllerAnchored (unanchored : Nat → Bool) (selectedRegistry : Nat)
    (history : List AgentReceiptView) : Bool :=
  !unanchored selectedRegistry &&
    (confirmedReceiptView history).any (fun event => match event.cutoff with
      | .chain receipt => !unanchored receipt.registry && receipt.registration
      | _ => false) &&
    (confirmedReceiptView history).all (fun event => match event.cutoff with
      | .chain receipt => unanchored receipt.registry || receipt.registration
      | _ => true)

/-- Use chain position only when both the history and the selected version
establish anchoring. Otherwise recompute at operation proof time. -/
def selectController (g : DocumentGraph) (patch : Nat → ComponentPatch D R)
    (empty initialData : D) (initial : R) (registry : R → Nat)
    (unanchored : Nat → Bool) (request : ControllerRequest)
    (history : List AgentReceiptView) : Option (ComponentState D R) :=
  let fallback := controllerAt g patch empty initialData initial (.proof request.proofTime) history
  match request.chain with
  | none => fallback
  | some receipt =>
    if !receipt.registration then fallback else
    let bounded := controllerAt g patch empty initialData initial (.chain receipt) history
    if bounded.any (fun state => controllerAnchored unanchored (registry state.registration) history)
    then bounded else fallback

theorem controller_missing (g : DocumentGraph) (patch : Nat → ComponentPatch D R)
    (empty initialData : D) (initial : R) (registry : R → Nat)
    (unanchored : Nat → Bool) (request : ControllerRequest) :
    selectController g patch empty initialData initial registry unanchored request [] = none := by
  cases request with | mk time chain =>
    cases chain <;> simp [selectController, controllerAt, controllerPrefix]

/-- Strict same-chain ordinal cutoff; timestamp is irrelevant. -/
theorem controller_same_chain (receipt limit : ChainReceiptView)
    (same : receipt.registry = limit.registry) :
    beforeControllerCutoff (.chain limit) (.chain receipt) =
      (compare receipt.ordinal limit.ordinal == .lt) := by
  simp [beforeControllerCutoff, same]

/-- Inclusive cross-chain block-time cutoff. -/
theorem controller_cross_chain (receipt limit : ChainReceiptView)
    (different : receipt.registry ≠ limit.registry) :
    beforeControllerCutoff (.chain limit) (.chain receipt) = (receipt.time ≤ limit.time) := by
  simp [beforeControllerCutoff, different]

/-- A backdated successor cannot bypass an excluded predecessor. -/
theorem controller_prefix_stops (cutoff : ControllerCutoff) (root next : AgentReceiptView)
    (rest : List AgentReceiptView)
    (excluded : (next.matching && beforeControllerCutoff cutoff next.cutoff) = false) :
    controllerPrefix cutoff (root :: next :: rest) = [root] := by
  simp [controllerPrefix, excluded]

/-- Named-method verification reads the selected controller's actual document.
Missing or deactivated controllers cannot authorize dependent operations. -/
def controllerVerifies (g : DocumentGraph) (state : Option (ComponentState D R))
    (named : Nat) (signatureValid : Nat → Bool) : Bool :=
  match state with
  | none => false
  | some state => match state.authority with
    | .deleted => false
    | .active document => verifiesDocument (g.documents document) named signatureValid

theorem controller_deleted_rejects (g : DocumentGraph) (data : D) (registration : R)
    (named : Nat) (signatureValid : Nat → Bool) :
    controllerVerifies g (some ⟨.deleted, data, registration⟩) named signatureValid = false := rfl

theorem controller_active_verifies (g : DocumentGraph) (document : Nat) (data : D) (registration : R)
    (named : Nat) (signatureValid : Nat → Bool) :
    controllerVerifies g (some ⟨.active document, data, registration⟩) named signatureValid =
      verifiesDocument (g.documents document) named signatureValid := rfl

/-- Compose source-derived A3 receipt convergence with component execution and
controller selection. Equal authorization verdicts are not a premise. -/
theorem controller_selection_same_sources [DecidableEq α] (g : DocumentGraph)
    (patch : Nat → ComponentPatch D R) (registry : R → Nat) (initial : R)
    (empty initialData : D) (unanchored : Nat → Bool) (request : ControllerRequest)
    (r : RegistryReceipts) (operationTime : Nat → Int) (chainFacts : Nat → ChainReceiptView)
    (ordered : AncestryOrdered (documentAgent g)) (bounded : DepthBounded (documentAgent g))
    (xs ys : List (AgentSourceReceipt α)) (same : SameAgentSources xs ys) :
    let a := componentAnchors g patch registry initial r
    let expected := expectedRegistry (componentRegistry g patch registry initial)
    let m := coldComponentEvents g a
    let view := fun records => selectController g patch empty initialData initial registry unanchored
      request (confirmedReceiptView (records.map (agentReceiptView a expected operationTime chainFacts)))
    (stopWhenStable (rankedPass m (chainOwner a) g.size (normalizeAgentSources a expected xs))
      (m.size + 3) []).map view =
    (stopWhenStable (rankedPass m (chainOwner a) g.size (normalizeAgentSources a expected ys))
      (m.size + 3) []).map view := by
  have shared := normalize_sources_membership (componentAnchors g patch registry initial r)
    (expectedRegistry (componentRegistry g patch registry initial)) xs ys same
  have equal := component_cold_same_receipt_view g patch registry initial r operationTime chainFacts
    ordered bounded _ _ shared.1 shared.2
  have selected := congrArg (Option.map
    (selectController g patch empty initialData initial registry unanchored request)) equal
  simpa only [Option.map_map, Function.comp_def] using selected

end Archon
