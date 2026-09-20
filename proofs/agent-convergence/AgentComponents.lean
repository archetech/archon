import DocumentAuthorization

set_option warningAsError true
namespace Archon

/-- Active document indices name complete immutable DID-document values.
Data and registration are opaque values; their JSON codecs are not proved here. -/
structure ComponentState (Data Registration : Type) where
  authority : AgentState
  data : Data
  registration : Registration
  deriving DecidableEq

structure ComponentPatch (Data Registration : Type) where
  data : Option Data
  registration : Option Registration

/-- The opaque full-document encoding must project to the method list used for
verification. This is an explicit bridge contract, not a JSON-parser proof. -/
theorem component_document_authority (g : DocumentGraph) (documents : Nat → Doc)
    (methods : Doc → List VerificationMethod)
    (agrees : ∀ i, methods (documents i) = g.documents i) (operation before : Nat) :
    verifiesDocument (methods (documents before)) (g.named operation) (g.signatureValid operation) =
      (documentAgent g).validBy operation before := by
  rw [agrees]
  rfl

/-- Authorization decoded from the same full-document values returned by resolution. -/
def decodedComponentGraph (g : DocumentGraph) (documents : Nat → Doc)
    (methods : Doc → List VerificationMethod) : DocumentGraph :=
  { g with documents := fun i => methods (documents i) }

theorem decoded_component_graph_eq (g : DocumentGraph) (documents : Nat → Doc)
    (methods : Doc → List VerificationMethod)
    (agrees : ∀ i, methods (documents i) = g.documents i) :
    decodedComponentGraph g documents methods = g := by
  have equal : (fun i => methods (documents i)) = g.documents := funext agrees
  simp [decodedComponentGraph, equal]

/-- Replace supplied components, carry forward omitted components. Deletion
clears data and preserves registration, while authority marks the empty DID doc. -/
def componentStep (g : DocumentGraph) (patch : Nat → ComponentPatch D R)
    (empty : D) (i : Nat) (before : ComponentState D R) : Option (ComponentState D R) :=
  (advanceAgent (documentAgent g) i before.authority).map fun next =>
    match next with
    | .deleted => ⟨next, empty, before.registration⟩
    | .active _ => ⟨next, (patch i).data.getD before.data,
        (patch i).registration.getD before.registration⟩

def runComponents (g : DocumentGraph) (patch : Nat → ComponentPatch D R) (empty : D) :
    ComponentState D R → List Nat → Option (ComponentState D R)
  | state, [] => some state
  | state, i :: rest => (componentStep g patch empty i state).bind
      (fun next => runComponents g patch empty next rest)

theorem component_step_authority (g : DocumentGraph) (patch : Nat → ComponentPatch D R)
    (empty : D) (i : Nat) (before : ComponentState D R) :
    (componentStep g patch empty i before).map ComponentState.authority =
      advanceAgent (documentAgent g) i before.authority := by
  cases h : advanceAgent (documentAgent g) i before.authority with
  | none => simp [componentStep, h]
  | some next => cases next <;> simp [componentStep, h]

/-- Carrying full component values does not change the authorization run. -/
theorem component_run_authority (g : DocumentGraph) (patch : Nat → ComponentPatch D R)
    (empty : D) (path : List Nat) (before : ComponentState D R) :
    (runComponents g patch empty before path).map ComponentState.authority =
      runAgent (documentAgent g) before.authority path := by
  induction path generalizing before with
  | nil => rfl
  | cons i rest ih =>
    have step := component_step_authority g patch empty i before
    cases h : componentStep g patch empty i before with
    | none =>
      simp only [h, Option.map_none] at step
      simp [runComponents, runAgent, h, ← step]
    | some next =>
      simp only [h, Option.map_some] at step
      simp [runComponents, runAgent, h, ← step, ih]

