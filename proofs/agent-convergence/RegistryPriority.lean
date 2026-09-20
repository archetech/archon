import RegistryAnchors
import ChainSuccessors

set_option warningAsError true
namespace Archon

/-- Only eligible receipts from the same registry need a shared ordinal order.
No relationship between positions on different chains is required. -/
def RegistryOrdinalRanks (g : RegistryGraph) (r : RegistryReceipts)
    (position : Nat → List Nat) : Prop :=
  ∀ x y, eligible (registryAnchors g r) (r.owner x) x = true →
    eligible (registryAnchors g r) (r.owner y) y = true →
    r.registry x = r.registry y →
    (x < y ↔ compare (position x) (position y) = .lt)

/-- The compiled sibling preference is precisely chain ordinal preference for
anchored siblings. The predecessor rule establishes that both positions are on
one chain; the rank representation is an explicit, required contract. -/
theorem registry_sibling_priority (g : RegistryGraph) (r : RegistryReceipts)
    (position : Nat → List Nat) (ranks : RegistryOrdinalRanks g r position)
    (genesis : g.parent g.root = none) (xs : List Nat) (a b p : Nat)
    (ap : g.parent a = some p) (bp : g.parent b = some p)
    (aa : winner (registryAnchors g r) a xs < r.size)
    (ab : winner (registryAnchors g r) b xs < r.size) :
    chainPriority (registryAnchors g r) xs a < chainPriority (registryAnchors g r) xs b ↔
      compare (position (winner (registryAnchors g r) a xs))
        (position (winner (registryAnchors g r) b xs)) = .lt := by
  obtain ⟨_, ax⟩ := winner_member (registryAnchors g r) a xs aa
  obtain ⟨_, bv⟩ := winner_member (registryAnchors g r) b xs ab
  have ao : r.owner (winner (registryAnchors g r) a xs) = a :=
    Option.some.inj (eligible_parent _ _ _ ax)
  have bo : r.owner (winner (registryAnchors g r) b xs) = b :=
    Option.some.inj (eligible_parent _ _ _ bv)
  have same := sibling_anchors_same_registry g r genesis a b p _ _ ap bp ax bv
  rw [chain_anchored_order _ xs a b aa ab]
  exact ranks _ _ (by simpa only [ao] using ax) (by simpa only [bo] using bv) same

/-- Rank contract for known-position receipt classes under ordinal/CID ordering.
Operation owners are injective ASCII canonical-CID ranks. Repeated receipts with
identical registry, ordinal, and owner are one ordering class; full payloads are
kept separately. Unlike `RegistryOrdinalRanks`, distinct owners may tie positions. -/
def RegistryCidRanks (g : RegistryGraph) (r : RegistryReceipts)
    (position : Nat → List Nat) : Prop :=
  ∀ x y, eligible (registryAnchors g r) (r.owner x) x = true →
    eligible (registryAnchors g r) (r.owner y) y = true →
    r.registry x = r.registry y →
    (x < y ↔ compare (position x) (position y) = .lt ∨
      (compare (position x) (position y) = .eq ∧ r.owner x < r.owner y))

/-- Known-position siblings compare registry-local ordinal then canonical CID.
Identical operation/position classes may share a rank. Unanchored receipts use
provisional operation ranks; chain receipts without positions are rejected before
entering this source domain. -/
theorem registry_sibling_cid_priority (g : RegistryGraph) (r : RegistryReceipts)
    (position : Nat → List Nat) (ranks : RegistryCidRanks g r position)
    (genesis : g.parent g.root = none) (xs : List Nat) (a b p : Nat)
    (ap : g.parent a = some p) (bp : g.parent b = some p)
    (aa : winner (registryAnchors g r) a xs < r.size)
    (ab : winner (registryAnchors g r) b xs < r.size) :
    chainPriority (registryAnchors g r) xs a < chainPriority (registryAnchors g r) xs b ↔
      compare (position (winner (registryAnchors g r) a xs))
        (position (winner (registryAnchors g r) b xs)) = .lt ∨
      (compare (position (winner (registryAnchors g r) a xs))
        (position (winner (registryAnchors g r) b xs)) = .eq ∧ a < b) := by
  obtain ⟨_, ax⟩ := winner_member (registryAnchors g r) a xs aa
  obtain ⟨_, bv⟩ := winner_member (registryAnchors g r) b xs ab
  have ao : r.owner (winner (registryAnchors g r) a xs) = a :=
    Option.some.inj (eligible_parent _ _ _ ax)
  have bo : r.owner (winner (registryAnchors g r) b xs) = b :=
    Option.some.inj (eligible_parent _ _ _ bv)
  have same := sibling_anchors_same_registry g r genesis a b p _ _ ap bp ax bv
  rw [chain_anchored_order _ xs a b aa ab]
  simpa only [ao, bo] using ranks _ _ (by simpa only [ao] using ax) (by simpa only [bo] using bv) same

