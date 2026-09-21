import ProtocolResult
import ProtocolSources

set_option warningAsError true
namespace Archon

theorem stopped_is_fixed [DecidableEq σ] (step : σ → σ) (fuel : Nat) (start result : σ)
    (stopped : stopWhenStable step fuel start = some result) : step result = result := by
  induction fuel generalizing start with
  | zero => simp [stopWhenStable] at stopped
  | succ fuel ih =>
    simp only [stopWhenStable] at stopped
    split at stopped
    · cases Option.some.inj stopped; assumption
    · exact ih _ stopped

/-- Full-record stability of each completed phase, not just operation-path
stability. Assets refer to this result's completed agent phase. -/
def ProtocolStable (w : ProtocolModel n) (evidence : ProtocolEvidence n α) (result : ProtocolRecords n α) : Prop :=
  (∀ i spec, w.controllers.table i.val = some spec →
    rankedPass (controllerSourceModel w.controllers i.val spec)
      (chainOwner (componentAnchors spec.graph spec.patch spec.registry spec.initialRegistry (w.controllers.receipts i.val)))
      spec.graph.size (controllerSourceRecords w.controllers i.val spec (evidence i))
      (result.agents i) = result.agents i) ∧
  (∀ i spec, w.asset i = some spec →
    rankedPass (coldAssetModel spec.graph (assetAnchors spec.graph spec.receipts))
      (chainOwner (assetAnchors spec.graph spec.receipts)) spec.graph.size
      (protocolAssetRecords w evidence result.agents i spec) (result.assets i) = result.assets i)

theorem protocol_stable [DecidableEq α] (w : ProtocolModel n)
    (evidence : ProtocolEvidence n α) (previous result : ProtocolRecords n α)
    (ran : reconcileProtocol w evidence previous = some result) : ProtocolStable w evidence result := by
  obtain ⟨agents, assets⟩ := protocol_reconciliation_phases w evidence previous result ran
  constructor
  · intro i spec entry
    have stop := agents i
    simp only [protocolAgentStop, entry, controllerSourceStop] at stop
    exact stopped_is_fixed _ _ _ _ stop
  · intro i spec entry
    have stop := assets i
    simp only [protocolAssetStop, entry] at stop
    exact stopped_is_fixed _ _ _ _ stop

/-- Dependent replay considers all retained evidence under the produced agent
histories, including previously rejected candidates. It gives a real state when
an authorized genesis is present and proves selected-record provenance. -/
theorem protocol_asset_guarantees [DecidableEq α] (w : ProtocolModel n) (domain : ProtocolDomain w)
    (evidence : ProtocolEvidence n α) (previous result : ProtocolRecords n α)
    (ran : reconcileProtocol w evidence previous = some result) (i : Fin n) (spec : ProtocolAsset)
    (entry : w.asset i = some spec) :
    AssetSiblingOrdering spec.graph spec.receipts spec.positions ∧
    AssetSourceGuarantees spec.graph spec.receipts w.controllers.table (protocolControllerViews w result.agents)
      w.unanchored w.localRegistry spec.chainFacts (evidence i) ∧
    AssetWinnerOrdering spec.graph spec.receipts spec.positions
      (recordIds (protocolAssetRecords w evidence result.agents i spec)) := by
  have valid := domain.assets i spec entry
  have phases := protocol_reconciliation_phases w evidence previous result ran
  have views := protocol_views_from_phase w evidence result.agents phases.1
  refine ⟨fun x y parent xp yp xa ya => asset_sibling_priority _ _ _ valid.ranks valid.genesis x y parent xp yp xa ya, ?_, ?_⟩
  · rw [views]
    exact asset_source_guarantees w.controllers (extendProtocolEvidence evidence) spec.graph spec.receipts
      w.unanchored w.localRegistry spec.chainFacts valid.ordered valid.bounded valid.parents valid.genesis
      valid.rootBound (evidence i)
  · exact fun parent x y chosen present available xp yp xa ya =>
      asset_winner_priority _ _ _ valid.ranks valid.genesis _ parent x y chosen present available xp yp xa ya

