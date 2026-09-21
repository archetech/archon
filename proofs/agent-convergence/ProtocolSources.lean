import ProtocolModel

set_option warningAsError true
namespace Archon

/-- The producer/decoder contract for a normalized source key. An authoritative
anchor belongs to this operation and registry. A receipt without an anchor may
only claim an unanchored registry: a chain hint is relayed as local, not confirmed.
Wrong-chain positioned receipts remain permitted. -/
def ProtocolSourceKey (size : Nat) (receiptSize : Nat) (owner registry : Nat → Nat)
    (unanchored : Nat → Bool) (key : AgentReceiptKey) : Prop :=
  key.operation < size ∧ match key.anchor with
  | none => unanchored key.registry = true
  | some rank => rank < receiptSize ∧ owner rank = key.operation ∧ registry rank = key.registry ∧
      unanchored key.registry = false

instance (size receiptSize : Nat) (owner registry : Nat → Nat) (unanchored : Nat → Bool) (key : AgentReceiptKey) :
    Decidable (ProtocolSourceKey size receiptSize owner registry unanchored key) := by
  unfold ProtocolSourceKey
  cases key.anchor <;> infer_instance

def protocolSourceValid (w : ProtocolModel n) (i : Fin n) (key : AgentReceiptKey) : Bool :=
  match w.dids i with
  | none => false
  | some (.agent spec) => decide (ProtocolSourceKey spec.core.graph.size spec.receipts.size
      spec.receipts.owner spec.receipts.registry w.unanchored key)
  | some (.asset spec) => decide (ProtocolSourceKey spec.graph.size spec.receipts.size
      spec.receipts.owner spec.receipts.registry w.unanchored key)

def ProtocolSources (w : ProtocolModel n) (evidence : ProtocolEvidence n α) : Prop :=
  ∀ i source, source ∈ evidence i → protocolSourceValid w i source.key = true

theorem protocol_sources_shared (w : ProtocolModel n) (left right : ProtocolEvidence n α)
    (valid : ProtocolSources w left) (same : ∀ i, SameAgentSources (left i) (right i)) :
    ProtocolSources w right := by
  intro i source member
  obtain ⟨original, retained, equal⟩ := (same i source.key).mpr ⟨source, member, rfl⟩
  simpa only [equal] using valid i original retained

end Archon
