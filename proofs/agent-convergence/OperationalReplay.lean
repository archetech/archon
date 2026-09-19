import AgentConvergence

set_option warningAsError true

/-!
Operational refinement for the fixed-authorization provisional agent domain.
A warm path excludes its already accepted root; cold state `none` means genesis
has not been accepted. Execution scans candidates and compares paths, without
calling the canonical projector. This is a Lean model, not extracted TS/Rust.
-/
namespace Archon

/-- A retained, authorized predecessor path, excluding its known root. -/
inductive ValidPath (m : Model) (evidence : List Nat) : Nat → List Nat → Prop
  | nil (p) : ValidPath m evidence p []
  | cons (member : child ∈ evidence) (valid : eligible m p child = true)
      (tail : ValidPath m evidence child rest) : ValidPath m evidence p (child :: rest)

/-- Scan the accepted predecessor path. Append at a matching leaf; replace a
larger sibling and truncate its suffix; otherwise continue scanning. On valid
acyclic paths, continuing past a losing sibling is a no-op (proved below). -/
def insertCandidate (m : Model) (p i : Nat) : List Nat → List Nat
  | [] => if eligible m p i then [i] else []
  | child :: rest =>
    if eligible m p i && i < child then [i]
    else child :: insertCandidate m child i rest

def replayPass (m : Model) (p : Nat) (evidence path : List Nat) : List Nat :=
  evidence.foldl (fun current i => insertCandidate m p i current) path

def replayRounds (m : Model) (p : Nat) (evidence : List Nat) : Nat → List Nat → List Nat
  | 0, path => path
  | n + 1, path => replayRounds m p evidence n (replayPass m p evidence path)

theorem eligible_lt (m : Model) (p i : Nat) (h : eligible m p i = true) : i < m.size := by
  simp only [eligible, Bool.and_eq_true, decide_eq_true_eq] at h
  exact h.1.1

theorem insert_valid (m : Model) (evidence : List Nat) (p i : Nat) (path : List Nat)
    (valid : ValidPath m evidence p path) (member : i ∈ evidence) :
    ValidPath m evidence p (insertCandidate m p i path) := by
  induction valid with
  | nil p =>
    simp only [insertCandidate]
    split
    · exact ValidPath.cons member (by assumption) (ValidPath.nil i)
    · exact ValidPath.nil p
  | @cons child p rest oldMember oldValid tail ih =>
    simp only [insertCandidate]
    split
    next preferred =>
      simp only [Bool.and_eq_true] at preferred
      have h : eligible m p i = true := preferred.1
      exact ValidPath.cons member h (ValidPath.nil i)
    next kept => exact ValidPath.cons oldMember oldValid ih

theorem pass_valid (m : Model) (evidence order : List Nat) (p : Nat) (path : List Nat)
    (valid : ValidPath m evidence p path) (retained : ∀ i, i ∈ order → i ∈ evidence) :
    ValidPath m evidence p (replayPass m p order path) := by
  induction order generalizing path with
  | nil => exact valid
  | cons i rest ih =>
    apply ih
    · exact insert_valid m evidence p i path valid (retained i (by simp))
    · intro j mem
      exact retained j (by simp [mem])

theorem valid_head_le (m : Model) (evidence : List Nat) (p : Nat) (path : List Nat)
    (valid : ValidPath m evidence p path) : path.headD m.size ≤ m.size := by
  cases valid with
  | nil => simp
  | cons member ok tail =>
    have := eligible_lt m _ _ ok
    simp only [List.headD_cons]
    omega

theorem insert_head (m : Model) (p i : Nat) (path : List Nat) :
    (insertCandidate m p i path).headD m.size =
      if eligible m p i then min i (path.headD m.size) else path.headD m.size := by
  cases path with
  | nil =>
    by_cases h : eligible m p i = true
    · have := eligible_lt m p i h
      simp [insertCandidate, h, Nat.min_eq_left (by omega : i ≤ m.size)]
    · simp [insertCandidate, h]
  | cons c rest =>
    by_cases h : eligible m p i = true
    · by_cases less : i < c
      · simp [insertCandidate, h, less, Nat.min_eq_left (by omega : i ≤ c)]
      · simp [insertCandidate, h, less, Nat.min_eq_right (by omega : c ≤ i)]
    · simp [insertCandidate, h]

