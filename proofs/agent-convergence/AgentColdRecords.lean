import AgentFullRecords
import ColdInterleaved

set_option warningAsError true
namespace Archon

/-- A fresh virtual identity lies outside the normalized operation-ID universe.
Referenced-but-unavailable predecessors may occupy IDs in that finite universe. -/
def AgentParentBounded (g : DocumentGraph) : Prop :=
  ∀ i p, i < g.size → g.parent i = some p → p < g.size

def coldComponentEvents (g : DocumentGraph) (a : AnchorModel) : Model :=
  withGenesis (componentEvents g a) (chainOwner a) g.root g.size

theorem component_event_owner_bound (g : DocumentGraph) (a : AnchorModel) (i : Nat)
    (authorized : (componentEvents g a).authorized i = true) : chainOwner a i < g.size := by
  simp only [componentEvents, documentEvents, Bool.and_eq_true, decide_eq_true_eq] at authorized
  exact authorized.1.1

theorem component_event_level_bound (g : DocumentGraph) (a : AnchorModel) (p : Nat) :
    (componentEvents g a).level p ≤ (componentEvents g a).size := by
  change g.size - g.depth p ≤ a.size + g.size
  omega

theorem cold_component_descending (g : DocumentGraph) (a : AnchorModel)
    (ordered : AncestryOrdered (documentAgent g)) (bounded : DepthBounded (documentAgent g)) :
    InterleavedDescending (coldComponentEvents g a) (chainOwner a) := by
  apply genesis_model_descending
  · exact document_events_descending g _ _ _ ordered bounded
  · exact component_event_level_bound g a
  · intro i _ authorized
    have := component_event_owner_bound g a i authorized
    omega

/-- Every eligible child of the virtual predecessor is a representation of the
unique genesis. Missing real predecessors cannot be confused with that sentinel. -/
theorem cold_component_genesis (g : DocumentGraph) (a : AnchorModel)
    (parents : AgentParentBounded g) (i : Nat)
    (eligibleRoot : eligible (coldComponentEvents g a) g.size i = true) :
    chainOwner a i = g.root := by
  have parent := eligible_parent _ _ _ eligibleRoot
  have authorized : (componentEvents g a).authorized i = true := by
    simp only [eligible, coldComponentEvents, withGenesis, Bool.and_eq_true] at eligibleRoot
    exact eligibleRoot.1.2
  have bound := component_event_owner_bound g a i authorized
  by_cases root : chainOwner a i = g.root
  · exact root
  · simp only [coldComponentEvents, withGenesis, root, ↓reduceIte, componentEvents, documentEvents] at parent
    have := parents _ _ bound parent
    omega

/-- An available valid genesis has a provisional representative even when its
first received envelope is wrong-registry or arrives last. -/
theorem cold_component_root_eligible (g : DocumentGraph) (a : AnchorModel)
    (rootBound : g.root < g.size) :
    eligible (coldComponentEvents g a) g.size (a.size + g.root) = true := by
  have outside : ¬ a.size + g.root < a.size := by omega
  have bound : a.size + g.root < a.size + g.size := by omega
  have auth : agentStateAt (documentAgent g) g.root = some (.active g.initialDocument) :=
    agent_state_root (documentAgent g) rootBound
  simp only [eligible, coldComponentEvents, withGenesis, componentEvents, documentEvents,
    chainOwner, outside, ↓reduceIte, Nat.add_sub_cancel_left, componentEventAllowed,
    agentModel, Bool.and_eq_true, decide_eq_true_eq,
    Option.some_beq_some, Nat.beq_eq_true_eq]
  exact ⟨⟨decide_eq_true bound, ⟨⟨rootBound, by rw [auth]; rfl⟩, True.intro⟩⟩, True.intro⟩

