import ProtocolModel

set_option warningAsError true
namespace Archon

theorem protocol_agent_bounds (w : ProtocolModel n) (domain : ProtocolDomain w)
    (owner : Nat) (spec : ControllerSpec) (entry : w.controllers.table owner = some spec) :
    AncestryOrdered (documentAgent spec.graph) ∧ DepthBounded (documentAgent spec.graph) := by
  rw [protocol_controller_table] at entry
  cases found : w.agent owner with
  | none => simp [found] at entry
  | some agent =>
    have equal : agent.core = spec := by simpa [found] using entry
    subst spec
    exact ⟨(domain.agents owner agent found).ordered, (domain.agents owner agent found).bounded⟩

theorem protocol_agent_total [DecidableEq α] (w : ProtocolModel n) (domain : ProtocolDomain w)
    (evidence : ProtocolEvidence n α) (i : Fin n) :
    ∃ result, protocolAgentStop w evidence i = some result := by
  cases entry : w.controllers.table i.val with
  | none => exact ⟨[], by simp [protocolAgentStop, entry]⟩
  | some spec =>
    have bounds := protocol_agent_bounds w domain i.val spec entry
    obtain ⟨result, stopped, _⟩ := controller_source_terminates w.controllers i.val spec
      (evidence i) bounds.1 bounds.2
    exact ⟨result, by simpa [protocolAgentStop, entry] using stopped⟩

/-- The asset phase sees the histories actually returned by the finite agent
phase. This connects the two executable phases to the source-derived B theorem. -/
theorem protocol_views_from_phase [DecidableEq α] (w : ProtocolModel n)
    (evidence : ProtocolEvidence n α) (agents : ProtocolPhase n α)
    (completed : ∀ i, protocolAgentStop w evidence i = some (agents i)) :
    protocolControllerViews w agents =
      reconciledControllerHistories w.controllers (extendProtocolEvidence evidence) := by
  funext owner
  by_cases inside : owner < n
  · cases entry : w.controllers.table owner with
    | none => simp [protocolControllerViews, reconciledControllerHistories, inside, entry]
    | some spec =>
      have ran := completed ⟨owner, inside⟩
      simp only [protocolAgentStop, entry] at ran
      simp [protocolControllerViews, reconciledControllerHistories, inside, entry,
        extendProtocolEvidence, ran]
  · simp [protocolControllerViews, reconciledControllerHistories, inside,
      protocol_controller_outside w owner inside]

theorem protocol_asset_total [DecidableEq α] (w : ProtocolModel n) (domain : ProtocolDomain w)
    (evidence : ProtocolEvidence n α) (agents : ProtocolPhase n α) (i : Fin n) :
    ∃ result, protocolAssetStop w evidence agents i = some result := by
  cases entry : w.asset i with
  | none => exact ⟨[], by simp [protocolAssetStop, entry]⟩
  | some spec =>
    have valid := domain.assets i spec entry
    obtain ⟨result, _, stopped, _, _, _, _⟩ := asset_reconciliation_converges
      spec.graph spec.receipts w.controllers.table (protocolControllerViews w agents)
      (protocolControllerViews w agents) (fun _ => rfl) w.unanchored w.localRegistry spec.chainFacts
      valid.ordered valid.bounded (evidence i) (evidence i) (fun _ => Iff.rfl)
    exact ⟨result, by simpa [protocolAssetStop, entry, protocolAssetRecords] using stopped⟩

/-- Actual finite-family execution, including both complete stop predicates. -/
theorem protocol_reconciliation_total [DecidableEq α] (w : ProtocolModel n) (domain : ProtocolDomain w)
    (evidence : ProtocolEvidence n α) (previous : ProtocolRecords n α) :
    ∃ result, reconcileProtocol w evidence previous = some result ∧
      (∀ i, protocolAgentStop w evidence i = some (result.agents i)) ∧
      (∀ i, protocolAssetStop w evidence result.agents i = some (result.assets i)) := by
  obtain ⟨agents, agentRun, agentStops⟩ := collect_finite_total n _ (protocol_agent_total w domain evidence)
  obtain ⟨assets, assetRun, assetStops⟩ := collect_finite_total n _ (protocol_asset_total w domain evidence agents)
  exact ⟨⟨agents, assets⟩, by simp [reconcileProtocol, agentRun, assetRun], agentStops, assetStops⟩

theorem protocol_reconciliation_phases [DecidableEq α] (w : ProtocolModel n)
    (evidence : ProtocolEvidence n α) (previous result : ProtocolRecords n α)
    (ran : reconcileProtocol w evidence previous = some result) :
    (∀ i, protocolAgentStop w evidence i = some (result.agents i)) ∧
      (∀ i, protocolAssetStop w evidence result.agents i = some (result.assets i)) := by
  cases agentsRun : collectFinite n (protocolAgentStop w evidence) with
  | none => simp [reconcileProtocol, agentsRun] at ran
  | some agents =>
    cases assetsRun : collectFinite n (protocolAssetStop w evidence agents) with
    | none => simp [reconcileProtocol, agentsRun, assetsRun] at ran
    | some assets =>
      have equal : ProtocolRecords.mk agents assets = result := by
        simpa [reconcileProtocol, agentsRun, assetsRun] using ran
      subst result
      exact ⟨collect_finite_correct n _ agents agentsRun, collect_finite_correct n _ assets assetsRun⟩

end Archon