theorem pass_head_min (m : Model) (evidence order : List Nat) (p : Nat) (path : List Nat)
    (valid : ValidPath m evidence p path) (retained : ∀ i, i ∈ order → i ∈ evidence) :
    (replayPass m p order path).headD m.size = min (winner m p order) (path.headD m.size) := by
  induction order generalizing path with
  | nil =>
    have bound := valid_head_le m evidence p path valid
    change path.headD m.size = min m.size (path.headD m.size)
    exact (Nat.min_eq_right bound).symm
  | cons i rest ih =>
    have nextValid := insert_valid m evidence p i path valid (retained i (by simp))
    have restRetained : ∀ j, j ∈ rest → j ∈ evidence := fun j mem => retained j (by simp [mem])
    change (replayPass m p rest (insertCandidate m p i path)).headD m.size = _
    rw [ih _ nextValid restRetained, insert_head]
    simp only [winner]
    split <;> simp_all [Nat.min_assoc, Nat.min_left_comm]

theorem pass_head (m : Model) (evidence : List Nat) (p : Nat) (path : List Nat)
    (valid : ValidPath m evidence p path) :
    (replayPass m p evidence path).headD m.size = winner m p evidence := by
  rw [pass_head_min m evidence evidence p path valid (fun _ h => h)]
  apply Nat.min_eq_left
  cases valid with
  | nil => exact winner_le_size m p evidence
  | cons member ok tail => exact winner_le_member m p _ evidence member ok

/-- Once the minimum sibling is installed, every later operation acts only on
its suffix. This is the operational prefix-stability property. -/
theorem pass_fixed_head (m : Model) (p child : Nat) (order rest : List Nat)
    (minimal : ∀ i, i ∈ order → eligible m p i = true → child ≤ i) :
    replayPass m p order (child :: rest) = child :: replayPass m child order rest := by
  induction order generalizing rest with
  | nil => rfl
  | cons i order ih =>
    have noReplace : (eligible m p i && i < child) = false := by
      by_cases h : eligible m p i = true
      · have bound := minimal i (by simp) h
        simp [h, show ¬i < child by omega]
      · simp [h]
    simp only [replayPass, List.foldl_cons, insertCandidate, noReplace, Bool.false_eq_true, ↓reduceIte]
    apply ih
    intro j mem ok
    exact minimal j (by simp [mem]) ok

theorem rounds_fixed_head (m : Model) (p child : Nat) (evidence rest : List Nat)
    (minimal : ∀ i, i ∈ evidence → eligible m p i = true → child ≤ i) (n : Nat) :
    replayRounds m p evidence n (child :: rest) = child :: replayRounds m child evidence n rest := by
  induction n generalizing rest with
  | zero => rfl
  | succ n ih =>
    simp only [replayRounds, pass_fixed_head m p child evidence rest minimal]
    exact ih _

theorem insert_complete (m : Model) (evidence : List Nat) (p i : Nat) (path : List Nat)
    (complete : Complete m evidence p path) (member : i ∈ evidence) :
    insertCandidate m p i path = path := by
  induction complete with
  | stop p none =>
    have invalid : eligible m p i ≠ true := by
      intro h
      have bound := winner_le_member m p i evidence member h
      have less := eligible_lt m p i h
      omega
    simp [insertCandidate, invalid]
  | step p childExists tail ih =>
    have noReplace : (eligible m p i && i < winner m p evidence) = false := by
      by_cases h : eligible m p i = true
      · have := winner_le_member m p i evidence member h
        simp [h, show ¬i < winner m p evidence by omega]
      · simp [h]
    simp [insertCandidate, noReplace, ih]

theorem pass_complete (m : Model) (evidence order : List Nat) (p : Nat) (path : List Nat)
    (complete : Complete m evidence p path) (retained : ∀ i, i ∈ order → i ∈ evidence) :
    replayPass m p order path = path := by
  induction order with
  | nil => rfl
  | cons i order ih =>
    change replayPass m p order (insertCandidate m p i path) = path
    rw [insert_complete m evidence p i path complete (retained i (by simp))]
    apply ih
    intro j mem
    exact retained j (by simp [mem])

