import FullReplay

set_option warningAsError true

namespace Archon

/-- Runtime-shaped stopping check; codec faithfulness is an explicit theorem premise. -/
def stopWhenEncodedStable [DecidableEq β] (step : σ → σ) (encode : σ → β) :
    Nat → σ → Option σ
  | 0, _ => none
  | n + 1, state =>
    let next := step state
    if encode next = encode state then some state
    else stopWhenEncodedStable step encode n next

/-- A partial decoder establishes equality reflection on its modeled state domain.
This is a codec obligation, not an axiom or an implementation of JSON parsing. -/
theorem encode_reflects_of_roundtrip (encode : σ → β) (decode : β → Option σ)
    (roundtrip : ∀ state, decode (encode state) = some state) (a b : σ)
    (same : encode a = encode b) : a = b := by
  have decoded := congrArg decode same
  rw [roundtrip a, roundtrip b] at decoded
  exact Option.some.inj decoded

/-- Faithful serialized equality gives exactly the same result and stopping pass. -/
theorem encoded_stop_eq [DecidableEq σ] [DecidableEq β] (step : σ → σ) (encode : σ → β)
    (reflects : ∀ a b, encode a = encode b → a = b) (fuel : Nat) (state : σ) :
    stopWhenEncodedStable step encode fuel state = stopWhenStable step fuel state := by
  induction fuel generalizing state with
  | zero => rfl
  | succ fuel ih =>
    by_cases fixed : step state = state
    · simp [stopWhenEncodedStable, stopWhenStable, fixed]
    · have changed : encode (step state) ≠ encode state := fun h => fixed (reflects _ _ h)
      simp [stopWhenEncodedStable, stopWhenStable, fixed, changed, ih]

/-- Only adjacent states on this replay's orbit need equality reflection. -/
theorem encoded_stop_eq_on_orbit [DecidableEq σ] [DecidableEq β] (step : σ → σ)
    (encode : σ → β) (fuel : Nat) (state : σ)
    (reflects : ∀ n, encode (step (iterateState step n state)) = encode (iterateState step n state) →
      step (iterateState step n state) = iterateState step n state) :
    stopWhenEncodedStable step encode fuel state = stopWhenStable step fuel state := by
  induction fuel generalizing state with
  | zero => rfl
  | succ fuel ih =>
    by_cases fixed : step state = state
    · simp [stopWhenEncodedStable, stopWhenStable, fixed]
    · have changed : encode (step state) ≠ encode state := fun h => fixed (reflects 0 h)
      simp only [stopWhenEncodedStable, stopWhenStable, fixed, changed, ↓reduceIte]
      exact ih (step state) (fun n => reflects (n + 1))

/-- Once genesis exists, a cold scan lifts exactly the warm full-event scan. -/
theorem cold_event_pass_some (m : Model) (root : Nat) (evidence : List (EventRecord α))
    (state : EventHistory α) :
    coldEventPass m root evidence (some state) = some (historyPass m root evidence state) := by
  induction evidence generalizing state with
  | nil => rfl
  | cons incoming rest ih => exact ih (historyStep m root state incoming)

theorem stop_some_eq [DecidableEq σ] (step : Option σ → Option σ) (warm : σ → σ)
    (lift : ∀ state, step (some state) = some (warm state)) (fuel : Nat) (state : σ) :
    stopWhenStable step fuel (some state) = (stopWhenStable warm fuel state).map some := by
  induction fuel generalizing state with
  | zero => rfl
  | succ fuel ih =>
    simp only [stopWhenStable, lift, Option.some.injEq]
    split
    · rfl
    · exact ih _

