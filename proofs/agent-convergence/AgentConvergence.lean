import Std

set_option warningAsError true

/-!
A bounded specification, not a verification of the production importer.
IDs are ranks of distinct canonical CIDs in ASCII order. Authorization is fixed.
The sentinel `size` is not an operation ID. Evidence may be unordered/duplicated.
-/
namespace Archon

structure Model where
  size : Nat
  parent : Nat → Option Nat
  authorized : Nat → Bool
  level : Nat → Nat

def eligible (m : Model) (p i : Nat) : Bool :=
  i < m.size && m.authorized i && m.parent i == some p

/-- A fold computes the smallest eligible child, or the sentinel. -/
def winner (m : Model) (p : Nat) : List Nat → Nat
  | [] => m.size
  | i :: rest => if eligible m p i then min i (winner m p rest) else winner m p rest

theorem winner_le_size (m : Model) (p : Nat) (xs : List Nat) :
    winner m p xs ≤ m.size := by
  induction xs with
  | nil => simp [winner]
  | cons i xs ih =>
    simp only [winner]
    split <;> omega

theorem winner_le_member (m : Model) (p i : Nat) (xs : List Nat)
    (member : i ∈ xs) (valid : eligible m p i = true) :
    winner m p xs ≤ i := by
  induction xs with
  | nil => simp at member
  | cons j xs ih =>
    simp only [List.mem_cons] at member
    rcases member with rfl | member
    · simp only [winner, ite_eq_left valid]
      omega
    · have h := ih member
      simp only [winner]
      split <;> omega

theorem winner_member (m : Model) (p : Nat) (xs : List Nat)
    (existsChild : winner m p xs < m.size) :
    winner m p xs ∈ xs ∧ eligible m p (winner m p xs) = true := by
  induction xs with
  | nil => simp [winner] at existsChild
  | cons i xs ih =>
    by_cases valid : eligible m p i = true
    · simp only [winner, ite_eq_left valid] at existsChild ⊢
      by_cases h : i ≤ winner m p xs
      · simp [Nat.min_eq_left h, valid]
      · have less : winner m p xs < m.size := by omega
        obtain ⟨mem, ok⟩ := ih less
        simp [Nat.min_eq_right (by omega : winner m p xs ≤ i), mem, ok]
    · simp only [winner, ite_eq_right valid] at existsChild ⊢
      obtain ⟨mem, ok⟩ := ih existsChild
      exact ⟨List.mem_cons_of_mem i mem, ok⟩

/-- Membership, not order or multiplicity, determines the next accepted child. -/
theorem winner_same_evidence (m : Model) (p : Nat) (xs ys : List Nat)
    (same : ∀ i, i ∈ xs ↔ i ∈ ys) : winner m p xs = winner m p ys := by
  have oneWay (a b : List Nat) (sub : ∀ i, i ∈ a → i ∈ b) :
      winner m p b ≤ winner m p a := by
    by_cases h : winner m p a < m.size
    · obtain ⟨mem, valid⟩ := winner_member m p a h
      exact winner_le_member m p _ b (sub _ mem) valid
    · have ha := winner_le_size m p a
      have hb := winner_le_size m p b
      omega
  have hxy := oneWay xs ys (fun i h => (same i).mp h)
  have hyx := oneWay ys xs (fun i h => (same i).mpr h)
  omega

/-- Fuel is a bound on remaining graph depth, not the number of deliveries. -/
def suffix (m : Model) (evidence : List Nat) : Nat → Nat → List Nat
  | 0, _ => []
  | fuel + 1, p =>
    let child := winner m p evidence
    if child < m.size then child :: suffix m evidence fuel child else []

def history (m : Model) (root : Nat) (evidence : List Nat) : List Nat :=
  root :: suffix m evidence (m.level root) root

theorem suffix_same_evidence (m : Model) (xs ys : List Nat)
    (same : ∀ i, i ∈ xs ↔ i ∈ ys) (fuel p : Nat) :
    suffix m xs fuel p = suffix m ys fuel p := by
  induction fuel generalizing p with
  | zero => rfl
  | succ fuel ih =>
    simp only [suffix, winner_same_evidence m p xs ys same]
    split
    · rw [ih]
    · rfl

theorem history_same_evidence (m : Model) (root : Nat) (xs ys : List Nat)
    (same : ∀ i, i ∈ xs ↔ i ∈ ys) : history m root xs = history m root ys := by
  unfold history
  rw [suffix_same_evidence m xs ys same]