theorem rounds_complete (m : Model) (evidence : List Nat) (p : Nat) (path : List Nat)
    (complete : Complete m evidence p path) (n : Nat) :
    replayRounds m p evidence n path = path := by
  induction n with
  | zero => rfl
  | succ n ih =>
    simp only [replayRounds, pass_complete m evidence evidence p path complete (fun _ h => h)]
    exact ih

/-- Every complete scan settles another predecessor level. The number of passes
is bounded by the finite graph level, independent of arrival order. -/
theorem rounds_eq_suffix (m : Model) (evidence : List Nat) (acyclic : WellFoundedEdges m)
    (fuel p : Nat) (path : List Nat) (valid : ValidPath m evidence p path)
    (enough : m.level p ≤ fuel) :
    replayRounds m p evidence fuel path = suffix m evidence fuel p := by
  induction fuel generalizing p path with
  | zero =>
    cases valid with
    | nil => rfl
    | cons member ok tail =>
      have := acyclic _ _ ok
      omega
  | succ fuel ih =>
    have nextValid := pass_valid m evidence evidence p path valid (fun _ h => h)
    have head := pass_head m evidence p path valid
    simp only [replayRounds, suffix]
    generalize next : replayPass m p evidence path = current at *
    cases nextValid with
    | nil =>
      simp only [List.headD_nil] at head
      have none : winner m p evidence = m.size := head.symm
      have stop := Complete.stop (m := m) (evidence := evidence) p none
      simp [none, rounds_complete m evidence p [] stop fuel]
    | @cons child p rest mem ok tail =>
      simp only [List.headD_cons] at head
      have childBound := eligible_lt m p child ok
      have desc := acyclic p child ok
      have minimal : ∀ i, i ∈ evidence → eligible m p i = true → child ≤ i := by
        intro i hi validI
        rw [head]
        exact winner_le_member m p i evidence hi validI
      rw [rounds_fixed_head m p child evidence rest minimal fuel]
      rw [ih child rest tail (by omega)]
      simp [← head, childBound]

/-- Production-style lookup stops immediately at a matching predecessor. -/
def lookupInsert (m : Model) (p i : Nat) : List Nat → List Nat
  | [] => if eligible m p i then [i] else []
  | child :: rest =>
    if eligible m p i then
      if i < child then [i] else child :: rest
    else child :: lookupInsert m child i rest

theorem eligible_parent (m : Model) (p i : Nat) (h : eligible m p i = true) :
    m.parent i = some p := by
  simp only [eligible, Bool.and_eq_true, beq_iff_eq] at h
  exact h.2

theorem insert_after_parent (m : Model) (evidence : List Nat) (ancestor i p : Nat)
    (path : List Nat) (acyclic : WellFoundedEdges m)
    (parent : m.parent i = some ancestor) (valid : ValidPath m evidence p path)
    (below : m.level p < m.level ancestor) : insertCandidate m p i path = path := by
  induction path generalizing p with
  | nil =>
    have inactive : eligible m p i ≠ true := by
      intro h
      have same := eligible_parent m p i h
      have eq : p = ancestor := by simpa [parent] using same.symm
      subst p
      omega
    simp [insertCandidate, inactive]
  | cons child rest ih =>
    have inactive : eligible m p i ≠ true := by
      intro h
      have same := eligible_parent m p i h
      have eq : p = ancestor := by simpa [parent] using same.symm
      subst p
      omega
    cases valid with
    | cons mem ok tail =>
      have desc := acyclic p child ok
      simp [insertCandidate, inactive, ih child tail (by omega)]

theorem lookup_eq_insert (m : Model) (evidence : List Nat) (p i : Nat) (path : List Nat)
    (acyclic : WellFoundedEdges m) (valid : ValidPath m evidence p path) :
    lookupInsert m p i path = insertCandidate m p i path := by
  induction valid with
  | nil p => rfl
  | @cons child p rest mem ok tail ih =>
    by_cases matched : eligible m p i = true
    · by_cases preferred : i < child
      · simp [lookupInsert, insertCandidate, matched, preferred]
      · have unchanged := insert_after_parent m evidence p i child rest acyclic
          (eligible_parent m p i matched) tail (acyclic p child ok)
        simp [lookupInsert, insertCandidate, matched, preferred, unchanged]
    · simp [lookupInsert, insertCandidate, matched, ih]

