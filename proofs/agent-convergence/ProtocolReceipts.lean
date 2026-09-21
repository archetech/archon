import ProtocolResult
import ProtocolSources

set_option warningAsError true
namespace Archon

/-- Decoded receipt fields read by authorization are separate from arbitrary
arrival bookkeeping. Unanchored envelopes have no authoritative chain header. -/
structure ProtocolReceipt (α : Type) where
  source : AgentSourceReceipt α
  chain : Option ChainReceiptView
  deriving DecidableEq

def ProtocolReceipt.identity (receipt : ProtocolReceipt α) := (receipt.source.key, receipt.chain)

def ProtocolReceipt.hasRegistration (receipt : ProtocolReceipt α) : Bool :=
  receipt.chain.any ChainReceiptView.registration

def metadataAvailable (receipts : List (ProtocolReceipt α)) (key : AgentReceiptKey) : Bool :=
  receipts.any fun receipt => receipt.source.key == key && receipt.hasRegistration

def keepProtocolReceipt (receipts : List (ProtocolReceipt α)) (receipt : ProtocolReceipt α) : Bool :=
  receipt.hasRegistration || !metadataAvailable receipts receipt.source.key

/-- Incomplete copies cannot supply fallback authorization once a richer copy
of the same chain receipt is known. Keep first-observation bookkeeping abstract. -/
def normalizeProtocolReceipts (receipts : List (ProtocolReceipt α)) : List (AgentSourceReceipt α) :=
  (receipts.filter (keepProtocolReceipt receipts)).map ProtocolReceipt.source

def SameProtocolReceipts (left right : List (ProtocolReceipt α)) : Prop :=
  ∀ identity, (∃ receipt ∈ left, receipt.identity = identity) ↔
    (∃ receipt ∈ right, receipt.identity = identity)

theorem metadata_available_shared (left right : List (ProtocolReceipt α))
    (same : SameProtocolReceipts left right) (key : AgentReceiptKey) :
    metadataAvailable left key = metadataAvailable right key := by
  have transfer (xs ys : List (ProtocolReceipt α)) (shared : SameProtocolReceipts xs ys)
      (available : metadataAvailable xs key = true) : metadataAvailable ys key = true := by
    obtain ⟨receipt, member, present⟩ := List.any_eq_true.mp available
    obtain ⟨other, there, equal⟩ := (shared receipt.identity).mp ⟨receipt, member, rfl⟩
    have keys : other.source.key = receipt.source.key := congrArg Prod.fst equal
    have headers : other.chain = receipt.chain := congrArg Prod.snd equal
    apply List.any_eq_true.mpr
    refine ⟨other, there, ?_⟩
    simpa only [ProtocolReceipt.identity, ProtocolReceipt.hasRegistration, keys, headers] using present
  cases l : metadataAvailable left key <;> cases r : metadataAvailable right key
  · rfl
  · have h := transfer right left (fun identity => (same identity).symm) r
    rw [l] at h
    contradiction
  · have h := transfer left right same l
    rw [r] at h
    contradiction
  · rfl

theorem normalized_receipt_key_present (receipts : List (ProtocolReceipt α))
    (receipt : ProtocolReceipt α) (member : receipt ∈ receipts) :
    ∃ source ∈ normalizeProtocolReceipts receipts, source.key = receipt.source.key := by
  by_cases available : metadataAvailable receipts receipt.source.key = true
  · obtain ⟨rich, retained, found⟩ := List.any_eq_true.mp available
    have both := Bool.and_eq_true_iff.mp found
    have key := beq_iff_eq.mp both.1
    have kept : keepProtocolReceipt receipts rich = true := by
      simp only [keepProtocolReceipt, both.2, Bool.true_or]
    exact ⟨rich.source, List.mem_map.mpr ⟨rich, List.mem_filter.mpr ⟨retained, kept⟩, rfl⟩, key⟩
  · have absent : metadataAvailable receipts receipt.source.key = false := by
      cases h : metadataAvailable receipts receipt.source.key <;> simp_all
    have kept : keepProtocolReceipt receipts receipt = true := by
      simp only [keepProtocolReceipt, absent, Bool.not_false, Bool.or_true]
    exact ⟨receipt.source, List.mem_map.mpr ⟨receipt, List.mem_filter.mpr ⟨member, kept⟩, rfl⟩, rfl⟩

