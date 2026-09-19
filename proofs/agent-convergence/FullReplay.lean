import EventRecords

set_option warningAsError true

namespace Archon

def recordIds (path : List (EventRecord α)) : List Nat := path.map EventRecord.opid

/-- Predecessor lookup preserves records, appends, or truncates at a preferred sibling. -/
def eventLookup (m : Model) (p : Nat) (incoming : EventRecord α) :
    List (EventRecord α) → List (EventRecord α)
  | [] => if eligible m p incoming.opid then [incoming] else []
  | child :: rest =>
    if eligible m p incoming.opid then
      if incoming.opid < child.opid then [incoming] else child :: rest
    else child :: eventLookup m child.opid incoming rest

/-- Duplicate metadata promotion and branch selection occur in the same importer. -/
def eventImport (m : Model) (p : Nat) (incoming : EventRecord α)
    (path : List (EventRecord α)) : List (EventRecord α) :=
  if incoming.opid ∈ recordIds path then recordStep path incoming
  else eventLookup m p incoming path

def eventPass (m : Model) (p : Nat) (evidence path : List (EventRecord α)) : List (EventRecord α) :=
  evidence.foldl (fun current e => eventImport m p e current) path

theorem record_step_ids (path : List (EventRecord α)) (incoming : EventRecord α) :
    recordIds (recordStep path incoming) = recordIds path := by
  simp [recordIds, recordStep, List.map_map, promote_opid]

theorem event_lookup_ids (m : Model) (p : Nat) (incoming : EventRecord α)
    (path : List (EventRecord α)) :
    recordIds (eventLookup m p incoming path) = lookupInsert m p incoming.opid (recordIds path) := by
  induction path generalizing p with
  | nil => simp [eventLookup, lookupInsert, recordIds]; split <;> rfl
  | cons child rest ih =>
    simp only [eventLookup, lookupInsert, recordIds, List.map_cons]
    split
    · split <;> rfl
    · simp only [List.map_cons]
      exact congrArg (child.opid :: ·) (ih child.opid)

theorem event_import_ids (m : Model) (p : Nat) (incoming : EventRecord α)
    (path : List (EventRecord α)) :
    recordIds (eventImport m p incoming path) = importCandidate m p incoming.opid (recordIds path) := by
  simp only [eventImport, importCandidate]
  split
  · exact record_step_ids path incoming
  · exact event_lookup_ids m p incoming path

theorem event_pass_ids (m : Model) (p : Nat) (evidence path : List (EventRecord α)) :
    recordIds (eventPass m p evidence path) = importPass m p (recordIds evidence) (recordIds path) := by
  induction evidence generalizing path with
  | nil => rfl
  | cons incoming rest ih =>
    change recordIds (eventPass m p rest (eventImport m p incoming path)) = _
    rw [ih, event_import_ids]
    rfl

/-- A lookup cannot silently replace metadata while preserving its ID path. -/
theorem event_lookup_unchanged (m : Model) (p : Nat) (incoming : EventRecord α)
    (path : List (EventRecord α))
    (same : recordIds (eventLookup m p incoming path) = recordIds path) :
    eventLookup m p incoming path = path := by
  induction path generalizing p with
  | nil =>
    by_cases ok : eligible m p incoming.opid = true
    · simp [eventLookup, ok, recordIds] at same
    · simp [eventLookup, ok]
  | cons child rest ih =>
    by_cases ok : eligible m p incoming.opid = true
    · by_cases less : incoming.opid < child.opid
      · simp only [eventLookup, ok, less, ↓reduceIte, recordIds, List.map_cons] at same
        have equal := (List.cons.inj same).1
        exfalso
        omega
      · simp [eventLookup, ok, less]
    · simp only [eventLookup, ok, recordIds, List.map_cons] at same
      have tail := ih child.opid (List.cons.inj same).2
      simp [eventLookup, ok, tail]

theorem record_step_absent (path : List (EventRecord α)) (incoming : EventRecord α)
    (absent : incoming.opid ∉ recordIds path) : recordStep path incoming = path := by
  induction path with
  | nil => rfl
  | cons child rest ih =>
    have different : child.opid ≠ incoming.opid := by
      intro h
      exact absent (by simp [recordIds, h])
    have tail : incoming.opid ∉ recordIds rest := by
      intro h
      exact absent (by simp [recordIds] at *; simp_all)
    change promote child incoming :: recordStep rest incoming = child :: rest
    rw [ih tail]
    simp [promote, different]