/-- Includes arbitrary reorderings, even when a predecessor arrives last. -/
theorem history_delivery_permutation (m : Model) (root : Nat) (xs ys : List Nat)
    (permutation : xs.Perm ys) : history m root xs = history m root ys :=
  history_same_evidence m root xs ys (fun _ => permutation.mem_iff)

theorem history_duplicate_delivery (m : Model) (root : Nat) (xs : List Nat) :
    history m root (xs ++ xs) = history m root xs := by
  apply history_same_evidence
  simp

/-- A terminal, fully selected path: no fuel/truncation assumption is hidden here. -/
inductive Complete (m : Model) (evidence : List Nat) : Nat → List Nat → Prop
  | stop (p) (none : winner m p evidence = m.size) : Complete m evidence p []
  | step (p) (existsChild : winner m p evidence < m.size)
      (tail : Complete m evidence (winner m p evidence) rest) :
      Complete m evidence p (winner m p evidence :: rest)

/-- An explicit finite acyclic-graph assumption, separate from CID order. -/
def WellFoundedEdges (m : Model) : Prop :=
  ∀ p i, eligible m p i = true → m.level i < m.level p

theorem suffix_complete (m : Model) (evidence : List Nat)
    (acyclic : WellFoundedEdges m) (fuel p : Nat) (enough : m.level p ≤ fuel) :
    Complete m evidence p (suffix m evidence fuel p) := by
  induction fuel generalizing p with
  | zero =>
    have bound := winner_le_size m p evidence
    have none : winner m p evidence = m.size := by
      by_cases less : winner m p evidence < m.size
      · have valid := (winner_member m p evidence less).2
        have desc := acyclic p _ valid
        omega
      · omega
    exact Complete.stop p none
  | succ fuel ih =>
    simp only [suffix]
    split
    next existsChild =>
      apply Complete.step p existsChild
      have desc := acyclic p _ (winner_member m p evidence existsChild).2
      apply ih
      omega
    next none =>
      apply Complete.stop
      have bound := winner_le_size m p evidence
      omega

theorem complete_unique (m : Model) (evidence : List Nat) (p : Nat)
    (a b : List Nat) (ha : Complete m evidence p a) (hb : Complete m evidence p b) :
    a = b := by
  induction ha generalizing b with
  | stop p none =>
    cases hb with
    | stop => rfl
    | step p existsChild tail => omega
  | step p existsChild tail ih =>
    cases hb with
    | stop p none => omega
    | step p other tailB => rw [ih _ tailB]

/-- Any complete selections agree, not just two calls to the same function. -/
theorem terminal_histories_agree (m : Model) (xs ys : List Nat) (root : Nat)
    (a b : List Nat) (acyclic : WellFoundedEdges m)
    (same : ∀ i, i ∈ xs ↔ i ∈ ys)
    (ha : Complete m xs root a) (hb : Complete m ys root b) : a = b := by
  calc
    a = suffix m xs (m.level root) root :=
      complete_unique m xs root _ _ ha (suffix_complete m xs acyclic _ root (Nat.le_refl _))
    _ = suffix m ys (m.level root) root := suffix_same_evidence m xs ys same _ root
    _ = b :=
      complete_unique m ys root _ _ (suffix_complete m ys acyclic _ root (Nat.le_refl _)) hb

/-- Reconciliation discards any stale projection and rebuilds from retained evidence.
This abstracts replay; it does not model production's insertion/pass scheduling. -/
def reconcile (m : Model) (root : Nat) (evidence stale : List Nat) : List Nat :=
  let _ := stale
  history m root evidence

/-- After any finite complete delivery, one abstract reconciliation suffices. -/
theorem convergence (m : Model) (root : Nat) (xs ys staleA staleB : List Nat)
    (acyclic : WellFoundedEdges m) (same : ∀ i, i ∈ xs ↔ i ∈ ys) :
    reconcile m root xs staleA = reconcile m root ys staleB ∧
    Complete m xs root (suffix m xs (m.level root) root) := by
  exact ⟨history_same_evidence m root xs ys same,
    suffix_complete m xs acyclic _ root (Nat.le_refl _)⟩

end Archon

#print axioms Archon.convergence
#print axioms Archon.complete_unique
#print axioms Archon.history_delivery_permutation
#print axioms Archon.history_duplicate_delivery

#print axioms Archon.terminal_histories_agree
