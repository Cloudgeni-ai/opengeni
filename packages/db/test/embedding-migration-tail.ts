import { allowanceMigrationTail } from "./allowance-migration-tail";

/** These migrations extend the post-0299 lifecycle and accepted-work ledgers.
 * Historical cutover fixtures must withhold and replay this entire ordered tail. */
export const embeddingMigrationTail = [
  "0437_organization_scoped_external_workspaces.sql",
  "0438_durable_connect_attempts.sql",
  "0439_external_identity_provisioning.sql",
  "0440_external_workspace_member_removal.sql",
  "0441_external_identity_membership_lifecycle.sql",
  "0442_external_owning_user_authority.sql",
  "0443_host_mcp_binding_registry.sql",
  "0444_host_mcp_delegations.sql",
  "0445_host_mcp_turn_authorities.sql",
  "0446_host_mcp_causal_continuation.sql",
  "0447_host_mcp_task_authorities.sql",
  "0448_host_mcp_child_authority.sql",
  "0449_external_identity_link_lifecycle.sql",
  "0450_external_identity_link_work.sql",
  "0451_external_link_preview_and_permission_ceiling.sql",
  "0452_external_link_scheduled_origin.sql",
  "0453_host_mcp_native_owner.sql",
  "0454_connect_origin_authority.sql",
  "0455_external_link_inventory_labels.sql",
  "0456_social_connection_versions.sql",
  "0457_canonical_session_scope_subject.sql",
  "0458_skill_review_wire_compatibility.sql",
  // Compiles against the linked-authority row type from 0449 and validates
  // scheduled/host authority. It must not run while those prerequisites are
  // marked applied but deliberately absent in a historical cutover fixture.
  "0459_mcp_operations.sql",
  "0461_unified_knowledge.sql",
  // Patches the instruction writer introduced by 0461, so historical fixtures
  // must replay it after that writer rather than before its original creation.
  "0462_agent_instruction_non_destructive_edits.sql",
  "0466_agent_instruction_activation_preservation.sql",
  // Compiles against the Knowledge tables and visibility helper from 0461.
  "0468_knowledge_relationship_projection.sql",
  "0469_knowledge_source_discovery.sql",
  // Patches the read function from withheld 0461; replay after its creation.
  "0640_knowledge_entry_created_since.sql",
  "0478_sender_owned_connections.sql",
  // Replayed 0402/0433 still consume historical Pack tables. Remove them only
  // after those earlier accepted-work and Skill cutovers have completed.
  "0482_remove_packs.sql",
  // Patches the exact Skill lifecycle rewritten by 0461; replay after it.
  "0488_permanent_skill_removal.sql",
  // Rewrites the original-file policy introduced by 0461.
  "0499_session_attachment_access.sql",
  "0501_session_sharing_execution.sql",
  // Reads the cursor table from 0374, withheld by these historical fixtures.
  "0503_session_meaningful_attention.sql",
  // New trial/Knowledge cutovers depend on the 0299 lifecycle and 0461 tables
  // withheld above. Keep historical replay fixtures on their original side.
  "0509_verified_signup_trial_credits.sql",
  "0510_knowledge_index_funding_wait.sql",
  "0511_knowledge_visible_index_status.sql",
  // Patches learning resolvers introduced by the withheld 0461 migration.
  "0515_autonomous_learning_defaults.sql",
  // Patches the 0509 trial grant trigger; replay after it.
  "0521_verified_signup_trial_runtime_switch.sql",
  // Reuses the revision guard installed by withheld 0521; its validation
  // follow-up must run after the original promotional-credit routines.
  "0613_model_scoped_promotional_credits.sql",
  "0615_credit_promotion_policy_validation.sql",
  // Replaces scheduled-run triggers installed by withheld 0275 and 0478.
  "0534_scheduled_admission_diagnostics.sql",
  // References the files scope identity introduced by withheld 0461.
  "0535_slack_file_upload_operations.sql",
  // Replaces scheduled-run triggers installed by withheld-then-replayed 0534.
  "0539_scheduled_admission_refusals.sql",
  // Installs inventory read policies with the session-tenancy fence helper
  // from withheld 0345; replay after it.
  "0547_idle_command_containment.sql",
  "0599_paused_recovery_command_containment.sql",
  // Allowance receipts compile against the withheld Knowledge/embedding and
  // scheduled-refusal lifecycle. Replay them after those prerequisites.
  ...allowanceMigrationTail,
  // Extends the attachment helper from withheld 0499; replay after it.
  "0560_archived_session_imports.sql",
  // Patches the scheduled producer fence after its withheld prerequisites.
  "0561_scheduled_session_agent_identity.sql",
  // Patches the reaper installed by withheld 0345/0388/0391/0397.
  "0564_browser_deadline_checkpoints.sql",
  // Patches the producer fence from withheld 0275/0414/0561; replay after them.
  "0582_scheduled_setup_policy_identity.sql",
  // Replaces the private instruction helper from withheld 0466; replay after it.
  "0584_agent_instruction_size_parity.sql",
  // Extends the cursor table and meaningful index withheld by these fixtures.
  "0585_session_attention_cursor.sql",
  // Clones the 0345 waiter fence and extends the accepted authority ledgers.
  "0598_claude_subscription_account_pools.sql",
  // Uses the existing session inventory/capability routines withheld by these fixtures.
  "0604_insights_raw_usage_api.sql",
  // Patches the sender-owned capture from withheld 0478 and reads the frozen
  // subscription authority installed by withheld 0598; replay after both.
  "0608_receiver_execution_context.sql",
  // Locks connection tables from withheld 0264 and rewrites the exact receipt
  // gates in routines from withheld 0306/0345/0478; replay after them.
  "0611_universal_session_tenancy_activation.sql",
  // Extends the containment reason installed by withheld 0547; replay after it.
  "0614_quiescence_command_containment.sql",
  "0622_organization_slack_bot_delivery.sql",
  // M2 extends the membership finalizer to revoke legacy Claude rows; replay
  // only after the deliberately withheld 0598 Claude tables are restored.
  "0642_shared_subscription_core.sql",
  "0643_model_call_facts_subscription_connection_index.sql",
  "0644_subscription_inference_source_settings.sql",
  "0645_subscription_core_runtime.sql",
  "0646_subscription_core_people_assignment_read.sql",
  // The session storage lifecycle extends the withheld 0560 import guards and
  // reads the 0402 input wait; replay after them.
  "0649_session_content_archive.sql",
  "0650_session_archive_activity.sql",
  "0651_session_event_delta_folding.sql",
  "0652_session_archive_guard_search_path.sql",
  "0653_session_archive_tenancy_fence.sql",
  "0657_session_archive_purge_retained_evidence.sql",
  "0660_session_archive_preference_snapshot_export.sql",
  // The inbox person resolver compiles against scheduled_tasks.owner_subject_id
  // from withheld 0478; replay after it.
  "0661_inbox_subagent_goals_and_schedules.sql",
  // Takes the session-tenancy fence inventory helpers from withheld 0345.
  "0662_session_first_party_default_intent.sql",
  // Replaces the inbox projection trigger from withheld 0661; replay after it
  // so the replayed 0661 body does not overwrite the newer one.
  "0663_inbox_paused_goal_setting.sql",
  // Each rewrites the inbox projection trigger and reads inbox_settings.paused_goals
  // from 0663; replay them after it, in order, so the newest trigger body wins.
  "0664_inbox_rich_notifications.sql",
  "0665_inbox_replies.sql",
  "0666_inbox_reply_current_turn.sql",
  "0667_subscription_authority_refresh_contract.sql",
  "0668_subscription_core_codex_chat_authority.sql",
  "0669_subscription_core_codex_waits.sql",
  "0670_subscription_core_codex_apps.sql",
  "0671_subscription_core_codex_operations.sql",
  // session_hands_back_v1 compiles against sessions.input_wait_turn_id from
  // withheld 0402; replay after it.
  "0674_inbox_reply_hands_back.sql",
  // Redefines 0661's inbox person resolver, which reads
  // scheduled_tasks.owner_subject_id from withheld 0478; replay after 0661.
  "0677_local_human_inbox_recipient.sql",

  // Rewrites the inbox projection and push triggers after 0674 and resolves
  // the session's person through 0661; replay after both so its bodies win.
  "0678_inbox_mute_session_replies.sql",
  // Extends the shared connection table created by withheld 0642.
  "0679_codex_extra_credit_consent.sql",
  "0688_subscription_core_codex_writers.sql",
];
