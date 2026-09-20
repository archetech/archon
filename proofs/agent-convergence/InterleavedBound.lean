import InterleavedReplay

set_option warningAsError true
namespace Archon

/-- Levels belong to operations (including the virtual genesis predecessor),
not to event priority ranks. Every eligible signed edge decreases the level. -/
def InterleavedDescending (m : Model) (owner : Nat → Nat) : Prop :=
  ∀ p i, eligible m p i = true → m.level (owner i) < m.level p

inductive InterleavedValid (m : Model) (owner : Nat → Nat) (evidence : List Nat) : Nat → List Nat → Prop
  | nil (p) : InterleavedValid m owner evidence p []
  | cons (member : child ∈ evidence) (valid : eligible m p child = true)
      (tail : InterleavedValid m owner evidence (owner child) rest) :
      InterleavedValid m owner evidence p (child :: rest)

theorem interleaved_insert_valid (m : Model) (owner : Nat → Nat) (evidence : List Nat)
    (p incoming : Nat) (path : List Nat) (valid : InterleavedValid m owner evidence p path)
    (member : incoming ∈ evidence) :
    InterleavedValid m owner evidence p (interleavedInsert m owner p incoming path) := by
  induction valid with
  | nil p =>
    simp only [interleavedInsert]
    split
    · exact .cons member (by assumption) (.nil _)
    · exact .nil _
  | @cons current p rest cm cv tail ih =>
    simp only [interleavedInsert]
    split
    next iv =>
      split
      next same =>
        by_cases less : incoming ≤ current
        · rw [Nat.min_eq_right less]
          exact .cons member iv (same ▸ tail)
        · rw [Nat.min_eq_left (by omega : current ≤ incoming)]
          exact .cons cm cv tail
      next different =>
        split
        · exact .cons member iv (.nil _)
        · exact .cons cm cv tail
    next invalid => exact .cons cm cv ih

theorem interleaved_pass_valid (m : Model) (owner : Nat → Nat) (evidence order : List Nat)
    (p : Nat) (path : List Nat) (valid : InterleavedValid m owner evidence p path)
    (retained : ∀ i ∈ order, i ∈ evidence) :
    InterleavedValid m owner evidence p (interleavedPass m owner p order path) := by
  induction order generalizing path with
  | nil => exact valid
  | cons i rest ih =>
    apply ih
    · exact interleaved_insert_valid m owner evidence p i path valid (retained i (by simp))
    · intro j mem
      exact retained j (by simp [mem])

/-- An event anchored above a valid suffix cannot act inside that suffix. -/
theorem interleaved_after_parent (m : Model) (owner : Nat → Nat) (evidence : List Nat)
    (ancestor incoming p : Nat) (path : List Nat)
    (descending : InterleavedDescending m owner)
    (parent : m.parent incoming = some ancestor)
    (valid : InterleavedValid m owner evidence p path)
    (below : m.level p < m.level ancestor) :
    interleavedInsert m owner p incoming path = path := by
  induction valid with
  | nil p =>
    have inactive : eligible m p incoming ≠ true := by
      intro h
      have same := eligible_parent m p incoming h
      have eq : p = ancestor := by simpa [parent] using same.symm
      subst p
      omega
    simp [interleavedInsert, inactive]
  | @cons child p rest mem ok tail ih =>
    have inactive : eligible m p incoming ≠ true := by
      intro h
      have same := eligible_parent m p incoming h
      have eq : p = ancestor := by simpa [parent] using same.symm
      subst p
      omega
    have lower := descending p child ok
    simp [interleavedInsert, inactive, ih (by omega)]

