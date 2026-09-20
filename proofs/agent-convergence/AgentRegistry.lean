import AgentComponents
import RegistryAnchors

set_option warningAsError true
namespace Archon

/-- Registry ancestry uses the same signed predecessor/action/patch tables as
component execution. A deletion preserves registration, including when an
out-of-domain patch table contains a registration value for that operation. -/
def componentRegistry (g : DocumentGraph) (patch : Nat → ComponentPatch D R)
    (registry : R → Nat) (initial : R) : RegistryGraph where
  size := g.size
  root := g.root
  initial := registry initial
  parent := g.parent
  depth := g.depth
  change := fun i => match g.action i with
    | .deactivate => none
    | _ => (patch i).registration.map registry

/-- Derive anchor authorization and expected registry rather than assuming a
shared set of accepted operations. Receipt validity abstracts chain admission,
not predecessor-key authorization. -/
def componentAnchors (g : DocumentGraph) (patch : Nat → ComponentPatch D R)
    (registry : R → Nat) (initial : R) (receipts : RegistryReceipts) : AnchorModel :=
  registryAnchors (componentRegistry g patch registry initial)
    { receipts with accepted := fun i => receipts.accepted i &&
        (agentModel (documentAgent g)).authorized (receipts.owner i) }

theorem component_step_registry (g : DocumentGraph) (patch : Nat → ComponentPatch D R)
    (registry : R → Nat) (initial : R) (empty : D) (i : Nat)
    (before after : ComponentState D R) (step : componentStep g patch empty i before = some after) :
    registry after.registration = applyRegistry (componentRegistry g patch registry initial) i
      (registry before.registration) := by
  cases before with | mk authority data registration =>
    cases authority with
    | deleted => simp [componentStep, advanceAgent] at step
    | active key =>
      cases action : g.action i <;>
        cases supplied : (patch i).registration <;>
        simp [componentStep, advanceAgent, documentAgent, action, supplied] at step
      all_goals
        obtain ⟨_, rfl⟩ := step
        simp [applyRegistry, componentRegistry, action, supplied]

theorem component_run_registry (g : DocumentGraph) (patch : Nat → ComponentPatch D R)
    (registry : R → Nat) (initial : R) (empty : D) (path : List Nat)
    (before after : ComponentState D R) (ran : runComponents g patch empty before path = some after) :
    registry after.registration = registryFold (componentRegistry g patch registry initial)
      (registry before.registration) path := by
  induction path generalizing before with
  | nil => simp only [runComponents, Option.some.injEq] at ran; subst after; rfl
  | cons i rest ih =>
    cases step : componentStep g patch empty i before with
    | none => simp [runComponents, step] at ran
    | some next =>
      have tail : runComponents g patch empty next rest = some after := by
        simpa only [runComponents, step, Option.bind_some] using ran
      rw [ih next tail, component_step_registry g patch registry initial empty i before next step]
      rfl

/-- Successful component execution gives the authorizing state reconstructed
from signed ancestry; it is not an independently supplied acceptance oracle. -/
theorem component_prefix_authority (g : DocumentGraph) (patch : Nat → ComponentPatch D R)
    (empty initialData : D) (initial : R)
    (ordered : AncestryOrdered (documentAgent g)) (genesis : g.parent g.root = none)
    (rootBound : g.root < g.size) (evidence path : List Nat)
    (valid : ValidPath (agentModel (documentAgent g)) evidence g.root path)
    (before : ComponentState D R)
    (ran : runComponents g patch empty ⟨.active g.initialDocument, initialData, initial⟩ path = some before) :
    agentStateAt (documentAgent g) (pathTip g.root path) = some before.authority := by
  obtain ⟨final, executed, state⟩ := valid_agent_path_runs (documentAgent g) ordered genesis
    evidence g.root path valid (.active g.initialDocument) (agent_state_root _ rootBound)
  have projection := component_run_authority g patch empty path ⟨.active g.initialDocument, initialData, initial⟩
  rw [ran, Option.map_some, executed] at projection
  exact state.trans projection.symm

/-- Every document-authorized path is also a bounded predecessor-linked registry
path, using the same identity tables. -/
theorem component_registry_path (g : DocumentGraph) (patch : Nat → ComponentPatch D R)
    (registry : R → Nat) (initial : R) (evidence : List Nat) (p : Nat) (path : List Nat)
    (valid : ValidPath (agentModel (documentAgent g)) evidence p path) :
    ValidPath (registryModel (componentRegistry g patch registry initial)) evidence p path := by
  induction valid with
  | nil => exact .nil _
  | cons member ok tail ih =>
    apply ValidPath.cons member _ ih
    have bound := eligible_lt _ _ _ ok
    have parent := eligible_parent _ _ _ ok
    simp only [eligible, registryModel, componentRegistry, Bool.and_eq_true]
    change g.parent _ = some _ at parent
    exact ⟨⟨decide_eq_true bound, True.intro⟩, by simp only [parent, Option.some_beq_some, Nat.beq_eq_true_eq]⟩

