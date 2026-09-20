import FullReplay
import InterleavedBound

set_option warningAsError true
namespace Archon

/-- Full records carry event priority ranks in `opid`; `owner` decodes operation
identity. Payload and first-observation promotion remain part of stop equality. -/
def rankedLookup (m : Model) (owner : Nat → Nat) (p : Nat) (incoming : EventRecord α) :
    List (EventRecord α) → List (EventRecord α)
  | [] => if eligible m p incoming.opid then [incoming] else []
  | current :: rest =>
    if eligible m p incoming.opid then
      if incoming.opid < current.opid then
        if owner current.opid = owner incoming.opid then incoming :: rest else [incoming]
      else current :: rest
    else current :: rankedLookup m owner (owner current.opid) incoming rest

def rankedImport (m : Model) (owner : Nat → Nat) (p : Nat) (incoming : EventRecord α)
    (path : List (EventRecord α)) : List (EventRecord α) :=
  recordStep (rankedLookup m owner p incoming path) incoming

def rankedPass (m : Model) (owner : Nat → Nat) (p : Nat)
    (evidence path : List (EventRecord α)) : List (EventRecord α) :=
  evidence.foldl (fun path incoming => rankedImport m owner p incoming path) path

theorem ranked_lookup_ids (m : Model) (owner : Nat → Nat) (p : Nat)
    (incoming : EventRecord α) (path : List (EventRecord α)) :
    recordIds (rankedLookup m owner p incoming path) =
      interleavedInsert m owner p incoming.opid (recordIds path) := by
  induction path generalizing p with
  | nil => simp only [rankedLookup, recordIds, List.map_nil, interleavedInsert]; split <;> rfl
  | cons current rest ih =>
    simp only [rankedLookup, recordIds, List.map_cons, interleavedInsert]
    by_cases ok : eligible m p incoming.opid = true
    · simp only [ok, ↓reduceIte]
      by_cases less : incoming.opid < current.opid
      · simp only [less, ↓reduceIte]
        split <;> simp only [List.map_cons, List.map_nil, Nat.min_eq_right (Nat.le_of_lt less)]
      · simp only [less, ↓reduceIte]
        split <;> simp only [Nat.min_eq_left (by omega : current.opid ≤ incoming.opid), List.map_cons]
    · simp only [ok, Bool.false_eq_true, ↓reduceIte, List.map_cons]
      exact congrArg (current.opid :: ·) (ih (owner current.opid))

theorem ranked_import_ids (m : Model) (owner : Nat → Nat) (p : Nat)
    (incoming : EventRecord α) (path : List (EventRecord α)) :
    recordIds (rankedImport m owner p incoming path) =
      interleavedInsert m owner p incoming.opid (recordIds path) := by
  rw [rankedImport, record_step_ids, ranked_lookup_ids]

theorem ranked_pass_ids (m : Model) (owner : Nat → Nat) (p : Nat)
    (evidence path : List (EventRecord α)) :
    recordIds (rankedPass m owner p evidence path) =
      interleavedPass m owner p (recordIds evidence) (recordIds path) := by
  induction evidence generalizing path with
  | nil => rfl
  | cons incoming rest ih =>
    change recordIds (rankedPass m owner p rest (rankedImport m owner p incoming path)) = _
    rw [ih, ranked_import_ids]
    rfl

/-- A structural insertion cannot change a payload without changing ranks.
The separate duplicate promotion is the only remaining full-record transition. -/
theorem ranked_lookup_unchanged (m : Model) (owner : Nat → Nat) (p : Nat)
    (incoming : EventRecord α) (path : List (EventRecord α))
    (same : recordIds (rankedLookup m owner p incoming path) = recordIds path) :
    rankedLookup m owner p incoming path = path := by
  induction path generalizing p with
  | nil =>
    by_cases ok : eligible m p incoming.opid = true
    · simp only [rankedLookup, ok, ↓reduceIte, recordIds, List.map_cons, List.map_nil] at same
      cases same
    · simp [rankedLookup, ok]
  | cons current rest ih =>
    by_cases ok : eligible m p incoming.opid = true
    · by_cases less : incoming.opid < current.opid
      · simp only [rankedLookup, ok, less, ↓reduceIte] at same
        split at same
        all_goals
          have eq := (List.cons.inj same).1
          exfalso
          omega
      · simp only [rankedLookup, ok, less, ↓reduceIte]
    · simp only [rankedLookup, ok, Bool.false_eq_true, ↓reduceIte, recordIds, List.map_cons] at same ⊢
      exact congrArg (current :: ·) (ih (owner current.opid) (List.cons.inj same).2)

/-- Completeness of ranked selection derives the metadata-only phase boundary. -/
theorem ranked_import_complete (m : Model) (owner : Nat → Nat) (p : Nat)
    (evidence : List Nat) (incoming : EventRecord α) (path : List (EventRecord α))
    (descending : InterleavedDescending m owner)
    (complete : InterleavedComplete m owner evidence p (recordIds path))
    (member : incoming.opid ∈ evidence) :
    rankedImport m owner p incoming path = recordStep path incoming := by
  unfold rankedImport
  rw [ranked_lookup_unchanged m owner p incoming path]
  rw [ranked_lookup_ids]
  exact interleaved_pass_complete m owner evidence [incoming.opid] p (recordIds path)
    descending complete (fun i hi => by simpa only [List.mem_singleton.mp hi] using member)

