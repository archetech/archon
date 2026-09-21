import AssetExecution
import AssetPriority

set_option warningAsError true
namespace Archon

/-- Static agent graphs and authoritative receipt-class facts. Controller
histories themselves are reconstructed below from retained source evidence. -/
structure AssetControllerInputs where
  table : ControllerTable
  receipts : Nat → RegistryReceipts
  operationTime : Nat → Nat → Int
  chainFacts : Nat → Nat → ChainReceiptView

def controllerSourceModel (inputs : AssetControllerInputs) (owner : Nat) (spec : ControllerSpec) :=
  coldComponentEvents spec.graph
    (componentAnchors spec.graph spec.patch spec.registry spec.initialRegistry (inputs.receipts owner))

def controllerSourceRecords (inputs : AssetControllerInputs) (owner : Nat) (spec : ControllerSpec)
    (sources : List (AgentSourceReceipt α)) :=
  normalizeAgentSources
    (componentAnchors spec.graph spec.patch spec.registry spec.initialRegistry (inputs.receipts owner))
    (expectedRegistry (componentRegistry spec.graph spec.patch spec.registry spec.initialRegistry)) sources

def controllerSourceStop [DecidableEq α] (inputs : AssetControllerInputs) (owner : Nat)
    (spec : ControllerSpec) (sources : List (AgentSourceReceipt α)) :=
  let a := componentAnchors spec.graph spec.patch spec.registry spec.initialRegistry (inputs.receipts owner)
  let m := controllerSourceModel inputs owner spec
  stopWhenStable (rankedPass m (chainOwner a) spec.graph.size (controllerSourceRecords inputs owner spec sources))
    (m.size + 3) []

def reconciledControllerHistories [DecidableEq α] (inputs : AssetControllerInputs)
    (sources : Nat → List (AgentSourceReceipt α)) : ControllerHistories := fun owner =>
  ((inputs.table owner).bind fun spec =>
    let a := componentAnchors spec.graph spec.patch spec.registry spec.initialRegistry (inputs.receipts owner)
    let expected := expectedRegistry (componentRegistry spec.graph spec.patch spec.registry spec.initialRegistry)
    (controllerSourceStop inputs owner spec (sources owner)).map fun records =>
      confirmedReceiptView (records.map (agentReceiptView a expected
        (inputs.operationTime owner) (inputs.chainFacts owner)))).getD []

/-- A3 supplies history equality constructively from shared agent source sets;
no shared authorizing document or accepted agent projection is supplied. -/
theorem controllers_from_shared_sources [DecidableEq α] (inputs : AssetControllerInputs)
    (left right : Nat → List (AgentSourceReceipt α))
    (same : ∀ owner, SameAgentSources (left owner) (right owner))
    (valid : ∀ owner spec, inputs.table owner = some spec →
      AncestryOrdered (documentAgent spec.graph) ∧ DepthBounded (documentAgent spec.graph)) :
    ∀ owner, reconciledControllerHistories inputs left owner = reconciledControllerHistories inputs right owner := by
  intro owner
  cases entry : inputs.table owner with
  | none => simp [reconciledControllerHistories, entry]
  | some spec =>
    have bounds := valid owner spec entry
    have equal := agent_sources_same_receipt_view spec.graph spec.patch spec.registry spec.initialRegistry
      (inputs.receipts owner) (inputs.operationTime owner) (inputs.chainFacts owner)
      bounds.1 bounds.2 (left owner) (right owner) (same owner)
    have mapped := congrArg (fun value => value.getD []) equal
    simpa only [reconciledControllerHistories, entry, Option.bind_some, controllerSourceStop,
      controllerSourceModel, controllerSourceRecords] using mapped

/-- The source reconstruction above really stops, rather than comparing two
failed/unfinished controller computations through the default empty view. -/
theorem controller_source_terminates [DecidableEq α] (inputs : AssetControllerInputs)
    (owner : Nat) (spec : ControllerSpec) (sources : List (AgentSourceReceipt α))
    (ordered : AncestryOrdered (documentAgent spec.graph)) (bounded : DepthBounded (documentAgent spec.graph)) :
    ∃ result, controllerSourceStop inputs owner spec sources = some result ∧
      rankedPass (controllerSourceModel inputs owner spec)
        (chainOwner (componentAnchors spec.graph spec.patch spec.registry spec.initialRegistry (inputs.receipts owner)))
        spec.graph.size (controllerSourceRecords inputs owner spec sources) result = result := by
  obtain ⟨result, _, stopped, _, fixed, _, _⟩ := integrated_agent_convergence spec.graph spec.patch
    spec.registry spec.initialRegistry spec.emptyData spec.initialData (inputs.receipts owner)
    (inputs.operationTime owner) (inputs.chainFacts owner) ordered bounded sources sources (fun _ => Iff.rfl)
  exact ⟨result, stopped, fixed⟩