/-- Reconciliation selects an executable full-component history, not just IDs. -/
theorem component_replay_converges [DecidableEq α] (g : DocumentGraph)
    (documents : Nat → Doc) (methods : Doc → List VerificationMethod)
    (agrees : ∀ i, methods (documents i) = g.documents i)
    (patch : Nat → ComponentPatch D R) (empty initialData : D) (initialRegistration : R)
    (ordered : AncestryOrdered (documentAgent g)) (bounded : DepthBounded (documentAgent g))
    (genesis : g.parent g.root = none) (rootBound : g.root < g.size)
    (evidence : List (EventRecord α)) (present : g.root ∈ recordIds evidence) :
    ∃ result final,
      replayFullCold (agentModel (documentAgent g)) g.root evidence = some result ∧
      recordIds (historyRecords result) = history (agentModel (documentAgent g)) g.root (recordIds evidence) ∧
      historyPass (agentModel (documentAgent g)) g.root evidence result = result ∧
      runComponents (decodedComponentGraph g documents methods) patch empty ⟨.active g.initialDocument, initialData, initialRegistration⟩
        (recordIds result.2) = some final := by
  rw [decoded_component_graph_eq g documents methods agrees]
  obtain ⟨result, authority, success, canonical, fixed, ran, _⟩ :=
    document_replay_converges g ordered bounded genesis rootBound evidence present
  have projection := component_run_authority g patch empty (recordIds result.2)
    ⟨.active g.initialDocument, initialData, initialRegistration⟩
  rw [ran] at projection
  cases h : runComponents g patch empty ⟨.active g.initialDocument, initialData, initialRegistration⟩
      (recordIds result.2) with
  | none => simp [h] at projection
  | some final => exact ⟨result, final, success, canonical, fixed, h⟩

/-- Decode active document indices to full DID-document values. Deleted documents
have a fixed value (the DID-only object); data and registration remain explicit. -/
def componentResult (documents : Nat → Doc) (deleted : Doc) (state : ComponentState D R) : Doc × D × R :=
  (match state.authority with | .active i => documents i | .deleted => deleted,
   state.data, state.registration)

theorem components_same_evidence [DecidableEq α] (g : DocumentGraph)
    (patch : Nat → ComponentPatch D R) (empty initialData : D) (initialRegistration : R)
    (documents : Nat → Doc) (deleted : Doc) (methods : Doc → List VerificationMethod)
    (agrees : ∀ i, methods (documents i) = g.documents i)
    (ordered : AncestryOrdered (documentAgent g)) (bounded : DepthBounded (documentAgent g))
    (genesis : g.parent g.root = none) (rootBound : g.root < g.size)
    (xs ys : List (EventRecord α)) (present : g.root ∈ recordIds xs)
    (same : ∀ i, i ∈ recordIds xs ↔ i ∈ recordIds ys) :
    (replayFullCold (agentModel (documentAgent g)) g.root xs).map (fun s =>
      (recordIds (historyRecords s), (runComponents (decodedComponentGraph g documents methods) patch empty
        ⟨.active g.initialDocument, initialData, initialRegistration⟩ (recordIds s.2)).map (componentResult documents deleted))) =
    (replayFullCold (agentModel (documentAgent g)) g.root ys).map (fun s =>
      (recordIds (historyRecords s), (runComponents (decodedComponentGraph g documents methods) patch empty
        ⟨.active g.initialDocument, initialData, initialRegistration⟩ (recordIds s.2)).map (componentResult documents deleted))) := by
  obtain ⟨left, _, hl, pl, _, _⟩ := component_replay_converges g documents methods agrees patch empty initialData initialRegistration ordered bounded genesis rootBound xs present
  obtain ⟨right, _, hr, pr, _, _⟩ := component_replay_converges g documents methods agrees patch empty initialData initialRegistration ordered bounded genesis rootBound ys ((same g.root).mp present)
  have ids : recordIds (historyRecords left) = recordIds (historyRecords right) := by
    rw [pl, pr, history_same_evidence (agentModel (documentAgent g)) g.root (recordIds xs) (recordIds ys) same]
  have tails := (List.cons.inj ids).2
  rw [hl, hr, Option.map_some, Option.map_some]
  exact congrArg some (Prod.ext ids (congrArg (fun path =>
    (runComponents (decodedComponentGraph g documents methods) patch empty ⟨.active g.initialDocument, initialData, initialRegistration⟩ path).map
      (componentResult documents deleted)) tails))

end Archon
