import InterleavedRecords

set_option warningAsError true
namespace Archon

/-- Full-record insertion cannot invent a receipt. -/
theorem ranked_lookup_preserves (P : EventRecord α → Prop) (m : Model)
    (owner : Nat → Nat) (p : Nat) (incoming : EventRecord α)
    (path : List (EventRecord α)) (fresh : P incoming)
    (valid : ∀ r ∈ path, P r) :
    ∀ r ∈ rankedLookup m owner p incoming path, P r := by
  induction path generalizing p with
  | nil =>
    simp only [rankedLookup]
    split <;> simp_all
  | cons current rest ih =>
    have hc := valid current (by simp)
    have hr : ∀ r ∈ rest, P r := fun r h => valid r (by simp [h])
    simp only [rankedLookup]
    split
    · split
      · split <;> simp_all
      · exact valid
    · intro r member
      rcases List.mem_cons.mp member with h | h
      · simpa only [h] using hc
      · exact ih (owner current.opid) hr r h

theorem promote_preserves (P : EventRecord α → Prop) (current incoming : EventRecord α)
    (hc : P current) (hi : P incoming) : P (promote current incoming) := by
  unfold promote
  split <;> assumption

theorem record_step_preserves (P : EventRecord α → Prop) (path : List (EventRecord α))
    (incoming : EventRecord α) (hi : P incoming) (valid : ∀ r ∈ path, P r) :
    ∀ r ∈ recordStep path incoming, P r := by
  intro r member
  change r ∈ path.map (fun old => promote old incoming) at member
  obtain ⟨old, oldMember, equal⟩ := List.mem_map.mp member
  subst r
  exact promote_preserves P old incoming (valid old oldMember) hi

theorem ranked_pass_preserves (P : EventRecord α → Prop) (m : Model)
    (owner : Nat → Nat) (p : Nat) (evidence path : List (EventRecord α))
    (retained : ∀ r ∈ evidence, P r) (valid : ∀ r ∈ path, P r) :
    ∀ r ∈ rankedPass m owner p evidence path, P r := by
  induction evidence generalizing path with
  | nil => exact valid
  | cons incoming rest ih =>
    have hi := retained incoming (by simp)
    apply ih _ (fun r h => retained r (by simp [h]))
    exact record_step_preserves P _ incoming hi
      (ranked_lookup_preserves P m owner p incoming path hi valid)

theorem stop_preserves [DecidableEq σ] (P : σ → Prop) (step : σ → σ)
    (preserves : ∀ s, P s → P (step s)) (fuel : Nat) (state result : σ)
    (valid : P state) (stopped : stopWhenStable step fuel state = some result) : P result := by
  induction fuel generalizing state with
  | zero => simp [stopWhenStable] at stopped
  | succ fuel ih =>
    simp only [stopWhenStable] at stopped
    split at stopped
    · cases Option.some.inj stopped
      exact valid
    · exact ih _ (preserves state valid) stopped

theorem cold_ranked_provenance [DecidableEq α] (m : Model) (owner : Nat → Nat)
    (p : Nat) (evidence result : List (EventRecord α)) (fuel : Nat)
    (stopped : stopWhenStable (rankedPass m owner p evidence) fuel [] = some result) :
    ∀ r ∈ result, r ∈ evidence := by
  exact stop_preserves (fun path => ∀ r ∈ path, r ∈ evidence)
    (rankedPass m owner p evidence)
    (fun path h => ranked_pass_preserves _ m owner p evidence path (fun _ h => h) h)
    fuel [] result (by simp) stopped

/-- Every retained matching receipt is considered during metadata settling. -/
theorem settle_expected_of_member (evidence : List (EventRecord α))
    (current incoming : EventRecord α) (member : incoming ∈ evidence)
    (same : current.opid = incoming.opid) (active : incoming.expected = true) :
    (settleRecord evidence current).expected = true := by
  induction evidence generalizing current with
  | nil => simp at member
  | cons head tail ih =>
    rcases List.mem_cons.mp member with h | h
    · subst head
      have promoted : (promote current incoming).expected = true := by
        cases hc : current.expected <;> simp [promote, same, active, hc]
      change (settleRecord tail (promote current incoming)).expected = true
      rw [settle_frozen tail _ promoted]
      exact promoted
    · exact ih (promote current head) h ((promote_opid current head).trans same)

theorem fixed_record_expected (evidence path : List (EventRecord α))
    (fixed : recordPass evidence path = path) (current incoming : EventRecord α)
    (member : current ∈ path) (retained : incoming ∈ evidence)
    (same : current.opid = incoming.opid) (active : incoming.expected = true) :
    current.expected = true := by
  rw [← fixed, record_pass_eq_map] at member
  obtain ⟨old, _, h⟩ := List.mem_map.mp member
  subst current
  exact settle_expected_of_member evidence old incoming retained
    ((settle_opid evidence old).symm.trans same) active

/-- Only availability of a matching receipt can promote the flag. Extra
nonmatching/local bookkeeping copies do not change this set. -/
def matchingRanks (records : List (EventRecord α)) : List Nat :=
  recordIds (records.filter EventRecord.expected)

