import ChainAnchors
import OperationalReplay

set_option warningAsError true
namespace Archon

/-- Event IDs are priority ranks, not operation IDs. `m.parent` names the signed
predecessor operation; `owner` maps each representation back to its operation.
Authorization/registry eligibility are fixed. A virtual parent admits genesis. -/
def interleavedInsert (m : Model) (owner : Nat → Nat) (parent incoming : Nat) : List Nat → List Nat
  | [] => if eligible m parent incoming then [incoming] else []
  | current :: rest =>
    if eligible m parent incoming then
      if owner current = owner incoming then min current incoming :: rest
      else if incoming < current then [incoming] else current :: rest
    else current :: interleavedInsert m owner (owner current) incoming rest

def interleavedPass (m : Model) (owner : Nat → Nat) (parent : Nat)
    (evidence path : List Nat) : List Nat :=
  evidence.foldl (fun path incoming => interleavedInsert m owner parent incoming path) path

/-- Promotion of a duplicate representation preserves its descendants. -/
theorem interleaved_duplicate_keeps_suffix (m : Model) (owner : Nat → Nat)
    (parent incoming current : Nat) (rest : List Nat)
    (valid : eligible m parent incoming = true) (same : owner current = owner incoming) :
    interleavedInsert m owner parent incoming (current :: rest) = min current incoming :: rest := by
  simp [interleavedInsert, valid, same]

/-- A preferred sibling drops the displaced branch, not only its first event. -/
theorem interleaved_sibling_truncates (m : Model) (owner : Nat → Nat)
    (parent incoming current : Nat) (rest : List Nat)
    (valid : eligible m parent incoming = true) (different : owner current ≠ owner incoming)
    (preferred : incoming < current) :
    interleavedInsert m owner parent incoming (current :: rest) = [incoming] := by
  simp [interleavedInsert, valid, different, preferred]

theorem interleaved_insert_head (m : Model) (owner : Nat → Nat)
    (parent incoming : Nat) (path : List Nat) :
    (interleavedInsert m owner parent incoming path).headD m.size =
      anchorStep m parent (path.headD m.size) incoming := by
  cases path with
  | nil =>
    by_cases valid : eligible m parent incoming = true
    · have bound := eligible_lt m parent incoming valid
      simp [interleavedInsert, anchorStep, valid, Nat.min_eq_right (by omega : incoming ≤ m.size)]
    · simp [interleavedInsert, anchorStep, valid]
  | cons current rest =>
    by_cases valid : eligible m parent incoming = true
    · by_cases same : owner current = owner incoming
      · simp [interleavedInsert, anchorStep, valid, same]
      · by_cases preferred : incoming < current
        · simp [interleavedInsert, anchorStep, valid, same, preferred, Nat.min_eq_right (by omega : incoming ≤ current)]
        · simp [interleavedInsert, anchorStep, valid, same, preferred, Nat.min_eq_left (by omega : current ≤ incoming)]
    · simp [interleavedInsert, anchorStep, valid]

/-- Head projection commutes with the actual interleaved scan, not a scan that
preselects anchors or separates duplicate promotion from branch replacement. -/
theorem interleaved_pass_head (m : Model) (owner : Nat → Nat) (parent : Nat)
    (evidence path : List Nat) :
    (interleavedPass m owner parent evidence path).headD m.size =
      anchorScan m parent evidence (path.headD m.size) := by
  induction evidence generalizing path with
  | nil => rfl
  | cons incoming rest ih =>
    change (interleavedPass m owner parent rest (interleavedInsert m owner parent incoming path)).headD m.size = _
    rw [ih, interleaved_insert_head]
    rfl

/-- Once a predecessor is fixed, one complete scan settles its next event from
any valid retained warm head, even while anchor promotion and forks interleave. -/
theorem interleaved_next_settles (m : Model) (owner : Nat → Nat) (parent : Nat)
    (evidence : List Nat) (current : Nat) (rest : List Nat)
    (member : current ∈ evidence) (valid : eligible m parent current = true) :
    (interleavedPass m owner parent evidence (current :: rest)).headD m.size = winner m parent evidence := by
  rw [interleaved_pass_head]
  exact anchor_scan_from_retained m parent evidence current member valid

theorem interleaved_empty_head (m : Model) (owner : Nat → Nat) (parent : Nat) (evidence : List Nat) :
    (interleavedPass m owner parent evidence []).headD m.size = winner m parent evidence := by
  rw [interleaved_pass_head]
  exact anchor_scan_cold m parent evidence

/-- Different retained heads and tails cannot bias the next event after a scan. -/
theorem interleaved_next_same_evidence (m : Model) (owner : Nat → Nat) (parent : Nat)
    (xs ys : List Nat) (a b : Nat) (left right : List Nat)
    (same : ∀ i, i ∈ xs ↔ i ∈ ys)
    (am : a ∈ xs) (av : eligible m parent a = true)
    (bm : b ∈ ys) (bv : eligible m parent b = true) :
    (interleavedPass m owner parent xs (a :: left)).headD m.size =
      (interleavedPass m owner parent ys (b :: right)).headD m.size := by
  rw [interleaved_next_settles m owner parent xs a left am av,
      interleaved_next_settles m owner parent ys b right bm bv]
  exact winner_same_evidence m parent xs ys same

end Archon