theorem normalize_protocol_receipts_shared (left right : List (ProtocolReceipt α))
    (same : SameProtocolReceipts left right) :
    SameAgentSources (normalizeProtocolReceipts left) (normalizeProtocolReceipts right) := by
  have transfer (xs ys : List (ProtocolReceipt α)) (shared : SameProtocolReceipts xs ys)
      (key : AgentReceiptKey) (present : ∃ source ∈ normalizeProtocolReceipts xs, source.key = key) :
      ∃ source ∈ normalizeProtocolReceipts ys, source.key = key := by
    obtain ⟨source, member, equal⟩ := present
    obtain ⟨receipt, kept, rfl⟩ := List.mem_map.mp member
    obtain ⟨other, there, identity⟩ := (shared receipt.identity).mp
      ⟨receipt, (List.mem_filter.mp kept).1, rfl⟩
    obtain ⟨result, retained, sameKey⟩ := normalized_receipt_key_present ys other there
    exact ⟨result, retained, sameKey.trans ((congrArg Prod.fst identity).trans equal)⟩
  exact fun key => ⟨transfer left right same key,
    transfer right left (fun identity => (same identity).symm) key⟩

/-- Preferred metadata is determined by an existential fact about the retained
receipts, not by their order or by an assumed equal final authorization. -/
theorem normalized_receipt_has_rich_metadata (receipts : List (ProtocolReceipt α))
    (receipt : ProtocolReceipt α) (kept : receipt ∈ receipts.filter (keepProtocolReceipt receipts))
    (available : metadataAvailable receipts receipt.source.key = true) :
    receipt.hasRegistration = true := by
  have keep := (List.mem_filter.mp kept).2
  simpa only [keepProtocolReceipt, available, Bool.not_true, Bool.or_false] using keep

abbrev ProtocolReceiptEvidence (n : Nat) (α : Type) := Fin n → List (ProtocolReceipt α)

def normalizeProtocolEvidence (receipts : ProtocolReceiptEvidence n α) : ProtocolEvidence n α :=
  fun i => normalizeProtocolReceipts (receipts i)

def SameProtocolReceiptEvidence (left right : ProtocolReceiptEvidence n α) : Prop :=
  ∀ i, SameProtocolReceipts (left i) (right i)

theorem normalize_protocol_evidence_shared (left right : ProtocolReceiptEvidence n α)
    (same : SameProtocolReceiptEvidence left right) :
    SameProtocolEvidence (normalizeProtocolEvidence left) (normalizeProtocolEvidence right) :=
  fun i => normalize_protocol_receipts_shared _ _ (same i)

/-- Decoded authorization headers combine fixed chain clocks/positions with an
EVIDENCE-DERIVED registration flag. The latter is not part of the authoritative
snapshot: `ProtocolReceiptValid` below computes its required value from copies.
An incomplete-only snapshot therefore uses false; later enrichment uses true,
without changing the physical chain facts (`withoutRegistration`). -/
def protocolChainFacts (w : ProtocolModel n) (i : Fin n) (key : AgentReceiptKey) : Option ChainReceiptView :=
  key.anchor.bind fun rank => match w.dids i with
    | none => none
    | some (.agent spec) => some (spec.chainFacts rank)
    | some (.asset spec) => some (spec.chainFacts rank)

def withoutRegistration (header : Option ChainReceiptView) : Option ChainReceiptView :=
  header.map fun fact => { fact with registration := false }

/-- Binding to decoded receipt fields: metadata completeness is the OR of the
actual copies, never an independently assumed agreement between authorizers. -/
def ProtocolReceiptValid (w : ProtocolModel n) (i : Fin n)
    (receipts : List (ProtocolReceipt α)) (receipt : ProtocolReceipt α) : Prop :=
  protocolSourceValid w i receipt.source.key = true ∧
    withoutRegistration receipt.chain = withoutRegistration (protocolChainFacts w i receipt.source.key) ∧
    (protocolChainFacts w i receipt.source.key).all
      (fun fact => fact.registration == metadataAvailable receipts receipt.source.key) = true

instance (w : ProtocolModel n) (i : Fin n) (receipts : List (ProtocolReceipt α)) (receipt : ProtocolReceipt α) :
    Decidable (ProtocolReceiptValid w i receipts receipt) := by
  unfold ProtocolReceiptValid
  infer_instance