theorem member_parent_level (m : Model) (evidence : List Nat) (p i ancestor : Nat)
    (path : List Nat) (acyclic : WellFoundedEdges m) (valid : ValidPath m evidence p path)
    (member : i ∈ path) (parent : m.parent i = some ancestor) :
    m.level ancestor ≤ m.level p := by
  induction valid with
  | nil p => simp at member
  | @cons child p rest mem ok tail ih =>
    simp only [List.mem_cons] at member
    rcases member with rfl | memRest
    · have same := eligible_parent m p i ok
      have eq : p = ancestor := by simpa [parent] using same.symm
      simp [eq]
    · have lower := ih memRest
      have desc := acyclic p child ok
      omega

theorem insert_duplicate (m : Model) (evidence : List Nat) (p i : Nat) (path : List Nat)
    (acyclic : WellFoundedEdges m) (valid : ValidPath m evidence p path)
    (member : i ∈ path) : insertCandidate m p i path = path := by
  induction valid with
  | nil p => simp at member
  | @cons child p rest mem ok tail ih =>
    simp only [List.mem_cons] at member
    rcases member with rfl | memRest
    · have unchanged := insert_after_parent m evidence p i i rest acyclic
        (eligible_parent m p i ok) tail (acyclic p i ok)
      simp [insertCandidate, unchanged]
    · have inactive : eligible m p i ≠ true := by
        intro h
        have back := member_parent_level m evidence child i p rest acyclic tail memRest
          (eligible_parent m p i h)
        have desc := acyclic p child ok
        omega
      simp [insertCandidate, inactive, ih memRest]

/-- Duplicate identity check followed by predecessor lookup/append/replacement. -/
def importCandidate (m : Model) (p i : Nat) (path : List Nat) : List Nat :=
  if i ∈ path then path else lookupInsert m p i path

theorem import_eq_insert (m : Model) (evidence : List Nat) (p i : Nat) (path : List Nat)
    (acyclic : WellFoundedEdges m) (valid : ValidPath m evidence p path) :
    importCandidate m p i path = insertCandidate m p i path := by
  unfold importCandidate
  split
  · exact (insert_duplicate m evidence p i path acyclic valid (by assumption)).symm
  · exact lookup_eq_insert m evidence p i path acyclic valid

def importPass (m : Model) (p : Nat) (evidence path : List Nat) : List Nat :=
  evidence.foldl (fun current i => importCandidate m p i current) path

theorem import_pass_eq (m : Model) (evidence order : List Nat) (p : Nat) (path : List Nat)
    (acyclic : WellFoundedEdges m) (valid : ValidPath m evidence p path)
    (retained : ∀ i, i ∈ order → i ∈ evidence) :
    importPass m p order path = replayPass m p order path := by
  induction order generalizing path with
  | nil => rfl
  | cons i order ih =>
    change importPass m p order (importCandidate m p i path) =
      replayPass m p order (insertCandidate m p i path)
    rw [import_eq_insert m evidence p i path acyclic valid]
    apply ih
    · exact insert_valid m evidence p i path valid (retained i (by simp))
    · intro j mem
      exact retained j (by simp [mem])

def importRounds (m : Model) (p : Nat) (evidence : List Nat) : Nat → List Nat → List Nat
  | 0, path => path
  | n + 1, path => importRounds m p evidence n (importPass m p evidence path)

theorem import_rounds_eq (m : Model) (evidence : List Nat) (p : Nat) (path : List Nat)
    (acyclic : WellFoundedEdges m) (valid : ValidPath m evidence p path) (n : Nat) :
    importRounds m p evidence n path = replayRounds m p evidence n path := by
  induction n generalizing path with
  | zero => rfl
  | succ n ih =>
    simp only [importRounds, replayRounds, import_pass_eq m evidence evidence p path acyclic valid (fun _ h => h)]
    exact ih _ (pass_valid m evidence evidence p path valid (fun _ h => h))

/-- Bounded representation of the production loop's stop-on-unchanged test.
The theorem below proves that its fuel cannot run out in the stated domain. -/
def untilStable (m : Model) (p : Nat) (evidence : List Nat) : Nat → List Nat → Option (List Nat)
  | 0, _ => none
  | fuel + 1, path =>
    let next := importPass m p evidence path
    if next = path then some path else untilStable m p evidence fuel next

