import InterleavedAuthorization
import PriorityProjection

set_option warningAsError true
namespace Archon

/-- The settled-priority suffix is executable with successive predecessor
 documents because the raw model derives authorization from those documents.
 The projection contract is local eligibility/representation agreement, not an
 assumption about selected paths or final document equality. Genesis is admitted
 separately; registry/position eligibility remains a fixed input. -/
theorem interleaved_document_priority_converges (g : DocumentGraph) (size : Nat)
    (owner priority : Nat → Nat) (allowed : Nat → Bool) (compiled : Model)
    (ordered : AncestryOrdered (documentAgent g)) (bounded : DepthBounded (documentAgent g))
    (genesis : g.parent g.root = none) (events selected : List Nat) (p : Nat)
    (path : List Nat) (before : AgentState)
    (projection : PriorityProjection (documentEvents g size owner allowed) compiled
      owner priority events selected g.size)
    (scope : p < g.size)
    (valid : InterleavedValid (documentEvents g size owner allowed) owner events p path)
    (state : agentStateAt (documentAgent g) p = some before) :
    ∃ result final,
      interleavedUntilStable (documentEvents g size owner allowed) owner p events
        ((documentEvents g size owner allowed).level p + 1) path = some result ∧
      result = suffix compiled selected ((documentEvents g size owner allowed).level p) (priority p) ∧
      runAgent (documentAgent g) before (result.map owner) = some final ∧
      agentStateAt (documentAgent g) (pathTip p (result.map owner)) = some final := by
  obtain ⟨result, final, replay, canonical, ran, atTip⟩ :=
    interleaved_document_converges g size owner allowed ordered bounded genesis events p path before valid state
  refine ⟨result, final, replay, ?_, ran, atTip⟩
  rw [canonical, priority_projection_suffix (documentEvents g size owner allowed) compiled
    owner priority events selected g.size projection _ p scope]

/-- With the admitted genesis and matching depth measure, prepend its selected
rank to identify the result with the compiled model's terminating cold replay. -/
theorem interleaved_document_priority_cold (g : DocumentGraph) (size : Nat)
    (owner priority : Nat → Nat) (allowed : Nat → Bool) (compiled : Model)
    (ordered : AncestryOrdered (documentAgent g)) (bounded : DepthBounded (documentAgent g))
    (genesis : g.parent g.root = none) (rootBound : g.root < g.size)
    (events selected path : List Nat)
    (projection : PriorityProjection (documentEvents g size owner allowed) compiled
      owner priority events selected g.size)
    (valid : InterleavedValid (documentEvents g size owner allowed) owner events g.root path)
    (depth : (documentEvents g size owner allowed).level g.root = compiled.level (priority g.root))
    (acyclic : WellFoundedEdges compiled) (create : compiled.parent (priority g.root) = none)
    (present : priority g.root ∈ selected) :
    ∃ result final,
      interleavedUntilStable (documentEvents g size owner allowed) owner g.root events
        ((documentEvents g size owner allowed).level g.root + 1) path = some result ∧
      replayCold compiled (priority g.root) selected = some (priority g.root :: result) ∧
      runAgent (documentAgent g) (.active g.initialDocument) (result.map owner) = some final ∧
      agentStateAt (documentAgent g) (pathTip g.root (result.map owner)) = some final := by
  obtain ⟨result, final, replay, canonical, ran, atTip⟩ :=
    interleaved_document_priority_converges g size owner priority allowed compiled ordered bounded
      genesis events selected g.root path (.active g.initialDocument) projection rootBound valid
      (agent_state_root (documentAgent g) rootBound)
  refine ⟨result, final, replay, ?_, ran, atTip⟩
  rw [cold_replay_converges compiled (priority g.root) selected acyclic create present,
    canonical, depth]
  rfl

end Archon
