import ControllerSelection

set_option warningAsError true
namespace Archon.ControllerExamples

-- Small kernel-checked rule examples; B3 supplies the signed runtime bridge.
def graph : DocumentGraph where
  size := 3
  root := 0
  initialDocument := 0
  parent := fun i => if i = 0 then none else some (i - 1)
  depth := id
  action := fun i => if i = 2 then .deactivate else .rotate 1
  documents := fun i => [⟨0, i⟩]
  named := fun _ => 0
  signatureValid := fun _ _ => true

def patch : Nat → ComponentPatch Nat Nat := fun _ => ⟨none, none⟩
def root : AgentReceiptView := ⟨0, true, .chain ⟨1, [10], 10, true⟩⟩
def rotation : AgentReceiptView := ⟨1, true, .chain ⟨1, [20], 30, true⟩⟩
def deletion : AgentReceiptView := ⟨2, true, .chain ⟨1, [30], 20, true⟩⟩
def history := [root, rotation, deletion]
def select (request : ControllerRequest) (events := history) :=
  (selectController graph patch 0 0 1 id (· == 0) request events).map ComponentState.authority

-- Same-chain ordinal excludes equal positions and ignores nonmonotone time.
example : select ⟨100, some ⟨1, [20], 40, true⟩⟩ = some (.active 0) := by decide
example : select ⟨100, some ⟨1, [25], 15, true⟩⟩ = some (.active 1) := by decide
example : select ⟨0, some ⟨1, [31], 0, true⟩⟩ = some .deleted := by decide
-- Cross-chain time never skips the rotation to reach a backdated deletion.
example : select ⟨100, some ⟨2, [100], 25, true⟩⟩ = some (.active 0) := by decide
example : select ⟨0, some ⟨2, [0], 30, true⟩⟩ = some .deleted := by decide
-- Missing anchoring metadata and direct/gossip operations use proof time.
example : select ⟨25, some ⟨1, [31], 100, false⟩⟩ = some (.active 0) := by decide
example : select ⟨30, none⟩ = some .deleted := by decide
example : select ⟨100, none⟩ [] = none := by decide
-- A confirmation gap truncates both controller selection and the anchoring scan.
example : select ⟨100, none⟩ [root, { rotation with matching := false, cutoff := .unconfirmed }, deletion] =
    some (.active 0) := by decide
-- The whole confirmed prefix determines anchoring, even after the bounded version.
example : select ⟨100, some ⟨1, [15], 15, true⟩⟩
    [root, { rotation with cutoff := .chain ⟨1, [20], 30, false⟩ }, deletion] =
    some .deleted := by decide
-- Migration to an unanchored registry in the selected version forces fallback.
example : (selectController graph (fun i => if i = 1 then ⟨none, some 0⟩ else patch i)
    0 0 1 id (· == 0) ⟨100, some ⟨1, [25], 15, true⟩⟩ history).map ComponentState.authority =
    some .deleted := by decide
-- Genesis is not excluded by a time before its creation (current protocol behavior).
example : select ⟨0, none⟩ = some (.active 0) := by decide

end Archon.ControllerExamples
