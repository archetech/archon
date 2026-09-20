import InterleavedRecords

set_option warningAsError true
namespace Archon

/-- A fresh virtual predecessor admits genesis in the same repeated-pass importer
as every successor. No genesis receipt or accepted suffix is preinstalled. -/
def withGenesis (m : Model) (owner : Nat → Nat) (root virtual : Nat) : Model where
  size := m.size
  parent := fun i => if owner i = root then some virtual else m.parent i
  authorized := m.authorized
  level := fun p => if p = virtual then m.size + 1 else m.level p

theorem genesis_model_descending (m : Model) (owner : Nat → Nat) (root virtual : Nat)
    (descending : InterleavedDescending m owner)
    (bounded : ∀ p, m.level p ≤ m.size)
    (fresh : ∀ i, i < m.size → m.authorized i = true → owner i ≠ virtual) :
    InterleavedDescending (withGenesis m owner root virtual) owner := by
  intro p i ok
  have bound := eligible_lt _ _ _ ok
  have authorized : m.authorized i = true := by
    simp only [eligible, withGenesis, Bool.and_eq_true] at ok
    exact ok.1.2
  have different := fresh i bound authorized
  by_cases atVirtual : p = virtual
  · subst p
    simp only [withGenesis, different, ↓reduceIte]
    have := bounded (owner i)
    omega
  · have parent := eligible_parent _ _ _ ok
    have nonroot : owner i ≠ root := by
      intro same
      simp only [withGenesis, same, ↓reduceIte, Option.some.injEq] at parent
      exact atVirtual parent.symm
    have original : eligible m p i = true := by
      simp only [withGenesis, nonroot, ↓reduceIte] at parent
      simp only [eligible, Bool.and_eq_true]
      exact ⟨⟨decide_eq_true bound, authorized⟩, by simp only [parent, Option.some_beq_some, Nat.beq_eq_true_eq]⟩
    simpa only [withGenesis, different, atVirtual, ↓reduceIte] using descending p i original

/-- At real predecessors the virtual-root wrapper preserves every eligible edge.
Freshness concerns a modeling index, not an excluded signed predecessor. -/
theorem genesis_model_eligible (m : Model) (owner : Nat → Nat) (root virtual p i : Nat)
    (different : p ≠ virtual)
    (rootParent : ∀ i, owner i = root → m.parent i = none) :
    eligible (withGenesis m owner root virtual) p i = eligible m p i := by
  by_cases isRoot : owner i = root
  · simp only [eligible, withGenesis, isRoot, ↓reduceIte, rootParent i isRoot,
      Option.some_beq_some, Option.none_beq_some]
    have ne : (virtual == p) = false := by simp [beq_eq_false_iff_ne, Ne.symm different]
    simp [ne]
  · simp only [eligible, withGenesis, isRoot, ↓reduceIte]; rfl

/-- Below genesis, valid wrapped histories are ordinary valid successor paths. -/
theorem genesis_valid_tail (m : Model) (owner : Nat → Nat) (root virtual : Nat)
    (evidence path : List Nat) (p : Nat) (different : p ≠ virtual)
    (rootParent : ∀ i, owner i = root → m.parent i = none)
    (fresh : ∀ i, i < m.size → m.authorized i = true → owner i ≠ virtual)
    (valid : InterleavedValid (withGenesis m owner root virtual) owner evidence p path) :
    InterleavedValid m owner evidence p path := by
  induction valid with
  | nil => exact .nil _
  | @cons child p rest member ok tail ih =>
    have original : eligible m p child = true := by
      rw [genesis_model_eligible m owner root virtual p child different rootParent] at ok
      exact ok
    have bound := eligible_lt _ _ _ original
    have auth : m.authorized child = true := by
      simp only [eligible, Bool.and_eq_true] at original
      exact original.1.2
    exact .cons member original (ih (fresh child bound auth))

/-- Without any eligible genesis evidence, cold replay remains empty. -/
theorem cold_without_genesis [DecidableEq α] (m : Model) (owner : Nat → Nat) (root virtual : Nat)
    (records : List (EventRecord α))
    (freshParent : ∀ i, m.parent i ≠ some virtual)
    (absent : ∀ e ∈ records, owner e.opid ≠ root) :
    stopWhenStable (rankedPass (withGenesis m owner root virtual) owner virtual records) 1 [] = some [] := by
  have noEligible : ∀ e ∈ records, eligible (withGenesis m owner root virtual) virtual e.opid = false := by
    intro e mem
    have nonroot := absent e mem
    have ne := freshParent e.opid
    simp only [eligible, withGenesis, nonroot, ↓reduceIte]
    have different : (m.parent e.opid == some virtual) = false := by
      cases h : m.parent e.opid with
      | none => rfl
      | some p =>
        have pNe : p ≠ virtual := by intro same; subst p; exact ne h
        simpa only [Option.some_beq_some, beq_eq_false_iff_ne] using pNe
    simp [different]
  have unchanged : rankedPass (withGenesis m owner root virtual) owner virtual records [] = [] := by
    induction records with
    | nil => rfl
    | cons head rest ih =>
      have step : rankedImport (withGenesis m owner root virtual) owner virtual head [] = [] := by
        simp [rankedImport, rankedLookup, noEligible head (by simp), recordStep]
      change rankedPass (withGenesis m owner root virtual) owner virtual rest
        (rankedImport (withGenesis m owner root virtual) owner virtual head []) = []
      rw [step]
      exact ih (fun e h => absent e (by simp [h])) (fun e h => noEligible e (by simp [h]))
  simp [stopWhenStable, unchanged]

/-- Cold/late-genesis replay really stops on full record equality. Shared rank
membership yields a unique complete result without seeding a preferred genesis. -/
theorem cold_ranked_converges [DecidableEq α] (m : Model) (owner : Nat → Nat) (root virtual : Nat)
    (records : List (EventRecord α))
    (descending : InterleavedDescending m owner)
    (bounded : ∀ p, m.level p ≤ m.size)
    (fresh : ∀ i, i < m.size → m.authorized i = true → owner i ≠ virtual) :
    ∃ result,
      stopWhenStable (rankedPass (withGenesis m owner root virtual) owner virtual records)
        (m.size + 3) [] = some result ∧
      recordIds result = interleavedSuffix (withGenesis m owner root virtual) owner
        (recordIds records) (m.size + 1) virtual ∧
      rankedPass (withGenesis m owner root virtual) owner virtual records result = result := by
  have result := ranked_full_converges _ owner virtual records []
    (genesis_model_descending m owner root virtual descending bounded fresh) (.nil _)
  simpa only [withGenesis, ↓reduceIte, Nat.add_assoc] using result

end Archon