/-- Required interpretation of ranked sibling choice, tied to the source's
actual registry-local ordinals and canonical CID ranks. -/
def AssetSiblingOrdering (g : AssetGraph) (r : AssetReceipts) (position : Nat → List Nat) : Prop :=
  ∀ x y parent, g.parent (r.owner x) = some parent → g.parent (r.owner y) = some parent →
    eligible (assetAnchors g r) (r.owner x) x = true → eligible (assetAnchors g r) (r.owner y) y = true →
    (x < y ↔ compare (position x) (position y) = .lt ∨
      (compare (position x) (position y) = .eq ∧ r.owner x < r.owner y))

/-- B2 endpoint from agent and asset source evidence. Agent reconstruction is
proved to stop, B1 derives each asset's authority, ranked full-record asset replay
stops with one full result, and the ordering contract is consumed by the endpoint.
Global finite-family scheduling/composition remains C1. -/
theorem integrated_asset_convergence [DecidableEq α] (inputs : AssetControllerInputs)
    (agentLeft agentRight : Nat → List (AgentSourceReceipt α))
    (agentsSame : ∀ owner, SameAgentSources (agentLeft owner) (agentRight owner))
    (agentsValid : ∀ owner spec, inputs.table owner = some spec →
      AncestryOrdered (documentAgent spec.graph) ∧ DepthBounded (documentAgent spec.graph))
    (g : AssetGraph) (r : AssetReceipts) (position : Nat → List Nat) (ranks : AssetCidRanks g r position)
    (genesis : g.parent g.root = none) (unanchored : Nat → Bool) (localRegistry : Nat)
    (chainFacts : Nat → ChainReceiptView)
    (ordered : AncestryOrdered (assetStructure g)) (bounded : DepthBounded (assetStructure g))
    (xs ys : List (AgentSourceReceipt α)) (same : SameAgentSources xs ys) :
    (∀ owner spec, inputs.table owner = some spec →
      (∃ result, controllerSourceStop inputs owner spec (agentLeft owner) = some result) ∧
      (∃ result, controllerSourceStop inputs owner spec (agentRight owner) = some result)) ∧
    AssetSiblingOrdering g r position ∧
    (let a := assetAnchors g r
     let m := coldAssetModel g a
     let lrecords := assetSourceRecords g r inputs.table (reconciledControllerHistories inputs agentLeft)
       unanchored localRegistry chainFacts xs
     let rrecords := assetSourceRecords g r inputs.table (reconciledControllerHistories inputs agentRight)
       unanchored localRegistry chainFacts ys
     ∃ lresult rresult,
       stopWhenStable (rankedPass m (chainOwner a) g.size lrecords) (m.size + 3) [] = some lresult ∧
       stopWhenStable (rankedPass m (chainOwner a) g.size rrecords) (m.size + 3) [] = some rresult ∧
       rankedPass m (chainOwner a) g.size lrecords lresult = lresult ∧
       rankedPass m (chainOwner a) g.size rrecords rresult = rresult ∧
       assetResult g a lresult = assetResult g a rresult) := by
  refine ⟨?_, ?_, ?_⟩
  · intro owner spec entry
    have bounds := agentsValid owner spec entry
    obtain ⟨left, stoppedLeft, _⟩ := controller_source_terminates inputs owner spec (agentLeft owner) bounds.1 bounds.2
    obtain ⟨right, stoppedRight, _⟩ := controller_source_terminates inputs owner spec (agentRight owner) bounds.1 bounds.2
    exact ⟨⟨left, stoppedLeft⟩, ⟨right, stoppedRight⟩⟩
  · exact fun x y parent xp yp xa ya => asset_sibling_priority g r position ranks genesis x y parent xp yp xa ya
  · exact asset_reconciliation_converges g r inputs.table _ _
      (controllers_from_shared_sources inputs agentLeft agentRight agentsSame agentsValid)
      unanchored localRegistry chainFacts ordered bounded xs ys same

end Archon