theorem import_rounds_fixed (m : Model) (evidence : List Nat) (p : Nat) (path : List Nat)
    (fixed : importPass m p evidence path = path) (n : Nat) :
    importRounds m p evidence n path = path := by
  induction n with
  | zero => rfl
  | succ n ih => simp [importRounds, fixed, ih]

theorem stable_of_reaches (m : Model) (evidence : List Nat) (p : Nat) (path target : List Nat)
    (n : Nat) (reaches : importRounds m p evidence n path = target)
    (fixed : importPass m p evidence target = target) :
    untilStable m p evidence (n + 1) path = some target := by
  induction n generalizing path with
  | zero =>
    simp only [importRounds] at reaches
    subst path
    simp [untilStable, fixed]
  | succ n ih =>
    simp only [untilStable]
    split
    next stopped =>
      have eq := import_rounds_fixed m evidence p path stopped (n + 1)
      rw [eq] at reaches
      simp [reaches]
    next changed =>
      exact ih _ reaches

theorem complete_valid (m : Model) (evidence : List Nat) (p : Nat) (path : List Nat)
    (complete : Complete m evidence p path) : ValidPath m evidence p path := by
  induction complete with
  | stop p none => exact ValidPath.nil p
  | step p existsChild tail ih =>
    obtain ⟨mem, ok⟩ := winner_member m p evidence existsChild
    exact ValidPath.cons mem ok ih

/-- The stop-on-unchanged loop terminates within level(root)+1 complete passes
and returns the unique complete canonical suffix, from any valid retained path. -/
theorem operational_replay_converges (m : Model) (evidence : List Nat) (p : Nat)
    (path : List Nat) (acyclic : WellFoundedEdges m) (valid : ValidPath m evidence p path) :
    untilStable m p evidence (m.level p + 1) path = some (suffix m evidence (m.level p) p) := by
  have reaches : importRounds m p evidence (m.level p) path = suffix m evidence (m.level p) p := by
    rw [import_rounds_eq m evidence p path acyclic valid]
    exact rounds_eq_suffix m evidence acyclic _ p path valid (Nat.le_refl _)
  apply stable_of_reaches m evidence p path _ (m.level p) reaches
  -- A complete path is retained and authorized, so the importer correspondence applies.
  have complete := suffix_complete m evidence acyclic (m.level p) p (Nat.le_refl _)
  have validComplete := complete_valid m evidence p _ complete
  rw [import_pass_eq m evidence evidence p _ acyclic validComplete (fun _ h => h)]
  exact pass_complete m evidence evidence p _ complete (fun _ h => h)

/-- A create is accepted when it arrives; updates before genesis leave no path.
The fixed root ID identifies the unique valid create in this bounded model. -/
def coldImport (m : Model) (root i : Nat) (state : Option (List Nat)) : Option (List Nat) :=
  if i = root then some (state.getD []) else state.map (importCandidate m root i)

def coldPass (m : Model) (root : Nat) (evidence : List Nat)
    (state : Option (List Nat)) : Option (List Nat) :=
  evidence.foldl (fun current i => coldImport m root i current) state

def ColdValid (m : Model) (evidence : List Nat) (root : Nat) : Option (List Nat) → Prop
  | none => True
  | some path => ValidPath m evidence root path

theorem import_valid (m : Model) (evidence : List Nat) (p i : Nat) (path : List Nat)
    (acyclic : WellFoundedEdges m) (valid : ValidPath m evidence p path) (member : i ∈ evidence) :
    ValidPath m evidence p (importCandidate m p i path) := by
  rw [import_eq_insert m evidence p i path acyclic valid]
  exact insert_valid m evidence p i path valid member

theorem cold_import_valid (m : Model) (evidence : List Nat) (root i : Nat)
    (state : Option (List Nat)) (acyclic : WellFoundedEdges m)
    (valid : ColdValid m evidence root state) (member : i ∈ evidence) :
    ColdValid m evidence root (coldImport m root i state) := by
  cases state with
  | none =>
    by_cases create : i = root
    · simp only [coldImport, create, ↓reduceIte, Option.getD_none, ColdValid]
      exact ValidPath.nil root
    · simp [coldImport, create, ColdValid]
  | some path =>
    by_cases create : i = root
    · simpa [coldImport, create, ColdValid] using valid
    · simp only [coldImport, create, ↓reduceIte, Option.map_some, ColdValid]
      exact import_valid m evidence root i path acyclic valid member

