import AssetReplay

set_option warningAsError true
namespace Archon

def AssetParentBounded (g : AssetGraph) : Prop :=
  ∀ i p, i < g.size → g.parent i = some p → p < g.size

theorem asset_valid_path_runs (g : AssetGraph) (ordered : AncestryOrdered (assetStructure g))
    (genesis : g.parent g.root = none) (evidence : List Nat) (p : Nat) (path : List Nat)
    (valid : ValidPath (agentModel (assetStructure g)) evidence p path) (before : ComponentState Nat Nat)
    (state : assetComponentsAt g p = some before) :
    ∃ after, runAssetComponents g before path = some after ∧
      assetComponentsAt g (pathTip p path) = some after := by
  induction valid generalizing before with
  | nil => exact ⟨before, rfl, state⟩
  | @cons child p rest member ok tail ih =>
    have bound := eligible_lt _ _ _ ok
    have parent := eligible_parent _ _ _ ok
    have authorized : (agentModel (assetStructure g)).authorized child = true := by
      simp only [eligible, Bool.and_eq_true] at ok
      exact ok.1.2
    have authority := asset_components_authority g p
    rw [state, Option.map_some] at authority
    obtain ⟨nextAuthority, applied⟩ := (agent_authorization_matches (assetStructure g) ordered
      genesis child p before.authority bound parent authority.symm).mp authorized
    have projection := asset_component_step_authority g child before
    rw [applied] at projection
    have nonroot : child ≠ g.root := by
      intro same; subst child; simp [agentModel, assetStructure, genesis] at parent
    cases step : assetComponentStep g child before with
    | none => simp [step] at projection
    | some next =>
      have nextState := asset_components_step g ordered child p bound nonroot parent
      rw [state, Option.bind_some, step] at nextState
      obtain ⟨after, ran, final⟩ := ih next nextState
      exact ⟨after, by simp [runAssetComponents, step, ran], final⟩

/-- Registry and owner projection are taken from the very same component state
that executes along the selected signed predecessor path. -/
theorem asset_predecessor_components (g : AssetGraph) (ordered : AncestryOrdered (assetStructure g))
    (genesis : g.parent g.root = none) (rootBound : g.root < g.size)
    (evidence path : List Nat) (valid : ValidPath (agentModel (assetStructure g)) evidence g.root path)
    (before : ComponentState Nat Nat) (ran : runAssetComponents g (assetInitial g) path = some before) :
    assetComponentsAt g (pathTip g.root path) = some before := by
  obtain ⟨after, executed, state⟩ := asset_valid_path_runs g ordered genesis evidence g.root path valid
    (assetInitial g) (asset_components_root g rootBound)
  rw [ran] at executed
  exact state.trans executed.symm

theorem asset_event_path (g : AssetGraph) (a : AnchorModel) (events : List Nat) (p : Nat) (path : List Nat)
    (valid : InterleavedValid (assetEventModel g a) (chainOwner a) events p path) :
    ValidPath (agentModel (assetStructure g)) (events.map (chainOwner a)) p (path.map (chainOwner a)) := by
  induction valid with
  | nil => exact .nil _
  | cons member ok tail ih =>
    exact .cons (List.mem_map.mpr ⟨_, member, rfl⟩) (asset_event_eligible g a _ _ ok) ih

theorem cold_asset_genesis (g : AssetGraph) (a : AnchorModel) (parents : AssetParentBounded g) (i : Nat)
    (ok : eligible (coldAssetModel g a) g.size i = true) : chainOwner a i = g.root := by
  have parent := eligible_parent _ _ _ ok
  have auth : (assetEventModel g a).authorized i = true := by
    simp only [eligible, coldAssetModel, withGenesis, Bool.and_eq_true] at ok
    exact ok.1.2
  have bound := asset_event_owner_bound g a i auth
  by_cases root : chainOwner a i = g.root
  · exact root
  · simp only [coldAssetModel, withGenesis, root, ↓reduceIte, assetEventModel] at parent
    have := parents _ _ bound parent
    omega

theorem cold_asset_root_eligible (g : AssetGraph) (a : AnchorModel) (rootBound : g.root < g.size) :
    eligible (coldAssetModel g a) g.size (a.size + g.root) = true := by
  have outside : ¬ a.size + g.root < a.size := by omega
  have bound : a.size + g.root < a.size + g.size := by omega
  have auth : agentStateAt (assetStructure g) g.root = some (.active g.initialDocument) :=
    agent_state_root (assetStructure g) rootBound
  simp only [eligible, coldAssetModel, withGenesis, assetEventModel, chainOwner, outside,
    ↓reduceIte, Nat.add_sub_cancel_left, agentModel, Bool.and_eq_true, decide_eq_true_eq,
    Option.some_beq_some, Nat.beq_eq_true_eq]
  exact ⟨⟨decide_eq_true bound, ⟨⟨rootBound, by rw [auth]; rfl⟩, by simp⟩⟩, True.intro⟩