/-- The integrated anchor predicate agrees with the actual predecessor component
state: old registry for the migration, and predecessor methods for its signature.
Full-document decoding is used by passing `decodedComponentGraph` as `g`. -/
theorem component_anchor_after_prefix (g : DocumentGraph) (patch : Nat → ComponentPatch D R)
    (registry : R → Nat) (initial : R) (empty initialData : D) (r : RegistryReceipts)
    (ordered : AncestryOrdered (documentAgent g)) (genesis : g.parent g.root = none)
    (rootBound : g.root < g.size) (evidence path : List Nat)
    (valid : ValidPath (agentModel (documentAgent g)) evidence g.root path)
    (before : ComponentState D R)
    (ran : runComponents g patch empty ⟨.active g.initialDocument, initialData, initial⟩ path = some before)
    (op receipt : Nat) (bounded : op < g.size)
    (parent : g.parent op = some (pathTip g.root path)) :
    eligible (componentAnchors g patch registry initial r) op receipt = true ↔
      receipt < r.size ∧ r.accepted receipt = true ∧ r.chain (r.registry receipt) = true ∧
      r.owner receipt = op ∧ r.registry receipt = registry before.registration ∧
      ∃ after, componentStep g patch empty op before = some after := by
  have regPath := component_registry_path g patch registry initial evidence g.root path valid
  have folded := component_run_registry g patch registry initial empty path _ before ran
  have reg := registry_anchor_after_prefix (componentRegistry g patch registry initial)
    { r with accepted := fun i => r.accepted i && (agentModel (documentAgent g)).authorized (r.owner i) }
    ordered genesis rootBound evidence path regPath op receipt bounded parent
  have authority := agent_authorization_matches (documentAgent g) ordered genesis op _ before.authority bounded parent
    (component_prefix_authority g patch empty initialData initial ordered genesis rootBound evidence path valid before ran)
  have step := component_step_authority g patch empty op before
  have executable : (∃ after, advanceAgent (documentAgent g) op before.authority = some after) ↔
      ∃ after, componentStep g patch empty op before = some after := by
    cases h : componentStep g patch empty op before <;> simp [h, ← step]
  change eligible (registryAnchors _ _) op receipt = true ↔ _
  rw [reg]
  simp only [Bool.and_eq_true]
  constructor
  · rintro ⟨bound, ⟨accepted, authorized⟩, chain, owner, matched⟩
    rw [owner] at authorized
    exact ⟨bound, accepted, chain, owner, matched.trans folded.symm,
      executable.mp (authority.mp authorized)⟩
  · rintro ⟨bound, accepted, chain, owner, matched, execution⟩
    refine ⟨bound, ⟨accepted, ?_⟩, chain, owner, matched.trans folded⟩
    rw [owner]
    exact authority.mpr (executable.mpr execution)

/-- Derive the predecessor components as well as eligibility from a valid history.
No supplied final document, registration, or successful component run is needed.
Genesis is admitted separately; this is a prefix/eligibility theorem, not yet
an integrated event-replay or full protocol convergence theorem. -/
theorem component_anchor_from_history (g : DocumentGraph) (patch : Nat → ComponentPatch D R)
    (registry : R → Nat) (initial : R) (empty initialData : D) (r : RegistryReceipts)
    (ordered : AncestryOrdered (documentAgent g)) (genesis : g.parent g.root = none)
    (rootBound : g.root < g.size) (evidence path : List Nat)
    (valid : ValidPath (agentModel (documentAgent g)) evidence g.root path)
    (op receipt : Nat) (bounded : op < g.size)
    (parent : g.parent op = some (pathTip g.root path)) :
    ∃ before,
      runComponents g patch empty ⟨.active g.initialDocument, initialData, initial⟩ path = some before ∧
      (eligible (componentAnchors g patch registry initial r) op receipt = true ↔
        receipt < r.size ∧ r.accepted receipt = true ∧ r.chain (r.registry receipt) = true ∧
        r.owner receipt = op ∧ r.registry receipt = registry before.registration ∧
        ∃ after, componentStep g patch empty op before = some after) := by
  obtain ⟨final, executed, _⟩ := valid_agent_path_runs (documentAgent g) ordered genesis
    evidence g.root path valid (.active g.initialDocument) (agent_state_root _ rootBound)
  have projection := component_run_authority g patch empty path
    ⟨.active g.initialDocument, initialData, initial⟩
  rw [executed] at projection
  cases ran : runComponents g patch empty ⟨.active g.initialDocument, initialData, initial⟩ path with
  | none => simp only [ran, Option.map_none, reduceCtorEq] at projection
  | some before =>
    exact ⟨before, rfl, component_anchor_after_prefix g patch registry initial empty initialData r
      ordered genesis rootBound evidence path valid before ran op receipt bounded parent⟩

end Archon
