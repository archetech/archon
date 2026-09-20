import AgentRegistry

set_option warningAsError true
namespace Archon.AgentRegistryExamples

-- Abstract model examples, not signed fixtures or runtime correspondence tests.
-- Document values include non-method content, returned by componentResult.
structure Document where
  methods : List VerificationMethod
  service : Nat
  deriving DecidableEq

def documents : Nat → Document
  | 0 => ⟨[⟨1, 10⟩], 100⟩
  | 1 => ⟨[⟨1, 20⟩], 200⟩
  | _ => ⟨[⟨1, 30⟩], 300⟩

def source : DocumentGraph where
  size := 8
  root := 0
  initialDocument := 0
  parent := fun i => match i with
    | 1 | 4 => some 0
    | 2 | 3 => some 1
    | 5 => some 2
    | 6 => some 5
    | 7 => some 6
    | _ => none
  depth := fun i => match i with
    | 1 | 4 => 1
    | 2 | 3 => 2
    | 5 => 3
    | 6 => 4
    | 7 => 5
    | _ => 0
  action := fun i => match i with
    | 1 | 4 => .rotate 1
    | 5 => .rotate 2
    | 6 => .deactivate
    | _ => .keep
  documents := fun i => (documents i).methods
  named := fun _ => 1
  signatureValid := fun i key => key == match i with
    | 1 | 3 => 10
    | 2 | 4 | 5 => 20
    | _ => 30

def graph := decodedComponentGraph source documents Document.methods

example : graph = source := decoded_component_graph_eq source documents Document.methods (fun _ => rfl)

def patches : Nat → ComponentPatch Nat Nat
  | 1 | 4 => ⟨some 101, some 20⟩
  | 2 => ⟨some 202, none⟩
  | 5 => ⟨none, some 10⟩
  | _ => ⟨none, none⟩

def receipts : RegistryReceipts where
  size := 11
  owner := fun i => [1, 1, 2, 2, 3, 4, 5, 6, 7, 1, 2][i]?.getD 99
  registry := fun i => [10, 20, 20, 10, 20, 10, 20, 10, 10, 10, 0][i]?.getD 0
  chain := fun i => i != 0
  accepted := fun _ => true

def anchors := componentAnchors graph patches id 10 receipts

theorem ordered : AncestryOrdered (documentAgent graph) := by
  intro i p parent
  simp only [documentAgent, graph, decodedComponentGraph, source] at parent ⊢
  split at parent <;> simp only [Option.some.injEq, reduceCtorEq] at parent
  all_goals subst p; decide

-- The single combined migration is signed with the OLD key on the OLD registry.
-- Its descendants use the replacement document and replacement registry.
example : (List.range receipts.size).map (fun r => eligible anchors (receipts.owner r) r) =
    [true, false, true, false, false, false, true, true, false, true, false] := by decide

-- Return migration carries data forward; deletion preserves registration.
example : runComponents graph patches 0 ⟨.active 0, 0, 10⟩ [1, 2, 5] =
    some ⟨.active 2, 202, 10⟩ := by decide
example : (runComponents graph patches 0 ⟨.active 0, 0, 10⟩ [1, 2, 5]).map
    (componentResult documents ⟨[], 0⟩) = some (documents 2, 202, 10) := by decide
example : (runComponents graph patches 0 ⟨.active 0, 0, 10⟩ [1, 2, 5, 6]).map
    (componentResult documents ⟨[], 0⟩) = some (⟨[], 0⟩, 0, 10) := by decide
example : runComponents graph patches 0 ⟨.active 0, 0, 10⟩ [1, 2, 5, 6, 7] = none := by decide

-- Instantiate the general theorem, not only its executable predicate.
-- Each supplied prefix is independently checked for predecessor linkage and
-- derived document authorization, including the deleted predecessor of op 7.
def predecessorPath : Nat → List Nat
  | 1 | 4 => []
  | 2 | 3 => [1]
  | 5 => [1, 2]
  | 6 => [1, 2, 5]
  | 7 => [1, 2, 5, 6]
  | _ => []

def before : Nat → ComponentState Nat Nat
  | 1 | 4 => ⟨.active 0, 0, 10⟩
  | 2 | 3 => ⟨.active 1, 101, 20⟩
  | 5 => ⟨.active 1, 202, 20⟩
  | 6 => ⟨.active 2, 202, 10⟩
  | 7 => ⟨.deleted, 0, 10⟩
  | _ => ⟨.active 0, 0, 10⟩

theorem prefix_valid : ∀ i : Fin 7,
    ValidPath (agentModel (documentAgent graph)) (List.range 8) 0 (predecessorPath (i.val + 1)) := by
  intro ⟨i, bound⟩
  rcases i with _ | _ | _ | _ | _ | _ | _ | i
  all_goals first
    | omega
    | (simp only [Nat.reduceAdd, predecessorPath];
       repeat first | exact ValidPath.nil _ | apply ValidPath.cons (by decide) (by decide))

theorem prefix_runs : ∀ i : Fin 7,
    runComponents graph patches 0 ⟨.active 0, 0, 10⟩ (predecessorPath (i.val + 1)) =
      some (before (i.val + 1)) := by decide

theorem prefix_parent : ∀ i : Fin 7,
    graph.parent (i.val + 1) = some (pathTip 0 (predecessorPath (i.val + 1))) := by decide

example (i : Fin 7) (r : Nat) :
    eligible anchors (i.val + 1) r = true ↔
      r < receipts.size ∧ receipts.accepted r = true ∧ receipts.chain (receipts.registry r) = true ∧
      receipts.owner r = i.val + 1 ∧ receipts.registry r = (before (i.val + 1)).registration ∧
      ∃ after, componentStep graph patches 0 (i.val + 1) (before (i.val + 1)) = some after := by
  exact component_anchor_after_prefix graph patches id 10 0 0 receipts ordered rfl (by decide)
    (List.range 8) (predecessorPath (i.val + 1)) (prefix_valid i) (before (i.val + 1)) (prefix_runs i)
    (i.val + 1) r (by have := i.isLt; change i.val + 1 < 8; omega) (prefix_parent i)

-- A caller can derive the predecessor state instead of supplying it.
example : ∃ state,
    runComponents graph patches 0 ⟨.active 0, 0, 10⟩ [1, 2] = some state ∧
    (eligible anchors 5 6 = true ↔
      6 < receipts.size ∧ receipts.accepted 6 = true ∧ receipts.chain (receipts.registry 6) = true ∧
      receipts.owner 6 = 5 ∧ receipts.registry 6 = state.registration ∧
      ∃ after, componentStep graph patches 0 5 state = some after) := by
  exact component_anchor_from_history graph patches id 10 0 0 receipts ordered rfl (by decide)
    (List.range 8) [1, 2] (by repeat first | exact ValidPath.nil _ | apply ValidPath.cons (by decide) (by decide)) 5 6 (by decide) rfl

end Archon.AgentRegistryExamples