/-- Full cold reconciliation, including the selected genesis record, terminates
and executes the complete component state. It starts with no accepted history;
no chosen genesis receipt, accepted suffix, or final document is supplied. -/
theorem component_cold_full_replay [DecidableEq α] (g : DocumentGraph)
    (patch : Nat → ComponentPatch D R) (registry : R → Nat)
    (initial : R) (empty initialData : D) (r : RegistryReceipts)
    (ordered : AncestryOrdered (documentAgent g)) (bounded : DepthBounded (documentAgent g))
    (parents : AgentParentBounded g) (genesis : g.parent g.root = none)
    (rootBound : g.root < g.size) (records : List (EventRecord α))
    (present : (componentAnchors g patch registry initial r).size + g.root ∈ recordIds records) :
    let a := componentAnchors g patch registry initial r
    let m := coldComponentEvents g a
    ∃ result final,
      stopWhenStable (rankedPass m (chainOwner a) g.size records) (m.size + 3) [] = some result ∧
      rankedPass m (chainOwner a) g.size records result = result ∧
      ((recordIds result).map (chainOwner a)).head? = some g.root ∧
      runComponents g patch empty ⟨.active g.initialDocument, initialData, initial⟩
        (((recordIds result).map (chainOwner a)).drop 1) = some final := by
  let a := componentAnchors g patch registry initial r
  let m := coldComponentEvents g a
  have descending := cold_component_descending g a ordered bounded
  obtain ⟨result, stopped, ids, fixed⟩ := cold_ranked_converges (componentEvents g a)
    (chainOwner a) g.root g.size records
    (document_events_descending g _ _ _ ordered bounded)
    (component_event_level_bound g a)
    (fun i _ auth => Nat.ne_of_lt (component_event_owner_bound g a i auth))
  have available := cold_component_root_eligible g a rootBound
  have minimum := winner_le_member m g.size (a.size + g.root) (recordIds records) present available
  have small : winner m g.size (recordIds records) < m.size := by
    have bound : a.size + g.root < m.size := eligible_lt _ _ _ available
    omega
  obtain ⟨_, rootOK⟩ := winner_member m g.size (recordIds records) small
  have rootOwner := cold_component_genesis g a parents _ rootOK
  have shape : recordIds result = winner m g.size (recordIds records) ::
      interleavedSuffix m (chainOwner a) (recordIds records) m.size g.root := by
    change recordIds result = interleavedSuffix m (chainOwner a) (recordIds records) (m.size + 1) g.size at ids
    simpa only [interleavedSuffix, small, ↓reduceIte, rootOwner] using ids
  have complete := interleaved_suffix_complete m (chainOwner a) (recordIds records) descending
    (m.size + 1) g.size (by simp [m, coldComponentEvents, withGenesis])
  have valid := interleaved_complete_valid m (chainOwner a) (recordIds records) g.size _ complete
  have tailValid : InterleavedValid m (chainOwner a) (recordIds records) g.root
      (interleavedSuffix m (chainOwner a) (recordIds records) m.size g.root) := by
    simp only [interleavedSuffix, small, ↓reduceIte, rootOwner] at valid
    cases valid with | cons _ _ tail => simpa only [rootOwner] using tail
  have rawValid := genesis_valid_tail (componentEvents g a) (chainOwner a) g.root g.size
    (recordIds records) _ g.root (Nat.ne_of_lt rootBound)
    (fun i owner => by simp only [componentEvents, documentEvents, owner, genesis])
    (fun i _ auth => Nat.ne_of_lt (component_event_owner_bound g a i auth)) tailValid
  have opValid := document_event_path g _ _ _ (recordIds records) g.root _ rawValid
  obtain ⟨authority, executed, _⟩ := valid_agent_path_runs (documentAgent g) ordered genesis _ g.root _
    opValid (.active g.initialDocument) (agent_state_root _ rootBound)
  have projection := component_run_authority g patch empty
    ((interleavedSuffix m (chainOwner a) (recordIds records) m.size g.root).map (chainOwner a))
    ⟨.active g.initialDocument, initialData, initial⟩
  rw [executed] at projection
  cases ran : runComponents g patch empty ⟨.active g.initialDocument, initialData, initial⟩
      ((interleavedSuffix m (chainOwner a) (recordIds records) m.size g.root).map (chainOwner a)) with
  | none => simp only [ran, Option.map_none, reduceCtorEq] at projection
  | some final =>
    refine ⟨result, final, stopped, fixed, ?_, ?_⟩
    · simp only [shape, List.map_cons, List.head?_cons]
      exact congrArg some rootOwner
    · simpa only [shape, List.map_cons, List.drop_succ_cons, List.drop_zero] using ran

/-- Cold reconstruction is independent of arrival order, duplicate delivery, and
any previously published projection (which is not an input to reconstruction). -/
theorem component_cold_same_state [DecidableEq α] (g : DocumentGraph)
    (patch : Nat → ComponentPatch D R) (registry : R → Nat)
    (initial : R) (empty initialData : D) (r : RegistryReceipts)
    (ordered : AncestryOrdered (documentAgent g)) (bounded : DepthBounded (documentAgent g))
    (xs ys : List (EventRecord α))
    (same : ∀ i, i ∈ recordIds xs ↔ i ∈ recordIds ys) :
    let a := componentAnchors g patch registry initial r
    let m := coldComponentEvents g a
    let view := fun records : List (EventRecord α) =>
      ((recordIds records).map (chainOwner a), runComponents g patch empty
        ⟨.active g.initialDocument, initialData, initial⟩ (((recordIds records).map (chainOwner a)).drop 1))
    (stopWhenStable (rankedPass m (chainOwner a) g.size xs) (m.size + 3) []).map view =
      (stopWhenStable (rankedPass m (chainOwner a) g.size ys) (m.size + 3) []).map view := by
  have result := ranked_full_same_semantics
    (coldComponentEvents g (componentAnchors g patch registry initial r))
    (chainOwner (componentAnchors g patch registry initial r)) g.size xs ys [] []
    (fun ids => (ids.map (chainOwner (componentAnchors g patch registry initial r)),
      runComponents g patch empty ⟨.active g.initialDocument, initialData, initial⟩
        ((ids.map (chainOwner (componentAnchors g patch registry initial r))).drop 1)))
    (cold_component_descending g _ ordered bounded) (.nil _) (.nil _) same
  simpa only [coldComponentEvents, withGenesis, ↓reduceIte, Nat.add_assoc] using result

end Archon