/-- Once installed, the minimum head survives every candidate. The remaining
work is exactly replay on its suffix, including duplicate-anchor candidates. -/
theorem interleaved_pass_fixed_head (m : Model) (owner : Nat → Nat) (evidence order : List Nat)
    (p child : Nat) (rest : List Nat) (descending : InterleavedDescending m owner)
    (childValid : eligible m p child = true)
    (tail : InterleavedValid m owner evidence (owner child) rest)
    (retained : ∀ i ∈ order, i ∈ evidence)
    (minimal : ∀ i ∈ order, eligible m p i = true → child ≤ i) :
    interleavedPass m owner p order (child :: rest) =
      child :: interleavedPass m owner (owner child) order rest := by
  induction order generalizing rest with
  | nil => rfl
  | cons incoming order ih =>
    have step : interleavedInsert m owner p incoming (child :: rest) =
        child :: interleavedInsert m owner (owner child) incoming rest := by
      by_cases active : eligible m p incoming = true
      · have bound := minimal incoming (by simp) active
        have unchanged := interleaved_after_parent m owner evidence p incoming (owner child) rest
          descending (eligible_parent m p incoming active) tail (descending p child childValid)
        rw [unchanged]
        simp [interleavedInsert, active, Nat.min_eq_left bound, show ¬incoming < child by omega]
      · simp [interleavedInsert, active]
    change interleavedPass m owner p order (interleavedInsert m owner p incoming (child :: rest)) = _
    rw [step]
    apply ih
    · exact interleaved_insert_valid m owner evidence (owner child) incoming rest tail (retained incoming (by simp))
    · intro i hi
      exact retained i (by simp [hi])
    · intro i hi ok
      exact minimal i (by simp [hi]) ok

def interleavedSuffix (m : Model) (owner : Nat → Nat) (evidence : List Nat) : Nat → Nat → List Nat
  | 0, _ => []
  | fuel + 1, p =>
    let child := winner m p evidence
    if child < m.size then child :: interleavedSuffix m owner evidence fuel (owner child) else []

inductive InterleavedComplete (m : Model) (owner : Nat → Nat) (evidence : List Nat) : Nat → List Nat → Prop
  | stop (p) (none : winner m p evidence = m.size) : InterleavedComplete m owner evidence p []
  | step (p) (existsChild : winner m p evidence < m.size)
      (tail : InterleavedComplete m owner evidence (owner (winner m p evidence)) rest) :
      InterleavedComplete m owner evidence p (winner m p evidence :: rest)

theorem interleaved_complete_valid (m : Model) (owner : Nat → Nat) (evidence : List Nat)
    (p : Nat) (path : List Nat) (complete : InterleavedComplete m owner evidence p path) :
    InterleavedValid m owner evidence p path := by
  induction complete with
  | stop p none => exact .nil _
  | step p existsChild tail ih =>
    obtain ⟨mem, ok⟩ := winner_member m p evidence existsChild
    exact .cons mem ok ih

theorem interleaved_pass_complete (m : Model) (owner : Nat → Nat) (evidence order : List Nat)
    (p : Nat) (path : List Nat) (descending : InterleavedDescending m owner)
    (complete : InterleavedComplete m owner evidence p path) (retained : ∀ i ∈ order, i ∈ evidence) :
    interleavedPass m owner p order path = path := by
  induction complete with
  | stop p none =>
    induction order with
    | nil => rfl
    | cons i rest ih =>
      have inactive : eligible m p i ≠ true := by
        intro ok
        have le := winner_le_member m p i evidence (retained i (by simp)) ok
        have lt := eligible_lt m p i ok
        omega
      change interleavedPass m owner p rest (interleavedInsert m owner p i []) = []
      simp only [interleavedInsert, inactive]
      exact ih (fun j hj => retained j (by simp [hj]))
  | step p existsChild tail ih =>
    obtain ⟨_, ok⟩ := winner_member m p evidence existsChild
    rw [interleaved_pass_fixed_head m owner evidence order p _ _ descending ok
      (interleaved_complete_valid m owner evidence _ _ tail) retained
      (fun i hi valid => winner_le_member m p i evidence (retained i hi) valid), ih]

def interleavedRounds (m : Model) (owner : Nat → Nat) (p : Nat) (evidence : List Nat) : Nat → List Nat → List Nat
  | 0, path => path
  | n + 1, path => interleavedRounds m owner p evidence n (interleavedPass m owner p evidence path)