/-- Completeness proves the phase boundary; it is not assumed as an importer law. -/
theorem event_import_complete (m : Model) (evidence : List Nat) (p : Nat)
    (incoming : EventRecord α) (path : List (EventRecord α))
    (acyclic : WellFoundedEdges m) (complete : Complete m evidence p (recordIds path))
    (member : incoming.opid ∈ evidence) :
    eventImport m p incoming path = recordStep path incoming := by
  unfold eventImport
  split
  · rfl
  next absent =>
    rw [record_step_absent path incoming absent]
    apply event_lookup_unchanged
    rw [event_lookup_ids, lookup_eq_insert m evidence p incoming.opid _ acyclic
      (complete_valid m evidence p _ complete)]
    exact insert_complete m evidence p incoming.opid _ complete member

theorem event_pass_complete (m : Model) (evidence : List Nat) (p : Nat)
    (order path : List (EventRecord α)) (acyclic : WellFoundedEdges m)
    (complete : Complete m evidence p (recordIds path))
    (retained : ∀ e ∈ order, e.opid ∈ evidence) :
    eventPass m p order path = recordPass order path := by
  induction order generalizing path with
  | nil => rfl
  | cons incoming rest ih =>
    change eventPass m p rest (eventImport m p incoming path) = recordPass rest (recordStep path incoming)
    rw [event_import_complete m evidence p incoming path acyclic complete (retained incoming (by simp))]
    apply ih
    · simpa only [record_step_ids] using complete
    · exact fun e he => retained e (by simp [he])

theorem event_pass_complete_ids (m : Model) (evidence : List Nat) (p : Nat)
    (order path : List (EventRecord α)) (acyclic : WellFoundedEdges m)
    (complete : Complete m evidence p (recordIds path))
    (retained : ∀ e ∈ order, e.opid ∈ evidence) :
    recordIds (eventPass m p order path) = recordIds path := by
  rw [event_pass_complete m evidence p order path acyclic complete retained]
  exact record_pass_preserves_path order path

theorem event_pass_settles (m : Model) (p : Nat) (evidence path : List (EventRecord α))
    (acyclic : WellFoundedEdges m) (complete : Complete m (recordIds evidence) p (recordIds path)) :
    eventPass m p evidence (eventPass m p evidence path) = eventPass m p evidence path := by
  have retained : ∀ e ∈ evidence, e.opid ∈ recordIds evidence := by
    intro e he
    exact List.mem_map.mpr ⟨e, he, rfl⟩
  have same := event_pass_complete_ids m _ p evidence path acyclic complete retained
  have nextComplete : Complete m (recordIds evidence) p (recordIds (eventPass m p evidence path)) := by
    rw [same]
    exact complete
  rw [event_pass_complete m _ p evidence _ acyclic nextComplete retained,
      event_pass_complete m _ p evidence path acyclic complete retained]
  exact record_pass_idempotent evidence path


/-- A warm history includes its genesis record as well as its successor records. -/
abbrev EventHistory (α : Type) := EventRecord α × List (EventRecord α)

def historyStep (m : Model) (root : Nat) (state : EventHistory α)
    (incoming : EventRecord α) : EventHistory α :=
  (promote state.1 incoming, eventImport m root incoming state.2)

def historyPass (m : Model) (root : Nat) (evidence : List (EventRecord α))
    (state : EventHistory α) : EventHistory α :=
  evidence.foldl (historyStep m root) state

theorem history_pass_components (m : Model) (root : Nat) (evidence : List (EventRecord α))
    (state : EventHistory α) :
    historyPass m root evidence state =
      (settleRecord evidence state.1, eventPass m root evidence state.2) := by
  induction evidence generalizing state with
  | nil => rfl
  | cons incoming rest ih =>
    change historyPass m root rest (historyStep m root state incoming) = _
    rw [ih]
    rfl

theorem history_pass_ids (m : Model) (root : Nat) (evidence : List (EventRecord α))
    (state : EventHistory α) :
    recordIds (historyPass m root evidence state).2 =
      importPass m root (recordIds evidence) (recordIds state.2) := by
  rw [history_pass_components]
  exact event_pass_ids m root evidence state.2

theorem history_pass_root (m : Model) (root : Nat) (evidence : List (EventRecord α))
    (state : EventHistory α) : (historyPass m root evidence state).1.opid = state.1.opid := by
  rw [history_pass_components]
  exact settle_opid evidence state.1

