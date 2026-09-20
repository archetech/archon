import AgentReceiptViews

set_option warningAsError true
namespace Archon

/-- Identity of a receipt after producer/relay normalization. An anchor names
an authoritative registry/ordinal/CID class, not a database row. -/
structure AgentReceiptKey where
  operation : Nat
  registry : Nat
  anchor : Option Nat
  deriving DecidableEq

/-- Node-local arrival data is separate from protocol receipt identity. -/
structure AgentSourceReceipt (α : Type) where
  key : AgentReceiptKey
  bookkeeping : α
  deriving DecidableEq

/-- One source receipt contributes its eligible anchor and a provisional owner
representative. Eligibility is the A1 predecessor-document/registry predicate. -/
def normalizeAgentSource (a : AnchorModel) (expected : Nat → Option Nat)
    (source : AgentSourceReceipt α) : List (EventRecord (AgentSourceReceipt α)) :=
  let provisional := EventRecord.mk (a.size + source.key.operation)
    (expected source.key.operation == some source.key.registry) source
  match source.key.anchor with
  | none => [provisional]
  | some rank =>
    if eligible a source.key.operation rank &&
        (expected source.key.operation == some source.key.registry) then
      [⟨rank, true, source⟩, provisional]
    else [provisional]

def normalizeAgentSources (a : AnchorModel) (expected : Nat → Option Nat)
    (sources : List (AgentSourceReceipt α)) : List (EventRecord (AgentSourceReceipt α)) :=
  sources.flatMap (normalizeAgentSource a expected)

/-- Same protocol receipts; arrival order, multiplicity and bookkeeping may differ. -/
def SameAgentSources (xs ys : List (AgentSourceReceipt α)) : Prop :=
  ∀ key, (∃ x ∈ xs, x.key = key) ↔ (∃ y ∈ ys, y.key = key)

theorem normalize_source_provisional (a : AnchorModel) (expected : Nat → Option Nat)
    (source : AgentSourceReceipt α) :
    a.size + source.key.operation ∈ recordIds (normalizeAgentSource a expected source) := by
  cases h : source.key.anchor with
  | none => simp [normalizeAgentSource, h, recordIds]
  | some rank =>
    simp only [normalizeAgentSource, h]
    split <;> simp [recordIds]

theorem normalize_sources_present (a : AnchorModel) (expected : Nat → Option Nat)
    (sources : List (AgentSourceReceipt α)) (op : Nat)
    (present : ∃ source ∈ sources, source.key.operation = op) :
    a.size + op ∈ recordIds (normalizeAgentSources a expected sources) := by
  obtain ⟨source, member, rfl⟩ := present
  obtain ⟨record, normalized, rank⟩ := List.mem_map.mp (normalize_source_provisional a expected source)
  exact List.mem_map.mpr ⟨record, List.mem_flatMap.mpr ⟨source, member, normalized⟩, rank⟩

/-- A finite executable check for the source-equivalence bridge. -/
def sameAgentSourceCheck [DecidableEq α] (xs ys : List (AgentSourceReceipt α)) : Bool :=
  (xs ++ ys).all fun source =>
    (xs.any fun x => x.key == source.key) == (ys.any fun y => y.key == source.key)

theorem same_sources_of_check [DecidableEq α] (xs ys : List (AgentSourceReceipt α))
    (checked : sameAgentSourceCheck xs ys = true) : SameAgentSources xs ys := by
  have agrees (source : AgentSourceReceipt α) (member : source ∈ xs ++ ys) :
      (xs.any fun x => x.key == source.key) = (ys.any fun y => y.key == source.key) := by
    have h := List.all_eq_true.mp checked source member
    exact beq_iff_eq.mp h
  intro key
  constructor
  · rintro ⟨source, member, rfl⟩
    have present : (xs.any fun x => x.key == source.key) = true :=
      List.any_eq_true.mpr ⟨source, member, by simp⟩
    rw [agrees source (List.mem_append_left _ member)] at present
    obtain ⟨other, there, equal⟩ := List.any_eq_true.mp present
    exact ⟨other, there, beq_iff_eq.mp equal⟩
  · rintro ⟨source, member, rfl⟩
    have present : (ys.any fun y => y.key == source.key) = true :=
      List.any_eq_true.mpr ⟨source, member, by simp⟩
    rw [← agrees source (List.mem_append_right _ member)] at present
    obtain ⟨other, there, equal⟩ := List.any_eq_true.mp present
    exact ⟨other, there, beq_iff_eq.mp equal⟩

theorem normalize_source_ids (a : AnchorModel) (expected : Nat → Option Nat)
    (x y : AgentSourceReceipt α) (same : x.key = y.key) :
    recordIds (normalizeAgentSource a expected x) =
      recordIds (normalizeAgentSource a expected y) := by
  cases anchor : y.key.anchor with
  | none => simp only [normalizeAgentSource, same, anchor, recordIds, List.map_cons, List.map_nil]
  | some rank =>
    simp only [normalizeAgentSource, same, anchor]
    split <;> rfl

