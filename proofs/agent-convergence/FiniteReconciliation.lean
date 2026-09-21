import AssetReceiptViews

set_option warningAsError true
namespace Archon

/-- Execute every member of a finite family. A failed member makes the entire
phase fail; no default result can conceal exhausted replay fuel. -/
def collectFinite : (n : Nat) → (Fin n → Option α) → Option (Fin n → α)
  | 0, _ => some Fin.elim0
  | n + 1, step => do
    let first ← step 0
    let rest ← collectFinite n (fun i => step i.succ)
    pure (Fin.cases first rest)

theorem collect_finite_total (n : Nat) (step : Fin n → Option α)
    (total : ∀ i, ∃ value, step i = some value) :
    ∃ result, collectFinite n step = some result ∧ ∀ i, step i = some (result i) := by
  induction n with
  | zero => exact ⟨Fin.elim0, rfl, fun i => Fin.elim0 i⟩
  | succ n ih =>
    obtain ⟨first, head⟩ := total 0
    obtain ⟨rest, tail, correct⟩ := ih (fun i => step i.succ) (fun i => total i.succ)
    refine ⟨Fin.cases first rest, ?_, ?_⟩
    · simp [collectFinite, head, tail]
    · intro i; exact Fin.cases head correct i

theorem collect_finite_correct (n : Nat) (step : Fin n → Option α) (result : Fin n → α)
    (ran : collectFinite n step = some result) : ∀ i, step i = some (result i) := by
  induction n with
  | zero => exact fun i => Fin.elim0 i
  | succ n ih =>
    cases head : step 0 with
    | none => simp [collectFinite, head] at ran
    | some first =>
      cases tail : collectFinite n (fun i => step i.succ) with
      | none => simp [collectFinite, head, tail] at ran
      | some rest =>
        have equal : Fin.cases first rest = result := by simpa [collectFinite, head, tail] using ran
        rw [← equal]
        exact fun i => Fin.cases head (ih _ rest tail) i

end Archon
