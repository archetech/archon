import IntegratedAssetConvergence

set_option warningAsError true
namespace Archon

/-- Keep the confirmed receipt view in the final protocol result, including for
assets. The clock/anchor projection has the same source contract as A3. -/
def assetReceiptResult (g : AssetGraph) (r : AssetReceipts)
    (operationTime : Nat → Int) (chainFacts : Nat → ChainReceiptView)
    (records : List (EventRecord α)) :=
  (assetResult g (assetAnchors g r) records,
    confirmedReceiptView (records.map (agentReceiptView (assetAnchors g r)
      (assetExpected g) operationTime chainFacts)))

theorem asset_sources_same_receipt_result [DecidableEq α] (g : AssetGraph) (r : AssetReceipts)
    (table : ControllerTable) (left right : ControllerHistories)
    (controllers : ∀ owner, left owner = right owner) (unanchored : Nat → Bool)
    (localRegistry : Nat) (operationTime : Nat → Int) (chainFacts : Nat → ChainReceiptView)
    (ordered : AncestryOrdered (assetStructure g)) (bounded : DepthBounded (assetStructure g))
    (xs ys : List (AgentSourceReceipt α)) (same : SameAgentSources xs ys) :
    let a := assetAnchors g r
    let m := coldAssetModel g a
    let lrecords := assetSourceRecords g r table left unanchored localRegistry chainFacts xs
    let rrecords := assetSourceRecords g r table right unanchored localRegistry chainFacts ys
    (stopWhenStable (rankedPass m (chainOwner a) g.size lrecords) (m.size + 3) []).map
      (assetReceiptResult g r operationTime chainFacts) =
    (stopWhenStable (rankedPass m (chainOwner a) g.size rrecords) (m.size + 3) []).map
      (assetReceiptResult g r operationTime chainFacts) := by
  have derived := asset_authorization_from_histories g table left right controllers unanchored localRegistry chainFacts
  have shared := normalize_sources_membership (assetAnchors g r) (assetExpected g) _ _
    (same_sources_filter xs ys same (assetReceiptAuthorized g table right unanchored localRegistry chainFacts))
  have views := cold_ranked_same_view (coldAssetModel g (assetAnchors g r))
    (chainOwner (assetAnchors g r)) g.size
    (assetSourceRecords g r table left unanchored localRegistry chainFacts xs)
    (assetSourceRecords g r table right unanchored localRegistry chainFacts ys)
    (agentReceiptView (assetAnchors g r) (assetExpected g) operationTime chainFacts)
    (cold_asset_descending g _ ordered bounded)
    (by simpa only [assetSourceRecords, derived] using shared.1)
    (by simpa only [assetSourceRecords, derived] using shared.2)
    (fun x _ y _ rank flag => agent_receipt_view_class _ _ _ _ x y rank flag)
  obtain ⟨lresult, rresult, ls, rs, _, _, result⟩ := asset_reconciliation_converges
    g r table left right controllers unanchored localRegistry chainFacts ordered bounded xs ys same
  have projected := congrArg (Option.map confirmedReceiptView) views
  simp only [Option.map_map, Function.comp_def] at projected
  have fuel : (coldAssetModel g (assetAnchors g r)).level g.size + 2 =
      (coldAssetModel g (assetAnchors g r)).size + 3 := by
    simp only [coldAssetModel, withGenesis, ↓reduceIte, Nat.add_assoc]
  rw [fuel] at projected
  rw [ls, rs] at projected
  have equalViews := Option.some.inj projected
  dsimp only
  rw [ls, rs]
  simp only [Option.map_some, assetReceiptResult, result, equalViews]

end Archon