/-- The successful path executes full components. This strengthens unique-result
agreement by excluding equality of two failed folds when valid genesis is present. -/
theorem asset_full_execution [DecidableEq α] (g : AssetGraph) (a : AnchorModel)
    (ordered : AncestryOrdered (assetStructure g)) (bounded : DepthBounded (assetStructure g))
    (parents : AssetParentBounded g) (genesis : g.parent g.root = none) (rootBound : g.root < g.size)
    (records : List (EventRecord α)) (present : a.size + g.root ∈ recordIds records) :
    let m := coldAssetModel g a
    ∃ result final,
      stopWhenStable (rankedPass m (chainOwner a) g.size records) (m.size + 3) [] = some result ∧
      rankedPass m (chainOwner a) g.size records result = result ∧
      ((recordIds result).map (chainOwner a)).head? = some g.root ∧
      runAssetComponents g (assetInitial g) (((recordIds result).map (chainOwner a)).drop 1) = some final := by
  let m := coldAssetModel g a
  have descending := cold_asset_descending g a ordered bounded
  obtain ⟨result, stopped, ids, fixed⟩ := cold_ranked_converges (assetEventModel g a)
    (chainOwner a) g.root g.size records (asset_events_descending g a ordered bounded)
    (by intro p; change g.size - g.depth p ≤ a.size + g.size; omega)
    (fun i _ auth => Nat.ne_of_lt (asset_event_owner_bound g a i auth))
  have available := cold_asset_root_eligible g a rootBound
  have minimum := winner_le_member m g.size (a.size + g.root) (recordIds records) present available
  have small : winner m g.size (recordIds records) < m.size := by
    have bound : a.size + g.root < m.size := eligible_lt _ _ _ available
    omega
  obtain ⟨_, rootOK⟩ := winner_member m g.size (recordIds records) small
  have rootOwner := cold_asset_genesis g a parents _ rootOK
  have shape : recordIds result = winner m g.size (recordIds records) ::
      interleavedSuffix m (chainOwner a) (recordIds records) m.size g.root := by
    change recordIds result = interleavedSuffix m (chainOwner a) (recordIds records) (m.size + 1) g.size at ids
    simpa only [interleavedSuffix, small, ↓reduceIte, rootOwner] using ids
  have complete := interleaved_suffix_complete m (chainOwner a) (recordIds records) descending
    (m.size + 1) g.size (by simp [m, coldAssetModel, withGenesis])
  have valid := interleaved_complete_valid m (chainOwner a) (recordIds records) g.size _ complete
  have tailValid : InterleavedValid m (chainOwner a) (recordIds records) g.root
      (interleavedSuffix m (chainOwner a) (recordIds records) m.size g.root) := by
    simp only [interleavedSuffix, small, ↓reduceIte, rootOwner] at valid
    cases valid with | cons _ _ tail => simpa only [rootOwner] using tail
  have rawValid := genesis_valid_tail (assetEventModel g a) (chainOwner a) g.root g.size
    (recordIds records) _ g.root (Nat.ne_of_lt rootBound)
    (fun i owner => by simp only [assetEventModel, owner, genesis])
    (fun i _ auth => Nat.ne_of_lt (asset_event_owner_bound g a i auth)) tailValid
  have opValid := asset_event_path g a (recordIds records) g.root _ rawValid
  obtain ⟨final, ran, _⟩ := asset_valid_path_runs g ordered genesis _ g.root _ opValid
    (assetInitial g) (asset_components_root g rootBound)
  refine ⟨result, final, stopped, fixed, ?_, ?_⟩
  · simp only [shape, List.map_cons, List.head?_cons]; exact congrArg some rootOwner
  · simpa only [shape, List.map_cons, List.drop_succ_cons, List.drop_zero] using ran

/-- Source-level nonvacuity: an actually authorized retained creation, not an
assumed accepted genesis projection, yields executable reconciled components. -/
theorem asset_source_execution [DecidableEq α] (g : AssetGraph) (r : AssetReceipts)
    (table : ControllerTable) (histories : ControllerHistories) (unanchored : Nat → Bool)
    (localRegistry : Nat) (chainFacts : Nat → ChainReceiptView)
    (ordered : AncestryOrdered (assetStructure g)) (bounded : DepthBounded (assetStructure g))
    (parents : AssetParentBounded g) (genesis : g.parent g.root = none) (rootBound : g.root < g.size)
    (sources : List (AgentSourceReceipt α)) (source : AgentSourceReceipt α)
    (retained : source ∈ sources) (root : source.key.operation = g.root)
    (authorized : assetReceiptAuthorized g table histories unanchored localRegistry chainFacts source.key = true) :
    let a := assetAnchors g r
    let m := coldAssetModel g a
    let records := assetSourceRecords g r table histories unanchored localRegistry chainFacts sources
    ∃ result final,
      stopWhenStable (rankedPass m (chainOwner a) g.size records) (m.size + 3) [] = some result ∧
      rankedPass m (chainOwner a) g.size records result = result ∧
      ((recordIds result).map (chainOwner a)).head? = some g.root ∧
      runAssetComponents g (assetInitial g) (((recordIds result).map (chainOwner a)).drop 1) = some final := by
  have present := asset_reconsidered g r table histories unanchored localRegistry chainFacts sources source retained authorized
  rw [root] at present
  exact asset_full_execution g _ ordered bounded parents genesis rootBound _ present

end Archon
