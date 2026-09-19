import OperationalReplay

set_option warningAsError true

namespace Archon

/-- Payload represents all remaining event fields; no equality on payload is needed.
`expected` is registry equality for this operation's fixed registration policy,
not a claim that the event is a blockchain confirmation. -/
structure EventRecord (Payload : Type) where
  opid : Nat
  expected : Bool
  payload : Payload
  deriving DecidableEq

/-- Duplicate branch, after fixed authorization succeeds. -/
def promote (current incoming : EventRecord α) : EventRecord α :=
  if current.opid = incoming.opid ∧ current.expected = false ∧ incoming.expected = true
  then incoming else current

/-- One journal scan for a record on an already settled operation path. -/
def settleRecord (evidence : List (EventRecord α)) (current : EventRecord α) : EventRecord α :=
  evidence.foldl promote current

theorem promote_frozen (current incoming : EventRecord α) (h : current.expected = true) :
    promote current incoming = current := by
  simp [promote, h]

theorem promote_opid (current incoming : EventRecord α) :
    (promote current incoming).opid = current.opid := by
  unfold promote
  split
  next h => exact h.1.symm
  next => rfl

theorem promote_either (current incoming : EventRecord α) :
    promote current incoming = current ∨ (promote current incoming).expected = true := by
  unfold promote
  split
  next h => exact Or.inr h.2.2
  next => exact Or.inl rfl

theorem settle_frozen (evidence : List (EventRecord α)) (current : EventRecord α)
    (h : current.expected = true) : settleRecord evidence current = current := by
  induction evidence with
  | nil => rfl
  | cons incoming rest ih =>
    simp only [settleRecord, List.foldl_cons, promote_frozen current incoming h]
    exact ih

theorem settle_opid (evidence : List (EventRecord α)) (current : EventRecord α) :
    (settleRecord evidence current).opid = current.opid := by
  induction evidence generalizing current with
  | nil => rfl
  | cons incoming rest ih =>
    exact (ih (promote current incoming)).trans (promote_opid current incoming)

theorem settle_either (evidence : List (EventRecord α)) (current : EventRecord α) :
    settleRecord evidence current = current ∨ (settleRecord evidence current).expected = true := by
  induction evidence generalizing current with
  | nil => exact Or.inl rfl
  | cons incoming rest ih =>
    change settleRecord rest (promote current incoming) = current ∨
      (settleRecord rest (promote current incoming)).expected = true
    rcases promote_either current incoming with unchanged | frozen
    · rw [unchanged]
      exact ih current
    · rw [settle_frozen rest _ frozen]
      exact Or.inr frozen

/-- Every retained duplicate is inert after one complete scan, even if scans reorder it. -/
theorem settled_absorbs (evidence : List (EventRecord α)) (current incoming : EventRecord α)
    (member : incoming ∈ evidence) :
    promote (settleRecord evidence current) incoming = settleRecord evidence current := by
  induction evidence generalizing current with
  | nil => simp at member
  | cons head rest ih =>
    change promote (settleRecord rest (promote current head)) incoming =
      settleRecord rest (promote current head)
    rcases promote_either current head with unchanged | frozen
    · rw [unchanged]
      rcases List.mem_cons.mp member with same | tail
      · subst incoming
        rcases settle_either rest current with same | frozen
        · rw [same]
          exact unchanged
        · exact promote_frozen _ _ frozen
      · exact ih current tail
    · rw [settle_frozen rest _ frozen]
      exact promote_frozen _ _ frozen

/-- Any further subset/reordering/duplication of the same evidence is inert. -/
theorem settled_scan_unchanged (evidence order : List (EventRecord α))
    (current : EventRecord α) (contained : ∀ e ∈ order, e ∈ evidence) :
    settleRecord order (settleRecord evidence current) = settleRecord evidence current := by
  have absorb := settled_absorbs evidence current
  generalize settleRecord evidence current = result at *
  induction order with
  | nil => rfl
  | cons head rest ih =>
    change settleRecord rest (promote result head) = result
    rw [absorb head (contained head (by simp))]
    exact ih (fun e he => contained e (by simp [he]))

/-- The duplicate-only event pass on a settled path. Unmatched candidates do nothing. -/
def recordStep (path : List (EventRecord α)) (incoming : EventRecord α) : List (EventRecord α) :=
  path.map (fun current => promote current incoming)

def recordPass (evidence path : List (EventRecord α)) : List (EventRecord α) :=
  evidence.foldl recordStep path

/-- The event-major scan equals independent per-record scans. -/
theorem record_pass_eq_map (evidence path : List (EventRecord α)) :
    recordPass evidence path = path.map (settleRecord evidence) := by
  induction evidence generalizing path with
  | nil => exact (List.map_id path).symm
  | cons incoming rest ih =>
    change recordPass rest (recordStep path incoming) = _
    rw [ih]
    simp only [recordStep, List.map_map]
    rfl

theorem record_pass_preserves_path (evidence path : List (EventRecord α)) :
    (recordPass evidence path).map EventRecord.opid = path.map EventRecord.opid := by
  rw [record_pass_eq_map, List.map_map]
  simp only [Function.comp_def, settle_opid]

/-- Full structural records stabilize, not merely their operation IDs. -/
theorem record_pass_idempotent (evidence path : List (EventRecord α)) :
    recordPass evidence (recordPass evidence path) = recordPass evidence path := by
  simp only [record_pass_eq_map, List.map_map, Function.comp_def]
  congr 1
  funext current
  exact settled_scan_unchanged evidence evidence current (fun _ h => h)

/-- Actual stop-on-full-record-equality shape, restricted to the settled-path phase. -/
def recordsUntilStable [DecidableEq α] (evidence : List (EventRecord α)) :
    Nat → List (EventRecord α) → Option (List (EventRecord α))
  | 0, _ => none
  | fuel + 1, path =>
    let next := recordPass evidence path
    if next = path then some path else recordsUntilStable evidence fuel next

/-- One settling pass plus one unchanged pass always suffices in this phase. -/
theorem record_loop_terminates [DecidableEq α] (evidence path : List (EventRecord α)) :
    recordsUntilStable evidence 2 path = some (recordPass evidence path) := by
  simp only [recordsUntilStable, record_pass_idempotent]
  split
  next h => rw [h]
  next => simp

end Archon