theorem history_pass_settles (m : Model) (root : Nat) (evidence : List (EventRecord α))
    (state : EventHistory α) (acyclic : WellFoundedEdges m)
    (complete : Complete m (recordIds evidence) root (recordIds state.2)) :
    historyPass m root evidence (historyPass m root evidence state) = historyPass m root evidence state := by
  simp only [history_pass_components]
  exact Prod.ext (settled_scan_unchanged evidence evidence state.1 (fun _ h => h))
    (event_pass_settles m root evidence state.2 acyclic complete)

/-- Generic deterministic iteration, and the actual stop-on-equality shape. -/
def iterateState (step : σ → σ) : Nat → σ → σ
  | 0, state => state
  | n + 1, state => iterateState step n (step state)

def stopWhenStable [DecidableEq σ] (step : σ → σ) : Nat → σ → Option σ
  | 0, _ => none
  | n + 1, state =>
    let next := step state
    if next = state then some state else stopWhenStable step n next

theorem iterate_fixed (step : σ → σ) (state : σ) (fixed : step state = state) (n : Nat) :
    iterateState step n state = state := by
  induction n with
  | zero => rfl
  | succ n ih => simp [iterateState, fixed, ih]

theorem iterate_last (step : σ → σ) (state : σ) (n : Nat) :
    iterateState step (n + 1) state = step (iterateState step n state) := by
  induction n generalizing state with
  | zero => rfl
  | succ n ih => exact ih (step state)

theorem stop_of_reaches [DecidableEq σ] (step : σ → σ) (state target : σ) (n : Nat)
    (reaches : iterateState step n state = target) (fixed : step target = target) :
    stopWhenStable step (n + 1) state = some target := by
  induction n generalizing state with
  | zero =>
    change state = target at reaches
    subst state
    simp [stopWhenStable, fixed]
  | succ n ih =>
    simp only [stopWhenStable]
    split
    next stopped =>
      rw [iterate_fixed step state stopped (n + 1)] at reaches
      simp [reaches]
    next => exact ih _ reaches

theorem history_rounds_ids (m : Model) (root : Nat) (evidence : List (EventRecord α))
    (state : EventHistory α) (n : Nat) :
    recordIds (iterateState (historyPass m root evidence) n state).2 =
      importRounds m root (recordIds evidence) n (recordIds state.2) := by
  induction n generalizing state with
  | zero => rfl
  | succ n ih =>
    change recordIds (iterateState (historyPass m root evidence) n
      (historyPass m root evidence state)).2 = _
    rw [ih, history_pass_ids]
    rfl

theorem history_rounds_root (m : Model) (root : Nat) (evidence : List (EventRecord α))
    (state : EventHistory α) (n : Nat) :
    (iterateState (historyPass m root evidence) n state).1.opid = state.1.opid := by
  induction n generalizing state with
  | zero => rfl
  | succ n ih => exact (ih (historyPass m root evidence state)).trans (history_pass_root m root evidence state)

/-- Bound includes path selection, metadata settling, and an unchanged full-record pass. -/
theorem full_warm_converges [DecidableEq α] (m : Model) (root : Nat)
    (evidence : List (EventRecord α)) (state : EventHistory α) (acyclic : WellFoundedEdges m)
    (valid : ValidPath m (recordIds evidence) root (recordIds state.2)) :
    ∃ result, stopWhenStable (historyPass m root evidence) (m.level root + 2) state = some result ∧
      recordIds result.2 = suffix m (recordIds evidence) (m.level root) root ∧
      result.1.opid = state.1.opid ∧ historyPass m root evidence result = result := by
  let selected := iterateState (historyPass m root evidence) (m.level root) state
  have ids : recordIds selected.2 = suffix m (recordIds evidence) (m.level root) root := by
    rw [history_rounds_ids, import_rounds_eq m (recordIds evidence) root _ acyclic valid]
    exact rounds_eq_suffix m (recordIds evidence) acyclic _ root _ valid (Nat.le_refl _)
  have complete : Complete m (recordIds evidence) root (recordIds selected.2) := by
    rw [ids]
    exact suffix_complete m (recordIds evidence) acyclic _ root (Nat.le_refl _)
  let result := historyPass m root evidence selected
  have fixed : historyPass m root evidence result = result :=
    history_pass_settles m root evidence selected acyclic complete
  refine ⟨result, ?_, ?_, ?_, fixed⟩
  · apply stop_of_reaches _ state result (m.level root + 1) _ fixed
    exact iterate_last _ state (m.level root)
  · change recordIds (historyPass m root evidence selected).2 = _
    rw [history_pass_components, event_pass_complete_ids m (recordIds evidence) root evidence
      selected.2 acyclic complete (fun e he => List.mem_map.mpr ⟨e, he, rfl⟩)]
    exact ids
  · exact (history_pass_root m root evidence selected).trans (history_rounds_root m root evidence state _)

