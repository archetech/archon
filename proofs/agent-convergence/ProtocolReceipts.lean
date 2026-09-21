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

/-- Admission requires complete chain headers. No richer-copy normalization is
needed; retain the source evidence independently of arrival bookkeeping. -/
def normalizeProtocolReceipts (receipts : List (ProtocolReceipt α)) : List (AgentSourceReceipt α) :=
  receipts.map ProtocolReceipt.source

def SameProtocolReceipts (left right : List (ProtocolReceipt α)) : Prop :=
  ∀ identity, (∃ receipt ∈ left, receipt.identity = identity) ↔
    (∃ receipt ∈ right, receipt.identity = identity)

theorem normalized_receipt_key_present (receipts : List (ProtocolReceipt α))
    (receipt : ProtocolReceipt α) (member : receipt ∈ receipts) :
    ∃ source ∈ normalizeProtocolReceipts receipts, source.key = receipt.source.key := by
  exact ⟨receipt.source, List.mem_map.mpr ⟨receipt, member, rfl⟩, rfl⟩

theorem normalize_protocol_receipts_shared (left right : List (ProtocolReceipt α))
    (same : SameProtocolReceipts left right) :
    SameAgentSources (normalizeProtocolReceipts left) (normalizeProtocolReceipts right) := by
  have transfer (xs ys : List (ProtocolReceipt α)) (shared : SameProtocolReceipts xs ys)
      (key : AgentReceiptKey) (present : ∃ source ∈ normalizeProtocolReceipts xs, source.key = key) :
      ∃ source ∈ normalizeProtocolReceipts ys, source.key = key := by
    obtain ⟨source, member, equal⟩ := present
    obtain ⟨receipt, kept, rfl⟩ := List.mem_map.mp member
    obtain ⟨other, there, identity⟩ := (shared receipt.identity).mp
      ⟨receipt, kept, rfl⟩
    obtain ⟨result, retained, sameKey⟩ := normalized_receipt_key_present ys other there
    exact ⟨result, retained, sameKey.trans ((congrArg Prod.fst identity).trans equal)⟩
  exact fun key => ⟨transfer left right same key,
    transfer right left (fun identity => (same identity).symm) key⟩

abbrev ProtocolReceiptEvidence (n : Nat) (α : Type) := Fin n → List (ProtocolReceipt α)

def normalizeProtocolEvidence (receipts : ProtocolReceiptEvidence n α) : ProtocolEvidence n α :=
  fun i => normalizeProtocolReceipts (receipts i)

def SameProtocolReceiptEvidence (left right : ProtocolReceiptEvidence n α) : Prop :=
  ∀ i, SameProtocolReceipts (left i) (right i)

theorem normalize_protocol_evidence_shared (left right : ProtocolReceiptEvidence n α)
    (same : SameProtocolReceiptEvidence left right) :
    SameProtocolEvidence (normalizeProtocolEvidence left) (normalizeProtocolEvidence right) :=
  fun i => normalize_protocol_receipts_shared _ _ (same i)

/-- Chain facts come from complete authoritative receipts. -/
def protocolChainFacts (w : ProtocolModel n) (i : Fin n) (key : AgentReceiptKey) : Option ChainReceiptView :=
  key.anchor.bind fun rank => match w.dids i with
    | none => none
    | some (.agent spec) => some (spec.chainFacts rank)
    | some (.asset spec) => some (spec.chainFacts rank)

/-- Bind the complete decoded header to the model; incomplete chain receipts
are outside the admitted protocol domain. -/
def ProtocolReceiptValid (w : ProtocolModel n) (i : Fin n)
    (_receipts : List (ProtocolReceipt α)) (receipt : ProtocolReceipt α) : Prop :=
  protocolSourceValid w i receipt.source.key = true ∧
    receipt.chain = protocolChainFacts w i receipt.source.key ∧
    receipt.chain.all ChainReceiptView.registration = true

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
  exact (valid i receipt kept).1

theorem protocol_receipt_sources_shared (w : ProtocolModel n)
    (left right : ProtocolReceiptEvidence n α) (valid : ProtocolReceiptSources w left)
    (same : SameProtocolReceiptEvidence left right) : ProtocolReceiptSources w right := by
  intro i receipt member
  obtain ⟨original, retained, equal⟩ := (same i receipt.identity).mpr ⟨receipt, member, rfl⟩
  have keys : original.source.key = receipt.source.key := congrArg Prod.fst equal
  have headers : original.chain = receipt.chain := congrArg Prod.snd equal
  obtain ⟨key, header, metadata⟩ := valid i original retained
  refine ⟨?_, ?_, ?_⟩
  · simpa only [keys] using key
  · simpa only [keys, headers] using header
  · simpa only [headers] using metadata

/-- Canonical signed fixture sources already carry one header interpretation
per receipt class; exposing it makes the final decoder contract checkable. -/
def protocolReceiptOfSource (w : ProtocolModel n) (i : Fin n) (source : AgentSourceReceipt α) : ProtocolReceipt α :=
  ⟨source, protocolChainFacts w i source.key⟩

def protocolReceiptsOfSources (w : ProtocolModel n) (sources : ProtocolEvidence n α) : ProtocolReceiptEvidence n α :=
  fun i => (sources i).map (protocolReceiptOfSource w i)


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
