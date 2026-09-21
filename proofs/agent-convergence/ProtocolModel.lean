import FiniteReconciliation

set_option warningAsError true
namespace Archon

structure ProtocolAgent where
  core : ControllerSpec
  receipts : RegistryReceipts
  positions : Nat → List Nat
  operationTime : Nat → Int
  chainFacts : Nat → ChainReceiptView
  documents : Nat → Nat
  methods : Nat → List VerificationMethod
  deletedDocument : Nat

structure ProtocolAsset where
  graph : AssetGraph
  receipts : AssetReceipts
  positions : Nat → List Nat
  operationTime : Nat → Int
  chainFacts : Nat → ChainReceiptView

/-- The immutable genesis kind chooses a single component; an asset can never
inhabit the controller table. Missing genesis may have no decoded specification. -/
inductive ProtocolDID where
  | agent (spec : ProtocolAgent)
  | asset (spec : ProtocolAsset)

structure ProtocolModel (n : Nat) where
  dids : Fin n → Option ProtocolDID
  unanchored : Nat → Bool
  localRegistry : Nat

def ProtocolModel.agent (w : ProtocolModel n) (owner : Nat) : Option ProtocolAgent :=
  if h : owner < n then (w.dids ⟨owner, h⟩).bind fun did => match did with
    | .agent spec => some spec
    | .asset _ => none
  else none

def ProtocolModel.asset (w : ProtocolModel n) (i : Fin n) : Option ProtocolAsset :=
  (w.dids i).bind fun did => match did with
    | .agent _ => none
    | .asset spec => some spec

def noProtocolReceipts : RegistryReceipts := ⟨0, fun _ => 0, fun _ => 0, fun _ => false, fun _ => false⟩

def ProtocolModel.controllers (w : ProtocolModel n) : AssetControllerInputs where
  isAgent := fun owner => (w.agent owner).isSome
  specifications := fun owner => (w.agent owner).map ProtocolAgent.core
  receipts := fun owner => ((w.agent owner).map ProtocolAgent.receipts).getD noProtocolReceipts
  operationTime := fun owner => ((w.agent owner).map ProtocolAgent.operationTime).getD (fun _ => 0)
  chainFacts := fun owner => ((w.agent owner).map ProtocolAgent.chainFacts).getD (fun _ => ⟨0, [], 0, false⟩)

theorem protocol_controller_table (w : ProtocolModel n) (owner : Nat) :
    w.controllers.table owner = (w.agent owner).map ProtocolAgent.core := by
  cases entry : w.agent owner <;> simp [ProtocolModel.controllers, AssetControllerInputs.table, entry]

theorem protocol_controller_outside (w : ProtocolModel n) (owner : Nat) (outside : ¬owner < n) :
    w.controllers.table owner = none := by
  rw [protocol_controller_table]; simp [ProtocolModel.agent, outside]

theorem protocol_asset_not_controller (w : ProtocolModel n) (i : Fin n) (spec : ProtocolAsset)
    (asset : w.asset i = some spec) : w.controllers.table i.val = none := by
  rw [protocol_controller_table]
  cases entry : w.dids i with
  | none => simp [ProtocolModel.asset, entry] at asset
  | some did => cases did with
    | agent agent => simp [ProtocolModel.asset, entry] at asset
    | asset value => simp [ProtocolModel.agent, i.isLt, entry]

abbrev ProtocolEvidence (n : Nat) (α : Type) := Fin n → List (AgentSourceReceipt α)
abbrev ProtocolHistory (α : Type) := List (EventRecord (AgentSourceReceipt α))
abbrev ProtocolPhase (n : Nat) (α : Type) := Fin n → ProtocolHistory α

structure ProtocolRecords (n : Nat) (α : Type) where
  agents : ProtocolPhase n α
  assets : ProtocolPhase n α

def extendProtocolEvidence (evidence : ProtocolEvidence n α) (owner : Nat) :=
  if h : owner < n then evidence ⟨owner, h⟩ else []

