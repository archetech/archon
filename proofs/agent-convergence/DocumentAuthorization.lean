import AgentAuthorization

set_option warningAsError true

namespace Archon

/-- IDs are normalized method references; keys identify public keys independently
of method names. The bridge, not this model, normalizes relative DID references. -/
structure VerificationMethod where
  id : Nat
  key : Nat
  deriving DecidableEq

/-- Version 1 selects the first named method. Relationship membership does not
restrict operation authorization; strengthening that rule is a separate decision. -/
def documentKey (methods : List VerificationMethod) (named : Nat) : Option Nat :=
  (methods.find? (fun method => method.id == named)).map VerificationMethod.key

def verifiesDocument (methods : List VerificationMethod) (named : Nat)
    (signatureValid : Nat → Bool) : Bool :=
  ((documentKey methods named).map signatureValid).getD false

structure DocumentGraph where
  size : Nat
  root : Nat
  initialDocument : Nat
  parent : Nat → Option Nat
  depth : Nat → Nat
  /-- `rotate` replaces the whole verification-method list at a document index. -/
  action : Nat → AgentAction
  documents : Nat → List VerificationMethod
  named : Nat → Nat
  /-- Fixed operation/public-key signature validity; cryptography is not proved. -/
  signatureValid : Nat → Nat → Bool

/-- Reuse the state/replay proof with active document indices in place of key
indices. Authorization now performs explicit method lookup in that document. -/
def documentAgent (g : DocumentGraph) : AgentGraph := {
  size := g.size
  root := g.root
  genesisKey := g.initialDocument
  parent := g.parent
  depth := g.depth
  action := g.action
  validBy := fun i document =>
    verifiesDocument (g.documents document) (g.named i) (g.signatureValid i)
}

theorem named_method_verifies (methods : List VerificationMethod) (named key : Nat)
    (signatureValid : Nat → Bool) (found : documentKey methods named = some key) :
    verifiesDocument methods named signatureValid = signatureValid key := by
  simp [verifiesDocument, found]

theorem missing_method_rejected (methods : List VerificationMethod) (named : Nat)
    (signatureValid : Nat → Bool) (missing : documentKey methods named = none) :
    verifiesDocument methods named signatureValid = false := by
  simp [verifiesDocument, missing]

theorem document_replacement_uses_predecessor (g : DocumentGraph) (i before after : Nat)
    (replacement : g.action i = .rotate after) :
    advanceAgent (documentAgent g) i (.active before) = some (.active after) ↔
      verifiesDocument (g.documents before) (g.named i) (g.signatureValid i) = true :=
  agent_rotation_uses_previous_key (documentAgent g) i before after replacement

/-- Reconstructed predecessor documents authorize exactly the predicate replay
uses. This includes missing/removed methods and same-name public-key changes. -/
theorem document_authorization_matches (g : DocumentGraph)
    (ordered : AncestryOrdered (documentAgent g)) (genesis : g.parent g.root = none)
    (i p before : Nat) (bounded : i < g.size) (parent : g.parent i = some p)
    (state : agentStateAt (documentAgent g) p = some (.active before)) :
    (agentModel (documentAgent g)).authorized i = true ↔
      ∃ after, advanceAgent (documentAgent g) i (.active before) = some after :=
  agent_authorization_matches (documentAgent g) ordered genesis i p _ bounded parent state

/-- Exact specialization of the full-record fixed-point and valid-path theorem.
Active state indices denote complete verification-method lists, not one key. -/
theorem document_replay_converges [DecidableEq α] (g : DocumentGraph)
    (ordered : AncestryOrdered (documentAgent g)) (bounded : DepthBounded (documentAgent g))
    (genesis : g.parent g.root = none) (rootBound : g.root < g.size)
    (evidence : List (EventRecord α)) (present : g.root ∈ recordIds evidence) :
    ∃ result final,
      replayFullCold (agentModel (documentAgent g)) g.root evidence = some result ∧
      recordIds (historyRecords result) = history (agentModel (documentAgent g)) g.root (recordIds evidence) ∧
      historyPass (agentModel (documentAgent g)) g.root evidence result = result ∧
      runAgent (documentAgent g) (.active g.initialDocument) (recordIds result.2) = some final ∧
      agentStateAt (documentAgent g) (pathTip g.root (recordIds result.2)) = some final :=
  rotating_agent_converges (documentAgent g) ordered bounded genesis rootBound evidence present

/-- Distinguish failed replay from successful deletion and an active document. -/
def documentResult (g : DocumentGraph) (state : AgentState) : Option (List VerificationMethod) :=
  match state with
  | .deleted => none
  | .active document => some (g.documents document)

theorem document_same_evidence [DecidableEq α] (g : DocumentGraph)
    (ordered : AncestryOrdered (documentAgent g)) (bounded : DepthBounded (documentAgent g))
    (genesis : g.parent g.root = none) (rootBound : g.root < g.size)
    (xs ys : List (EventRecord α)) (present : g.root ∈ recordIds xs)
    (same : ∀ i, i ∈ recordIds xs ↔ i ∈ recordIds ys) :
    (replayFullCold (agentModel (documentAgent g)) g.root xs).map (fun s =>
      (recordIds (historyRecords s), (runAgent (documentAgent g) (.active g.initialDocument)
        (recordIds s.2)).map (documentResult g))) =
    (replayFullCold (agentModel (documentAgent g)) g.root ys).map (fun s =>
      (recordIds (historyRecords s), (runAgent (documentAgent g) (.active g.initialDocument)
        (recordIds s.2)).map (documentResult g))) := by
  have equal := rotating_agent_same_evidence (documentAgent g) ordered bounded genesis rootBound xs ys present same
  have mapped := congrArg (Option.map (fun pair : List Nat × Option AgentState =>
    (pair.1, pair.2.map (documentResult g)))) equal
  simpa only [Option.map_map, Function.comp_def, documentAgent] using mapped

end Archon
