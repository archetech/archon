import AssetComponents

set_option warningAsError true
namespace Archon

/-- Positioned chain classes only; signature verdicts are derived per source. -/
structure AssetReceipts where
  size : Nat
  owner : Nat → Nat
  registry : Nat → Nat
  chain : Nat → Bool

def assetExpected (g : AssetGraph) (i : Nat) : Option Nat :=
  if i = g.root then some (g.registry g.initialRegistry) else
    ((g.parent i).bind (assetComponentsAt g)).map (fun state => g.registry state.registration)

/-- Normalization cannot change the operation or its source payload. -/
theorem normalized_source_identity (a : AnchorModel) (expected : Nat → Option Nat)
    (source : AgentSourceReceipt α) (record : EventRecord (AgentSourceReceipt α))
    (member : record ∈ normalizeAgentSource a expected source) :
    chainOwner a record.opid = source.key.operation ∧ record.payload = source := by
  have provisional : chainOwner a (a.size + source.key.operation) = source.key.operation := by
    simp [chainOwner, show ¬a.size + source.key.operation < a.size by omega]
  cases anchor : source.key.anchor with
  | none =>
    simp only [normalizeAgentSource, anchor, List.mem_singleton] at member
    subst record; exact ⟨provisional, rfl⟩
  | some rank =>
    by_cases valid : (eligible a source.key.operation rank &&
        (expected source.key.operation == some source.key.registry)) = true
    · have both := valid
      simp only [Bool.and_eq_true] at both
      have ok := both.1
      have bound := eligible_lt _ _ _ ok
      have parent := eligible_parent _ _ _ ok
      simp [normalizeAgentSource, anchor, valid] at member
      rcases member with rfl | rfl
      · simp [chainOwner, bound, parent]
      · exact ⟨provisional, rfl⟩
    · simp [normalizeAgentSource, anchor, valid] at member
      subst record; exact ⟨provisional, rfl⟩

/-- Registry ownership is structural and independent of the controller clock.
Contextual authorization is performed on each retained source before normalization. -/
def assetAnchors (g : AssetGraph) (r : AssetReceipts) : AnchorModel where
  size := r.size
  parent := fun i => some (r.owner i)
  authorized := fun i => r.owner i < g.size && r.chain (r.registry i) && assetExpected g (r.owner i) == some (r.registry i)
  level := fun _ => 1

def assetEventModel (g : AssetGraph) (a : AnchorModel) : Model where
  size := a.size + g.size
  parent := fun i => g.parent (chainOwner a i)
  authorized := fun i => chainOwner a i < g.size && (agentModel (assetStructure g)).authorized (chainOwner a i)
    && (i ≥ a.size || a.authorized i)
  level := fun p => g.size - g.depth p

def coldAssetModel (g : AssetGraph) (a : AnchorModel) : Model :=
  withGenesis (assetEventModel g a) (chainOwner a) g.root g.size

def assetSourceRecords (g : AssetGraph) (r : AssetReceipts) (table : ControllerTable)
    (histories : ControllerHistories) (unanchored : Nat → Bool) (localRegistry : Nat)
    (chainFacts : Nat → ChainReceiptView) (sources : List (AgentSourceReceipt α)) :=
  normalizeAgentSources (assetAnchors g r) (assetExpected g)
    (sources.filter fun source => assetReceiptAuthorized g table histories unanchored localRegistry chainFacts source.key)

/-- Filtering is pointwise on immutable source identity, not arrival order or
previous acceptance. All rejected/deferred evidence stays in the input journal. -/
theorem same_sources_filter (xs ys : List (AgentSourceReceipt α))
    (same : SameAgentSources xs ys) (accept : AgentReceiptKey → Bool) :
    SameAgentSources (xs.filter (fun s => accept s.key)) (ys.filter (fun s => accept s.key)) := by
  intro key
  have one (left right : List (AgentSourceReceipt α)) (shared : SameAgentSources left right) :
      (∃ s ∈ left.filter (fun s => accept s.key), s.key = key) →
      (∃ s ∈ right.filter (fun s => accept s.key), s.key = key) := by
    rintro ⟨source, member, equal⟩
    obtain ⟨present, accepted⟩ := List.mem_filter.mp member
    obtain ⟨other, there, sameKey⟩ := (shared key).mp ⟨source, present, equal⟩
    exact ⟨other, List.mem_filter.mpr ⟨there, by simpa only [sameKey, equal] using accepted⟩, sameKey⟩
  exact ⟨one xs ys same, one ys xs (fun key => (same key).symm)⟩