def protocolAgentStop [DecidableEq α] (w : ProtocolModel n) (evidence : ProtocolEvidence n α) (i : Fin n) :=
  match w.controllers.table i.val with
  | none => some ([] : ProtocolHistory α)
  | some spec => controllerSourceStop w.controllers i.val spec (evidence i)

def protocolControllerViews (w : ProtocolModel n) (agents : ProtocolPhase n α) : ControllerHistories := fun owner =>
  if h : owner < n then
    match w.controllers.table owner with
    | none => []
    | some spec =>
      let a := componentAnchors spec.graph spec.patch spec.registry spec.initialRegistry (w.controllers.receipts owner)
      confirmedReceiptView ((agents ⟨owner, h⟩).map (agentReceiptView a
        (expectedRegistry (componentRegistry spec.graph spec.patch spec.registry spec.initialRegistry))
        (w.controllers.operationTime owner) (w.controllers.chainFacts owner)))
  else []

def protocolAssetRecords (w : ProtocolModel n) (evidence : ProtocolEvidence n α)
    (agents : ProtocolPhase n α) (i : Fin n) (spec : ProtocolAsset) :=
  assetSourceRecords spec.graph spec.receipts w.controllers.table (protocolControllerViews w agents)
    w.unanchored w.localRegistry spec.chainFacts (evidence i)

def protocolAssetStop [DecidableEq α] (w : ProtocolModel n) (evidence : ProtocolEvidence n α)
    (agents : ProtocolPhase n α) (i : Fin n) :=
  match w.asset i with
  | none => some ([] : ProtocolHistory α)
  | some spec =>
    let a := assetAnchors spec.graph spec.receipts
    let m := coldAssetModel spec.graph a
    stopWhenStable (rankedPass m (chainOwner a) spec.graph.size
      (protocolAssetRecords w evidence agents i spec)) (m.size + 3) []

/-- Full cold reconstruction. The asset phase consumes the actual completed
agent phase, not a supplied controller-history oracle. Prior published state is
intentionally discarded by this reconstruction path. -/
def reconcileProtocol [DecidableEq α] (w : ProtocolModel n) (evidence : ProtocolEvidence n α)
    (_previous : ProtocolRecords n α) : Option (ProtocolRecords n α) := do
  let agents ← collectFinite n (protocolAgentStop w evidence)
  let assets ← collectFinite n (protocolAssetStop w evidence agents)
  pure ⟨agents, assets⟩

theorem protocol_reconstruction_ignores_previous [DecidableEq α] (w : ProtocolModel n)
    (evidence : ProtocolEvidence n α) (left right : ProtocolRecords n α) :
    reconcileProtocol w evidence left = reconcileProtocol w evidence right := rfl

/-- Bounds and parser/projection contracts. None assumes equal authorization,
accepted histories, or receipt bookkeeping. The authoritative source decoder
supplies identities, signature primitives, component values and clock facts. -/
structure ProtocolAgentDomain (spec : ProtocolAgent) : Prop where
  ordered : AncestryOrdered (documentAgent spec.core.graph)
  bounded : DepthBounded (documentAgent spec.core.graph)
  parents : AgentParentBounded spec.core.graph
  genesis : spec.core.graph.parent spec.core.graph.root = none
  rootBound : spec.core.graph.root < spec.core.graph.size
  rootSignature : verifiesDocument (spec.core.graph.documents spec.core.graph.initialDocument)
    (spec.core.graph.named spec.core.graph.root) (spec.core.graph.signatureValid spec.core.graph.root) = true
  rootAction : spec.core.graph.action spec.core.graph.root = .keep
  methods : ∀ i, spec.methods (spec.documents i) = spec.core.graph.documents i
  ranks : RegistryCidRanks (componentRegistry spec.core.graph spec.core.patch spec.core.registry spec.core.initialRegistry)
    spec.receipts spec.positions
  admittedAnchors : ∀ rank, rank < spec.receipts.size → spec.receipts.accepted rank = true
  facts : ∀ rank, rank < spec.receipts.size →
    (spec.chainFacts rank).registry = spec.receipts.registry rank ∧
    (spec.chainFacts rank).ordinal = spec.positions rank ∧ spec.positions rank ≠ []

