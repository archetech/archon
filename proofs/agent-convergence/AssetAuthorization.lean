import ControllerSelection

set_option warningAsError true
namespace Archon

/-- Only validated self-controlled agent DIDs inhabit this table. An asset DID
or an unavailable controller has no entry. Histories are supplied separately so
controller replay changes can reconsider every retained dependent receipt. -/
structure ControllerSpec where
  graph : DocumentGraph
  patch : Nat → ComponentPatch Nat Nat
  initialData : Nat
  emptyData : Nat
  initialRegistry : Nat
  registry : Nat → Nat

abbrev ControllerTable := Nat → Option ControllerSpec
abbrev ControllerHistories := Nat → List AgentReceiptView

def selectedOwner (table : ControllerTable) (histories : ControllerHistories)
    (unanchored : Nat → Bool) (owner : Nat) (request : ControllerRequest) :
    Option (ComponentState Nat Nat) :=
  (table owner).bind fun spec => selectController spec.graph spec.patch spec.emptyData spec.initialData
    spec.initialRegistry spec.registry unanchored request (histories owner)

def ownerRegistry (table : ControllerTable) (histories : ControllerHistories)
    (unanchored : Nat → Bool) (owner : Nat) (request : ControllerRequest) : Option Nat :=
  (table owner).bind fun spec => (selectedOwner table histories unanchored owner request).map
    (fun state => spec.registry state.registration)

def activeOwner (table : ControllerTable) (histories : ControllerHistories)
    (unanchored : Nat → Bool) (owner : Nat) (request : ControllerRequest) : Bool :=
  (selectedOwner table histories unanchored owner request).any fun state => match state.authority with
    | .active _ => true
    | .deleted => false

def ownerVerifies (table : ControllerTable) (histories : ControllerHistories)
    (unanchored : Nat → Bool) (owner : Nat) (request : ControllerRequest)
    (named : Nat) (signature : Nat → Bool) : Bool :=
  ((table owner).map fun spec => controllerVerifies spec.graph
    (selectedOwner table histories unanchored owner request) named signature).getD false

/-- A complete abstract asset document: the owner field plus all remaining
fields as an opaque payload. The bridge decodes both from the same signed document;
there is no independent authorizing-owner table. -/
structure AssetDocument where
  payload : Nat
  owner : Nat
  deriving DecidableEq

/-- Immutable operation tables. `shape` is syntax/identity/registration validity,
not signature or controller availability. All authorization is derived below.
Actions and patches are decoded from those same operations by the signed bridge. -/
structure AssetGraph where
  size : Nat
  root : Nat
  initialDocument : Nat
  initialData : Nat
  emptyData : Nat
  initialRegistry : Nat
  registry : Nat → Nat
  parent : Nat → Option Nat
  depth : Nat → Nat
  deletion : Nat → Bool
  /-- The root is decoded from a creation, never from a deletion. -/
  rootNotDeleted : deletion root = false
  documents : Nat → AssetDocument
  patch : Nat → ComponentPatch Nat Nat
  /-- Proposed DID document is checked even on deletion, before discarding it. -/
  proposed : Nat → Option Nat
  shape : Nat → Bool
  proofTime : Nat → Int
  named : Nat → Nat
  signer : Nat → Nat
  signature : Nat → Nat → Bool

def assetAction (g : AssetGraph) (i : Nat) : AgentAction :=
  if g.deletion i then .deactivate else
    match g.proposed i with
    | none => .keep
    | some document => .rotate document

/-- Reuse the active/deleted ancestry algebra for structural asset document
indices. This does not treat an asset document as a verification key. -/
def assetStructure (g : AssetGraph) : AgentGraph where
  size := g.size
  root := g.root
  genesisKey := g.initialDocument
  parent := g.parent
  depth := g.depth
  action := assetAction g
  validBy := fun operation _ => g.shape operation

