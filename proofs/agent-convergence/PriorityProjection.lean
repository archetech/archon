import InterleavedBound
import ChainSuccessors

set_option warningAsError true
namespace Archon

/-- A local representation contract, not a history-equality assumption.
Every eligible raw event has an eligible no-later preferred copy; compiled
candidates are sound raw evidence and canonical representatives. -/
structure PriorityProjection (raw compiled : Model) (owner priority : Nat → Nat)
    (events selected : List Nat) (operations : Nat) : Prop where
  sameSize : raw.size = compiled.size
  representative : ∀ p, p < operations → ∀ i ∈ events, eligible raw p i = true →
    priority (owner i) ∈ selected ∧ eligible compiled (priority p) (priority (owner i)) = true ∧
      priority (owner i) ≤ i
  sound : ∀ p, p < operations → ∀ i ∈ selected, eligible compiled (priority p) i = true →
    i ∈ events ∧ eligible raw p i = true
  canonical : ∀ p, p < operations → ∀ i ∈ selected, eligible compiled (priority p) i = true →
    i = priority (owner i) ∧ owner i < operations

/-- Removing redundant representations preserves the minimum eligible sibling. -/
theorem priority_projection_winner (raw compiled : Model) (owner priority : Nat → Nat)
    (events selected : List Nat) (operations p : Nat)
    (projection : PriorityProjection raw compiled owner priority events selected operations)
    (scope : p < operations) : winner raw p events = winner compiled (priority p) selected := by
  have rawBound := winner_le_size raw p events
  have compiledBound := winner_le_size compiled (priority p) selected
  have forward : winner compiled (priority p) selected ≤ winner raw p events := by
    by_cases existsRaw : winner raw p events < raw.size
    · obtain ⟨mem, ok⟩ := winner_member raw p events existsRaw
      obtain ⟨repMem, repOk, le⟩ := projection.representative p scope _ mem ok
      have bound := winner_le_member compiled (priority p) _ selected repMem repOk
      omega
    · have sizes := projection.sameSize
      omega
  have backward : winner raw p events ≤ winner compiled (priority p) selected := by
    by_cases existsCompiled : winner compiled (priority p) selected < compiled.size
    · obtain ⟨mem, ok⟩ := winner_member compiled (priority p) selected existsCompiled
      obtain ⟨rawMem, rawOk⟩ := projection.sound p scope _ mem ok
      exact winner_le_member raw p _ events rawMem rawOk
    · have sizes := projection.sameSize
      omega
  omega

/-- The recursive projections agree on complete ranked suffixes, not merely
operation IDs; the contract also keeps every recursive owner within scope. -/
theorem priority_projection_suffix (raw compiled : Model) (owner priority : Nat → Nat)
    (events selected : List Nat) (operations : Nat)
    (projection : PriorityProjection raw compiled owner priority events selected operations)
    (fuel p : Nat) (scope : p < operations) :
    interleavedSuffix raw owner events fuel p = suffix compiled selected fuel (priority p) := by
  induction fuel generalizing p with
  | zero => rfl
  | succ fuel ih =>
    have winners := priority_projection_winner raw compiled owner priority events selected operations p projection scope
    simp only [interleavedSuffix, suffix, winners, projection.sameSize]
    by_cases existsChild : winner compiled (priority p) selected < compiled.size
    · simp only [existsChild, ↓reduceIte]
      obtain ⟨mem, ok⟩ := winner_member compiled (priority p) selected existsChild
      obtain ⟨canonical, inScope⟩ := projection.canonical p scope _ mem ok
      rw [ih _ inScope]
      rw [← canonical]
    · simp only [existsChild, ↓reduceIte]

/-- The convergent interleaved loop computes the settled-priority suffix from
any valid retained starting path. -/
theorem interleaved_computes_priority_suffix (raw compiled : Model) (owner priority : Nat → Nat)
    (events selected : List Nat) (operations p : Nat) (path : List Nat)
    (projection : PriorityProjection raw compiled owner priority events selected operations)
    (scope : p < operations) (descending : InterleavedDescending raw owner)
    (valid : InterleavedValid raw owner events p path) :
    interleavedUntilStable raw owner p events (raw.level p + 1) path =
      some (suffix compiled selected (raw.level p) (priority p)) := by
  rw [interleaved_replay_converges raw owner events p path descending valid,
      priority_projection_suffix raw compiled owner priority events selected operations projection _ p scope]

/-- Include genesis: the virtual predecessor's unique selected create is the
compiled root. The depth relation aligns the virtual edge with the compiled
model, whose cold importer handles genesis separately. -/
theorem interleaved_and_priority_replay_agree (raw compiled : Model) (owner priority : Nat → Nat)
    (events selected : List Nat) (operations virtual root : Nat) (path : List Nat)
    (projection : PriorityProjection raw compiled owner priority events selected operations)
    (scope : root < operations) (descending : InterleavedDescending raw owner)
    (valid : InterleavedValid raw owner events virtual path)
    (depth : raw.level virtual = compiled.level (priority root) + 1)
    (create : winner raw virtual events = priority root)
    (rootBound : priority root < raw.size) (rootOwner : owner (priority root) = root)
    (acyclic : WellFoundedEdges compiled)
    (genesis : compiled.parent (priority root) = none) (present : priority root ∈ selected) :
    interleavedUntilStable raw owner virtual events (raw.level virtual + 1) path =
      replayCold compiled (priority root) selected := by
  rw [interleaved_replay_converges raw owner events virtual path descending valid,
      cold_replay_converges compiled (priority root) selected acyclic genesis present,
      depth]
  simp only [interleavedSuffix, create, rootBound, ↓reduceIte, rootOwner, history]
  rw [priority_projection_suffix raw compiled owner priority events selected operations projection _ root scope]

end Archon
