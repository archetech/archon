import AgentSourceRecords

set_option warningAsError true
namespace Archon

/-- The semantic agent result includes the fields needed by the later asset
proof. An absent genesis has no resolved component state. -/
def agentResult (g : DocumentGraph) (patch : Nat → ComponentPatch D R)
    (initial : R) (empty initialData : D) (a : AnchorModel)
    (expected : Nat → Option Nat) (operationTime : Nat → Int)
    (chainFacts : Nat → ChainReceiptView) (records : List (EventRecord α)) :=
  let ids := (recordIds records).map (chainOwner a)
  (ids, (if ids.isEmpty then none else runComponents g patch empty
    ⟨.active g.initialDocument, initialData, initial⟩ (ids.drop 1)),
    confirmedReceiptView (records.map (agentReceiptView a expected operationTime chainFacts)))

/-- Integrated agent convergence and actual full-record termination, from shared
normalized source evidence. Authorization, registry eligibility, components and
the confirmed receipt view are derived. No accepted-history or final-document
equality is assumed; node-local payloads can differ. -/
theorem integrated_agent_convergence [DecidableEq α] (g : DocumentGraph)
    (patch : Nat → ComponentPatch D R) (registry : R → Nat)
    (initial : R) (empty initialData : D) (r : RegistryReceipts)
    (operationTime : Nat → Int) (chainFacts : Nat → ChainReceiptView)
    (ordered : AncestryOrdered (documentAgent g)) (bounded : DepthBounded (documentAgent g))
    (xs ys : List (AgentSourceReceipt α)) (same : SameAgentSources xs ys) :
    let a := componentAnchors g patch registry initial r
    let expected := expectedRegistry (componentRegistry g patch registry initial)
    let m := coldComponentEvents g a
    let left := normalizeAgentSources a expected xs
    let right := normalizeAgentSources a expected ys
    ∃ lresult rresult,
      stopWhenStable (rankedPass m (chainOwner a) g.size left) (m.size + 3) [] = some lresult ∧
      stopWhenStable (rankedPass m (chainOwner a) g.size right) (m.size + 3) [] = some rresult ∧
      rankedPass m (chainOwner a) g.size left lresult = lresult ∧
      rankedPass m (chainOwner a) g.size right rresult = rresult ∧
      agentResult g patch initial empty initialData a expected operationTime chainFacts lresult =
        agentResult g patch initial empty initialData a expected operationTime chainFacts rresult := by
  let a := componentAnchors g patch registry initial r
  let expected := expectedRegistry (componentRegistry g patch registry initial)
  let m := coldComponentEvents g a
  let left := normalizeAgentSources a expected xs
  let right := normalizeAgentSources a expected ys
  have shared := normalize_sources_membership a expected xs ys same
  have descending := cold_component_descending g a ordered bounded
  obtain ⟨lresult, ls, li, lf⟩ := ranked_full_converges m (chainOwner a) g.size left [] descending (.nil _)
  obtain ⟨rresult, rs, ri, rf⟩ := ranked_full_converges m (chainOwner a) g.size right [] descending (.nil _)
  have ids : recordIds lresult = recordIds rresult := by
    rw [li, ri, interleaved_suffix_same_evidence m (chainOwner a) (recordIds left)
      (recordIds right) shared.1]
  have lv : stopWhenStable (rankedPass m (chainOwner a) g.size left) (m.size + 3) [] = some lresult := by
    simpa only [m, coldComponentEvents, withGenesis, ↓reduceIte, Nat.add_assoc] using ls
  have rv : stopWhenStable (rankedPass m (chainOwner a) g.size right) (m.size + 3) [] = some rresult := by
    simpa only [m, coldComponentEvents, withGenesis, ↓reduceIte, Nat.add_assoc] using rs
  have views := component_cold_same_receipt_view g patch registry initial r operationTime chainFacts
    ordered bounded left right shared.1 shared.2
  change (stopWhenStable (rankedPass m (chainOwner a) g.size left) (m.size + 3) []).map _ =
    (stopWhenStable (rankedPass m (chainOwner a) g.size right) (m.size + 3) []).map _ at views
  rw [lv, rv] at views
  have equalViews := Option.some.inj views
  refine ⟨lresult, rresult, lv, rv, lf, rf, ?_⟩
  simp only [agentResult, ids, equalViews]

/-- With an available valid genesis, the source-level endpoint returns an actual
complete component state. This rules out a vacuous equality of failed folds. -/
theorem integrated_agent_execution [DecidableEq α] (g : DocumentGraph)
    (patch : Nat → ComponentPatch D R) (registry : R → Nat)
    (initial : R) (empty initialData : D) (r : RegistryReceipts)
    (ordered : AncestryOrdered (documentAgent g)) (bounded : DepthBounded (documentAgent g))
    (parents : AgentParentBounded g) (genesis : g.parent g.root = none)
    (rootBound : g.root < g.size) (sources : List (AgentSourceReceipt α))
    (present : ∃ source ∈ sources, source.key.operation = g.root) :
    let a := componentAnchors g patch registry initial r
    let expected := expectedRegistry (componentRegistry g patch registry initial)
    let m := coldComponentEvents g a
    let records := normalizeAgentSources a expected sources
    ∃ result final,
      stopWhenStable (rankedPass m (chainOwner a) g.size records) (m.size + 3) [] = some result ∧
      rankedPass m (chainOwner a) g.size records result = result ∧
      ((recordIds result).map (chainOwner a)).head? = some g.root ∧
      runComponents g patch empty ⟨.active g.initialDocument, initialData, initial⟩
        (((recordIds result).map (chainOwner a)).drop 1) = some final := by
  exact component_cold_full_replay g patch registry initial empty initialData r
    ordered bounded parents genesis rootBound _
    (normalize_sources_present _ _ sources g.root present)

end Archon