theorem interleaved_rounds_complete (m : Model) (owner : Nat → Nat) (evidence : List Nat)
    (p : Nat) (path : List Nat) (descending : InterleavedDescending m owner)
    (complete : InterleavedComplete m owner evidence p path) (n : Nat) :
    interleavedRounds m owner p evidence n path = path := by
  induction n with
  | zero => rfl
  | succ n ih =>
    simp only [interleavedRounds, interleaved_pass_complete m owner evidence evidence p path descending complete (fun _ h => h)]
    exact ih

theorem interleaved_rounds_fixed_head (m : Model) (owner : Nat → Nat) (evidence : List Nat)
    (p child : Nat) (rest : List Nat) (descending : InterleavedDescending m owner)
    (childValid : eligible m p child = true)
    (tail : InterleavedValid m owner evidence (owner child) rest)
    (minimal : ∀ i ∈ evidence, eligible m p i = true → child ≤ i) (n : Nat) :
    interleavedRounds m owner p evidence n (child :: rest) =
      child :: interleavedRounds m owner (owner child) evidence n rest := by
  induction n generalizing rest with
  | zero => rfl
  | succ n ih =>
    simp only [interleavedRounds, interleaved_pass_fixed_head m owner evidence evidence p child rest descending childValid tail (fun _ h => h) minimal]
    exact ih _ (interleaved_pass_valid m owner evidence evidence _ rest tail (fun _ h => h))

theorem interleaved_rounds_converge (m : Model) (owner : Nat → Nat) (evidence : List Nat)
    (descending : InterleavedDescending m owner) (fuel p : Nat) (path : List Nat)
    (valid : InterleavedValid m owner evidence p path) (enough : m.level p ≤ fuel) :
    interleavedRounds m owner p evidence fuel path = interleavedSuffix m owner evidence fuel p := by
  induction fuel generalizing p path with
  | zero =>
    cases valid with
    | nil => rfl
    | cons member ok tail =>
      have := descending _ _ ok
      omega
  | succ fuel ih =>
    have nextValid := interleaved_pass_valid m owner evidence evidence p path valid (fun _ h => h)
    have head : (interleavedPass m owner p evidence path).headD m.size = winner m p evidence := by
      cases valid with
      | nil => exact interleaved_empty_head m owner p evidence
      | cons mem ok tail => exact interleaved_next_settles m owner p evidence _ _ mem ok
    simp only [interleavedRounds, interleavedSuffix]
    generalize next : interleavedPass m owner p evidence path = current at *
    cases nextValid with
    | nil =>
      simp only [List.headD_nil] at head
      have none : winner m p evidence = m.size := head.symm
      have stop := InterleavedComplete.stop (m := m) (owner := owner) (evidence := evidence) p none
      simp [none, interleaved_rounds_complete m owner evidence p [] descending stop fuel]
    | @cons child p rest mem ok tail =>
      simp only [List.headD_cons] at head
      have childBound := eligible_lt m p child ok
      have desc := descending p child ok
      have minimal : ∀ i ∈ evidence, eligible m p i = true → child ≤ i := by
        intro i hi vi
        rw [head]
        exact winner_le_member m p i evidence hi vi
      rw [interleaved_rounds_fixed_head m owner evidence p child rest descending ok tail minimal fuel]
      rw [ih (owner child) rest tail (by omega)]
      simp [← head, childBound]

theorem interleaved_suffix_complete (m : Model) (owner : Nat → Nat) (evidence : List Nat)
    (descending : InterleavedDescending m owner) (fuel p : Nat) (enough : m.level p ≤ fuel) :
    InterleavedComplete m owner evidence p (interleavedSuffix m owner evidence fuel p) := by
  induction fuel generalizing p with
  | zero =>
    have none : winner m p evidence = m.size := by
      have bound := winner_le_size m p evidence
      by_cases less : winner m p evidence < m.size
      · obtain ⟨_, ok⟩ := winner_member m p evidence less
        have desc := descending p _ ok
        omega
      · omega
    exact .stop p none
  | succ fuel ih =>
    simp only [interleavedSuffix]
    split
    next existsChild =>
      obtain ⟨_, ok⟩ := winner_member m p evidence existsChild
      have desc := descending p _ ok
      exact .step p existsChild (ih _ (by omega))
    next noChild =>
      have bound := winner_le_size m p evidence
      exact .stop p (by omega)