theorem normalize_source_matching (a : AnchorModel) (expected : Nat → Option Nat)
    (x y : AgentSourceReceipt α) (same : x.key = y.key) :
    matchingRanks (normalizeAgentSource a expected x) =
      matchingRanks (normalizeAgentSource a expected y) := by
  simp only [normalizeAgentSource, same]
  cases h : (expected y.key.operation == some y.key.registry) <;>
    split <;> simp_all [matchingRanks, recordIds]
  all_goals split <;> simp_all

theorem normalize_sources_membership (a : AnchorModel) (expected : Nat → Option Nat)
    (xs ys : List (AgentSourceReceipt α)) (same : SameAgentSources xs ys) :
    (∀ i, i ∈ recordIds (normalizeAgentSources a expected xs) ↔
      i ∈ recordIds (normalizeAgentSources a expected ys)) ∧
    (∀ i, i ∈ matchingRanks (normalizeAgentSources a expected xs) ↔
      i ∈ matchingRanks (normalizeAgentSources a expected ys)) := by
  have transfer (left right : List (AgentSourceReceipt α))
      (keys : SameAgentSources left right)
      (select : EventRecord (AgentSourceReceipt α) → Bool)
      (coherent : ∀ x y : AgentSourceReceipt α, x.key = y.key →
        recordIds ((normalizeAgentSource a expected x).filter select) =
          recordIds ((normalizeAgentSource a expected y).filter select)) :
      ∀ i, i ∈ recordIds ((normalizeAgentSources a expected left).filter select) →
        i ∈ recordIds ((normalizeAgentSources a expected right).filter select) := by
    intro i member
    obtain ⟨record, member, rank⟩ := List.mem_map.mp member
    obtain ⟨retained, selected⟩ := List.mem_filter.mp member
    obtain ⟨source, present, normalized⟩ := List.mem_flatMap.mp retained
    obtain ⟨other, there, equal⟩ := (keys source.key).mp ⟨source, present, rfl⟩
    have localMember : i ∈ recordIds ((normalizeAgentSource a expected source).filter select) :=
      List.mem_map.mpr ⟨record, List.mem_filter.mpr ⟨normalized, selected⟩, rank⟩
    rw [coherent source other equal.symm] at localMember
    obtain ⟨chosen, chosenMember, chosenRank⟩ := List.mem_map.mp localMember
    obtain ⟨chosenSource, chosenSelected⟩ := List.mem_filter.mp chosenMember
    exact List.mem_map.mpr ⟨chosen, List.mem_filter.mpr
      ⟨List.mem_flatMap.mpr ⟨other, there, chosenSource⟩, chosenSelected⟩, chosenRank⟩
  have reverse : SameAgentSources ys xs := fun key => (same key).symm
  have filterAll (zs : List (EventRecord (AgentSourceReceipt α))) : zs.filter (fun _ => true) = zs :=
    List.filter_eq_self.mpr (by simp)
  constructor
  · intro i
    have coherent := fun (x y : AgentSourceReceipt α) (h : x.key = y.key) => normalize_source_ids a expected x y h
    simpa only [filterAll] using Iff.intro (transfer xs ys same (fun _ => true) (by simpa only [filterAll] using coherent) i)
      (transfer ys xs reverse (fun _ => true) (by simpa only [filterAll] using coherent) i)
  · intro i
    exact ⟨transfer xs ys same EventRecord.expected (normalize_source_matching a expected) i,
      transfer ys xs reverse EventRecord.expected (normalize_source_matching a expected) i⟩

/-- The source normalization premise is derived from shared receipt identities,
not supplied as equal accepted paths or equal final authorization views. -/
theorem agent_sources_same_receipt_view [DecidableEq α] (g : DocumentGraph)
    (patch : Nat → ComponentPatch D R) (registry : R → Nat) (initial : R)
    (r : RegistryReceipts) (operationTime : Nat → Int) (chainFacts : Nat → ChainReceiptView)
    (ordered : AncestryOrdered (documentAgent g)) (bounded : DepthBounded (documentAgent g))
    (xs ys : List (AgentSourceReceipt α)) (same : SameAgentSources xs ys) :
    let a := componentAnchors g patch registry initial r
    let expected := expectedRegistry (componentRegistry g patch registry initial)
    let m := coldComponentEvents g a
    let view := agentReceiptView a expected operationTime chainFacts
    (stopWhenStable (rankedPass m (chainOwner a) g.size (normalizeAgentSources a expected xs))
      (m.size + 3) []).map (fun records => confirmedReceiptView (records.map view)) =
    (stopWhenStable (rankedPass m (chainOwner a) g.size (normalizeAgentSources a expected ys))
      (m.size + 3) []).map (fun records => confirmedReceiptView (records.map view)) := by
  have shared := normalize_sources_membership (componentAnchors g patch registry initial r)
    (expectedRegistry (componentRegistry g patch registry initial)) xs ys same
  exact component_cold_same_receipt_view g patch registry initial r operationTime chainFacts
    ordered bounded _ _ shared.1 shared.2

end Archon
