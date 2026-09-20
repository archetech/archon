import RegistryPriority
import PriorityProjection

set_option warningAsError true
namespace Archon

/-- Events for a fixed, already authorized registry graph. Matching anchors have
individual ranks; provisional receipts of one operation can share its CID rank.
This model projects ordering and does not identify their full receipt metadata. -/
def registryEvents (g : RegistryGraph) (anchors : AnchorModel) : Model where
  size := anchors.size + g.size
  parent := fun i => g.parent (chainOwner anchors i)
  authorized := fun i => decide (chainOwner anchors i < g.size)
  level := (registryModel g).level

theorem registry_event_eligible (g : RegistryGraph) (anchors : AnchorModel) (p i : Nat)
    (ok : eligible (registryEvents g anchors) p i = true) :
    eligible (registryModel g) p (chainOwner anchors i) = true := by
  simp only [eligible, registryEvents, registryModel, Bool.and_eq_true, decide_eq_true_eq] at ok ⊢
  exact ⟨⟨decide_eq_true ok.1.2, True.intro⟩, ok.2⟩

theorem registry_events_descending (g : RegistryGraph) (anchors : AnchorModel)
    (ordered : RegistryOrdered g) (bounded : ∀ i, i < g.size → g.depth i < g.size) :
    InterleavedDescending (registryEvents g anchors) (chainOwner anchors) := by
  intro p i ok
  exact registry_model_acyclic g ordered bounded p (chainOwner anchors i)
    (registry_event_eligible g anchors p i ok)

/-- Under the local representative contract, the interleaved ordering loop and
compiled registry replay have equal decoded histories. The admitted genesis is
seeded separately, and retained warm suffixes must be valid. Full receipt equality
and runtime refinement are separate obligations. -/
theorem interleaved_registry_cold (g : RegistryGraph) (r : RegistryReceipts)
    (ordered : RegistryOrdered g) (bounded : ∀ i, i < g.size → g.depth i < g.size)
    (genesis : g.parent g.root = none) (rootBound : g.root < g.size)
    (receipts operations events path : List Nat)
    (projection : PriorityProjection (registryEvents g (registryAnchors g r))
      (chainGraph (registryModel g) (registryAnchors g r) receipts)
      (chainOwner (registryAnchors g r)) (chainPriority (registryAnchors g r) receipts)
      events (operations.map (chainPriority (registryAnchors g r) receipts)) g.size)
    (valid : InterleavedValid (registryEvents g (registryAnchors g r))
      (chainOwner (registryAnchors g r)) events g.root path)
    (present : g.root ∈ operations) :
    (interleavedUntilStable (registryEvents g (registryAnchors g r))
      (chainOwner (registryAnchors g r)) g.root events
      ((registryEvents g (registryAnchors g r)).level g.root + 1) path).map
      (fun result => g.root :: result.map (chainOwner (registryAnchors g r))) =
      registryReplay g r receipts operations := by
  have replay := interleaved_computes_priority_suffix _ _ _ _ _ _ _ g.root path
    projection rootBound (registry_events_descending g _ ordered bounded) valid
  have acyclic := chain_graph_acyclic (registryModel g) (registryAnchors g r) receipts
    (registry_model_acyclic g ordered bounded)
  have create : (chainGraph (registryModel g) (registryAnchors g r) receipts).parent
      (chainPriority (registryAnchors g r) receipts g.root) = none := by
    simp only [chainGraph, chain_priority_owner, registryModel, genesis, Option.map_none]
  rw [replay]
  unfold registryReplay chainReplay
  rw [cold_replay_converges _ _ _ acyclic create (List.mem_map.mpr ⟨g.root, present, rfl⟩)]
  simp only [Option.map_some, history, List.map_cons, chainGraph, chain_priority_owner,
    registryEvents]

end Archon
