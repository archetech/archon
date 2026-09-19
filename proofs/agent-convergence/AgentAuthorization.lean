import FullReplay

set_option warningAsError true

namespace Archon

inductive AgentState where
  | active (key : Nat)
  | deleted
  deriving DecidableEq

inductive AgentAction where
  | keep
  | rotate (key : Nat)
  | deactivate
  deriving DecidableEq

/-- Finite immutable signed operations. Key identifiers represent one verification
method/key and its permissions. `validBy` abstracts the existing signature and
method validation, not a claim that cryptography is proved in Lean. -/
structure AgentGraph where
  size : Nat
  root : Nat
  genesisKey : Nat
  parent : Nat → Option Nat
  action : Nat → AgentAction
  validBy : Nat → Nat → Bool
  depth : Nat → Nat

def AncestryOrdered (g : AgentGraph) : Prop :=
  ∀ i p, g.parent i = some p → g.depth p < g.depth i

def DepthBounded (g : AgentGraph) : Prop := ∀ i, i < g.size → g.depth i < g.size

/-- Authorize against the predecessor's key before applying the proposed change. -/
def advanceAgent (g : AgentGraph) (i : Nat) : AgentState → Option AgentState
  | .deleted => none
  | .active key =>
    if g.validBy i key then
      match g.action i with
      | .keep => some (.active key)
      | .rotate next => some (.active next)
      | .deactivate => some .deleted
    else none

/-- Ancestry evaluation, independent of candidate traversal or the selected fork.
An unavailable/out-of-domain predecessor has no reconstructable state. -/
def evaluateAgent (g : AgentGraph) : Nat → Nat → Option AgentState
  | 0, _ => none
  | fuel + 1, i =>
    if i < g.size then
      if i = g.root then some (.active g.genesisKey)
      else (g.parent i).bind (fun p => (evaluateAgent g fuel p).bind (advanceAgent g i))
    else none

def agentStateAt (g : AgentGraph) (i : Nat) : Option AgentState := evaluateAgent g (g.depth i + 1) i

theorem evaluate_agent_agrees (g : AgentGraph) (ordered : AncestryOrdered g)
    (fuel other i : Nat) (enough : g.depth i < fuel) (otherEnough : g.depth i < other) :
    evaluateAgent g fuel i = evaluateAgent g other i := by
  induction fuel generalizing other i with
  | zero => exfalso; omega
  | succ fuel ih =>
    cases other with
    | zero => exfalso; omega
    | succ other =>
      by_cases bounded : i < g.size
      · by_cases root : i = g.root
        · simp [evaluateAgent, root]
        · cases parent : g.parent i with
          | none => simp [evaluateAgent, bounded, root, parent]
          | some p =>
            have lower := ordered i p parent
            have same := ih other p (by omega) (by omega)
            simp [evaluateAgent, bounded, root, parent, same]
      · simp [evaluateAgent, bounded]

theorem agent_state_root (g : AgentGraph) (bounded : g.root < g.size) :
    agentStateAt g g.root = some (.active g.genesisKey) := by
  simp [agentStateAt, evaluateAgent, bounded]

theorem agent_state_step (g : AgentGraph) (ordered : AncestryOrdered g) (i p : Nat)
    (bounded : i < g.size) (notRoot : i ≠ g.root) (parent : g.parent i = some p) :
    agentStateAt g i = (agentStateAt g p).bind (advanceAgent g i) := by
  have lower := ordered i p parent
  have same := evaluate_agent_agrees g ordered (g.depth i) (g.depth p + 1) p lower (by omega)
  simp only [agentStateAt, evaluateAgent, bounded, notRoot, parent, ↓reduceIte, Option.bind_some]
  rw [same]
  rfl

/-- The earlier fixed predicate is now derived from predecessor authorization. -/
def agentModel (g : AgentGraph) : Model := {
  size := g.size
  parent := g.parent
  authorized := fun i => (agentStateAt g i).isSome
  level := fun i => g.size - g.depth i
}

theorem agent_model_acyclic (g : AgentGraph) (ordered : AncestryOrdered g) (bounded : DepthBounded g) :
    WellFoundedEdges (agentModel g) := by
  intro p i eligibleI
  have size := eligible_lt (agentModel g) p i eligibleI
  have parent := eligible_parent (agentModel g) p i eligibleI
  have lower := ordered i p parent
  have bound := bounded i size
  change g.size - g.depth i < g.size - g.depth p
  omega

/-- Local authorization against a reconstructed predecessor equals the derived predicate. -/
theorem agent_authorization_matches (g : AgentGraph) (ordered : AncestryOrdered g)
    (genesis : g.parent g.root = none) (i p : Nat) (before : AgentState)
    (bounded : i < g.size) (parent : g.parent i = some p)
    (state : agentStateAt g p = some before) :
    (agentModel g).authorized i = true ↔ ∃ after, advanceAgent g i before = some after := by
  have notRoot : i ≠ g.root := by
    intro same
    subst i
    simp [genesis] at parent
  have step := agent_state_step g ordered i p bounded notRoot parent
  rw [state] at step
  change (agentStateAt g i).isSome = true ↔ _
  rw [step]
  cases result : advanceAgent g i before <;> simp [result]

theorem agent_deleted_terminal (g : AgentGraph) (ordered : AncestryOrdered g)
    (genesis : g.parent g.root = none) (i p : Nat) (bounded : i < g.size)
    (parent : g.parent i = some p) (deleted : agentStateAt g p = some .deleted) :
    (agentModel g).authorized i = false := by
  have matched := agent_authorization_matches g ordered genesis i p .deleted bounded parent deleted
  have cannot : (agentModel g).authorized i ≠ true := by
    intro h
    obtain ⟨after, impossible⟩ := matched.mp h
    simp [advanceAgent] at impossible
  exact Bool.eq_false_iff.mpr cannot