theorem cold_pass_valid (m : Model) (evidence order : List Nat) (root : Nat)
    (state : Option (List Nat)) (acyclic : WellFoundedEdges m)
    (valid : ColdValid m evidence root state) (retained : ∀ i, i ∈ order → i ∈ evidence) :
    ColdValid m evidence root (coldPass m root order state) := by
  induction order generalizing state with
  | nil => exact valid
  | cons i order ih =>
    apply ih
    · exact cold_import_valid m evidence root i state acyclic valid (retained i (by simp))
    · intro j mem
      exact retained j (by simp [mem])

theorem lookup_no_parent (m : Model) (p i : Nat) (path : List Nat)
    (genesis : m.parent i = none) : lookupInsert m p i path = path := by
  induction path generalizing p with
  | nil => simp [lookupInsert, eligible, genesis]
  | cons child rest ih => simp [lookupInsert, eligible, genesis, ih]

theorem import_no_parent (m : Model) (p i : Nat) (path : List Nat)
    (genesis : m.parent i = none) : importCandidate m p i path = path := by
  simp [importCandidate, lookup_no_parent m p i path genesis]

theorem cold_import_some (m : Model) (root i : Nat) (path : List Nat)
    (genesis : m.parent root = none) :
    coldImport m root i (some path) = some (importCandidate m root i path) := by
  by_cases create : i = root
  · subst i
    simp [coldImport, import_no_parent m root root path genesis]
  · simp [coldImport, create]

theorem cold_pass_some (m : Model) (root : Nat) (order path : List Nat)
    (genesis : m.parent root = none) :
    coldPass m root order (some path) = some (importPass m root order path) := by
  induction order generalizing path with
  | nil => rfl
  | cons i order ih =>
    change coldPass m root order (coldImport m root i (some path)) =
      some (importPass m root order (importCandidate m root i path))
    rw [cold_import_some m root i path genesis, ih]

theorem cold_pass_initializes (m : Model) (root : Nat) (order : List Nat)
    (state : Option (List Nat)) (genesis : m.parent root = none) (present : root ∈ order) :
    ∃ path, coldPass m root order state = some path := by
  induction order generalizing state with
  | nil => simp at present
  | cons i order ih =>
    simp only [List.mem_cons] at present
    rcases present with rfl | mem
    · refine ⟨importPass m root order (state.getD []), ?_⟩
      change coldPass m root order (coldImport m root root state) = _
      simp only [coldImport, ↓reduceIte]
      exact cold_pass_some m root order (state.getD []) genesis
    · exact ih (coldImport m root i state) mem

/-- One cold pass followed by stop-on-unchanged warm replay. With genesis present,
the first pass necessarily changes the empty state. Total bound: level(root)+2. -/
def replayCold (m : Model) (root : Nat) (evidence : List Nat) : Option (List Nat) :=
  (coldPass m root evidence none).bind fun path =>
    (untilStable m root evidence (m.level root + 1) path).map (root :: ·)

theorem cold_replay_converges (m : Model) (root : Nat) (evidence : List Nat)
    (acyclic : WellFoundedEdges m) (genesis : m.parent root = none) (present : root ∈ evidence) :
    replayCold m root evidence = some (history m root evidence) := by
  obtain ⟨path, started⟩ := cold_pass_initializes m root evidence none genesis present
  have valid := cold_pass_valid m evidence evidence root none acyclic True.intro (fun _ h => h)
  rw [started] at valid
  unfold replayCold
  rw [started]
  simp only [Option.bind_some]
  rw [operational_replay_converges m evidence root path acyclic valid]
  rfl

theorem cold_replay_same_evidence (m : Model) (root : Nat) (xs ys : List Nat)
    (acyclic : WellFoundedEdges m) (genesis : m.parent root = none) (present : root ∈ xs)
    (same : ∀ i, i ∈ xs ↔ i ∈ ys) : replayCold m root xs = replayCold m root ys := by
  rw [cold_replay_converges m root xs acyclic genesis present,
    cold_replay_converges m root ys acyclic genesis ((same root).mp present),
    history_same_evidence m root xs ys same]

#print axioms operational_replay_converges
#print axioms cold_replay_converges
#print axioms cold_replay_same_evidence

end Archon