/-- No accepted history exists until the unique valid genesis arrives. -/
def coldEventImport (m : Model) (root : Nat) (incoming : EventRecord α) :
    Option (EventHistory α) → Option (EventHistory α)
  | none => if incoming.opid = root then some (incoming, []) else none
  | some state => some (historyStep m root state incoming)

def coldEventPass (m : Model) (root : Nat) (evidence : List (EventRecord α))
    (state : Option (EventHistory α)) : Option (EventHistory α) :=
  evidence.foldl (fun current e => coldEventImport m root e current) state

def coldRecordIds (state : Option (EventHistory α)) : Option (List Nat) :=
  state.map (fun s => recordIds s.2)

theorem cold_event_import_ids (m : Model) (root : Nat) (incoming : EventRecord α)
    (state : Option (EventHistory α)) (genesis : m.parent root = none) :
    coldRecordIds (coldEventImport m root incoming state) =
      coldImport m root incoming.opid (coldRecordIds state) := by
  cases state with
  | none =>
    by_cases isRoot : incoming.opid = root <;>
      simp [coldRecordIds, coldEventImport, coldImport, isRoot, recordIds]
  | some state =>
    rw [show coldRecordIds (some state) = some (recordIds state.2) from rfl,
      cold_import_some m root incoming.opid _ genesis]
    change some (recordIds (eventImport m root incoming state.2)) = _
    rw [event_import_ids]

theorem cold_event_pass_ids (m : Model) (root : Nat) (evidence : List (EventRecord α))
    (state : Option (EventHistory α)) (genesis : m.parent root = none) :
    coldRecordIds (coldEventPass m root evidence state) =
      coldPass m root (recordIds evidence) (coldRecordIds state) := by
  induction evidence generalizing state with
  | nil => rfl
  | cons incoming rest ih =>
    change coldRecordIds (coldEventPass m root rest (coldEventImport m root incoming state)) = _
    rw [ih, cold_event_import_ids m root incoming state genesis]
    rfl

def HasRoot (root : Nat) : Option (EventHistory α) → Prop
  | none => True
  | some state => state.1.opid = root

theorem cold_event_import_root (m : Model) (root : Nat) (incoming : EventRecord α)
    (state : Option (EventHistory α)) (valid : HasRoot root state) :
    HasRoot root (coldEventImport m root incoming state) := by
  cases state with
  | none =>
    by_cases isRoot : incoming.opid = root <;> simp [coldEventImport, isRoot, HasRoot]
  | some state =>
    change (promote state.1 incoming).opid = root
    rw [promote_opid]
    exact valid

theorem cold_event_pass_root (m : Model) (root : Nat) (evidence : List (EventRecord α))
    (state : Option (EventHistory α)) (valid : HasRoot root state) :
    HasRoot root (coldEventPass m root evidence state) := by
  induction evidence generalizing state with
  | nil => exact valid
  | cons incoming rest ih => exact ih _ (cold_event_import_root m root incoming state valid)

def historyRecords (state : EventHistory α) : List (EventRecord α) := state.1 :: state.2

/-- First cold scan, then the same full-record comparison loop used for warm replay.
The first scan necessarily changes None when retained evidence includes genesis. -/
def replayFullCold [DecidableEq α] (m : Model) (root : Nat) (evidence : List (EventRecord α)) :
    Option (EventHistory α) :=
  (coldEventPass m root evidence none).bind
    (stopWhenStable (historyPass m root evidence) (m.level root + 2))

