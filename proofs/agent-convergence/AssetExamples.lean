import AssetExecution

set_option warningAsError true
namespace Archon.AssetExamples

def controller : ControllerSpec where
  graph := {
    size := 2
    root := 0
    initialDocument := 0
    parent := fun i => if i = 1 then some 0 else none
    depth := id
    action := fun _ => .rotate 1
    documents := fun i => [⟨0, i⟩]
    named := fun _ => 0
    signatureValid := fun _ _ => true }
  patch := fun _ => ⟨none, none⟩
  initialData := 0
  initialRegistry := 1
  registry := id

def table : ControllerTable := fun owner => if owner = 10 ∨ owner = 11 then some controller else none
def genesis : AgentReceiptView := ⟨0, true, .unanchored (some 1) 0⟩
def rotation : AgentReceiptView := ⟨1, true, .unanchored (some 1) 20⟩
def before : ControllerHistories := fun _ => [genesis]
def after : ControllerHistories := fun _ => [genesis, rotation]
def unanchored : Nat → Bool := fun registry => registry ≤ 1

def asset : AssetGraph where
  size := 4
  root := 0
  initialDocument := 0
  initialData := 3
  initialRegistry := 1
  registry := id
  parent := fun i => if i = 0 then none else some (i - 1)
  depth := id
  deletion := fun i => i == 2
  documents := fun i => ⟨100 + i, if i = 0 then 10 else 11⟩
  proposed := fun i => if i = 1 then some 1 else none
  patch := fun i => if i = 1 then ⟨some 4, none⟩ else ⟨none, none⟩
  shape := fun _ => true
  proofTime := fun _ => 30
  named := fun _ => 0
  signer := fun _ => 10
  signature := fun _ key => key == 0

def facts : Nat → ChainReceiptView := fun _ => ⟨2, [1], 10, true⟩
def authorize (g := asset) (histories := before) (operation := 0) :=
  assetReceiptAuthorized g table histories unanchored 0 facts ⟨operation, 1, none⟩

example : authorize = true := by decide
example : authorize asset after = false := by decide
example : authorize { asset with signature := fun _ key => key == 1 } before = false := by decide
example : authorize { asset with signature := fun _ key => key == 1 } after = true := by decide
-- Transfer is signed by the previous owner's key; the prospective agent is active.
example : authorize asset before 1 = true := by decide
example : assetReceiptAuthorized asset table (fun owner => if owner = 11 then [] else before owner)
    unanchored 0 facts ⟨1, 1, none⟩ = false := by decide
-- Agent-only owner table: asset/nonagent DID 12 cannot receive a transfer.
example : authorize { asset with documents := fun i => ⟨i, if i = 0 then 10 else 12⟩ } before 1 = false := by decide
-- Deletion is authorized, but its successor cannot execute.
example : authorize asset before 2 = true := by decide
example : authorize asset before 3 = false := by decide
example : runAssetComponents asset (assetInitial asset) [1, 2] = some ⟨.deleted, 0, 1⟩ := by decide
-- Local-only controllers may create local assets, but not non-local ones.
example : assetReceiptAuthorized asset (fun _ => some { controller with initialRegistry := 0 }) before
    unanchored 0 facts ⟨0, 1, none⟩ = false := by decide
example : assetReceiptAuthorized { asset with initialRegistry := 0 }
    (fun _ => some { controller with initialRegistry := 0 }) before
    unanchored 0 facts ⟨0, 0, none⟩ = true := by decide

def receipts : AssetReceipts := { size := 0, owner := fun _ => 0, registry := fun _ => 1, chain := fun _ => false }
def sources : List (AgentSourceReceipt Nat) := [⟨⟨2, 1, none⟩, 0⟩, ⟨⟨1, 1, none⟩, 1⟩, ⟨⟨0, 1, none⟩, 2⟩]
def records := assetSourceRecords asset receipts table before unanchored 0 facts sources
example : ((stopWhenStable (rankedPass (coldAssetModel asset (assetAnchors asset receipts))
    (chainOwner (assetAnchors asset receipts)) asset.size records) 7 []).map
      (assetResult asset (assetAnchors asset receipts))) = some ([0, 1, 2], some (none, 0, 1)) := by decide
-- Every old-key candidate is rejected after rotation, including genesis.
example : assetSourceRecords asset receipts table after unanchored 0 facts sources = [] := by decide

-- Whole registration values remain distinct even when their registry names agree.
def metadataChange : AssetGraph := { asset with
  patch := fun i => if i = 1 then ⟨some 4, some 9⟩ else ⟨none, none⟩
  registry := fun value => if value = 9 then 1 else value }
example : assetExpected metadataChange 2 = some 1 := by decide
example : runAssetComponents metadataChange (assetInitial metadataChange) [1] =
    some ⟨.active 1, 4, 9⟩ := by decide

end Archon.AssetExamples