theorem asset_source_membership (g : AssetGraph) (r : AssetReceipts) (table : ControllerTable)
    (left right : ControllerHistories) (controllers : ∀ owner, left owner = right owner)
    (unanchored : Nat → Bool) (localRegistry : Nat) (chainFacts : Nat → ChainReceiptView)
    (xs ys : List (AgentSourceReceipt α)) (same : SameAgentSources xs ys) :
    ∀ i, i ∈ recordIds (assetSourceRecords g r table left unanchored localRegistry chainFacts xs) ↔
      i ∈ recordIds (assetSourceRecords g r table right unanchored localRegistry chainFacts ys) := by
  have derived := asset_authorization_from_histories g table left right controllers unanchored localRegistry chainFacts
  simp only [assetSourceRecords, derived]
  exact (normalize_sources_membership _ _ _ _ (same_sources_filter xs ys same _)).1

/-- A previously rejected receipt contributes again when the selected agent
history now authorizes it. Prior verdicts are not cached into normalization. -/
theorem asset_reconsidered (g : AssetGraph) (r : AssetReceipts) (table : ControllerTable)
    (histories : ControllerHistories) (unanchored : Nat → Bool) (localRegistry : Nat)
    (chainFacts : Nat → ChainReceiptView) (sources : List (AgentSourceReceipt α))
    (source : AgentSourceReceipt α) (retained : source ∈ sources)
    (nowValid : assetReceiptAuthorized g table histories unanchored localRegistry chainFacts source.key = true) :
    (assetAnchors g r).size + source.key.operation ∈
      recordIds (assetSourceRecords g r table histories unanchored localRegistry chainFacts sources) := by
  exact normalize_sources_present _ _ _ source.key.operation
    ⟨source, List.mem_filter.mpr ⟨retained, nowValid⟩, rfl⟩

theorem asset_event_eligible (g : AssetGraph) (a : AnchorModel) (p i : Nat)
    (ok : eligible (assetEventModel g a) p i = true) :
    eligible (agentModel (assetStructure g)) p (chainOwner a i) = true := by
  simp only [eligible, assetEventModel, Bool.and_eq_true, decide_eq_true_eq] at ok ⊢
  exact ⟨⟨ok.1.2.1.1, ok.1.2.1.2⟩, ok.2⟩

theorem asset_events_descending (g : AssetGraph) (a : AnchorModel)
    (ordered : AncestryOrdered (assetStructure g)) (bounded : DepthBounded (assetStructure g)) :
    InterleavedDescending (assetEventModel g a) (chainOwner a) := by
  intro p i ok
  exact agent_model_acyclic (assetStructure g) ordered bounded p (chainOwner a i)
    (asset_event_eligible g a p i ok)

theorem asset_event_owner_bound (g : AssetGraph) (a : AnchorModel) (i : Nat)
    (auth : (assetEventModel g a).authorized i = true) : chainOwner a i < g.size := by
  simp only [assetEventModel, Bool.and_eq_true, decide_eq_true_eq] at auth
  exact auth.1.1

theorem cold_asset_descending (g : AssetGraph) (a : AnchorModel)
    (ordered : AncestryOrdered (assetStructure g)) (bounded : DepthBounded (assetStructure g)) :
    InterleavedDescending (coldAssetModel g a) (chainOwner a) := by
  apply genesis_model_descending
  · exact asset_events_descending g a ordered bounded
  · intro p; change g.size - g.depth p ≤ a.size + g.size; omega
  · intro i _ auth; exact Nat.ne_of_lt (asset_event_owner_bound g a i auth)

/-- Decode document indices through the same document table used for ownership.
Data/registration indices name shared opaque whole-component values. -/
def resolvedAssetState (g : AssetGraph) (state : ComponentState Nat Nat) :=
  (match state.authority with
    | .deleted => none
    | .active document => some (g.documents document), state.data, state.registration)

def assetResult (g : AssetGraph) (a : AnchorModel) (records : List (EventRecord α)) :=
  let ids := (recordIds records).map (chainOwner a)
  (ids, if ids.isEmpty then none else
    (runAssetComponents g (assetInitial g) (ids.drop 1)).map (resolvedAssetState g))