/-- One stopping loop starting empty, including its first equality check. -/
theorem full_cold_loop_converges [DecidableEq α] (m : Model) (root : Nat)
    (evidence : List (EventRecord α)) (acyclic : WellFoundedEdges m)
    (genesis : m.parent root = none) (present : root ∈ recordIds evidence) :
    ∃ result,
      stopWhenStable (coldEventPass m root evidence) (m.level root + 3) none = some (some result) ∧
      recordIds (historyRecords result) = history m root (recordIds evidence) ∧
      historyPass m root evidence result = result := by
  obtain ⟨result, success, canonical, fixed⟩ := full_cold_converges m root evidence acyclic genesis present
  refine ⟨result, ?_, canonical, fixed⟩
  cases first : coldEventPass m root evidence none with
  | none => simp [replayFullCold, first] at success
  | some initial =>
    simp only [replayFullCold, first, Option.bind_some] at success
    change (if coldEventPass m root evidence none = none then some none
      else stopWhenStable (coldEventPass m root evidence) (m.level root + 2)
        (coldEventPass m root evidence none)) = some (some result)
    rw [first]
    simp only [Option.some_ne_none, ↓reduceIte]
    rw [stop_some_eq _ (historyPass m root evidence) (cold_event_pass_some m root evidence), success]
    rfl

/-- The full bound and canonical ID result transfer to a faithful serialized stopping check.
The codec premise must be established for the representation being modeled. -/
theorem serialized_cold_converges [DecidableEq α] [DecidableEq β] (m : Model) (root : Nat)
    (evidence : List (EventRecord α)) (encode : Option (EventHistory α) → β)
    (reflects : ∀ a b, encode a = encode b → a = b)
    (acyclic : WellFoundedEdges m) (genesis : m.parent root = none)
    (present : root ∈ recordIds evidence) :
    ∃ result,
      stopWhenEncodedStable (coldEventPass m root evidence) encode (m.level root + 3) none = some (some result) ∧
      recordIds (historyRecords result) = history m root (recordIds evidence) ∧
      historyPass m root evidence result = result := by
  rw [encoded_stop_eq _ encode reflects]
  exact full_cold_loop_converges m root evidence acyclic genesis present

/-- Gatekeeper stores an empty array before genesis, and a root-first array afterwards. -/
def historyWire : Option (EventHistory α) → List (EventRecord α)
  | none => []
  | some state => historyRecords state

def historyUnwire : List (EventRecord α) → Option (EventHistory α)
  | [] => none
  | head :: rest => some (head, rest)

theorem history_wire_roundtrip (state : Option (EventHistory α)) :
    historyUnwire (historyWire state) = state := by
  cases state <;> rfl

/-- Flattening the modeled root/suffix pair to a runtime-shaped array loses no state.
The serializer/parser round trip is required only along this replay orbit, not
for arbitrary records with inconsistent derived fields or non-JSON payloads. -/
theorem serialized_array_converges [DecidableEq α] [DecidableEq β] (m : Model) (root : Nat)
    (evidence : List (EventRecord α)) (encode : List (EventRecord α) → β)
    (decode : β → Option (List (EventRecord α)))
    (roundtrip : ∀ n,
      decode (encode (historyWire (iterateState (coldEventPass m root evidence) n none))) =
        some (historyWire (iterateState (coldEventPass m root evidence) n none)))
    (acyclic : WellFoundedEdges m) (genesis : m.parent root = none)
    (present : root ∈ recordIds evidence) :
    ∃ result,
      stopWhenEncodedStable (coldEventPass m root evidence) (fun s => encode (historyWire s))
        (m.level root + 3) none = some (some result) ∧
      recordIds (historyRecords result) = history m root (recordIds evidence) ∧
      historyPass m root evidence result = result := by
  have reflects : ∀ n,
      encode (historyWire (coldEventPass m root evidence (iterateState (coldEventPass m root evidence) n none))) =
        encode (historyWire (iterateState (coldEventPass m root evidence) n none)) →
      coldEventPass m root evidence (iterateState (coldEventPass m root evidence) n none) =
        iterateState (coldEventPass m root evidence) n none := by
    intro n same
    have next := roundtrip (n + 1)
    rw [iterate_last] at next
    have decoded := congrArg decode same
    rw [next, roundtrip n] at decoded
    have stateSame := congrArg historyUnwire (Option.some.inj decoded)
    simpa only [history_wire_roundtrip] using stateSame
  rw [encoded_stop_eq_on_orbit _ _ _ none reflects]
  exact full_cold_loop_converges m root evidence acyclic genesis present

end Archon
