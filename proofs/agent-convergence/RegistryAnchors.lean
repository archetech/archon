import RegistryAncestry
import ChainAnchors

set_option warningAsError true
namespace Archon

/-- Receipt ranks preserve ordinal order within each chain. Their order across
chains is irrelevant to per-operation selection. `accepted` abstracts signature
and chain-position validation; `chain` excludes local, hyperswarm, and pin. -/
structure RegistryReceipts where
  size : Nat
  owner : Nat → Nat
  registry : Nat → Nat
  chain : Nat → Bool
  accepted : Nat → Bool

def registryAnchors (g : RegistryGraph) (r : RegistryReceipts) : AnchorModel where
  size := r.size
  parent := fun i => some (r.owner i)
  authorized := fun i => decide (r.owner i < g.size) && r.accepted i
    && r.chain (r.registry i) && receiptRegistryMatches g (r.owner i) (r.registry i)
  level := fun _ => 0

/-- All competing successors use the same registry, even when they propose
migration to different destination registries. -/
theorem siblings_expected_registry (g : RegistryGraph)
    (genesis : g.parent g.root = none) (a b p : Nat)
    (ap : g.parent a = some p) (bp : g.parent b = some p) :
    expectedRegistry g a = expectedRegistry g b := by
  have ar : a ≠ g.root := by intro h; subst a; simp [genesis] at ap
  have br : b ≠ g.root := by intro h; subst b; simp [genesis] at bp
  simp only [expectedRegistry, ar, br, ↓reduceIte, ap, bp]

/-- Every eligible receipt actually names the derived expected registry. -/
theorem registry_anchor_matches (g : RegistryGraph) (r : RegistryReceipts)
    (op receipt : Nat) (valid : eligible (registryAnchors g r) op receipt = true) :
    expectedRegistry g op = some (r.registry receipt) := by
  simp only [eligible, registryAnchors, Bool.and_eq_true,
    Option.some_beq_some, Nat.beq_eq_true_eq] at valid
  have matched := valid.1.2.2
  rw [valid.2] at matched
  simpa [receiptRegistryMatches] using matched

/-- Eligible anchors of competing siblings belong to one chain. Their numeric
rank comparison therefore needs an ordinal embedding only within that chain. -/
theorem sibling_anchors_same_registry (g : RegistryGraph) (r : RegistryReceipts)
    (genesis : g.parent g.root = none) (a b p x y : Nat)
    (ap : g.parent a = some p) (bp : g.parent b = some p)
    (ax : eligible (registryAnchors g r) a x = true)
    (bv : eligible (registryAnchors g r) b y = true) :
    r.registry x = r.registry y := by
  have same := siblings_expected_registry g genesis a b p ap bp
  rw [registry_anchor_matches g r a x ax, registry_anchor_matches g r b y bv] at same
  exact Option.some.inj same

/-- An ancestry-derived anchor filter agrees with the filter at any valid
prefix ending at the operation's signed predecessor. -/
theorem registry_anchor_after_prefix (g : RegistryGraph) (r : RegistryReceipts)
    (ordered : RegistryOrdered g) (genesis : g.parent g.root = none)
    (rootBound : g.root < g.size) (evidence path : List Nat)
    (valid : ValidPath (registryModel g) evidence g.root path)
    (op receipt : Nat) (bounded : op < g.size)
    (parent : g.parent op = some (pathTip g.root path)) :
    eligible (registryAnchors g r) op receipt = true ↔
      receipt < r.size ∧ r.accepted receipt = true ∧
      r.chain (r.registry receipt) = true ∧ r.owner receipt = op ∧
      r.registry receipt = registryFold g g.initial path := by
  have expected := receipt_registry_after_prefix g ordered genesis rootBound
    evidence path valid op (r.registry receipt) bounded parent
  simp only [eligible, registryAnchors, Bool.and_eq_true, decide_eq_true_eq,
    Option.some_beq_some, Nat.beq_eq_true_eq]
  constructor
  · rintro ⟨⟨rb, ⟨⟨⟨_, accepted⟩, chain⟩, matched⟩⟩, owner⟩
    rw [owner] at matched
    exact ⟨of_decide_eq_true rb, accepted, chain, owner, expected.mp matched⟩
  · rintro ⟨rb, accepted, chain, owner, registry⟩
    rw [owner]
    exact ⟨⟨by exact decide_eq_true rb, ⟨⟨⟨bounded, accepted⟩, chain⟩, expected.mpr registry⟩⟩, rfl⟩

/-- Cold selection is independent of receipt arrival order and multiplicity,
with the expected registry derived from immutable predecessor ancestry. -/
theorem registry_anchors_same_evidence (g : RegistryGraph) (r : RegistryReceipts)
    (op : Nat) (xs ys : List Nat) (same : ∀ i, i ∈ xs ↔ i ∈ ys) :
    anchorScan (registryAnchors g r) op xs r.size =
      anchorScan (registryAnchors g r) op ys r.size := by
  change anchorScan (registryAnchors g r) op xs (registryAnchors g r).size =
    anchorScan (registryAnchors g r) op ys (registryAnchors g r).size
  rw [anchor_scan_cold, anchor_scan_cold]
  exact winner_same_evidence _ _ _ _ same

/-- A valid retained receipt cannot bias the reconstruction. -/
theorem registry_anchor_warm_agrees (g : RegistryGraph) (r : RegistryReceipts)
    (op : Nat) (xs : List Nat) (current : Nat)
    (member : current ∈ xs) (valid : eligible (registryAnchors g r) op current = true) :
    anchorScan (registryAnchors g r) op xs current =
      anchorScan (registryAnchors g r) op xs r.size := by
  exact (anchor_scan_from_retained _ _ _ _ member valid).trans
    (anchor_scan_cold (registryAnchors g r) op xs).symm

end Archon
