import AssetReplay

set_option warningAsError true
namespace Archon

/-- The bridge sorts registry-local chain classes by complete ordinal then
canonical operation CID. Equal registry/ordinal/CID classes share one rank.
No ordering of positions on different chains is assumed. -/
def AssetCidRanks (g : AssetGraph) (r : AssetReceipts) (position : Nat → List Nat) : Prop :=
  ∀ x y, eligible (assetAnchors g r) (r.owner x) x = true →
    eligible (assetAnchors g r) (r.owner y) y = true → r.registry x = r.registry y →
    (x < y ↔ compare (position x) (position y) = .lt ∨
      (compare (position x) (position y) = .eq ∧ r.owner x < r.owner y))

/-- A migration is confirmed on the predecessor registry, not its proposed one. -/
theorem asset_expected_predecessor (g : AssetGraph) (operation parent : Nat)
    (nonroot : operation ≠ g.root) (previous : g.parent operation = some parent) :
    assetExpected g operation = (assetComponentsAt g parent).map (fun state => g.registry state.registration) := by
  simp [assetExpected, nonroot, previous]

theorem asset_siblings_expected (g : AssetGraph) (genesis : g.parent g.root = none)
    (left right parent : Nat) (lp : g.parent left = some parent) (rp : g.parent right = some parent) :
    assetExpected g left = assetExpected g right := by
  have ln : left ≠ g.root := by intro same; subst left; simp [genesis] at lp
  have rn : right ≠ g.root := by intro same; subst right; simp [genesis] at rp
  rw [asset_expected_predecessor g left parent ln lp, asset_expected_predecessor g right parent rn rp]

/-- Only matching predecessor-registry anchors have chain priority. -/
theorem asset_matching_anchor (g : AssetGraph) (r : AssetReceipts) (operation receipt : Nat)
    (ok : eligible (assetAnchors g r) operation receipt = true) :
    r.owner receipt = operation ∧ r.chain (r.registry receipt) = true ∧
      assetExpected g operation = some (r.registry receipt) := by
  have owner : r.owner receipt = operation := Option.some.inj (eligible_parent _ _ _ ok)
  simp only [eligible, assetAnchors, Bool.and_eq_true] at ok
  refine ⟨owner, ok.1.2.1.2, ?_⟩
  simpa only [owner] using (beq_iff_eq.mp ok.1.2.2)

/-- Tied ordinals retain the canonical-CID tie-breaker, including asset forks.
The ordering contract is required here and checked by the signed bridge. -/
theorem asset_sibling_priority (g : AssetGraph) (r : AssetReceipts) (position : Nat → List Nat)
    (ranks : AssetCidRanks g r position) (genesis : g.parent g.root = none)
    (x y parent : Nat) (xp : g.parent (r.owner x) = some parent) (yp : g.parent (r.owner y) = some parent)
    (xa : eligible (assetAnchors g r) (r.owner x) x = true)
    (ya : eligible (assetAnchors g r) (r.owner y) y = true) :
    x < y ↔ compare (position x) (position y) = .lt ∨
      (compare (position x) (position y) = .eq ∧ r.owner x < r.owner y) := by
  have xreg := (asset_matching_anchor g r _ x xa).2.2
  have yreg := (asset_matching_anchor g r _ y ya).2.2
  have same := asset_siblings_expected g genesis _ _ parent xp yp
  rw [xreg, yreg] at same
  exact ranks x y xa ya (Option.some.inj same)

end Archon
