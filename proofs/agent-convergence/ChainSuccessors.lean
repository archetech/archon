import ChainAnchors
import OperationalReplay

set_option warningAsError true

namespace Archon

/-- Lift a finite, executable evidence-set check to membership for every Nat. -/
theorem bounded_membership_agrees (size : Nat) (xs ys : List Nat)
    (xb : xs.all (fun i => decide (i < size)) = true)
    (yb : ys.all (fun i => decide (i < size)) = true)
    (same : ∀ i : Fin size, i.val ∈ xs ↔ i.val ∈ ys) :
    ∀ i, i ∈ xs ↔ i ∈ ys := by
  intro i
  by_cases bound : i < size
  · exact same ⟨i, bound⟩
  · have xn : i ∉ xs := by
      intro member
      have h := (List.all_eq_true.mp xb) i member
      simp only [decide_eq_true_eq] at h
      exact bound h
    have yn : i ∉ ys := by
      intro member
      have h := (List.all_eq_true.mp yb) i member
      simp only [decide_eq_true_eq] at h
      exact bound h
    simp [xn, yn]

/-- Chain anchors outrank provisional representations; operation IDs are CID
ranks, so the fallback preserves the provisional sibling rule. -/
def chainPriority (anchors : AnchorModel) (evidence : List Nat) (op : Nat) : Nat :=
  let selected := anchorScan anchors op evidence anchors.size
  if selected < anchors.size then selected else anchors.size + op

def chainOwner (anchors : AnchorModel) (position : Nat) : Nat :=
  if position < anchors.size then (anchors.parent position).getD 0
  else position - anchors.size

/-- Priority compilation preserves operation identity. -/
theorem chain_priority_owner (anchors : AnchorModel) (xs : List Nat) (op : Nat) :
    chainOwner anchors (chainPriority anchors xs op) = op := by
  by_cases chosen : winner anchors op xs < anchors.size
  · obtain ⟨_, valid⟩ := winner_member anchors op xs chosen
    have owner := eligible_parent anchors op (winner anchors op xs) valid
    simp [chainPriority, anchor_scan_cold, chosen, chainOwner, owner]
  · have outside : ¬ anchors.size + op < anchors.size := by omega
    simp [chainPriority, anchor_scan_cold, chosen, chainOwner, outside]

theorem chain_priority_injective (anchors : AnchorModel) (xs : List Nat) :
    Function.Injective (chainPriority anchors xs) := by
  intro a b same
  have decoded := congrArg (chainOwner anchors) same
  simpa only [chain_priority_owner] using decoded

/-- Compile settled anchor choices into the existing ordered replay model.
The operation graph and each anchor's authorization/registry eligibility are
fixed. This is a phase boundary, not the live runtime's event loop. -/
def chainGraph (operations : Model) (anchors : AnchorModel) (evidence : List Nat) : Model where
  size := anchors.size + operations.size
  parent := fun position => (operations.parent (chainOwner anchors position)).map (chainPriority anchors evidence)
  authorized := fun position => decide (chainOwner anchors position < operations.size)
    && operations.authorized (chainOwner anchors position)
    && decide (position = chainPriority anchors evidence (chainOwner anchors position))
  level := fun position => operations.level (chainOwner anchors position)

theorem chain_priority_same_evidence (anchors : AnchorModel) (xs ys : List Nat)
    (same : ∀ i, i ∈ xs ↔ i ∈ ys) : chainPriority anchors xs = chainPriority anchors ys := by
  funext op
  simp only [chainPriority, anchor_scan_cold, winner_same_evidence anchors op xs ys same]

theorem chain_graph_same_evidence (operations : Model) (anchors : AnchorModel) (xs ys : List Nat)
    (same : ∀ i, i ∈ xs ↔ i ∈ ys) : chainGraph operations anchors xs = chainGraph operations anchors ys := by
  simp only [chainGraph, chain_priority_same_evidence anchors xs ys same]

