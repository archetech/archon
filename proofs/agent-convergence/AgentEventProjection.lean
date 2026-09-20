import AgentRegistry
import ChainDocuments
import RegistryPriority

set_option warningAsError true
namespace Archon

/-- Normalize receipt identities to matching-anchor ranks or one provisional CID
rank per operation. The provisional representative is harmless when a preferred
anchor exists; it remains below every anchored sibling in priority. -/
def componentEventAllowed (a : AnchorModel) (i : Nat) : Bool :=
  if i < a.size then eligible a (chainOwner a i) i else true

def componentEvents (g : DocumentGraph) (a : AnchorModel) : Model :=
  documentEvents g (a.size + g.size) (chainOwner a) (componentEventAllowed a)

def componentEventEvidence (a : AnchorModel) (receipts operations : List Nat) : List Nat :=
  receipts.filter (fun i => eligible a (chainOwner a i) i) ++ operations.map (fun op => a.size + op)

theorem component_priority_bound (a : AnchorModel) (receipts : List Nat) (op size : Nat)
    (bound : op < size) : chainPriority a receipts op < a.size + size := by
  simp only [chainPriority, anchor_scan_cold]
  split <;> omega

theorem component_priority_allowed (a : AnchorModel) (receipts : List Nat) (op : Nat) :
    componentEventAllowed a (chainPriority a receipts op) = true := by
  by_cases anchored : winner a op receipts < a.size
  · have ok := (winner_member a op receipts anchored).2
    have identity := chain_priority_owner a receipts op
    simp only [chainPriority, anchor_scan_cold, anchored, ↓reduceIte] at identity ⊢
    simp only [componentEventAllowed, anchored, ↓reduceIte, identity]
    exact ok
  · have outside : ¬ a.size + op < a.size := by omega
    simp only [chainPriority, anchor_scan_cold, anchored, ↓reduceIte,
      componentEventAllowed, outside]

theorem component_priority_member (a : AnchorModel) (receipts operations : List Nat) (op : Nat)
    (member : op ∈ operations) :
    chainPriority a receipts op ∈ componentEventEvidence a receipts operations := by
  by_cases anchored : winner a op receipts < a.size
  · obtain ⟨mem, ok⟩ := winner_member a op receipts anchored
    have identity := chain_priority_owner a receipts op
    simp only [chainPriority, anchor_scan_cold, anchored, ↓reduceIte] at identity ⊢
    apply List.mem_append_left
    exact List.mem_filter.mpr ⟨mem, by rw [identity]; exact ok⟩
  · simp only [chainPriority, anchor_scan_cold, anchored, ↓reduceIte]
    exact List.mem_append_right _ (List.mem_map.mpr ⟨op, member, rfl⟩)

theorem component_priority_le (a : AnchorModel) (receipts operations : List Nat) (i : Nat)
    (member : i ∈ componentEventEvidence a receipts operations) :
    chainPriority a receipts (chainOwner a i) ≤ i := by
  rcases List.mem_append.mp member with anchored | provisional
  · obtain ⟨mem, ok⟩ := List.mem_filter.mp anchored
    have bound := eligible_lt _ _ _ ok
    have minimal := winner_le_member a (chainOwner a i) i receipts mem ok
    have chosen : winner a (chainOwner a i) receipts < a.size := by omega
    simp only [chainPriority, anchor_scan_cold, chosen, ↓reduceIte]
    exact minimal
  · obtain ⟨op, _, rfl⟩ := List.mem_map.mp provisional
    have outside : ¬ a.size + op < a.size := by omega
    simp only [chainOwner, outside, ↓reduceIte, Nat.add_sub_cancel_left,
      chainPriority, anchor_scan_cold]
    split <;> omega

/-- Canonical compiled eligibility is exactly the underlying operation predicate.
The predecessor map is reflected by the proved priority/owner inverse. -/
theorem component_compiled_eligible (m : Model) (a : AnchorModel) (receipts : List Nat)
    (p i : Nat) :
    eligible (chainGraph m a receipts) (chainPriority a receipts p) i = true ↔
      eligible m p (chainOwner a i) = true ∧ i = chainPriority a receipts (chainOwner a i) := by
  simp only [eligible, chainGraph, Bool.and_eq_true, decide_eq_true_eq]
  cases parent : m.parent (chainOwner a i) with
  | none => simp only [Option.map_none, Option.none_beq_some, Bool.false_eq_true, and_false, false_and]
  | some predecessor =>
    simp only [Option.map_some, Option.some_beq_some, Nat.beq_eq_true_eq]
    constructor
    · rintro ⟨⟨_, ⟨⟨bound, authorized⟩, canonical⟩⟩, edge⟩
      exact ⟨⟨⟨bound, authorized⟩, chain_priority_injective a receipts edge⟩, canonical⟩
    · rintro ⟨⟨⟨bound, authorized⟩, rfl⟩, canonical⟩
      have bounded := component_priority_bound a receipts (chainOwner a i) m.size bound
      rw [← canonical] at bounded
      exact ⟨⟨decide_eq_true bounded, ⟨⟨bound, authorized⟩, canonical⟩⟩, rfl⟩

