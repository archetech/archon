import IntegratedAgentConvergence
import AgentSourceRecords
import ReceiptViews
import AgentColdRecords
import ColdInterleaved
import AgentFullRecords
import InterleavedRecords
import AgentEventProjection
import AgentRegistry
import SerializedReplay
import AgentAuthorization
import DocumentAuthorization
import AgentComponents
import ChainAnchors
import ChainSuccessors
import InterleavedReplay
import InterleavedBound
import PriorityProjection
import InterleavedAuthorization
import ChainDocuments
import RegistryAncestry
import RegistryAnchors
import RegistryPriority
import RegistryInterleaved
import Lean.Util.CollectAxioms
import Lean.Elab.Command

set_option warningAsError true

open Lean Elab Command in
run_cmd do
  let allowed := #[``propext, ``Quot.sound]
  for theoremName in #[``Archon.normalize_source_provisional, ``Archon.normalize_sources_present, ``Archon.integrated_agent_execution, ``Archon.same_sources_of_check, ``Archon.integrated_agent_convergence, ``Archon.normalize_source_ids, ``Archon.normalize_source_matching, ``Archon.normalize_sources_membership, ``Archon.agent_sources_same_receipt_view, ``Archon.agent_receipt_view_class, ``Archon.component_cold_same_receipt_view, ``Archon.ranked_lookup_preserves, ``Archon.promote_preserves, ``Archon.record_step_preserves, ``Archon.ranked_pass_preserves, ``Archon.stop_preserves, ``Archon.cold_ranked_provenance, ``Archon.settle_expected_of_member, ``Archon.fixed_record_expected, ``Archon.fixed_record_flags_agree, ``Archon.record_views_of_ids, ``Archon.fixed_record_views_agree, ``Archon.cold_ranked_same_view,
      ``Archon.component_event_owner_bound, ``Archon.component_event_level_bound,
      ``Archon.cold_component_descending, ``Archon.cold_component_genesis, ``Archon.cold_component_root_eligible,
      ``Archon.component_cold_full_replay, ``Archon.component_cold_same_state, ``Archon.genesis_valid_tail, ``Archon.genesis_model_descending, ``Archon.genesis_model_eligible,
      ``Archon.cold_without_genesis, ``Archon.cold_ranked_converges, ``Archon.registry_sibling_cid_priority, ``Archon.component_full_replay, ``Archon.component_full_same_state, ``Archon.ranked_lookup_ids, ``Archon.ranked_import_ids,
      ``Archon.ranked_pass_ids, ``Archon.ranked_lookup_unchanged, ``Archon.ranked_import_complete,
      ``Archon.ranked_pass_complete, ``Archon.ranked_pass_settles, ``Archon.ranked_rounds_ids,
      ``Archon.ranked_full_converges, ``Archon.ranked_full_same_semantics, ``Archon.component_priority_bound, ``Archon.component_priority_allowed,
      ``Archon.component_priority_member, ``Archon.component_priority_le,
      ``Archon.component_compiled_eligible, ``Archon.component_event_projection,
      ``Archon.component_interleaved_replay, ``Archon.component_step_registry, ``Archon.component_run_registry,
      ``Archon.component_prefix_authority, ``Archon.component_registry_path,
      ``Archon.component_anchor_after_prefix, ``Archon.component_anchor_from_history,
      ``Archon.evaluate_registry_agrees, ``Archon.registry_at_root,
      ``Archon.registry_at_step, ``Archon.migration_uses_predecessor_registry,
      ``Archon.registry_prefix_agrees, ``Archon.expected_registry_after_prefix,
      ``Archon.receipt_registry_after_prefix,
      ``Archon.siblings_expected_registry, ``Archon.registry_anchor_matches,
      ``Archon.sibling_anchors_same_registry, ``Archon.registry_anchor_after_prefix,
      ``Archon.registry_anchors_same_evidence, ``Archon.registry_anchor_warm_agrees,
      ``Archon.registry_sibling_priority, ``Archon.registry_replay_same_evidence,
      ``Archon.chain_graph_acyclic, ``Archon.registry_model_acyclic,
      ``Archon.registry_event_eligible, ``Archon.registry_events_descending,
      ``Archon.interleaved_registry_cold,
      ``Archon.interleaved_document_priority_converges,
      ``Archon.interleaved_document_priority_cold,
      ``Archon.document_event_eligible, ``Archon.document_event_authorization,
      ``Archon.document_events_descending, ``Archon.document_event_path,
      ``Archon.interleaved_document_converges, ``Archon.interleaved_document_same_evidence,
      ``Archon.priority_projection_winner, ``Archon.priority_projection_suffix,
      ``Archon.interleaved_computes_priority_suffix, ``Archon.interleaved_and_priority_replay_agree,
      ``Archon.interleaved_insert_valid, ``Archon.interleaved_pass_valid,
      ``Archon.interleaved_after_parent, ``Archon.interleaved_pass_fixed_head,
      ``Archon.interleaved_rounds_converge, ``Archon.interleaved_suffix_complete,
      ``Archon.interleaved_replay_converges, ``Archon.interleaved_replay_same_evidence,
      ``Archon.interleaved_duplicate_keeps_suffix,
      ``Archon.interleaved_sibling_truncates, ``Archon.interleaved_insert_head,
      ``Archon.interleaved_pass_head, ``Archon.interleaved_next_settles,
      ``Archon.interleaved_empty_head, ``Archon.interleaved_next_same_evidence,
      ``Archon.bounded_membership_agrees,
      ``Archon.chain_priority_owner, ``Archon.chain_priority_injective,
      ``Archon.chain_priority_same_evidence, ``Archon.chain_graph_same_evidence,
      ``Archon.chain_anchored_order, ``Archon.chain_provisional_order,
      ``Archon.chain_anchor_precedes_provisional, ``Archon.chain_replay_converges,
      ``Archon.chain_successors_same_evidence,
      ``Archon.anchor_scan_min, ``Archon.anchor_scan_from_retained,
      ``Archon.anchor_scan_cold, ``Archon.anchors_same_evidence, ``Archon.anchor_scan_idempotent,
      ``Archon.convergence, ``Archon.complete_unique,
      ``Archon.history_delivery_permutation, ``Archon.history_duplicate_delivery,
      ``Archon.terminal_histories_agree, ``Archon.import_eq_insert,
      ``Archon.rounds_eq_suffix, ``Archon.operational_replay_converges,
      ``Archon.cold_replay_converges, ``Archon.cold_replay_same_evidence,
      ``Archon.settled_scan_unchanged, ``Archon.record_pass_eq_map,
      ``Archon.record_pass_preserves_path, ``Archon.record_pass_idempotent,
      ``Archon.record_loop_terminates, ``Archon.event_import_ids,
      ``Archon.event_pass_complete, ``Archon.full_warm_converges,
      ``Archon.full_cold_converges, ``Archon.full_cold_same_operations,
      ``Archon.valid_path_nodup, ``Archon.history_step_genesis,
      ``Archon.encode_reflects_of_roundtrip, ``Archon.encoded_stop_eq,
      ``Archon.encoded_stop_eq_on_orbit,
      ``Archon.full_cold_loop_converges, ``Archon.serialized_cold_converges,
      ``Archon.decoded_component_graph_eq, ``Archon.component_document_authority, ``Archon.component_step_authority, ``Archon.component_run_authority,
      ``Archon.component_replay_converges, ``Archon.components_same_evidence,
      ``Archon.named_method_verifies, ``Archon.missing_method_rejected,
      ``Archon.document_replacement_uses_predecessor, ``Archon.document_authorization_matches,
      ``Archon.document_replay_converges, ``Archon.document_same_evidence,
      ``Archon.agent_authorization_matches, ``Archon.agent_deleted_terminal,
      ``Archon.agent_rotation_uses_previous_key, ``Archon.rotating_agent_converges,
      ``Archon.rotating_agent_same_evidence, ``Archon.history_wire_roundtrip, ``Archon.serialized_array_converges] do
    let dependencies ← Lean.collectAxioms theoremName
    for dependency in dependencies do
      unless allowed.contains dependency do
        throwError "{theoremName} uses an unapproved axiom: {dependency}"
    logInfo m!"{theoremName}: axiom allowlist passed ({dependencies})"