/-- An available agent genesis produces a successful complete component fold in
this global execution, rather than merely equal failed optional results. -/
theorem protocol_agent_execution [DecidableEq α] (w : ProtocolModel n) (domain : ProtocolDomain w)
    (evidence : ProtocolEvidence n α) (previous result : ProtocolRecords n α)
    (ran : reconcileProtocol w evidence previous = some result) (i : Fin n) (spec : ProtocolAgent)
    (entry : w.agent i.val = some spec)
    (present : ∃ source ∈ evidence i, source.key.operation = spec.core.graph.root) :
    ∃ final,
      ((recordIds (result.agents i)).map (chainOwner (componentAnchors spec.core.graph spec.core.patch
        spec.core.registry spec.core.initialRegistry spec.receipts))).head? = some spec.core.graph.root ∧
      runComponents spec.core.graph spec.core.patch spec.core.emptyData
        ⟨.active spec.core.graph.initialDocument, spec.core.initialData, spec.core.initialRegistry⟩
        (((recordIds (result.agents i)).map (chainOwner (componentAnchors spec.core.graph spec.core.patch
          spec.core.registry spec.core.initialRegistry spec.receipts))).drop 1) = some final := by
  have valid := domain.agents i.val spec entry
  have phases := protocol_reconciliation_phases w evidence previous result ran
  have table : w.controllers.table i.val = some spec.core := by rw [protocol_controller_table, entry]; rfl
  have stopped := phases.1 i
  simp only [protocolAgentStop, table] at stopped
  simp only [controllerSourceStop, controllerSourceModel, controllerSourceRecords,
    ProtocolModel.controllers, entry, Option.map_some, Option.getD_some] at stopped
  obtain ⟨records, final, stop, _, root, executed⟩ := integrated_agent_execution spec.core.graph
    spec.core.patch spec.core.registry spec.core.initialRegistry spec.core.emptyData spec.core.initialData
    spec.receipts valid.ordered valid.bounded valid.parents valid.genesis valid.rootBound (evidence i) present
  have equal := Option.some.inj (stop.symm.trans stopped)
  exact ⟨final, by simpa only [equal] using root, by simpa only [equal] using executed⟩

abbrev ProtocolSemanticResult (n : Nat) :=
  Fin n → Option (Sum
    (List Nat × Option ((Nat × Nat × Nat) × Bool) × List AgentReceiptView)
    ((List Nat × Option (Option AssetDocument × Nat × Nat)) × List AgentReceiptView))

/-- A semantic result is canonical exactly when every equivalent finite delivery
and every prior published projection reconstruct to it and really stop. -/
def ProtocolCanonical [DecidableEq α] (w : ProtocolModel n) (evidence : ProtocolEvidence n α)
    (canonical : ProtocolSemanticResult n) : Prop :=
  ∀ delivery, SameProtocolEvidence evidence delivery → ∀ previous,
    ProtocolSources w delivery ∧
    ∃ result, reconcileProtocol w delivery previous = some result ∧
      ProtocolStable w delivery result ∧ protocolResult w result = canonical

/-- C1 endpoint: a unique full protocol result for any finite DID family.
Authorization is derived in two actual replay phases; neither accepted history
nor a shared final authorizing document is an input. -/
theorem protocol_convergence [DecidableEq α] (w : ProtocolModel n) (domain : ProtocolDomain w)
    (evidence : ProtocolEvidence n α) (sources : ProtocolSources w evidence) :
    ∃ canonical, ProtocolCanonical w evidence canonical ∧
      ∀ other, ProtocolCanonical w evidence other → other = canonical := by
  let empty : ProtocolRecords n α := ⟨fun _ => [], fun _ => []⟩
  obtain ⟨base, ran, _, _⟩ := protocol_reconciliation_total w domain evidence empty
  refine ⟨protocolResult w base, ?_, ?_⟩
  · intro delivery same previous
    obtain ⟨result, completed, _, _⟩ := protocol_reconciliation_total w domain delivery previous
    exact ⟨protocol_sources_shared w evidence delivery sources same, result, completed, protocol_stable w delivery previous result completed,
      (protocol_results_agree w domain evidence delivery same empty previous base result ran completed).symm⟩
  · intro other canonical
    obtain ⟨_, result, completed, _, equal⟩ := canonical evidence (fun _ _ => Iff.rfl) empty
    have same : result = base := Option.some.inj (completed.symm.trans ran)
    simpa only [same] using equal.symm

/-- Evidence may grow, shrink, or reorganize before settlement. Once snapshots
agree as protocol evidence, any completed later reconciliation has the one
canonical result. Eventual scheduling/storage success is the liveness premise. -/
theorem protocol_eventual_convergence [DecidableEq α] (w : ProtocolModel n) (domain : ProtocolDomain w)
    (settled : ProtocolEvidence n α) (sources : ProtocolSources w settled) (snapshots : Nat → ProtocolEvidence n α) (after : Nat)
    (settles : ∀ time, after ≤ time → SameProtocolEvidence settled (snapshots time)) :
    ∃ canonical, ∀ time, after ≤ time → ∀ previous,
      ∃ result, reconcileProtocol w (snapshots time) previous = some result ∧
        ProtocolStable w (snapshots time) result ∧ protocolResult w result = canonical := by
  obtain ⟨canonical, converges, _⟩ := protocol_convergence w domain settled sources
  exact ⟨canonical, fun time later previous => (converges (snapshots time) (settles time later) previous).2⟩

end Archon
