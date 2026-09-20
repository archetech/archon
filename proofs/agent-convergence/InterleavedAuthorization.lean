import InterleavedBound
import DocumentAuthorization

set_option warningAsError true
namespace Archon

/-- Event ranks may have multiple representations of an operation. Registry and
position eligibility are explicit inputs; document authorization is derived from
immutable signed predecessor ancestry. Genesis is already admitted separately. -/
def documentEvents (g : DocumentGraph) (size : Nat) (owner : Nat → Nat)
    (allowed : Nat → Bool) : Model where
  size := size
  parent := fun i => g.parent (owner i)
  authorized := fun i => decide (owner i < g.size) &&
    (agentModel (documentAgent g)).authorized (owner i) && allowed i
  level := (agentModel (documentAgent g)).level

/-- An eligible event decodes to an authorized operation at the same predecessor. -/
theorem document_event_eligible (g : DocumentGraph) (size : Nat) (owner : Nat → Nat)
    (allowed : Nat → Bool) (p i : Nat)
    (ok : eligible (documentEvents g size owner allowed) p i = true) :
    eligible (agentModel (documentAgent g)) p (owner i) = true := by
  simp only [eligible, documentEvents, Bool.and_eq_true, decide_eq_true_eq] at ok ⊢
  exact ⟨⟨ok.1.2.1.1, ok.1.2.1.2⟩, ok.2⟩

/-- For a reconstructed active predecessor, the event predicate uses the named
method in that document, before applying a replacement or deletion. -/
theorem document_event_authorization (g : DocumentGraph) (size : Nat) (owner : Nat → Nat)
    (allowed : Nat → Bool) (ordered : AncestryOrdered (documentAgent g))
    (genesis : g.parent g.root = none) (i p before : Nat)
    (bound : owner i < g.size) (parent : g.parent (owner i) = some p)
    (state : agentStateAt (documentAgent g) p = some (.active before)) :
    (documentEvents g size owner allowed).authorized i = true ↔
      allowed i = true ∧ ∃ after,
        advanceAgent (documentAgent g) (owner i) (.active before) = some after := by
  simp only [documentEvents, Bool.and_eq_true, decide_eq_true_eq, bound, true_and]
  rw [document_authorization_matches g ordered genesis (owner i) p before bound parent state]
  exact and_comm

/-- Signed predecessor depth supplies the interleaved stopping measure even
when several event ranks identify the same operation. -/
theorem document_events_descending (g : DocumentGraph) (size : Nat) (owner : Nat → Nat)
    (allowed : Nat → Bool) (ordered : AncestryOrdered (documentAgent g))
    (bounded : DepthBounded (documentAgent g)) :
    InterleavedDescending (documentEvents g size owner allowed) owner := by
  intro p i ok
  exact agent_model_acyclic (documentAgent g) ordered bounded p (owner i)
    (document_event_eligible g size owner allowed p i ok)

/-- Decoding a retained interleaved path preserves signed predecessor edges and
predecessor-document authorization. No selected-history equality is assumed. -/
theorem document_event_path (g : DocumentGraph) (size : Nat) (owner : Nat → Nat)
    (allowed : Nat → Bool) (events : List Nat) (p : Nat) (path : List Nat)
    (valid : InterleavedValid (documentEvents g size owner allowed) owner events p path) :
    ValidPath (agentModel (documentAgent g)) (events.map owner) p (path.map owner) := by
  induction valid with
  | nil => exact .nil _
  | cons member ok tail ih =>
    exact .cons (List.mem_map.mpr ⟨_, member, rfl⟩)
      (document_event_eligible g size owner allowed _ _ ok) ih

/-- The bounded interleaved loop selects a path that actually executes using
successive predecessor documents, and ends at its ancestry-derived state.
This includes method replacement/removal and terminal deletion. -/
theorem interleaved_document_converges (g : DocumentGraph) (size : Nat) (owner : Nat → Nat)
    (allowed : Nat → Bool) (ordered : AncestryOrdered (documentAgent g))
    (bounded : DepthBounded (documentAgent g)) (genesis : g.parent g.root = none)
    (events : List Nat) (p : Nat) (path : List Nat) (before : AgentState)
    (valid : InterleavedValid (documentEvents g size owner allowed) owner events p path)
    (state : agentStateAt (documentAgent g) p = some before) :
    ∃ result final,
      interleavedUntilStable (documentEvents g size owner allowed) owner p events
        ((documentEvents g size owner allowed).level p + 1) path = some result ∧
      result = interleavedSuffix (documentEvents g size owner allowed) owner events
        ((documentEvents g size owner allowed).level p) p ∧
      runAgent (documentAgent g) before (result.map owner) = some final ∧
      agentStateAt (documentAgent g) (pathTip p (result.map owner)) = some final := by
  let m := documentEvents g size owner allowed
  have descending := document_events_descending g size owner allowed ordered bounded
  have complete := interleaved_suffix_complete m owner events descending (m.level p) p (Nat.le_refl _)
  have decoded := document_event_path g size owner allowed events p _
    (interleaved_complete_valid m owner events _ _ complete)
  obtain ⟨final, ran, atTip⟩ := valid_agent_path_runs (documentAgent g) ordered genesis
    (events.map owner) p _ decoded before state
  exact ⟨_, final, interleaved_replay_converges m owner events p path descending valid, rfl, ran, atTip⟩

/-- Equal retained event sets give the same ranked path and decoded document
result, independently of delivery order and valid warm starting branch. -/
theorem interleaved_document_same_evidence (g : DocumentGraph) (size : Nat) (owner : Nat → Nat)
    (allowed : Nat → Bool) (ordered : AncestryOrdered (documentAgent g))
    (bounded : DepthBounded (documentAgent g)) (xs ys : List Nat) (p : Nat)
    (left right : List Nat) (before : AgentState)
    (lv : InterleavedValid (documentEvents g size owner allowed) owner xs p left)
    (rv : InterleavedValid (documentEvents g size owner allowed) owner ys p right)
    (same : ∀ i, i ∈ xs ↔ i ∈ ys) :
    (interleavedUntilStable (documentEvents g size owner allowed) owner p xs
      ((documentEvents g size owner allowed).level p + 1) left).map (fun path =>
        (path, (runAgent (documentAgent g) before (path.map owner)).map (documentResult g))) =
    (interleavedUntilStable (documentEvents g size owner allowed) owner p ys
      ((documentEvents g size owner allowed).level p + 1) right).map (fun path =>
        (path, (runAgent (documentAgent g) before (path.map owner)).map (documentResult g))) := by
  rw [interleaved_replay_same_evidence (documentEvents g size owner allowed) owner xs ys p left right
    (document_events_descending g size owner allowed ordered bounded) lv rv same]

end Archon
