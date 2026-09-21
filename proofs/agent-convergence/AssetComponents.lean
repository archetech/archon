import AssetAuthorization

set_option warningAsError true
namespace Archon

def assetInitial (g : AssetGraph) : ComponentState Nat Nat :=
  ⟨.active g.initialDocument, g.initialData, g.initialRegistry⟩

def assetComponentStep (g : AssetGraph) (i : Nat) (before : ComponentState Nat Nat) :
    Option (ComponentState Nat Nat) :=
  (advanceAgent (assetStructure g) i before.authority).map fun next =>
    match next with
    | .deleted => ⟨next, 0, before.registration⟩
    | .active _ => ⟨next, (g.patch i).data.getD before.data,
        (g.patch i).registration.getD before.registration⟩

def runAssetComponents (g : AssetGraph) : ComponentState Nat Nat → List Nat → Option (ComponentState Nat Nat)
  | state, [] => some state
  | state, i :: rest => (assetComponentStep g i state).bind (fun next => runAssetComponents g next rest)

def evaluateAssetComponents (g : AssetGraph) : Nat → Nat → Option (ComponentState Nat Nat)
  | 0, _ => none
  | fuel + 1, i =>
    if i < g.size then
      if i = g.root then some (assetInitial g)
      else (g.parent i).bind (fun p => (evaluateAssetComponents g fuel p).bind (assetComponentStep g i))
    else none

def assetComponentsAt (g : AssetGraph) (i : Nat) := evaluateAssetComponents g (g.depth i + 1) i

theorem asset_component_step_authority (g : AssetGraph) (i : Nat) (before : ComponentState Nat Nat) :
    (assetComponentStep g i before).map ComponentState.authority =
      advanceAgent (assetStructure g) i before.authority := by
  cases h : advanceAgent (assetStructure g) i before.authority with
  | none => simp [assetComponentStep, h]
  | some next => cases next <;> simp [assetComponentStep, h]

theorem asset_run_authority (g : AssetGraph) (path : List Nat) (before : ComponentState Nat Nat) :
    (runAssetComponents g before path).map ComponentState.authority =
      runAgent (assetStructure g) before.authority path := by
  induction path generalizing before with
  | nil => rfl
  | cons i rest ih =>
    have step := asset_component_step_authority g i before
    cases h : assetComponentStep g i before with
    | none =>
      simp only [h, Option.map_none] at step
      simp [runAssetComponents, runAgent, h, ← step]
    | some next =>
      simp only [h, Option.map_some] at step
      simp [runAssetComponents, runAgent, h, ← step, ih]

theorem asset_evaluate_authority (g : AssetGraph) (fuel i : Nat) :
    (evaluateAssetComponents g fuel i).map ComponentState.authority =
      evaluateAgent (assetStructure g) fuel i := by
  induction fuel generalizing i with
  | zero => rfl
  | succ fuel ih =>
    by_cases bound : i < g.size
    · by_cases root : i = g.root
      · simp [evaluateAssetComponents, evaluateAgent, assetStructure, root, assetInitial]
      · cases parent : g.parent i with
        | none => simp [evaluateAssetComponents, evaluateAgent, assetStructure, bound, root, parent]
        | some p =>
          have rhs : evaluateAgent (assetStructure g) (fuel + 1) i =
              (evaluateAgent (assetStructure g) fuel p).bind (advanceAgent (assetStructure g) i) := by
            simp [evaluateAgent, assetStructure, bound, root, parent]
          rw [rhs, ← ih p]
          cases h : evaluateAssetComponents g fuel p with
          | none => simp [evaluateAssetComponents, bound, root, parent, h]
          | some state =>
            simpa only [evaluateAssetComponents, bound, root, ↓reduceIte, parent,
              Option.bind_some, h, Option.map_some] using asset_component_step_authority g i state
    · simp [evaluateAssetComponents, evaluateAgent, assetStructure, bound]

theorem asset_components_authority (g : AssetGraph) (i : Nat) :
    (assetComponentsAt g i).map ComponentState.authority = agentStateAt (assetStructure g) i :=
  asset_evaluate_authority g (g.depth i + 1) i

/-- Structural ancestry recovers whole component values independently of which
receipt is selected. Fuel is sufficient by signed-predecessor depth. -/
theorem asset_evaluate_agrees (g : AssetGraph) (ordered : AncestryOrdered (assetStructure g))
    (fuel other i : Nat) (enough : g.depth i < fuel) (otherEnough : g.depth i < other) :
    evaluateAssetComponents g fuel i = evaluateAssetComponents g other i := by
  induction fuel generalizing other i with
  | zero => exfalso; omega
  | succ fuel ih =>
    cases other with
    | zero => exfalso; omega
    | succ other =>
      by_cases bound : i < g.size
      · by_cases root : i = g.root
        · simp [evaluateAssetComponents, root]
        · cases parent : g.parent i with
          | none => simp [evaluateAssetComponents, bound, root, parent]
          | some p =>
            have lower : g.depth p < g.depth i := ordered i p parent
            have same := ih other p (by exact Nat.lt_of_lt_of_le lower (by omega))
              (by exact Nat.lt_of_lt_of_le lower (by omega))
            simp [evaluateAssetComponents, bound, root, parent, same]
      · simp [evaluateAssetComponents, bound]

theorem asset_components_root (g : AssetGraph) (bound : g.root < g.size) :
    assetComponentsAt g g.root = some (assetInitial g) := by
  simp [assetComponentsAt, evaluateAssetComponents, bound]

theorem asset_components_step (g : AssetGraph) (ordered : AncestryOrdered (assetStructure g))
    (i p : Nat) (bound : i < g.size) (nonroot : i ≠ g.root) (parent : g.parent i = some p) :
    assetComponentsAt g i = (assetComponentsAt g p).bind (assetComponentStep g i) := by
  have lower : g.depth p < g.depth i := ordered i p parent
  have same := asset_evaluate_agrees g ordered (g.depth i) (g.depth p + 1) p lower (by omega)
  simp [assetComponentsAt, evaluateAssetComponents, bound, nonroot, parent, same]

end Archon