structure ProtocolAssetDomain (spec : ProtocolAsset) : Prop where
  ordered : AncestryOrdered (assetStructure spec.graph)
  bounded : DepthBounded (assetStructure spec.graph)
  parents : AssetParentBounded spec.graph
  genesis : spec.graph.parent spec.graph.root = none
  rootBound : spec.graph.root < spec.graph.size
  clocks : ∀ operation, operation ≠ spec.graph.root → spec.operationTime operation = spec.graph.proofTime operation
  ranks : AssetCidRanks spec.graph spec.receipts spec.positions
  facts : ∀ rank, rank < spec.receipts.size →
    (spec.chainFacts rank).registry = spec.receipts.registry rank ∧
    (spec.chainFacts rank).ordinal = spec.positions rank ∧ spec.positions rank ≠ []

structure ProtocolDomain (w : ProtocolModel n) : Prop where
  agents : ∀ owner spec, w.agent owner = some spec → ProtocolAgentDomain spec
  assets : ∀ i spec, w.asset i = some spec → ProtocolAssetDomain spec
  agentChains : ∀ owner spec, w.agent owner = some spec → ∀ rank, rank < spec.receipts.size →
    spec.receipts.chain (spec.receipts.registry rank) = !w.unanchored (spec.receipts.registry rank)
  assetChains : ∀ i spec, w.asset i = some spec → ∀ rank, rank < spec.receipts.size →
    spec.receipts.chain (spec.receipts.registry rank) = !w.unanchored (spec.receipts.registry rank)

/-- Lift finite typed-DID contracts to every natural-number owner lookup. -/
theorem protocol_domain_of_slots (w : ProtocolModel n)
    (agents : ∀ i spec, w.dids i = some (.agent spec) → ProtocolAgentDomain spec)
    (assets : ∀ i spec, w.dids i = some (.asset spec) → ProtocolAssetDomain spec)
    (agentChains : ∀ i spec, w.dids i = some (.agent spec) → ∀ rank, rank < spec.receipts.size →
      spec.receipts.chain (spec.receipts.registry rank) = !w.unanchored (spec.receipts.registry rank))
    (assetChains : ∀ i spec, w.dids i = some (.asset spec) → ∀ rank, rank < spec.receipts.size →
      spec.receipts.chain (spec.receipts.registry rank) = !w.unanchored (spec.receipts.registry rank)) :
    ProtocolDomain w := by
  have agentEntry (owner : Nat) (spec : ProtocolAgent) (found : w.agent owner = some spec) :
      ∃ i : Fin n, w.dids i = some (.agent spec) := by
    unfold ProtocolModel.agent at found
    split at found
    next inside =>
      cases entry : w.dids ⟨owner, inside⟩ with
      | none => simp [entry] at found
      | some did => cases did with
        | asset value => simp [entry] at found
        | agent value =>
          have equal : value = spec := by simpa [entry] using found
          exact ⟨⟨owner, inside⟩, by simpa [equal] using entry⟩
    next => simp at found
  have assetEntry (i : Fin n) (spec : ProtocolAsset) (found : w.asset i = some spec) :
      w.dids i = some (.asset spec) := by
    cases entry : w.dids i with
    | none => simp [ProtocolModel.asset, entry] at found
    | some did => cases did with
      | agent value => simp [ProtocolModel.asset, entry] at found
      | asset value =>
        have equal : value = spec := by simpa [ProtocolModel.asset, entry] using found
        simp [equal]
  exact ⟨fun owner spec found => let ⟨i, entry⟩ := agentEntry owner spec found; agents i spec entry,
    fun i spec found => assets i spec (assetEntry i spec found),
    fun owner spec found => let ⟨i, entry⟩ := agentEntry owner spec found; agentChains i spec entry,
    fun i spec found => assetChains i spec (assetEntry i spec found)⟩

end Archon
