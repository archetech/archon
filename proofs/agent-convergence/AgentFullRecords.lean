import AgentEventProjection
import InterleavedRecords

set_option warningAsError true
namespace Archon

/-- Full-record termination composes with derived signature/registry/anchor
eligibility and complete component execution. `representation` concerns retained
rank membership only, allowing arbitrary order, duplicates, and receipt payloads.
It does not assert agreement of selected histories or authorization outcomes. -/
theorem component_full_replay [DecidableEq α] (g : DocumentGraph)
    (documents : Nat → Doc) (methods : Doc → List VerificationMethod)
    (agrees : ∀ i, methods (documents i) = g.documents i)
    (patch : Nat → ComponentPatch D R) (registry : R → Nat)
    (initial : R) (empty initialData : D) (r : RegistryReceipts)
    (ordered : AncestryOrdered (documentAgent g)) (bounded : DepthBounded (documentAgent g))
    (genesis : g.parent g.root = none) (rootBound : g.root < g.size)
    (receipts operations : List Nat) (records path : List (EventRecord α))
    (covered : ∀ i ∈ receipts,
      eligible (componentAnchors g patch registry initial r)
        (chainOwner (componentAnchors g patch registry initial r) i) i = true →
      chainOwner (componentAnchors g patch registry initial r) i ∈ operations)
    (present : g.root ∈ operations)
    (representation : ∀ i, i ∈ recordIds records ↔
      i ∈ componentEventEvidence (componentAnchors g patch registry initial r) receipts operations)
    (valid : InterleavedValid (componentEvents g (componentAnchors g patch registry initial r))
      (chainOwner (componentAnchors g patch registry initial r)) (recordIds records) g.root (recordIds path)) :
    let a := componentAnchors g patch registry initial r
    let m := componentEvents g a
    ∃ result final,
      stopWhenStable (rankedPass m (chainOwner a) g.root records) (m.level g.root + 2) path = some result ∧
      rankedPass m (chainOwner a) g.root records result = result ∧
      chainReplay (agentModel (documentAgent g)) a receipts g.root operations =
        some (g.root :: (recordIds result).map (chainOwner a)) ∧
      runComponents (decodedComponentGraph g documents methods) patch empty
        ⟨.active g.initialDocument, initialData, initial⟩ ((recordIds result).map (chainOwner a)) = some final := by
  let a := componentAnchors g patch registry initial r
  let m := componentEvents g a
  have descending : InterleavedDescending m (chainOwner a) :=
    document_events_descending g _ _ _ ordered bounded
  obtain ⟨result, stopped, ranked, fixed⟩ :=
    ranked_full_converges m (chainOwner a) g.root records path descending valid
  obtain ⟨cold, final, coldStopped, compiled, ran⟩ := component_interleaved_replay g documents methods agrees
    patch registry initial empty initialData r ordered bounded genesis rootBound receipts operations []
    covered present (.nil _)
  have canonical := interleaved_replay_converges m (chainOwner a)
    (componentEventEvidence a receipts operations) g.root [] descending (.nil _)
  have sameRanks : recordIds result = cold := by
    rw [ranked, interleaved_suffix_same_evidence m (chainOwner a) (recordIds records)
      (componentEventEvidence a receipts operations) representation]
    rw [coldStopped] at canonical
    exact (Option.some.inj canonical).symm
  refine ⟨result, final, stopped, fixed, ?_, ?_⟩
  · rw [sameRanks]; exact compiled
  · rw [sameRanks]; exact ran

/-- Complete resolved component state agrees after structural stopping for two
finite enumerations of the same normalized evidence. Payload equality is not a
premise; authorization-relevant receipt fields need their own projection proof. -/
theorem component_full_same_state [DecidableEq α] (g : DocumentGraph)
    (patch : Nat → ComponentPatch D R) (registry : R → Nat)
    (initial : R) (empty initialData : D) (r : RegistryReceipts)
    (ordered : AncestryOrdered (documentAgent g)) (bounded : DepthBounded (documentAgent g))
    (xs ys left right : List (EventRecord α))
    (lv : InterleavedValid (componentEvents g (componentAnchors g patch registry initial r))
      (chainOwner (componentAnchors g patch registry initial r)) (recordIds xs) g.root (recordIds left))
    (rv : InterleavedValid (componentEvents g (componentAnchors g patch registry initial r))
      (chainOwner (componentAnchors g patch registry initial r)) (recordIds ys) g.root (recordIds right))
    (same : ∀ i, i ∈ recordIds xs ↔ i ∈ recordIds ys) :
    let a := componentAnchors g patch registry initial r
    let m := componentEvents g a
    let view := fun records : List (EventRecord α) =>
      ((recordIds records).map (chainOwner a), runComponents g patch empty
        ⟨.active g.initialDocument, initialData, initial⟩ ((recordIds records).map (chainOwner a)))
    (stopWhenStable (rankedPass m (chainOwner a) g.root xs) (m.level g.root + 2) left).map view =
      (stopWhenStable (rankedPass m (chainOwner a) g.root ys) (m.level g.root + 2) right).map view := by
  exact ranked_full_same_semantics _ _ _ xs ys left right
    (fun ids => (ids.map (chainOwner (componentAnchors g patch registry initial r)),
      runComponents g patch empty ⟨.active g.initialDocument, initialData, initial⟩
        (ids.map (chainOwner (componentAnchors g patch registry initial r)))))
    (document_events_descending g _ _ _ ordered bounded) lv rv same

end Archon