/-- Cold bound: level(root)+3 complete passes, including metadata and final equality.
No metadata equality between different evidence orders is claimed. -/
theorem full_cold_converges [DecidableEq α] (m : Model) (root : Nat)
    (evidence : List (EventRecord α)) (acyclic : WellFoundedEdges m)
    (genesis : m.parent root = none) (present : root ∈ recordIds evidence) :
    ∃ result, replayFullCold m root evidence = some result ∧
      recordIds (historyRecords result) = history m root (recordIds evidence) ∧
      historyPass m root evidence result = result := by
  obtain ⟨path, initialized⟩ := cold_pass_initializes m root (recordIds evidence) none genesis present
  have projected := cold_event_pass_ids m root evidence none genesis
  change coldRecordIds (coldEventPass m root evidence none) = coldPass m root (recordIds evidence) none at projected
  rw [initialized] at projected
  have hasRoot := cold_event_pass_root m root evidence none True.intro
  generalize started : coldEventPass m root evidence none = state at *
  cases state with
  | none => simp [coldRecordIds] at projected
  | some state =>
    have valid := cold_pass_valid m (recordIds evidence) (recordIds evidence) root none acyclic
      True.intro (fun _ h => h)
    rw [initialized] at valid
    have ids : recordIds state.2 = path := Option.some.inj projected
    have validState : ValidPath m (recordIds evidence) root (recordIds state.2) := by
      rw [ids]
      exact valid
    obtain ⟨result, stopped, canonical, rootKept, fixed⟩ :=
      full_warm_converges m root evidence state acyclic validState
    refine ⟨result, ?_, ?_, fixed⟩
    · simp only [replayFullCold, started, Option.bind_some]
      exact stopped
    · change result.1.opid :: recordIds result.2 = _
      rw [canonical, rootKept, show state.1.opid = root from hasRoot]
      rfl

/-- Across nodes, only the operation-ID projection is invariant under reordered receipts. -/
theorem full_cold_same_operations [DecidableEq α] (m : Model) (root : Nat)
    (xs ys : List (EventRecord α)) (acyclic : WellFoundedEdges m)
    (genesis : m.parent root = none) (present : root ∈ recordIds xs)
    (same : ∀ i, i ∈ recordIds xs ↔ i ∈ recordIds ys) :
    (replayFullCold m root xs).map (fun s => recordIds (historyRecords s)) =
      (replayFullCold m root ys).map (fun s => recordIds (historyRecords s)) := by
  obtain ⟨left, hl, pl, _⟩ := full_cold_converges m root xs acyclic genesis present
  obtain ⟨right, hr, pr, _⟩ := full_cold_converges m root ys acyclic genesis ((same root).mp present)
  rw [hl, hr, Option.map_some, Option.map_some, pl, pr,
    history_same_evidence m root (recordIds xs) (recordIds ys) same]

/-- Valid acyclic paths never repeat an ID, so map-based promotion updates at most one row. -/
theorem valid_member_below (m : Model) (evidence : List Nat) (p i : Nat) (path : List Nat)
    (acyclic : WellFoundedEdges m) (valid : ValidPath m evidence p path) (member : i ∈ path) :
    m.level i < m.level p := by
  induction valid with
  | nil => simp at member
  | @cons child p rest mem ok tail ih =>
    rcases List.mem_cons.mp member with rfl | later
    · exact acyclic p i ok
    · have := ih later
      have := acyclic p child ok
      omega

theorem valid_path_nodup (m : Model) (evidence : List Nat) (p : Nat) (path : List Nat)
    (acyclic : WellFoundedEdges m) (valid : ValidPath m evidence p path) : path.Nodup := by
  induction valid with
  | nil => simp
  | @cons child p rest mem ok tail ih =>
    apply List.nodup_cons.mpr
    refine ⟨?_, ih⟩
    intro member
    have := valid_member_below m evidence child child rest acyclic tail member
    omega

/-- Processing a duplicate genesis only promotes its record; it cannot affect successors. -/
theorem history_step_genesis (m : Model) (evidence : List Nat) (root : Nat)
    (incoming : EventRecord α) (state : EventHistory α) (acyclic : WellFoundedEdges m)
    (genesis : m.parent root = none) (valid : ValidPath m evidence root (recordIds state.2))
    (isRoot : incoming.opid = root) :
    historyStep m root state incoming = (promote state.1 incoming, state.2) := by
  have absent : incoming.opid ∉ recordIds state.2 := by
    intro member
    rw [isRoot] at member
    have := valid_member_below m evidence root root _ acyclic valid member
    omega
  have unchanged : eventLookup m root incoming state.2 = state.2 := by
    apply event_lookup_unchanged
    rw [event_lookup_ids, isRoot, lookup_no_parent m root root _ genesis]
  simp [historyStep, eventImport, absent, unchanged]

end Archon