theorem ranked_pass_complete (m : Model) (owner : Nat → Nat) (p : Nat)
    (evidence : List Nat) (order path : List (EventRecord α))
    (descending : InterleavedDescending m owner)
    (complete : InterleavedComplete m owner evidence p (recordIds path))
    (retained : ∀ e ∈ order, e.opid ∈ evidence) :
    rankedPass m owner p order path = recordPass order path := by
  induction order generalizing path with
  | nil => rfl
  | cons incoming rest ih =>
    change rankedPass m owner p rest (rankedImport m owner p incoming path) =
      recordPass rest (recordStep path incoming)
    rw [ranked_import_complete m owner p evidence incoming path descending complete
      (retained incoming (by simp))]
    exact ih _ (by simpa only [record_step_ids] using complete)
      (fun e he => retained e (by simp [he]))

theorem ranked_pass_settles (m : Model) (owner : Nat → Nat) (p : Nat)
    (evidence path : List (EventRecord α)) (descending : InterleavedDescending m owner)
    (complete : InterleavedComplete m owner (recordIds evidence) p (recordIds path)) :
    rankedPass m owner p evidence (rankedPass m owner p evidence path) =
      rankedPass m owner p evidence path := by
  have retained : ∀ e ∈ evidence, e.opid ∈ recordIds evidence :=
    fun e he => List.mem_map.mpr ⟨e, he, rfl⟩
  rw [ranked_pass_complete m owner p _ evidence path descending complete retained]
  have nextComplete : InterleavedComplete m owner (recordIds evidence) p
      (recordIds (recordPass evidence path)) := by
    simpa only [recordIds, record_pass_preserves_path] using complete
  rw [ranked_pass_complete m owner p _ evidence _ descending nextComplete retained]
  exact record_pass_idempotent evidence path

theorem ranked_rounds_ids (m : Model) (owner : Nat → Nat) (p : Nat)
    (evidence path : List (EventRecord α)) (n : Nat) :
    recordIds (iterateState (rankedPass m owner p evidence) n path) =
      interleavedRounds m owner p (recordIds evidence) n (recordIds path) := by
  induction n generalizing path with
  | zero => rfl
  | succ n ih =>
    change recordIds (iterateState (rankedPass m owner p evidence) n
      (rankedPass m owner p evidence path)) = _
    rw [ih, ranked_pass_ids]
    rfl

/-- Interleaved anchor promotion, sibling replacement, and payload promotion
terminate under the actual full-record equality predicate. The extra two passes
settle payloads and detect equality after rank convergence. -/
theorem ranked_full_converges [DecidableEq α] (m : Model) (owner : Nat → Nat) (p : Nat)
    (evidence path : List (EventRecord α)) (descending : InterleavedDescending m owner)
    (valid : InterleavedValid m owner (recordIds evidence) p (recordIds path)) :
    ∃ result, stopWhenStable (rankedPass m owner p evidence) (m.level p + 2) path = some result ∧
      recordIds result = interleavedSuffix m owner (recordIds evidence) (m.level p) p ∧
      rankedPass m owner p evidence result = result := by
  let selected := iterateState (rankedPass m owner p evidence) (m.level p) path
  have ids : recordIds selected = interleavedSuffix m owner (recordIds evidence) (m.level p) p := by
    rw [ranked_rounds_ids]
    exact interleaved_rounds_converge m owner (recordIds evidence) descending _ p _ valid (Nat.le_refl _)
  have complete : InterleavedComplete m owner (recordIds evidence) p (recordIds selected) := by
    rw [ids]
    exact interleaved_suffix_complete m owner (recordIds evidence) descending _ p (Nat.le_refl _)
  let result := rankedPass m owner p evidence selected
  have fixed : rankedPass m owner p evidence result = result :=
    ranked_pass_settles m owner p evidence selected descending complete
  refine ⟨result, stop_of_reaches _ path result (m.level p + 1) (iterate_last _ path _) fixed, ?_, fixed⟩
  change recordIds (rankedPass m owner p evidence selected) = _
  rw [ranked_pass_complete m owner p _ evidence selected descending complete
    (fun e he => List.mem_map.mpr ⟨e, he, rfl⟩)]
  exact (record_pass_preserves_path evidence selected).trans ids

/-- Different receipt payloads may settle differently; every function of the
canonical ranked path is nevertheless identical after full structural stopping. -/
theorem ranked_full_same_semantics [DecidableEq α] (m : Model) (owner : Nat → Nat) (p : Nat)
    (xs ys left right : List (EventRecord α)) (view : List Nat → β)
    (descending : InterleavedDescending m owner)
    (lv : InterleavedValid m owner (recordIds xs) p (recordIds left))
    (rv : InterleavedValid m owner (recordIds ys) p (recordIds right))
    (same : ∀ i, i ∈ recordIds xs ↔ i ∈ recordIds ys) :
    (stopWhenStable (rankedPass m owner p xs) (m.level p + 2) left).map
        (fun records => view (recordIds records)) =
      (stopWhenStable (rankedPass m owner p ys) (m.level p + 2) right).map
        (fun records => view (recordIds records)) := by
  obtain ⟨a, stoppedA, idsA, _⟩ := ranked_full_converges m owner p xs left descending lv
  obtain ⟨b, stoppedB, idsB, _⟩ := ranked_full_converges m owner p ys right descending rv
  rw [stoppedA, stoppedB, Option.map_some, Option.map_some, idsA, idsB,
    interleaved_suffix_same_evidence m owner (recordIds xs) (recordIds ys) same]

end Archon