/-- Settled matching-registry flags depend on matching evidence, not arrival. -/
theorem fixed_record_flags_agree (xs ys left right : List (EventRecord α))
    (sameMatching : ∀ i, i ∈ matchingRanks xs ↔ i ∈ matchingRanks ys)
    (lf : recordPass xs left = left) (rf : recordPass ys right = right)
    (lp : ∀ r ∈ left, r ∈ xs) (rp : ∀ r ∈ right, r ∈ ys)
    (a b : EventRecord α) (ha : a ∈ left) (hb : b ∈ right) (same : a.opid = b.opid) :
    a.expected = b.expected := by
  have transfer : ∀ a ∈ xs, a.expected = true → ∃ b ∈ ys, b.opid = a.opid ∧ b.expected = true := by
    intro r hr active
    obtain ⟨b, hb, eq⟩ := List.mem_map.mp
      ((sameMatching r.opid).mp (List.mem_map.mpr ⟨r, List.mem_filter.mpr ⟨hr, active⟩, rfl⟩))
    exact ⟨b, (List.mem_filter.mp hb).1, eq, (List.mem_filter.mp hb).2⟩
  have reverse : ∀ b ∈ ys, b.expected = true → ∃ a ∈ xs, a.opid = b.opid ∧ a.expected = true := by
    intro r hr active
    obtain ⟨a, ha, eq⟩ := List.mem_map.mp
      ((sameMatching r.opid).mpr (List.mem_map.mpr ⟨r, List.mem_filter.mpr ⟨hr, active⟩, rfl⟩))
    exact ⟨a, (List.mem_filter.mp ha).1, eq, (List.mem_filter.mp ha).2⟩
  cases h : a.expected
  · cases k : b.expected
    · rfl
    · obtain ⟨candidate, member, rank, flag⟩ := reverse b (rp b hb) k
      have impossible := fixed_record_expected xs left lf a candidate ha member
        (same.trans rank.symm) flag
      simp [h] at impossible
  · obtain ⟨candidate, member, rank, flag⟩ := transfer a (lp a ha) h
    exact (fixed_record_expected ys right rf b candidate hb member
      (same.symm.trans rank.symm) flag).symm

/-- Equal receipt-class ranks and converged flags suffice when the source
projection proves equal authorization views within each such class. -/
theorem record_views_of_ids (view : EventRecord α → β) (left right : List (EventRecord α))
    (ids : recordIds left = recordIds right)
    (agrees : ∀ a ∈ left, ∀ b ∈ right, a.opid = b.opid → view a = view b) :
    left.map view = right.map view := by
  induction left generalizing right with
  | nil => cases right <;> simp_all [recordIds]
  | cons head tail ih =>
    cases right with
    | nil => simp [recordIds] at ids
    | cons other rest =>
      obtain ⟨first, next⟩ := List.cons.inj ids
      simp only [List.map_cons]
      rw [agrees head (by simp) other (by simp) first]
      exact congrArg (view other :: ·) (ih rest next
        (fun a ha b hb => agrees a (by simp [ha]) b (by simp [hb])))

theorem fixed_record_views_agree (view : EventRecord α → β)
    (xs ys left right : List (EventRecord α))
    (sameMatching : ∀ i, i ∈ matchingRanks xs ↔ i ∈ matchingRanks ys)
    (lf : recordPass xs left = left) (rf : recordPass ys right = right)
    (lp : ∀ r ∈ left, r ∈ xs) (rp : ∀ r ∈ right, r ∈ ys)
    (ids : recordIds left = recordIds right)
    (source : ∀ a ∈ xs, ∀ b ∈ ys, a.opid = b.opid → a.expected = b.expected → view a = view b) :
    left.map view = right.map view := by
  apply record_views_of_ids view left right ids
  intro a ha b hb same
  exact source a (lp a ha) b (rp b hb) same
    (fixed_record_flags_agree xs ys left right sameMatching lf rf lp rp a b ha hb same)

/-- A source-level receipt-class view contract composes with actual cold stopping.
It does not assume equal final flags, final receipts, or authorization verdicts. -/
theorem cold_ranked_same_view [DecidableEq α] (m : Model) (owner : Nat → Nat) (p : Nat)
    (xs ys : List (EventRecord α)) (view : EventRecord α → β)
    (descending : InterleavedDescending m owner)
    (sameRanks : ∀ i, i ∈ recordIds xs ↔ i ∈ recordIds ys)
    (sameMatching : ∀ i, i ∈ matchingRanks xs ↔ i ∈ matchingRanks ys)
    (source : ∀ a ∈ xs, ∀ b ∈ ys, a.opid = b.opid → a.expected = b.expected → view a = view b) :
    (stopWhenStable (rankedPass m owner p xs) (m.level p + 2) []).map (List.map view) =
      (stopWhenStable (rankedPass m owner p ys) (m.level p + 2) []).map (List.map view) := by
  obtain ⟨left, ls, li, lf⟩ := ranked_full_converges m owner p xs [] descending (.nil _)
  obtain ⟨right, rs, ri, rf⟩ := ranked_full_converges m owner p ys [] descending (.nil _)
  have ids : recordIds left = recordIds right := by
    rw [li, ri, interleaved_suffix_same_evidence m owner (recordIds xs) (recordIds ys) sameRanks]
  have completeLeft : InterleavedComplete m owner (recordIds xs) p (recordIds left) := by
    rw [li]
    exact interleaved_suffix_complete m owner (recordIds xs) descending _ p (Nat.le_refl _)
  have completeRight : InterleavedComplete m owner (recordIds ys) p (recordIds right) := by
    rw [ri]
    exact interleaved_suffix_complete m owner (recordIds ys) descending _ p (Nat.le_refl _)
  rw [ranked_pass_complete m owner p _ xs left descending completeLeft
    (fun r hr => List.mem_map.mpr ⟨r, hr, rfl⟩)] at lf
  rw [ranked_pass_complete m owner p _ ys right descending completeRight
    (fun r hr => List.mem_map.mpr ⟨r, hr, rfl⟩)] at rf
  rw [ls, rs, Option.map_some, Option.map_some]
  exact congrArg some (fixed_record_views_agree view xs ys left right sameMatching lf rf
    (cold_ranked_provenance m owner p xs left _ ls)
    (cold_ranked_provenance m owner p ys right _ rs) ids source)

end Archon