/-- The signed predecessor's owner signs the update/deletion. A changed owner
must independently be an active agent; that owner need not co-sign. -/
def assetOwnerAuthorized (g : AssetGraph) (table : ControllerTable)
    (histories : ControllerHistories) (unanchored : Nat → Bool)
    (localRegistry operation : Nat) (request : ControllerRequest) : Bool :=
  if operation = g.root then
    let owner := (g.documents g.initialDocument).owner
    activeOwner table histories unanchored owner request &&
      (g.signer operation == owner) &&
      ownerVerifies table histories unanchored owner request (g.named operation) (g.signature operation) &&
      (ownerRegistry table histories unanchored owner request).any (fun registry =>
        registry != localRegistry || g.registry g.initialRegistry == localRegistry)
  else
    ((g.parent operation).bind (agentStateAt (assetStructure g))).any fun previous =>
      match previous with
      | .deleted => false
      | .active document =>
        let owner := (g.documents document).owner
        let prospective := (g.documents ((g.proposed operation).getD document)).owner
        activeOwner table histories unanchored owner request &&
          ownerVerifies table histories unanchored owner request (g.named operation) (g.signature operation) &&
          (prospective == owner || activeOwner table histories unanchored prospective request)

/-- The controller named by the proposed document does not sign the transfer.
Authorization uses the signed predecessor's owner and independently checks the
prospective owner at the same receipt cutoff. -/
theorem asset_transfer_authorization (g : AssetGraph) (table : ControllerTable)
    (histories : ControllerHistories) (unanchored : Nat → Bool)
    (localRegistry operation parent document : Nat) (request : ControllerRequest)
    (nonroot : operation ≠ g.root) (predecessor : g.parent operation = some parent)
    (previous : agentStateAt (assetStructure g) parent = some (.active document)) :
    assetOwnerAuthorized g table histories unanchored localRegistry operation request =
      (activeOwner table histories unanchored (g.documents document).owner request &&
       ownerVerifies table histories unanchored (g.documents document).owner request
         (g.named operation) (g.signature operation) &&
       ((g.documents ((g.proposed operation).getD document)).owner == (g.documents document).owner ||
        activeOwner table histories unanchored
          (g.documents ((g.proposed operation).getD document)).owner request)) := by
  simp [assetOwnerAuthorized, nonroot, predecessor, previous]

theorem asset_deleted_predecessor_rejects (g : AssetGraph) (table : ControllerTable)
    (histories : ControllerHistories) (unanchored : Nat → Bool)
    (localRegistry operation parent : Nat) (request : ControllerRequest)
    (nonroot : operation ≠ g.root) (predecessor : g.parent operation = some parent)
    (deleted : agentStateAt (assetStructure g) parent = some .deleted) :
    assetOwnerAuthorized g table histories unanchored localRegistry operation request = false := by
  simp [assetOwnerAuthorized, nonroot, predecessor, deleted]

/-- A complete retained receipt is authorized in its own context. A rejected
chain receipt never manufactures an accepted proof-time gossip hint. -/
def assetReceiptAuthorized (g : AssetGraph) (table : ControllerTable)
    (histories : ControllerHistories) (unanchored : Nat → Bool) (localRegistry : Nat)
    (chainFacts : Nat → ChainReceiptView) (key : AgentReceiptKey) : Bool :=
  key.operation < g.size && g.shape key.operation &&
    (agentStateAt (assetStructure g) key.operation).isSome &&
    assetOwnerAuthorized g table histories unanchored localRegistry key.operation
      ⟨g.proofTime key.operation, key.anchor.map chainFacts⟩

/-- No asset-to-asset or controller-cycle recursion exists in this dependency
model: only an agent-table entry can supply authority. -/
theorem absent_owner_rejects (table : ControllerTable) (histories : ControllerHistories)
    (unanchored : Nat → Bool) (owner : Nat) (request : ControllerRequest)
    (absent : table owner = none) (named : Nat) (signature : Nat → Bool) :
    activeOwner table histories unanchored owner request = false ∧
      ownerVerifies table histories unanchored owner request named signature = false := by
  simp [activeOwner, selectedOwner, ownerVerifies, absent]

/-- Derived verdicts settle when the agent histories do, for every receipt and
both predecessor/prospective owners. Equal verdicts are not an input premise. -/
theorem asset_authorization_from_histories (g : AssetGraph) (table : ControllerTable)
    (left right : ControllerHistories) (same : ∀ owner, left owner = right owner)
    (unanchored : Nat → Bool) (localRegistry : Nat)
    (chainFacts : Nat → ChainReceiptView) :
    assetReceiptAuthorized g table left unanchored localRegistry chainFacts =
      assetReceiptAuthorized g table right unanchored localRegistry chainFacts := by
  have equal : left = right := funext same
  rw [equal]

end Archon
