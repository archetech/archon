import FullReplay
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
      ``Archon.cold_replay_converges, ``Archon.cold_replay_same_evidence,
      ``Archon.settled_scan_unchanged, ``Archon.record_pass_eq_map,
      ``Archon.record_pass_preserves_path, ``Archon.record_pass_idempotent,
      ``Archon.record_loop_terminates, ``Archon.event_import_ids,
      ``Archon.event_pass_complete, ``Archon.full_warm_converges,
      ``Archon.full_cold_converges, ``Archon.full_cold_same_operations,
      ``Archon.valid_path_nodup, ``Archon.history_step_genesis] do
    let dependencies ← Lean.collectAxioms theoremName
    for dependency in dependencies do
      unless allowed.contains dependency do
        throwError "{theoremName} uses an unapproved axiom: {dependency}"
    logInfo m!"{theoremName}: axiom allowlist passed ({dependencies})"