/-- The compiled numeric priority matches anchored-over-provisional preference. -/
theorem chain_anchor_precedes_provisional (anchors : AnchorModel) (xs : List Nat) (a b : Nat)
    (anchored : winner anchors a xs < anchors.size)
    (provisional : winner anchors b xs = anchors.size) :
    chainPriority anchors xs a < chainPriority anchors xs b := by
  simp only [chainPriority, anchor_scan_cold, anchored, ↓reduceIte, provisional, Nat.lt_irrefl]
  omega

theorem chain_provisional_order (anchors : AnchorModel) (xs : List Nat) (a b : Nat)
    (pa : winner anchors a xs = anchors.size) (pb : winner anchors b xs = anchors.size) :
    chainPriority anchors xs a < chainPriority anchors xs b ↔ a < b := by
  simp [chainPriority, anchor_scan_cold, pa, pb]

theorem chain_anchored_order (anchors : AnchorModel) (xs : List Nat) (a b : Nat)
    (aa : winner anchors a xs < anchors.size) (ab : winner anchors b xs < anchors.size) :
    chainPriority anchors xs a < chainPriority anchors xs b ↔
      winner anchors a xs < winner anchors b xs := by
  simp only [chainPriority, anchor_scan_cold, aa, ab, ↓reduceIte]

/-- Decode the converged operation path, retaining the existing cold importer and
stop-on-unchanged loop. No runtime signatures or registry migrations are modeled. -/
def chainReplay (operations : Model) (anchors : AnchorModel) (anchorEvidence : List Nat)
    (root : Nat) (delivery : List Nat) : Option (List Nat) :=
  (replayCold (chainGraph operations anchors anchorEvidence)
    (chainPriority anchors anchorEvidence root)
    (delivery.map (chainPriority anchors anchorEvidence))).map (List.map (chainOwner anchors))

theorem chain_replay_converges (operations : Model) (anchors : AnchorModel) (xs : List Nat)
    (root : Nat) (delivery : List Nat)
    (acyclic : WellFoundedEdges (chainGraph operations anchors xs))
    (genesis : (chainGraph operations anchors xs).parent (chainPriority anchors xs root) = none)
    (present : root ∈ delivery) :
    chainReplay operations anchors xs root delivery =
      some ((history (chainGraph operations anchors xs) (chainPriority anchors xs root)
        (delivery.map (chainPriority anchors xs))).map (chainOwner anchors)) := by
  unfold chainReplay
  rw [cold_replay_converges _ _ _ acyclic genesis (List.mem_map.mpr ⟨root, present, rfl⟩)]
  rfl

/-- Equal retained anchors and operation sets give equal decoded paths in the
compiled phase, regardless of either delivery order or multiplicity. -/
theorem chain_successors_same_evidence (operations : Model) (anchors : AnchorModel)
    (xs ys left right : List Nat) (root : Nat)
    (sameAnchors : ∀ i, i ∈ xs ↔ i ∈ ys)
    (sameOperations : ∀ i, i ∈ left ↔ i ∈ right)
    (acyclic : WellFoundedEdges (chainGraph operations anchors xs))
    (genesis : (chainGraph operations anchors xs).parent (chainPriority anchors xs root) = none)
    (present : root ∈ left) :
    chainReplay operations anchors xs root left = chainReplay operations anchors ys root right := by
  unfold chainReplay
  rw [← chain_graph_same_evidence operations anchors xs ys sameAnchors,
      ← chain_priority_same_evidence anchors xs ys sameAnchors]
  congr 1
  apply cold_replay_same_evidence _ _ _ _ acyclic genesis
  · exact List.mem_map.mpr ⟨root, present, rfl⟩
  · intro i
    simp only [List.mem_map]
    constructor
    · rintro ⟨op, member, eq⟩
      exact ⟨op, (sameOperations op).mp member, eq⟩
    · rintro ⟨op, member, eq⟩
      exact ⟨op, (sameOperations op).mpr member, eq⟩

end Archon