def interleavedUntilStable (m : Model) (owner : Nat → Nat) (p : Nat) (evidence : List Nat) :
    Nat → List Nat → Option (List Nat)
  | 0, _ => none
  | fuel + 1, path =>
    let next := interleavedPass m owner p evidence path
    if next = path then some path else interleavedUntilStable m owner p evidence fuel next

theorem interleaved_rounds_fixed (m : Model) (owner : Nat → Nat) (p : Nat) (evidence path : List Nat)
    (fixed : interleavedPass m owner p evidence path = path) (n : Nat) :
    interleavedRounds m owner p evidence n path = path := by
  induction n with
  | zero => rfl
  | succ n ih => simp [interleavedRounds, fixed, ih]

theorem interleaved_stable_of_reaches (m : Model) (owner : Nat → Nat) (p : Nat)
    (evidence path target : List Nat) (n : Nat)
    (reaches : interleavedRounds m owner p evidence n path = target)
    (fixed : interleavedPass m owner p evidence target = target) :
    interleavedUntilStable m owner p evidence (n + 1) path = some target := by
  induction n generalizing path with
  | zero =>
    simp only [interleavedRounds] at reaches
    subst path
    simp [interleavedUntilStable, fixed]
  | succ n ih =>
    simp only [interleavedUntilStable]
    split
    next stopped =>
      have eq := interleaved_rounds_fixed m owner p evidence path stopped (n + 1)
      rw [eq] at reaches
      simp [reaches]
    next changed => exact ih _ reaches

/-- Arbitrary valid retained histories converge in level(parent) passes, followed
by at most one pass detecting stability. This bound is independent of delivery
order, number of duplicates, and which valid warm branch was initially accepted. -/
theorem interleaved_replay_converges (m : Model) (owner : Nat → Nat) (evidence : List Nat)
    (p : Nat) (path : List Nat) (descending : InterleavedDescending m owner)
    (valid : InterleavedValid m owner evidence p path) :
    interleavedUntilStable m owner p evidence (m.level p + 1) path =
      some (interleavedSuffix m owner evidence (m.level p) p) := by
  apply interleaved_stable_of_reaches
  · exact interleaved_rounds_converge m owner evidence descending _ p path valid (Nat.le_refl _)
  · exact interleaved_pass_complete m owner evidence evidence p _ descending
      (interleaved_suffix_complete m owner evidence descending _ p (Nat.le_refl _)) (fun _ h => h)

theorem interleaved_suffix_same_evidence (m : Model) (owner : Nat → Nat) (xs ys : List Nat)
    (same : ∀ i, i ∈ xs ↔ i ∈ ys) (fuel p : Nat) :
    interleavedSuffix m owner xs fuel p = interleavedSuffix m owner ys fuel p := by
  induction fuel generalizing p with
  | zero => rfl
  | succ fuel ih =>
    simp only [interleavedSuffix, winner_same_evidence m p xs ys same]
    split
    · rw [ih]
    · rfl

/-- Equal retained event sets give identical complete ranked paths, including
from different valid initial histories. This is conditional model convergence,
not verification of the runtime's authorization or serialized record codec. -/
theorem interleaved_replay_same_evidence (m : Model) (owner : Nat → Nat) (xs ys : List Nat)
    (p : Nat) (left right : List Nat) (descending : InterleavedDescending m owner)
    (lv : InterleavedValid m owner xs p left) (rv : InterleavedValid m owner ys p right)
    (same : ∀ i, i ∈ xs ↔ i ∈ ys) :
    interleavedUntilStable m owner p xs (m.level p + 1) left =
      interleavedUntilStable m owner p ys (m.level p + 1) right := by
  rw [interleaved_replay_converges m owner xs p left descending lv,
      interleaved_replay_converges m owner ys p right descending rv,
      interleaved_suffix_same_evidence m owner xs ys same]

end Archon
