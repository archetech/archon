import ProtocolExecution

set_option warningAsError true
namespace Archon

/-- Decoding preserves the complete document and an explicit deactivation bit,
including the distinction between a deleted DID and missing genesis. -/
def protocolAgentResult (spec : ProtocolAgent) (records : ProtocolHistory α) :=
  let core := spec.core
  let a := componentAnchors core.graph core.patch core.registry core.initialRegistry spec.receipts
  let result := agentResult core.graph core.patch core.initialRegistry core.emptyData core.initialData a
    (expectedRegistry (componentRegistry core.graph core.patch core.registry core.initialRegistry))
    spec.operationTime spec.chainFacts records
  (result.1, result.2.1.map (fun state => (componentResult spec.documents spec.deletedDocument state,
    match state.authority with | .active _ => false | .deleted => true)), result.2.2)

/-- Each immutable DID kind has exactly one semantic result. Opaque component
atoms are shared decoded JSON values, not verification-method identifiers. -/
def protocolResult (w : ProtocolModel n) (records : ProtocolRecords n α) (i : Fin n) :=
  match w.dids i with
  | none => none
  | some (.agent spec) => some (Sum.inl (protocolAgentResult spec (records.agents i)))
  | some (.asset spec) => some (Sum.inr (assetReceiptResult spec.graph spec.receipts
      spec.operationTime spec.chainFacts (records.assets i)))

def SameProtocolEvidence (left right : ProtocolEvidence n α) : Prop :=
  ∀ i, SameAgentSources (left i) (right i)

theorem extend_protocol_same (left right : ProtocolEvidence n α) (same : SameProtocolEvidence left right) :
    ∀ owner, SameAgentSources (extendProtocolEvidence left owner) (extendProtocolEvidence right owner) := by
  intro owner
  unfold extendProtocolEvidence
  split
  · exact same _
  · exact fun _ => Iff.rfl

theorem protocol_controllers_agree [DecidableEq α] (w : ProtocolModel n) (domain : ProtocolDomain w)
    (left right : ProtocolEvidence n α) (same : SameProtocolEvidence left right)
    (lrecords rrecords : ProtocolPhase n α)
    (ls : ∀ i, protocolAgentStop w left i = some (lrecords i))
    (rs : ∀ i, protocolAgentStop w right i = some (rrecords i)) :
    ∀ owner, protocolControllerViews w lrecords owner = protocolControllerViews w rrecords owner := by
  rw [protocol_views_from_phase w left lrecords ls, protocol_views_from_phase w right rrecords rs]
  exact controllers_from_shared_sources w.controllers _ _ (extend_protocol_same left right same)
    (protocol_agent_bounds w domain)

theorem protocol_agent_result_agrees [DecidableEq α] (w : ProtocolModel n) (domain : ProtocolDomain w)
    (left right : ProtocolEvidence n α) (same : SameProtocolEvidence left right)
    (i : Fin n) (spec : ProtocolAgent) (entry : w.dids i = some (.agent spec))
    (lrecords rrecords : ProtocolHistory α)
    (ls : protocolAgentStop w left i = some lrecords)
    (rs : protocolAgentStop w right i = some rrecords) :
    protocolAgentResult spec lrecords = protocolAgentResult spec rrecords := by
  have found : w.agent i.val = some spec := by simp [ProtocolModel.agent, i.isLt, entry]
  have table : w.controllers.table i.val = some spec.core := by rw [protocol_controller_table, found]; rfl
  have valid := domain.agents i.val spec found
  obtain ⟨lr, rr, lstop, rstop, _, _, equal⟩ := integrated_agent_convergence
    spec.core.graph spec.core.patch spec.core.registry spec.core.initialRegistry spec.core.emptyData
    spec.core.initialData spec.receipts spec.operationTime spec.chainFacts valid.ordered valid.bounded
    (left i) (right i) (same i)
  have lstop' : protocolAgentStop w left i = some lr := by
    simp only [protocolAgentStop, table]
    simpa only [controllerSourceStop, controllerSourceModel, controllerSourceRecords,
      ProtocolModel.controllers, found, Option.map_some, Option.getD_some] using lstop
  have rstop' : protocolAgentStop w right i = some rr := by
    simp only [protocolAgentStop, table]
    simpa only [controllerSourceStop, controllerSourceModel, controllerSourceRecords,
      ProtocolModel.controllers, found, Option.map_some, Option.getD_some] using rstop
  have leq := Option.some.inj (lstop'.symm.trans ls)
  have req := Option.some.inj (rstop'.symm.trans rs)
  subst lr; subst rr
  simp only [protocolAgentResult, equal]

/-- Composition: actual finite agent execution determines asset authorization;
actual asset execution then determines complete semantic results. -/
theorem protocol_results_agree [DecidableEq α] (w : ProtocolModel n) (domain : ProtocolDomain w)
    (left right : ProtocolEvidence n α) (same : SameProtocolEvidence left right)
    (lp rp lr rr : ProtocolRecords n α)
    (ls : reconcileProtocol w left lp = some lr) (rs : reconcileProtocol w right rp = some rr) :
    protocolResult w lr = protocolResult w rr := by
  obtain ⟨lagents, lassets⟩ := protocol_reconciliation_phases w left lp lr ls
  obtain ⟨ragents, rassets⟩ := protocol_reconciliation_phases w right rp rr rs
  have controllers := protocol_controllers_agree w domain left right same _ _ lagents ragents
  funext i
  cases entry : w.dids i with
  | none => simp [protocolResult, entry]
  | some did => cases did with
    | agent spec =>
      simp only [protocolResult, entry]
      rw [protocol_agent_result_agrees w domain left right same i spec entry _ _ (lagents i) (ragents i)]
    | asset spec =>
      have asset : w.asset i = some spec := by simp [ProtocolModel.asset, entry]
      have valid := domain.assets i spec asset
      have equal := asset_sources_same_receipt_result spec.graph spec.receipts w.controllers.table
        (protocolControllerViews w lr.agents) (protocolControllerViews w rr.agents) controllers
        w.unanchored w.localRegistry spec.operationTime spec.chainFacts valid.ordered valid.bounded
        (left i) (right i) (same i)
      have lstop := lassets i
      have rstop := rassets i
      simp only [protocolAssetStop, asset, protocolAssetRecords] at lstop rstop
      dsimp only at equal
      rw [lstop, rstop] at equal
      simp only [protocolResult, entry]
      rw [Option.some.inj equal]

end Archon