/-- The full raw/compiled representation contract follows from receipt ownership
and normalization, not assumed agreement of accepted sets or selected histories. -/
theorem component_event_projection (g : DocumentGraph) (a : AnchorModel)
    (receipts operations : List Nat)
    (covered : ∀ i ∈ receipts, eligible a (chainOwner a i) i = true → chainOwner a i ∈ operations) :
    PriorityProjection (componentEvents g a) (chainGraph (agentModel (documentAgent g)) a receipts)
      (chainOwner a) (chainPriority a receipts) (componentEventEvidence a receipts operations)
      (operations.map (chainPriority a receipts)) g.size := by
  constructor
  · rfl
  · intro p _ i member valid
    have opValid := document_event_eligible g _ _ _ p i valid
    have opMember : chainOwner a i ∈ operations := by
      rcases List.mem_append.mp member with anchored | provisional
      · obtain ⟨mem, ok⟩ := List.mem_filter.mp anchored
        exact covered i mem ok
      · obtain ⟨op, mem, rfl⟩ := List.mem_map.mp provisional
        have outside : ¬ a.size + op < a.size := by omega
        simpa only [chainOwner, outside, ↓reduceIte, Nat.add_sub_cancel_left] using mem
    refine ⟨List.mem_map.mpr ⟨_, opMember, rfl⟩, ?_, component_priority_le a receipts operations i member⟩
    apply (component_compiled_eligible _ _ _ _ _).mpr
    simp only [chain_priority_owner]
    exact ⟨opValid, True.intro⟩
  · intro p _ i selected valid
    obtain ⟨op, member, rfl⟩ := List.mem_map.mp selected
    obtain ⟨opValid, _⟩ := (component_compiled_eligible _ _ _ _ _).mp valid
    rw [chain_priority_owner] at opValid
    refine ⟨component_priority_member a receipts operations op member, ?_⟩
    have bound := component_priority_bound a receipts op g.size (eligible_lt _ _ _ opValid)
    have allowed := component_priority_allowed a receipts op
    simp only [eligible, Bool.and_eq_true] at opValid
    simp only [componentEvents, documentEvents, eligible, Bool.and_eq_true, chain_priority_owner]
    exact ⟨⟨decide_eq_true bound, ⟨⟨opValid.1.1, opValid.1.2⟩, allowed⟩⟩, opValid.2⟩
  · intro p _ i _ valid
    obtain ⟨opValid, canonical⟩ := (component_compiled_eligible _ _ _ _ _).mp valid
    exact ⟨canonical, eligible_lt _ _ _ opValid⟩

/-- One derived agent model now drives raw normalized event replay, compiled
priority selection, and complete component execution. The only representation
premise is that retained eligible receipts name retained operations. -/
theorem component_interleaved_replay (g : DocumentGraph)
    (documents : Nat → Doc) (methods : Doc → List VerificationMethod)
    (agrees : ∀ i, methods (documents i) = g.documents i)
    (patch : Nat → ComponentPatch D R) (registry : R → Nat)
    (initial : R) (empty initialData : D) (r : RegistryReceipts)
    (ordered : AncestryOrdered (documentAgent g)) (bounded : DepthBounded (documentAgent g))
    (genesis : g.parent g.root = none) (rootBound : g.root < g.size)
    (receipts operations path : List Nat)
    (covered : ∀ i ∈ receipts,
      eligible (componentAnchors g patch registry initial r)
        (chainOwner (componentAnchors g patch registry initial r) i) i = true →
      chainOwner (componentAnchors g patch registry initial r) i ∈ operations)
    (present : g.root ∈ operations)
    (valid : InterleavedValid (componentEvents g (componentAnchors g patch registry initial r))
      (chainOwner (componentAnchors g patch registry initial r))
      (componentEventEvidence (componentAnchors g patch registry initial r) receipts operations) g.root path) :
    let a := componentAnchors g patch registry initial r
    ∃ result final,
      interleavedUntilStable (componentEvents g a) (chainOwner a) g.root
        (componentEventEvidence a receipts operations) ((componentEvents g a).level g.root + 1) path = some result ∧
      chainReplay (agentModel (documentAgent g)) a receipts g.root operations =
        some (g.root :: result.map (chainOwner a)) ∧
      runComponents (decodedComponentGraph g documents methods) patch empty
        ⟨.active g.initialDocument, initialData, initial⟩ (result.map (chainOwner a)) = some final := by
  let a := componentAnchors g patch registry initial r
  let compiled := chainGraph (agentModel (documentAgent g)) a receipts
  have depth : (componentEvents g a).level g.root = compiled.level (chainPriority a receipts g.root) := by
    simp only [componentEvents, documentEvents, compiled, chainGraph, chain_priority_owner]
  have create : compiled.parent (chainPriority a receipts g.root) = none := by
    simp only [compiled, chainGraph, chain_priority_owner, agentModel, documentAgent, genesis, Option.map_none]
  obtain ⟨result, authority, replay, _, cold, ran, _⟩ :=
    interleaved_document_priority_cold g (a.size + g.size) (chainOwner a) (chainPriority a receipts)
      (componentEventAllowed a) compiled ordered bounded genesis rootBound
      (componentEventEvidence a receipts operations) (operations.map (chainPriority a receipts)) path
      (component_event_projection g a receipts operations covered) valid depth
      (chain_graph_acyclic _ _ _ (agent_model_acyclic _ ordered bounded)) create
      (List.mem_map.mpr ⟨g.root, present, rfl⟩) (chain_priority_owner a receipts g.root)
  have projection := component_run_authority g patch empty (result.map (chainOwner a))
    ⟨.active g.initialDocument, initialData, initial⟩
  rw [ran] at projection
  cases executed : runComponents g patch empty ⟨.active g.initialDocument, initialData, initial⟩
      (result.map (chainOwner a)) with
  | none => simp only [executed, Option.map_none, reduceCtorEq] at projection
  | some final =>
    refine ⟨result, final, replay, cold, ?_⟩
    rw [decoded_component_graph_eq g documents methods agrees]
    exact executed

end Archon