theorem agent_rotation_uses_previous_key (g : AgentGraph) (i old next : Nat)
    (rotation : g.action i = .rotate next) :
    advanceAgent g i (.active old) = some (.active next) ↔ g.validBy i old = true := by
  simp [advanceAgent, rotation]

def runAgent (g : AgentGraph) : AgentState → List Nat → Option AgentState
  | state, [] => some state
  | state, i :: rest => (advanceAgent g i state).bind (fun next => runAgent g next rest)

def pathTip : Nat → List Nat → Nat
  | p, [] => p
  | _, i :: rest => pathTip i rest

/-- Every selected path dynamically verifies using each predecessor state;
a descendant cannot borrow a key from a different accepted or rejected branch. -/
theorem valid_agent_path_runs (g : AgentGraph) (ordered : AncestryOrdered g)
    (genesis : g.parent g.root = none) (evidence : List Nat) (p : Nat) (path : List Nat)
    (valid : ValidPath (agentModel g) evidence p path) (before : AgentState)
    (state : agentStateAt g p = some before) :
    ∃ after, runAgent g before path = some after ∧ agentStateAt g (pathTip p path) = some after := by
  induction valid generalizing before with
  | nil => exact ⟨before, rfl, state⟩
  | @cons child p rest member ok tail ih =>
    have size := eligible_lt (agentModel g) p child ok
    have parent := eligible_parent (agentModel g) p child ok
    have authorized : (agentModel g).authorized child = true := by
      simp only [eligible, Bool.and_eq_true] at ok
      exact ok.1.2
    obtain ⟨next, applied⟩ := (agent_authorization_matches g ordered genesis child p before size parent state).mp authorized
    have notRoot : child ≠ g.root := by
      intro same
      subst child
      simp [agentModel, genesis] at parent
    have nextState := agent_state_step g ordered child p size notRoot parent
    rw [state, Option.bind_some, applied] at nextState
    obtain ⟨after, ran, final⟩ := ih next nextState
    refine ⟨after, ?_, final⟩
    simp [runAgent, applied, ran]

/-- Same full-event replay theorem, now instantiated with derived key/deletion authorization. -/
theorem rotating_agent_converges [DecidableEq α] (g : AgentGraph)
    (ordered : AncestryOrdered g) (bounded : DepthBounded g)
    (genesis : g.parent g.root = none) (rootBound : g.root < g.size)
    (evidence : List (EventRecord α)) (present : g.root ∈ recordIds evidence) :
    ∃ result final,
      replayFullCold (agentModel g) g.root evidence = some result ∧
      recordIds (historyRecords result) = history (agentModel g) g.root (recordIds evidence) ∧
      historyPass (agentModel g) g.root evidence result = result ∧
      runAgent g (.active g.genesisKey) (recordIds result.2) = some final ∧
      agentStateAt g (pathTip g.root (recordIds result.2)) = some final := by
  have acyclic := agent_model_acyclic g ordered bounded
  obtain ⟨result, success, canonical, fixed⟩ := full_cold_converges (agentModel g) g.root evidence acyclic genesis present
  have tailIds : recordIds result.2 = suffix (agentModel g) (recordIds evidence)
      ((agentModel g).level g.root) g.root := (List.cons.inj canonical).2
  have complete := suffix_complete (agentModel g) (recordIds evidence) acyclic _ g.root (Nat.le_refl _)
  rw [← tailIds] at complete
  obtain ⟨final, ran, state⟩ := valid_agent_path_runs g ordered genesis _ g.root _
    (complete_valid (agentModel g) _ _ _ complete) (.active g.genesisKey) (agent_state_root g rootBound)
  exact ⟨result, final, success, canonical, fixed, ran, state⟩

/-- Both the chosen ID history and reconstructed key/deletion state agree across orders. -/
theorem rotating_agent_same_evidence [DecidableEq α] (g : AgentGraph)
    (ordered : AncestryOrdered g) (bounded : DepthBounded g)
    (genesis : g.parent g.root = none) (rootBound : g.root < g.size)
    (xs ys : List (EventRecord α)) (present : g.root ∈ recordIds xs)
    (same : ∀ i, i ∈ recordIds xs ↔ i ∈ recordIds ys) :
    (replayFullCold (agentModel g) g.root xs).map (fun s =>
      (recordIds (historyRecords s), runAgent g (.active g.genesisKey) (recordIds s.2))) =
    (replayFullCold (agentModel g) g.root ys).map (fun s =>
      (recordIds (historyRecords s), runAgent g (.active g.genesisKey) (recordIds s.2))) := by
  obtain ⟨left, _, hl, pl, _, _, _⟩ := rotating_agent_converges g ordered bounded genesis rootBound xs present
  obtain ⟨right, _, hr, pr, _, _, _⟩ := rotating_agent_converges g ordered bounded genesis rootBound ys ((same g.root).mp present)
  have ids : recordIds (historyRecords left) = recordIds (historyRecords right) := by
    rw [pl, pr, history_same_evidence (agentModel g) g.root (recordIds xs) (recordIds ys) same]
  have tails := (List.cons.inj ids).2
  rw [hl, hr, Option.map_some, Option.map_some]
  exact congrArg some (Prod.ext ids (congrArg (runAgent g (.active g.genesisKey)) tails))

end Archon
