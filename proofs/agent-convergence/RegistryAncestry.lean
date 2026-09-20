import AgentAuthorization

set_option warningAsError true
namespace Archon

/-- Registry IDs denote names, not an ordering between chains. This model covers
create/update ancestry with whole registration replacements or omitted registry
changes. Authorization and preferred-branch selection remain separate. -/
structure RegistryGraph where
  size : Nat
  root : Nat
  initial : Nat
  parent : Nat → Option Nat
  depth : Nat → Nat
  change : Nat → Option Nat

def RegistryOrdered (g : RegistryGraph) : Prop :=
  ∀ i p, g.parent i = some p → g.depth p < g.depth i

def applyRegistry (g : RegistryGraph) (i before : Nat) : Nat :=
  (g.change i).getD before

def evaluateRegistry (g : RegistryGraph) : Nat → Nat → Option Nat
  | 0, _ => none
  | fuel + 1, i =>
    if i < g.size then
      if i = g.root then some g.initial
      else (g.parent i).bind (fun p => (evaluateRegistry g fuel p).map (applyRegistry g i))
    else none

def registryAt (g : RegistryGraph) (i : Nat) : Option Nat :=
  evaluateRegistry g (g.depth i + 1) i

/-- The operation itself uses its predecessor registry. A proposed migration
changes the registry only for its descendants. -/
def expectedRegistry (g : RegistryGraph) (i : Nat) : Option Nat :=
  if i = g.root then some g.initial else (g.parent i).bind (registryAt g)

def registryFold (g : RegistryGraph) : Nat → List Nat → Nat
  | before, [] => before
  | before, i :: rest => registryFold g (applyRegistry g i before) rest

def registryModel (g : RegistryGraph) : Model :=
  ⟨g.size, g.parent, fun _ => true, fun i => g.size - g.depth i⟩

theorem evaluate_registry_agrees (g : RegistryGraph) (ordered : RegistryOrdered g)
    (fuel other i : Nat) (enough : g.depth i < fuel) (otherEnough : g.depth i < other) :
    evaluateRegistry g fuel i = evaluateRegistry g other i := by
  induction fuel generalizing other i with
  | zero => exfalso; omega
  | succ fuel ih =>
    cases other with
    | zero => exfalso; omega
    | succ other =>
      by_cases bounded : i < g.size
      · by_cases root : i = g.root
        · simp [evaluateRegistry, root]
        · cases parent : g.parent i with
          | none => simp [evaluateRegistry, bounded, root, parent]
          | some p =>
            have lower := ordered i p parent
            have same := ih other p (by omega) (by omega)
            simp [evaluateRegistry, bounded, root, parent, same]
      · simp [evaluateRegistry, bounded]

theorem registry_at_root (g : RegistryGraph) (bounded : g.root < g.size) :
    registryAt g g.root = some g.initial := by
  simp [registryAt, evaluateRegistry, bounded]

theorem registry_at_step (g : RegistryGraph) (ordered : RegistryOrdered g)
    (i p : Nat) (bounded : i < g.size) (notRoot : i ≠ g.root)
    (parent : g.parent i = some p) :
    registryAt g i = (registryAt g p).map (applyRegistry g i) := by
  have lower := ordered i p parent
  have same := evaluate_registry_agrees g ordered (g.depth i) (g.depth p + 1) p lower (by omega)
  simp only [registryAt, evaluateRegistry, bounded, notRoot, parent, ↓reduceIte, Option.bind_some]
  rw [same]
  rfl

/-- Incoming migration eligibility and outgoing registry state are distinct. -/
theorem migration_uses_predecessor_registry (g : RegistryGraph) (ordered : RegistryOrdered g)
    (genesis : g.parent g.root = none) (i p before : Nat)
    (bounded : i < g.size) (parent : g.parent i = some p)
    (state : registryAt g p = some before) :
    expectedRegistry g i = some before ∧ registryAt g i = some (applyRegistry g i before) := by
  have notRoot : i ≠ g.root := by
    intro same
    subst i
    simp [genesis] at parent
  constructor
  · simp [expectedRegistry, notRoot, parent, state]
  · rw [registry_at_step g ordered i p bounded notRoot parent, state]
    rfl

/-- Walking a valid signed prefix computes the same registry as independently
following its tip's predecessor ancestry. The evidence list is only membership;
its traversal order does not determine registry state. -/
theorem registry_prefix_agrees (g : RegistryGraph) (ordered : RegistryOrdered g)
    (genesis : g.parent g.root = none) (evidence : List Nat) (p : Nat) (path : List Nat)
    (valid : ValidPath (registryModel g) evidence p path) (before : Nat)
    (state : registryAt g p = some before) :
    registryAt g (pathTip p path) = some (registryFold g before path) := by
  induction valid generalizing before with
  | nil => exact state
  | @cons child p rest member ok tail ih =>
    have bound := eligible_lt (registryModel g) p child ok
    have parent := eligible_parent (registryModel g) p child ok
    have next := (migration_uses_predecessor_registry g ordered genesis child p before bound parent state).2
    exact ih (applyRegistry g child before) next

/-- The registry used for a next operation is the result of the preceding valid
prefix, excluding the next operation's proposed registration change. -/
theorem expected_registry_after_prefix (g : RegistryGraph) (ordered : RegistryOrdered g)
    (genesis : g.parent g.root = none) (rootBound : g.root < g.size)
    (evidence path : List Nat) (valid : ValidPath (registryModel g) evidence g.root path)
    (next : Nat) (bounded : next < g.size) (parent : g.parent next = some (pathTip g.root path)) :
    expectedRegistry g next = some (registryFold g g.initial path) := by
  have state := registry_prefix_agrees g ordered genesis evidence g.root path valid g.initial (registry_at_root g rootBound)
  exact (migration_uses_predecessor_registry g ordered genesis next _ _ bounded parent state).1

/-- Registry equality only: whether that registry supplies chain priority is a
separate policy (local/hyperswarm/pin are not made chain anchors here). -/
def receiptRegistryMatches (g : RegistryGraph) (operation registry : Nat) : Bool :=
  expectedRegistry g operation == some registry

theorem receipt_registry_after_prefix (g : RegistryGraph) (ordered : RegistryOrdered g)
    (genesis : g.parent g.root = none) (rootBound : g.root < g.size)
    (evidence path : List Nat) (valid : ValidPath (registryModel g) evidence g.root path)
    (next registry : Nat) (bounded : next < g.size)
    (parent : g.parent next = some (pathTip g.root path)) :
    receiptRegistryMatches g next registry = true ↔ registry = registryFold g g.initial path := by
  have expected := expected_registry_after_prefix g ordered genesis rootBound evidence path valid next bounded parent
  simp only [receiptRegistryMatches, expected, Option.some_beq_some, Nat.beq_eq_true_eq]
  exact eq_comm

end Archon
