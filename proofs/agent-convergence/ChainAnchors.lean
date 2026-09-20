import AgentConvergence

set_option warningAsError true

namespace Archon

/-- Finite anchor ranks in strict chain-ordinal order. `parent` names the
operation, not its predecessor. Authorization and expected registry are fixed
in `authorized`; the sentinel represents no accepted expected-chain anchor. -/
abbrev AnchorModel := Model

/-- Duplicate replacement after the operation path and authorization settle. -/
def anchorStep (m : AnchorModel) (op current incoming : Nat) : Nat :=
  if eligible m op incoming then min current incoming else current

def anchorScan (m : AnchorModel) (op : Nat) (evidence : List Nat) (current : Nat) : Nat :=
  evidence.foldl (anchorStep m op) current

/-- A scan computes the least eligible position including the accepted anchor. -/
theorem anchor_scan_min (m : AnchorModel) (op : Nat) (xs : List Nat)
    (current : Nat) (bounded : current ≤ m.size) :
    anchorScan m op xs current = min current (winner m op xs) := by
  induction xs generalizing current with
  | nil => simp [anchorScan, winner, Nat.min_eq_left bounded]
  | cons incoming rest ih =>
    simp only [anchorScan, List.foldl_cons]
    change anchorScan m op rest (anchorStep m op current incoming) = _
    by_cases valid : eligible m op incoming = true
    · simp only [anchorStep, valid, ↓reduceIte, winner]
      rw [ih (min current incoming) (by omega)]
      omega
    · simp only [anchorStep, valid, winner]
      exact ih current bounded

/-- A warm accepted anchor from the evidence cannot bias the result. -/
theorem anchor_scan_from_retained (m : AnchorModel) (op : Nat) (xs : List Nat)
    (current : Nat) (member : current ∈ xs) (valid : eligible m op current = true) :
    anchorScan m op xs current = winner m op xs := by
  have bound : current < m.size := by
    simp [eligible] at valid
    exact valid.1.1
  rw [anchor_scan_min m op xs current (by omega)]
  exact Nat.min_eq_right (winner_le_member m op current xs member valid)

/-- Cold reconstruction agrees with warm selection. -/
theorem anchor_scan_cold (m : AnchorModel) (op : Nat) (xs : List Nat) :
    anchorScan m op xs m.size = winner m op xs := by
  rw [anchor_scan_min m op xs m.size (by omega)]
  exact Nat.min_eq_right (winner_le_size m op xs)

/-- Equal evidence sets converge from possibly different valid retained anchors.
Order and multiplicity are irrelevant once authorization is fixed. -/
theorem anchors_same_evidence (m : AnchorModel) (op : Nat) (xs ys : List Nat)
    (a b : Nat) (same : ∀ i, i ∈ xs ↔ i ∈ ys)
    (am : a ∈ xs) (av : eligible m op a = true)
    (bm : b ∈ ys) (bv : eligible m op b = true) :
    anchorScan m op xs a = anchorScan m op ys b := by
  rw [anchor_scan_from_retained m op xs a am av,
      anchor_scan_from_retained m op ys b bm bv]
  exact winner_same_evidence m op xs ys same

/-- Repeated scans cannot change the selected position. -/
theorem anchor_scan_idempotent (m : AnchorModel) (op : Nat) (xs : List Nat) :
    anchorScan m op xs (anchorScan m op xs m.size) = anchorScan m op xs m.size := by
  rw [anchor_scan_cold, anchor_scan_min m op xs _ (winner_le_size m op xs)]
  exact Nat.min_self _

end Archon