/-- The settled-priority replay model now derives anchor eligibility from
registry ancestry. The operation graph contains already authorized create/update
operations; this is not the raw interleaved runtime or a signature verifier. -/
def registryReplay (g : RegistryGraph) (r : RegistryReceipts)
    (receipts operations : List Nat) : Option (List Nat) :=
  chainReplay (registryModel g) (registryAnchors g r) receipts g.root operations

/-- Compiling receipt priorities preserves an acyclic operation graph. -/
theorem chain_graph_acyclic (operations : Model) (anchors : AnchorModel) (xs : List Nat)
    (acyclic : WellFoundedEdges operations) :
    WellFoundedEdges (chainGraph operations anchors xs) := by
  intro p i valid
  have parent := eligible_parent _ _ _ valid
  have auth : (chainGraph operations anchors xs).authorized i = true := by
    simp only [eligible, Bool.and_eq_true] at valid
    exact valid.1.2
  simp only [chainGraph, Bool.and_eq_true, decide_eq_true_eq] at auth
  change (operations.parent (chainOwner anchors i)).map (chainPriority anchors xs) = some p at parent
  cases edge : operations.parent (chainOwner anchors i) with
  | none => simp [edge] at parent
  | some before =>
    simp only [edge, Option.map_some, Option.some.injEq] at parent
    subst p
    have eligibleOp : eligible operations before (chainOwner anchors i) = true := by
      simp only [eligible, edge, Option.some_beq_some, Bool.and_eq_true, Nat.beq_eq_true_eq]
      exact ⟨⟨decide_eq_true auth.1.1, auth.1.2⟩, True.intro⟩
    have lower := acyclic before (chainOwner anchors i) eligibleOp
    simpa only [chainGraph, chain_priority_owner] using lower

/-- Bounded increasing ancestry depth supplies the replay termination measure. -/
theorem registry_model_acyclic (g : RegistryGraph) (ordered : RegistryOrdered g)
    (depthBound : ∀ i, i < g.size → g.depth i < g.size) :
    WellFoundedEdges (registryModel g) := by
  intro p i valid
  have bound := eligible_lt _ _ _ valid
  have parent := eligible_parent _ _ _ valid
  have lower := ordered i p parent
  have within := depthBound i bound
  change g.size - g.depth i < g.size - g.depth p
  omega

/-- Equal retained receipt and authorized operation sets converge in the
compiled phase, even when registry changes alter which anchors are eligible. -/
theorem registry_replay_same_evidence (g : RegistryGraph) (r : RegistryReceipts)
    (xs ys left right : List Nat)
    (sameReceipts : ∀ i, i ∈ xs ↔ i ∈ ys)
    (sameOperations : ∀ i, i ∈ left ↔ i ∈ right)
    (ordered : RegistryOrdered g)
    (depthBound : ∀ i, i < g.size → g.depth i < g.size)
    (genesis : g.parent g.root = none)
    (present : g.root ∈ left) : registryReplay g r xs left = registryReplay g r ys right := by
  have acyclic := chain_graph_acyclic (registryModel g) (registryAnchors g r) xs
    (registry_model_acyclic g ordered depthBound)
  apply chain_successors_same_evidence _ _ xs ys left right g.root
    sameReceipts sameOperations acyclic _ present
  simp only [chainGraph, chain_priority_owner, registryModel, genesis, Option.map_none]

end Archon