/-- Every selected representation traces back to an authorized retained source;
filtering does not merely force two equally empty or invalid outputs. -/
theorem asset_selected_authorized [DecidableEq α] (g : AssetGraph) (r : AssetReceipts)
    (table : ControllerTable) (histories : ControllerHistories) (unanchored : Nat → Bool)
    (localRegistry : Nat) (chainFacts : Nat → ChainReceiptView)
    (sources : List (AgentSourceReceipt α)) (result : List (EventRecord (AgentSourceReceipt α))) (fuel : Nat)
    (stopped : stopWhenStable
      (rankedPass (coldAssetModel g (assetAnchors g r)) (chainOwner (assetAnchors g r)) g.size
        (assetSourceRecords g r table histories unanchored localRegistry chainFacts sources)) fuel [] = some result)
    (record : EventRecord (AgentSourceReceipt α)) (selected : record ∈ result) :
    record.payload ∈ sources ∧
      assetReceiptAuthorized g table histories unanchored localRegistry chainFacts record.payload.key = true ∧
      chainOwner (assetAnchors g r) record.opid = record.payload.key.operation := by
  have member := cold_ranked_provenance _ _ _ _ result fuel stopped record selected
  obtain ⟨source, retained, normalized⟩ := List.mem_flatMap.mp member
  obtain ⟨present, accepted⟩ := List.mem_filter.mp retained
  have identity := normalized_source_identity _ _ source record normalized
  rw [identity.2]
  exact ⟨present, accepted, identity.1⟩

/-- After agent reconciliation, deriving per-receipt verdicts and replaying the
entire candidate journal terminates on full-record equality and yields one asset
operation/component result. It neither assumes shared verdicts nor seeds genesis
or a previously accepted asset projection. -/
theorem asset_reconciliation_converges [DecidableEq α] (g : AssetGraph) (r : AssetReceipts)
    (table : ControllerTable) (left right : ControllerHistories)
    (controllers : ∀ owner, left owner = right owner) (unanchored : Nat → Bool) (localRegistry : Nat)
    (chainFacts : Nat → ChainReceiptView)
    (ordered : AncestryOrdered (assetStructure g)) (bounded : DepthBounded (assetStructure g))
    (xs ys : List (AgentSourceReceipt α)) (same : SameAgentSources xs ys) :
    let a := assetAnchors g r
    let m := coldAssetModel g a
    let lrecords := assetSourceRecords g r table left unanchored localRegistry chainFacts xs
    let rrecords := assetSourceRecords g r table right unanchored localRegistry chainFacts ys
    ∃ lresult rresult,
      stopWhenStable (rankedPass m (chainOwner a) g.size lrecords) (m.size + 3) [] = some lresult ∧
      stopWhenStable (rankedPass m (chainOwner a) g.size rrecords) (m.size + 3) [] = some rresult ∧
      rankedPass m (chainOwner a) g.size lrecords lresult = lresult ∧
      rankedPass m (chainOwner a) g.size rrecords rresult = rresult ∧
      assetResult g a lresult = assetResult g a rresult := by
  let a := assetAnchors g r
  let m := coldAssetModel g a
  let lrecords := assetSourceRecords g r table left unanchored localRegistry chainFacts xs
  let rrecords := assetSourceRecords g r table right unanchored localRegistry chainFacts ys
  have descending := cold_asset_descending g a ordered bounded
  have shared := asset_source_membership g r table left right controllers unanchored localRegistry chainFacts xs ys same
  obtain ⟨lresult, ls, li, lf⟩ := ranked_full_converges m (chainOwner a) g.size lrecords [] descending (.nil _)
  obtain ⟨rresult, rs, ri, rf⟩ := ranked_full_converges m (chainOwner a) g.size rrecords [] descending (.nil _)
  have ids : recordIds lresult = recordIds rresult := by
    rw [li, ri, interleaved_suffix_same_evidence m (chainOwner a) _ _ shared]
  refine ⟨lresult, rresult, ?_, ?_, lf, rf, ?_⟩
  · simpa only [m, coldAssetModel, withGenesis, ↓reduceIte, Nat.add_assoc] using ls
  · simpa only [m, coldAssetModel, withGenesis, ↓reduceIte, Nat.add_assoc] using rs
  · simp only [assetResult, ids]

end Archon