def ProtocolReceiptSources (w : ProtocolModel n) (receipts : ProtocolReceiptEvidence n α) : Prop :=
  ∀ i receipt, receipt ∈ receipts i → ProtocolReceiptValid w i (receipts i) receipt

theorem protocol_normalized_sources (w : ProtocolModel n) (receipts : ProtocolReceiptEvidence n α)
    (valid : ProtocolReceiptSources w receipts) :
    ProtocolSources w (normalizeProtocolEvidence receipts) := by
  intro i source member
  obtain ⟨receipt, kept, rfl⟩ := List.mem_map.mp member
  exact (valid i receipt (List.mem_filter.mp kept).1).1

theorem protocol_receipt_sources_shared (w : ProtocolModel n)
    (left right : ProtocolReceiptEvidence n α) (valid : ProtocolReceiptSources w left)
    (same : SameProtocolReceiptEvidence left right) : ProtocolReceiptSources w right := by
  intro i receipt member
  obtain ⟨original, retained, equal⟩ := (same i receipt.identity).mpr ⟨receipt, member, rfl⟩
  have keys : original.source.key = receipt.source.key := congrArg Prod.fst equal
  have headers : original.chain = receipt.chain := congrArg Prod.snd equal
  have rich := metadata_available_shared (left i) (right i) (same i) receipt.source.key
  obtain ⟨key, header, metadata⟩ := valid i original retained
  refine ⟨?_, ?_, ?_⟩
  · simpa only [keys] using key
  · simpa only [keys, headers] using header
  · simpa only [keys, rich] using metadata

/-- Canonical signed fixture sources already carry one header interpretation
per receipt class; exposing it makes the final decoder contract checkable. -/
def protocolReceiptOfSource (w : ProtocolModel n) (i : Fin n) (source : AgentSourceReceipt α) : ProtocolReceipt α :=
  ⟨source, protocolChainFacts w i source.key⟩

def protocolReceiptsOfSources (w : ProtocolModel n) (sources : ProtocolEvidence n α) : ProtocolReceiptEvidence n α :=
  fun i => (sources i).map (protocolReceiptOfSource w i)


/-- Shared signed bridge expansion: add an incomplete observation without
changing the operation, ordinal or authoritative chain clock. -/
def withIncompleteProtocolReceipts (richFirst : Bool) (receipts : List (ProtocolReceipt α)) : List (ProtocolReceipt α) :=
  receipts.flatMap fun receipt =>
    if receipt.hasRegistration then
      let weak := { receipt with chain := withoutRegistration receipt.chain }
      if richFirst then [receipt, weak] else [weak, receipt]
    else [receipt]

def sameProtocolReceiptCheck (left right : List (ProtocolReceipt α)) : Bool :=
  (left ++ right).all fun receipt =>
    (left.any fun r => r.identity == receipt.identity) == (right.any fun r => r.identity == receipt.identity)

theorem same_protocol_receipts_of_check (left right : List (ProtocolReceipt α))
    (checked : sameProtocolReceiptCheck left right = true) : SameProtocolReceipts left right := by
  have agrees (receipt : ProtocolReceipt α) (member : receipt ∈ left ++ right) :
      (left.any fun r => r.identity == receipt.identity) = (right.any fun r => r.identity == receipt.identity) := by
    exact beq_iff_eq.mp (List.all_eq_true.mp checked receipt member)
  intro identity
  constructor
  · rintro ⟨receipt, member, rfl⟩
    have present : (left.any fun r => r.identity == receipt.identity) = true :=
      List.any_eq_true.mpr ⟨receipt, member, by simp only [beq_self_eq_true]⟩
    rw [agrees receipt (List.mem_append_left _ member)] at present
    obtain ⟨other, there, equal⟩ := List.any_eq_true.mp present
    exact ⟨other, there, beq_iff_eq.mp equal⟩
  · rintro ⟨receipt, member, rfl⟩
    have present : (right.any fun r => r.identity == receipt.identity) = true :=
      List.any_eq_true.mpr ⟨receipt, member, by simp only [beq_self_eq_true]⟩
    rw [← agrees receipt (List.mem_append_right _ member)] at present
    obtain ⟨other, there, equal⟩ := List.any_eq_true.mp present
    exact ⟨other, there, beq_iff_eq.mp equal⟩


end Archon
