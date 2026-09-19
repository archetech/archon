import OperationalReplay
import Lean.Util.CollectAxioms
import Lean.Elab.Command

set_option warningAsError true

open Lean Elab Command in
run_cmd do
  let allowed := #[``propext, ``Quot.sound]
  for theoremName in #[``Archon.convergence, ``Archon.complete_unique,
      ``Archon.history_delivery_permutation, ``Archon.history_duplicate_delivery,
      ``Archon.terminal_histories_agree, ``Archon.import_eq_insert,
      ``Archon.rounds_eq_suffix, ``Archon.operational_replay_converges,
      ``Archon.cold_replay_converges, ``Archon.cold_replay_same_evidence] do
    let dependencies ← Lean.collectAxioms theoremName
    for dependency in dependencies do
      unless allowed.contains dependency do
        throwError "{theoremName} uses an unapproved axiom: {dependency}"
    logInfo m!"{theoremName}: axiom allowlist passed ({dependencies})"
