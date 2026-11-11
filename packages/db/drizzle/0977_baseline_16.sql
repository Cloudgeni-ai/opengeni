-- deployment-mode: rolling
-- Opengeni baseline part 16 of 22: the schema as of migration 0977,
-- replacing migrations 0000-0977 (see packages/db/src/migration-baseline.ts).
-- A fresh database runs every part; a database that applied all of 0000-0977
-- records the parts without running them. The runner replaces {{schema}},
-- {{schema_oid}}, {{owner}} and {{migrated_at}} with the migration session's
-- current schema, its OID, the current user and now().

ALTER TABLE ONLY subscription_leases
    ADD CONSTRAINT subscription_leases_workspace_id_account_id_fkey FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY subscription_leases
    ADD CONSTRAINT subscription_leases_account_id_session_id_fkey FOREIGN KEY (account_id, session_id) REFERENCES sessions(account_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY subscription_leases
    ADD CONSTRAINT subscription_leases_account_id_provider_connection_id_fkey FOREIGN KEY (account_id, provider, connection_id) REFERENCES subscription_connections(account_id, provider, id) ON DELETE RESTRICT;

ALTER TABLE ONLY subscription_leases
    ADD CONSTRAINT subscription_leases_workspace_id_turn_id_fkey FOREIGN KEY (workspace_id, turn_id) REFERENCES session_turns(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY subscription_capacity_waiters
    ADD CONSTRAINT subscription_capacity_waiters_workspace_id_account_id_fkey FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY subscription_capacity_waiters
    ADD CONSTRAINT subscription_capacity_waiters_account_id_session_id_fkey FOREIGN KEY (account_id, session_id) REFERENCES sessions(account_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY subscription_capacity_waiters
    ADD CONSTRAINT subscription_capacity_waiters_workspace_id_turn_id_fkey FOREIGN KEY (workspace_id, turn_id) REFERENCES session_turns(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY subscription_turn_failures
    ADD CONSTRAINT subscription_turn_failures_workspace_id_account_id_fkey FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY subscription_turn_failures
    ADD CONSTRAINT subscription_turn_failures_account_id_session_id_fkey FOREIGN KEY (account_id, session_id) REFERENCES sessions(account_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY subscription_turn_failures
    ADD CONSTRAINT subscription_turn_failures_workspace_id_turn_id_fkey FOREIGN KEY (workspace_id, turn_id) REFERENCES session_turns(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY subscription_turn_failures
    ADD CONSTRAINT subscription_turn_failures_account_id_provider_connection__fkey FOREIGN KEY (account_id, provider, connection_id) REFERENCES subscription_connections(account_id, provider, id) ON DELETE CASCADE;

ALTER TABLE ONLY subscription_apps_designations
    ADD CONSTRAINT subscription_apps_designations_workspace_id_account_id_fkey FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY subscription_apps_designations
    ADD CONSTRAINT subscription_apps_designations_account_id_connection_id_fkey FOREIGN KEY (account_id, connection_id) REFERENCES subscription_connections(account_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY subscription_provider_cutovers
    ADD CONSTRAINT subscription_provider_cutovers_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY model_call_facts
    ADD CONSTRAINT model_call_facts_subscription_connection_fk FOREIGN KEY (account_id, connection_id) REFERENCES subscription_connections(account_id, id) ON DELETE SET NULL (connection_id) NOT VALID;

ALTER TABLE ONLY subscription_capacity_wake_outbox
    ADD CONSTRAINT subscription_capacity_wake_outbox_account_id_workspace_id_fkey FOREIGN KEY (account_id, workspace_id) REFERENCES workspaces(account_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY subscription_capacity_wake_outbox
    ADD CONSTRAINT subscription_capacity_wake_outbox_account_id_waiter_id_fkey FOREIGN KEY (account_id, waiter_id) REFERENCES subscription_capacity_waiters(account_id, waiter_id) ON DELETE CASCADE;

ALTER TABLE ONLY subscription_connection_assignment_policies
    ADD CONSTRAINT subscription_connection_assignmen_account_id_connection_id_fkey FOREIGN KEY (account_id, connection_id) REFERENCES subscription_connections(account_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY subscription_connection_assignment_policies
    ADD CONSTRAINT subscription_connection_assignment_account_id_workspace_id_fkey FOREIGN KEY (account_id, workspace_id) REFERENCES workspaces(account_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY subscription_connection_assignment_policies
    ADD CONSTRAINT subscription_connection_assig_account_id_managed_by_worksp_fkey FOREIGN KEY (account_id, managed_by_workspace_id) REFERENCES workspaces(account_id, id) ON DELETE SET NULL (managed_by_workspace_id);

ALTER TABLE ONLY subscription_operation_leases
    ADD CONSTRAINT subscription_operation_leases_account_id_workspace_id_fkey FOREIGN KEY (account_id, workspace_id) REFERENCES workspaces(account_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY subscription_operation_leases
    ADD CONSTRAINT subscription_operation_leases_account_id_session_id_fkey FOREIGN KEY (account_id, session_id) REFERENCES sessions(account_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY subscription_operation_leases
    ADD CONSTRAINT subscription_operation_leases_workspace_id_turn_id_fkey FOREIGN KEY (workspace_id, turn_id) REFERENCES session_turns(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY subscription_operation_leases
    ADD CONSTRAINT subscription_operation_leases_account_id_provider_connecti_fkey FOREIGN KEY (account_id, provider, connection_id) REFERENCES subscription_connections(account_id, provider, id) ON DELETE RESTRICT;

ALTER TABLE ONLY session_content_blobs
    ADD CONSTRAINT session_content_blobs_session_fk FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_content_blobs
    ADD CONSTRAINT session_content_blobs_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.session_turn_delta_folds
    ADD CONSTRAINT session_turn_delta_folds_turn_fk FOREIGN KEY (turn_id) REFERENCES session_turns(id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.inbox_items
    ADD CONSTRAINT inbox_items_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.inbox_items
    ADD CONSTRAINT inbox_items_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.subscription_core_auto_assignments
    ADD CONSTRAINT subscription_codex_auto_assignmen_account_id_connection_id_fkey FOREIGN KEY (account_id, connection_id) REFERENCES subscription_connections(account_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY organization_model_defaults
    ADD CONSTRAINT organization_model_defaults_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY organization_agent_admin_access
    ADD CONSTRAINT organization_agent_admin_access_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_admin_access
    ADD CONSTRAINT session_admin_access_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_admin_access
    ADD CONSTRAINT session_admin_access_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_admin_access
    ADD CONSTRAINT session_admin_access_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY enrollment_token_redemptions
    ADD CONSTRAINT enrollment_token_redemptions_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY enrollment_token_redemptions
    ADD CONSTRAINT enrollment_token_redemptions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY enrollment_token_redemptions
    ADD CONSTRAINT enrollment_token_redemptions_enrollment_id_fkey FOREIGN KEY (enrollment_id) REFERENCES enrollments(id) ON DELETE SET NULL;

ALTER TABLE ONLY opengeni_private.inbox_member_notify_optins
    ADD CONSTRAINT inbox_member_notify_optins_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY subscription_settings
    ADD CONSTRAINT subscription_settings_codex_primary_provider_fkey FOREIGN KEY (account_id, codex_primary_provider, codex_primary_connection_id) REFERENCES subscription_connections(account_id, provider, id) ON DELETE SET NULL (codex_primary_connection_id);

ALTER TABLE ONLY subscription_settings
    ADD CONSTRAINT subscription_settings_claude_primary_provider_fkey FOREIGN KEY (account_id, claude_primary_provider, claude_primary_connection_id) REFERENCES subscription_connections(account_id, provider, id) ON DELETE SET NULL (claude_primary_connection_id);

ALTER TABLE ONLY subscription_settings
    ADD CONSTRAINT subscription_settings_xai_primary_provider_fkey FOREIGN KEY (account_id, xai_primary_provider, xai_primary_connection_id) REFERENCES subscription_connections(account_id, provider, id) ON DELETE SET NULL (xai_primary_connection_id);

ALTER TABLE ONLY opengeni_private.subscription_core_plan_change_providers
    ADD CONSTRAINT subscription_core_plan_change_providers_provider_fkey FOREIGN KEY (provider) REFERENCES opengeni_private.subscription_core_providers(provider);

ALTER TABLE ONLY opengeni_private.subscription_core_auto_assignments
    ADD CONSTRAINT subscription_codex_auto_assignments_provider_fkey FOREIGN KEY (provider) REFERENCES opengeni_private.subscription_core_providers(provider);

ALTER TABLE ONLY opengeni_private.subscription_authority_compat
    ADD CONSTRAINT subscription_authority_compat_session_fk FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.subscription_authority_compat
    ADD CONSTRAINT subscription_authority_compat_turn_fk FOREIGN KEY (workspace_id, turn_id) REFERENCES session_turns(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.subscription_authority_compat
    ADD CONSTRAINT subscription_authority_compat_task_fk FOREIGN KEY (scheduled_task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.subscription_authority_compat
    ADD CONSTRAINT subscription_authority_compat_revision_fk FOREIGN KEY (scheduled_task_id, task_authority_revision) REFERENCES scheduled_task_revision_authorities(task_id, task_authority_revision) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.subscription_authority_compat
    ADD CONSTRAINT subscription_authority_compat_update_fk FOREIGN KEY (workspace_id, system_update_id) REFERENCES session_system_updates(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.subscription_authority_compat
    ADD CONSTRAINT subscription_authority_compat_outbox_fk FOREIGN KEY (outbox_id) REFERENCES session_system_update_outbox(id) ON DELETE CASCADE;

ALTER TABLE ONLY organization_privacy_preferences
    ADD CONSTRAINT organization_privacy_preferences_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY vaults
    ADD CONSTRAINT vaults_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY vaults
    ADD CONSTRAINT vaults_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY vaults
    ADD CONSTRAINT vaults_authority_fk FOREIGN KEY (authority_id, account_id, owner_organization_membership_id) REFERENCES organization_user_resource_authorities(id, account_id, organization_membership_id) ON DELETE RESTRICT;

ALTER TABLE ONLY vaults
    ADD CONSTRAINT vaults_origin_workspace_fk FOREIGN KEY (origin_workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE SET NULL (origin_workspace_id);

ALTER TABLE ONLY vaults
    ADD CONSTRAINT vaults_root_session_fk FOREIGN KEY (workspace_id, root_session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY vault_items
    ADD CONSTRAINT vault_items_vault_fk FOREIGN KEY (vault_id, account_id) REFERENCES vaults(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY vault_item_fields
    ADD CONSTRAINT vault_item_fields_item_id_fkey FOREIGN KEY (item_id) REFERENCES vault_items(id) ON DELETE CASCADE;

ALTER TABLE ONLY vault_items
    ADD CONSTRAINT vault_items_primary_field_fk FOREIGN KEY (primary_field_id) REFERENCES vault_item_fields(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY vault_field_versions
    ADD CONSTRAINT vault_field_versions_field_id_fkey FOREIGN KEY (field_id) REFERENCES vault_item_fields(id) ON DELETE CASCADE;

ALTER TABLE ONLY vault_item_name_aliases
    ADD CONSTRAINT vault_item_name_aliases_vault_id_fkey FOREIGN KEY (vault_id) REFERENCES vaults(id) ON DELETE CASCADE;

ALTER TABLE ONLY vault_item_name_aliases
    ADD CONSTRAINT vault_item_name_aliases_item_id_fkey FOREIGN KEY (item_id) REFERENCES vault_items(id) ON DELETE CASCADE;

ALTER TABLE ONLY vault_name_aliases
    ADD CONSTRAINT vault_name_aliases_vault_id_fkey FOREIGN KEY (vault_id) REFERENCES vaults(id) ON DELETE CASCADE;

ALTER TABLE ONLY vault_passkey_leases
    ADD CONSTRAINT vault_passkey_leases_item_id_fkey FOREIGN KEY (item_id) REFERENCES vault_items(id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.subscription_core_auto_assignments
    ADD CONSTRAINT subscription_core_auto_assignments_connection_provider_fkey FOREIGN KEY (account_id, provider, connection_id) REFERENCES subscription_connections(account_id, provider, id) ON DELETE CASCADE;

ALTER TABLE ONLY scheduled_task_schedule_outbox
    ADD CONSTRAINT scheduled_task_schedule_outbox_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY scheduled_task_schedule_outbox
    ADD CONSTRAINT scheduled_task_schedule_outbox_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.session_usage_limit_roots
    ADD CONSTRAINT session_usage_limit_roots_workspace_id_account_id_fkey FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.session_usage_limit_roots
    ADD CONSTRAINT session_usage_limit_roots_root_session_id_fkey FOREIGN KEY (root_session_id) REFERENCES sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.session_usage_limit_receipts
    ADD CONSTRAINT session_usage_limit_receipts_workspace_id_root_session_id_fkey FOREIGN KEY (workspace_id, root_session_id) REFERENCES opengeni_private.session_usage_limit_roots(workspace_id, root_session_id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.session_usage_limit_config_receipts
    ADD CONSTRAINT session_usage_limit_config_re_workspace_id_root_session_id_fkey FOREIGN KEY (workspace_id, root_session_id) REFERENCES opengeni_private.session_usage_limit_roots(workspace_id, root_session_id) ON DELETE CASCADE;

ALTER TABLE ONLY site_data_collections
    ADD CONSTRAINT site_data_collections_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY site_data_collections
    ADD CONSTRAINT site_data_collections_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY site_data_collections
    ADD CONSTRAINT site_data_collections_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY site_data_collections
    ADD CONSTRAINT site_data_collections_site_fk FOREIGN KEY (workspace_id, site_id) REFERENCES workspace_artifacts(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY site_data_records
    ADD CONSTRAINT site_data_records_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY site_data_records
    ADD CONSTRAINT site_data_records_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY site_data_records
    ADD CONSTRAINT site_data_records_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY site_data_records
    ADD CONSTRAINT site_data_records_collection_fk FOREIGN KEY (workspace_id, site_id, collection_id) REFERENCES site_data_collections(workspace_id, site_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY site_data_record_values
    ADD CONSTRAINT site_data_record_values_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY site_data_record_values
    ADD CONSTRAINT site_data_record_values_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY site_data_record_values
    ADD CONSTRAINT site_data_record_values_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY site_data_record_values
    ADD CONSTRAINT site_data_record_values_record_fk FOREIGN KEY (workspace_id, record_id) REFERENCES site_data_records(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY site_data_files
    ADD CONSTRAINT site_data_files_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY site_data_files
    ADD CONSTRAINT site_data_files_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY site_data_files
    ADD CONSTRAINT site_data_files_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY site_data_files
    ADD CONSTRAINT site_data_files_site_fk FOREIGN KEY (workspace_id, site_id) REFERENCES workspace_artifacts(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY site_data_usage
    ADD CONSTRAINT site_data_usage_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY site_data_usage
    ADD CONSTRAINT site_data_usage_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY site_data_usage
    ADD CONSTRAINT site_data_usage_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY site_data_usage
    ADD CONSTRAINT site_data_usage_site_fk FOREIGN KEY (workspace_id, site_id) REFERENCES workspace_artifacts(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY site_data_rate_windows
    ADD CONSTRAINT site_data_rate_windows_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY site_data_rate_windows
    ADD CONSTRAINT site_data_rate_windows_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY site_data_rate_windows
    ADD CONSTRAINT site_data_rate_windows_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY site_data_rate_windows
    ADD CONSTRAINT site_data_rate_windows_site_fk FOREIGN KEY (workspace_id, site_id) REFERENCES workspace_artifacts(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY site_data_validation_windows
    ADD CONSTRAINT site_data_validation_windows_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY site_data_validation_windows
    ADD CONSTRAINT site_data_validation_windows_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY site_data_validation_windows
    ADD CONSTRAINT site_data_validation_windows_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY site_data_validation_windows
    ADD CONSTRAINT site_data_validation_windows_site_fk FOREIGN KEY (workspace_id, site_id) REFERENCES workspace_artifacts(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY site_data_workspace_validation_windows
    ADD CONSTRAINT site_data_workspace_validation_windows_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY site_data_workspace_validation_windows
    ADD CONSTRAINT site_data_workspace_validation_windows_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY site_data_workspace_validation_windows
    ADD CONSTRAINT site_data_workspace_validation_windows_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY site_publications
    ADD CONSTRAINT site_publications_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY site_publications
    ADD CONSTRAINT site_publications_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY site_publications
    ADD CONSTRAINT site_publications_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY site_publications
    ADD CONSTRAINT site_publications_site_fk FOREIGN KEY (workspace_id, site_id) REFERENCES workspace_artifacts(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY site_hostnames
    ADD CONSTRAINT site_hostnames_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY site_hostnames
    ADD CONSTRAINT site_hostnames_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY site_hostnames
    ADD CONSTRAINT site_hostnames_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY site_hostnames
    ADD CONSTRAINT site_hostnames_site_fk FOREIGN KEY (workspace_id, site_id) REFERENCES workspace_artifacts(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY site_auth_codes
    ADD CONSTRAINT site_auth_codes_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY site_auth_codes
    ADD CONSTRAINT site_auth_codes_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY site_auth_codes
    ADD CONSTRAINT site_auth_codes_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY site_auth_codes
    ADD CONSTRAINT site_auth_codes_site_fk FOREIGN KEY (workspace_id, site_id) REFERENCES workspace_artifacts(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY site_viewer_sessions
    ADD CONSTRAINT site_viewer_sessions_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY site_viewer_sessions
    ADD CONSTRAINT site_viewer_sessions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY site_viewer_sessions
    ADD CONSTRAINT site_viewer_sessions_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY site_viewer_sessions
    ADD CONSTRAINT site_viewer_sessions_site_fk FOREIGN KEY (workspace_id, site_id) REFERENCES workspace_artifacts(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY site_limit_profiles
    ADD CONSTRAINT site_limit_profiles_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY site_limit_profiles
    ADD CONSTRAINT site_limit_profiles_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY site_runtime_conversations
    ADD CONSTRAINT site_runtime_conversations_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY site_runtime_conversations
    ADD CONSTRAINT site_runtime_conversations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY site_runtime_conversations
    ADD CONSTRAINT site_runtime_conversations_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY site_runtime_conversations
    ADD CONSTRAINT site_runtime_conversations_site_fk FOREIGN KEY (workspace_id, site_id) REFERENCES workspace_artifacts(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY site_runtime_usage
    ADD CONSTRAINT site_runtime_usage_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY site_runtime_usage
    ADD CONSTRAINT site_runtime_usage_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY site_runtime_usage
    ADD CONSTRAINT site_runtime_usage_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY site_runtime_usage
    ADD CONSTRAINT site_runtime_usage_site_fk FOREIGN KEY (workspace_id, site_id) REFERENCES workspace_artifacts(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY site_runtime_rate_windows
    ADD CONSTRAINT site_runtime_rate_windows_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY site_runtime_rate_windows
    ADD CONSTRAINT site_runtime_rate_windows_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY site_runtime_rate_windows
    ADD CONSTRAINT site_runtime_rate_windows_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY site_runtime_rate_windows
    ADD CONSTRAINT site_runtime_rate_windows_site_fk FOREIGN KEY (workspace_id, site_id) REFERENCES workspace_artifacts(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY site_abuse_reports
    ADD CONSTRAINT site_abuse_reports_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY site_abuse_reports
    ADD CONSTRAINT site_abuse_reports_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY site_abuse_reports
    ADD CONSTRAINT site_abuse_reports_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY site_abuse_reports
    ADD CONSTRAINT site_abuse_reports_site_fk FOREIGN KEY (workspace_id, site_id) REFERENCES workspace_artifacts(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY site_sql_databases
    ADD CONSTRAINT site_sql_databases_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY site_sql_databases
    ADD CONSTRAINT site_sql_databases_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY site_sql_databases
    ADD CONSTRAINT site_sql_databases_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY site_sql_databases
    ADD CONSTRAINT site_sql_databases_site_fk FOREIGN KEY (workspace_id, site_id) REFERENCES workspace_artifacts(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY site_sql_usage
    ADD CONSTRAINT site_sql_usage_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY site_sql_usage
    ADD CONSTRAINT site_sql_usage_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY site_sql_usage
    ADD CONSTRAINT site_sql_usage_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY site_sql_usage
    ADD CONSTRAINT site_sql_usage_database_fk FOREIGN KEY (workspace_id, site_id) REFERENCES site_sql_databases(workspace_id, site_id) ON DELETE CASCADE;

ALTER TABLE ONLY site_sql_migrations
    ADD CONSTRAINT site_sql_migrations_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY site_sql_migrations
    ADD CONSTRAINT site_sql_migrations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY site_sql_migrations
    ADD CONSTRAINT site_sql_migrations_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY site_sql_migrations
    ADD CONSTRAINT site_sql_migrations_database_fk FOREIGN KEY (workspace_id, site_id) REFERENCES site_sql_databases(workspace_id, site_id) ON DELETE CASCADE;

ALTER TABLE ONLY site_sql_queries
    ADD CONSTRAINT site_sql_queries_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY site_sql_queries
    ADD CONSTRAINT site_sql_queries_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY site_sql_queries
    ADD CONSTRAINT site_sql_queries_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY site_sql_queries
    ADD CONSTRAINT site_sql_queries_database_fk FOREIGN KEY (workspace_id, site_id) REFERENCES site_sql_databases(workspace_id, site_id) ON DELETE CASCADE;

ALTER TABLE ONLY site_sql_rate_windows
    ADD CONSTRAINT site_sql_rate_windows_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY site_sql_rate_windows
    ADD CONSTRAINT site_sql_rate_windows_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY site_sql_rate_windows
    ADD CONSTRAINT site_sql_rate_windows_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY site_sql_rate_windows
    ADD CONSTRAINT site_sql_rate_windows_site_fk FOREIGN KEY (workspace_id, site_id) REFERENCES workspace_artifacts(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY site_platform_storage
    ADD CONSTRAINT site_platform_storage_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY site_platform_usage
    ADD CONSTRAINT site_platform_usage_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY site_platform_usage
    ADD CONSTRAINT site_platform_usage_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY scheduled_task_blocker_reviews
    ADD CONSTRAINT scheduled_task_blocker_reviews_task_id_fkey FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE;

ALTER TABLE ONLY scheduled_task_blocker_reviews
    ADD CONSTRAINT scheduled_task_blocker_reviews_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY scheduled_task_blocker_reviews
    ADD CONSTRAINT scheduled_task_blocker_reviews_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY billing_subscription_operations
    ADD CONSTRAINT billing_subscription_operations_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY organization_plans
    ADD CONSTRAINT organization_plans_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY plan_credit_periods
    ADD CONSTRAINT plan_credit_periods_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY plan_credit_periods
    ADD CONSTRAINT plan_credit_periods_catalog_revision_fkey FOREIGN KEY (catalog_revision) REFERENCES opengeni_private.subscription_plan_catalog_revisions(revision);

ALTER TABLE ONLY plan_credit_periods
    ADD CONSTRAINT plan_credit_periods_grant_entry_id_account_id_fkey FOREIGN KEY (grant_entry_id, account_id) REFERENCES credit_ledger_entries(id, account_id);

ALTER TABLE ONLY plan_credit_periods
    ADD CONSTRAINT plan_credit_periods_expiry_entry_id_account_id_fkey FOREIGN KEY (expiry_entry_id, account_id) REFERENCES credit_ledger_entries(id, account_id);

ALTER TABLE ONLY opengeni_private.insights_usage_hourly_rollups
    ADD CONSTRAINT insights_usage_hourly_rollups_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.insights_usage_hourly_backfill
    ADD CONSTRAINT insights_usage_hourly_backfill_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY browser_session_retained_downloads
    ADD CONSTRAINT browser_session_retained_downloads_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY browser_session_retained_downloads
    ADD CONSTRAINT browser_session_retained_downloads_browser_fk FOREIGN KEY (workspace_id, browser_session_id) REFERENCES browser_sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY browser_session_retained_downloads
    ADD CONSTRAINT browser_session_retained_downloads_file_fk FOREIGN KEY (account_id, workspace_id, file_id) REFERENCES files(account_id, workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY session_turn_machine_consents
    ADD CONSTRAINT session_turn_machine_consents_workspace_id_turn_id_fkey FOREIGN KEY (workspace_id, turn_id) REFERENCES session_turns(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY session_attempt_machine_consents
    ADD CONSTRAINT session_attempt_machine_consents_attempt_id_fkey FOREIGN KEY (attempt_id) REFERENCES session_turn_attempts(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_attempt_machine_consents
    ADD CONSTRAINT session_attempt_machine_consents_consent_id_fkey FOREIGN KEY (consent_id) REFERENCES session_turn_machine_consents(id) ON DELETE CASCADE;

ALTER TABLE ONLY site_session_access
    ADD CONSTRAINT site_session_access_workspace_id_account_id_fkey FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY site_session_access
    ADD CONSTRAINT site_session_access_workspace_id_site_id_fkey FOREIGN KEY (workspace_id, site_id) REFERENCES workspace_artifacts(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY site_session_access
    ADD CONSTRAINT site_session_access_workspace_id_session_id_fkey FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY session_title_operations
    ADD CONSTRAINT session_title_operations_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_title_operations
    ADD CONSTRAINT session_title_operations_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY session_title_operations
    ADD CONSTRAINT session_title_operations_session_fk FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY session_title_operations
    ADD CONSTRAINT session_title_operations_turn_fk FOREIGN KEY (workspace_id, source_turn_id) REFERENCES session_turns(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY session_title_operations
    ADD CONSTRAINT session_title_operations_attempt_fk FOREIGN KEY (workspace_id, source_attempt_id) REFERENCES session_turn_attempts(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY connections
    ADD CONSTRAINT connections_origin_workspace_fk FOREIGN KEY (origin_workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.subscription_usage_readings
    ADD CONSTRAINT subscription_usage_readings_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.subscription_usage_readings
    ADD CONSTRAINT subscription_usage_readings_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES subscription_connections(id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.subscription_usage_calls
    ADD CONSTRAINT subscription_usage_calls_fact_id_fkey FOREIGN KEY (fact_id) REFERENCES model_call_facts(id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.subscription_usage_calls
    ADD CONSTRAINT subscription_usage_calls_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.subscription_usage_calls
    ADD CONSTRAINT subscription_usage_calls_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES subscription_connections(id) ON DELETE CASCADE;

ALTER TABLE ONLY model_call_fact_reconciliation_progress
    ADD CONSTRAINT model_call_fact_reconciliation_pro_workspace_id_account_id_fkey FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY model_call_fact_reconciliation_candidates
    ADD CONSTRAINT model_call_fact_reconciliation_can_workspace_id_account_id_fkey FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY site_opens
    ADD CONSTRAINT site_opens_workspace_id_account_id_fkey FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY site_opens
    ADD CONSTRAINT site_opens_workspace_id_site_id_fkey FOREIGN KEY (workspace_id, site_id) REFERENCES workspace_artifacts(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY session_message_search_texts
    ADD CONSTRAINT session_message_search_texts_event_fk FOREIGN KEY (workspace_id, session_id, sequence) REFERENCES session_events(workspace_id, session_id, sequence) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_change_proposals
    ADD CONSTRAINT knowledge_change_proposals_scope_workspace_account_fk FOREIGN KEY (scope_workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_change_proposals
    ADD CONSTRAINT knowledge_change_proposals_scope_workspace_id_fkey FOREIGN KEY (scope_workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_claim_evidence
    ADD CONSTRAINT knowledge_claim_evidence_scope_workspace_account_fk FOREIGN KEY (scope_workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_claim_evidence
    ADD CONSTRAINT knowledge_claim_evidence_scope_workspace_id_fkey FOREIGN KEY (scope_workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_claim_relations
    ADD CONSTRAINT knowledge_claim_relations_scope_workspace_account_fk FOREIGN KEY (scope_workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_claim_relations
    ADD CONSTRAINT knowledge_claim_relations_scope_workspace_id_fkey FOREIGN KEY (scope_workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_claim_reviews
    ADD CONSTRAINT knowledge_claim_reviews_scope_workspace_account_fk FOREIGN KEY (scope_workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_claim_reviews
    ADD CONSTRAINT knowledge_claim_reviews_scope_workspace_id_fkey FOREIGN KEY (scope_workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_claims
    ADD CONSTRAINT knowledge_claims_scope_workspace_account_fk FOREIGN KEY (scope_workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_claims
    ADD CONSTRAINT knowledge_claims_scope_workspace_id_fkey FOREIGN KEY (scope_workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_document_versions
    ADD CONSTRAINT knowledge_document_versions_scope_workspace_account_fk FOREIGN KEY (scope_workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_document_versions
    ADD CONSTRAINT knowledge_document_versions_scope_workspace_id_fkey FOREIGN KEY (scope_workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_entities
    ADD CONSTRAINT knowledge_entities_scope_workspace_account_fk FOREIGN KEY (scope_workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_entities
    ADD CONSTRAINT knowledge_entities_scope_workspace_id_fkey FOREIGN KEY (scope_workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_entity_aliases
    ADD CONSTRAINT knowledge_entity_aliases_scope_workspace_account_fk FOREIGN KEY (scope_workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_entity_aliases
    ADD CONSTRAINT knowledge_entity_aliases_scope_workspace_id_fkey FOREIGN KEY (scope_workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_facts
    ADD CONSTRAINT knowledge_facts_scope_workspace_account_fk FOREIGN KEY (scope_workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_facts
    ADD CONSTRAINT knowledge_facts_scope_workspace_id_fkey FOREIGN KEY (scope_workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_lifecycle_events
    ADD CONSTRAINT knowledge_lifecycle_events_scope_workspace_account_fk FOREIGN KEY (scope_workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_lifecycle_events
    ADD CONSTRAINT knowledge_lifecycle_events_scope_workspace_id_fkey FOREIGN KEY (scope_workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_memory_lifecycle_events
    ADD CONSTRAINT knowledge_memory_lifecycle_events_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_memory_relationships
    ADD CONSTRAINT knowledge_memory_relationships_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_operation_receipts
    ADD CONSTRAINT knowledge_operation_receipts_scope_workspace_account_fk FOREIGN KEY (scope_workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_operation_receipts
    ADD CONSTRAINT knowledge_operation_receipts_scope_workspace_id_fkey FOREIGN KEY (scope_workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_providers
    ADD CONSTRAINT knowledge_providers_scope_workspace_account_fk FOREIGN KEY (scope_workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_providers
    ADD CONSTRAINT knowledge_providers_scope_workspace_id_fkey FOREIGN KEY (scope_workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_source_acl_versions
    ADD CONSTRAINT knowledge_source_acl_versions_scope_workspace_account_fk FOREIGN KEY (scope_workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_source_acl_versions
    ADD CONSTRAINT knowledge_source_acl_versions_scope_workspace_id_fkey FOREIGN KEY (scope_workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_source_objects
    ADD CONSTRAINT knowledge_source_objects_scope_workspace_account_fk FOREIGN KEY (scope_workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_source_objects
    ADD CONSTRAINT knowledge_source_objects_scope_workspace_id_fkey FOREIGN KEY (scope_workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_sources
    ADD CONSTRAINT knowledge_sources_scope_workspace_account_fk FOREIGN KEY (scope_workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_sources
    ADD CONSTRAINT knowledge_sources_scope_workspace_id_fkey FOREIGN KEY (scope_workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_sync_runs
    ADD CONSTRAINT knowledge_sync_runs_scope_workspace_account_fk FOREIGN KEY (scope_workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_sync_runs
    ADD CONSTRAINT knowledge_sync_runs_scope_workspace_id_fkey FOREIGN KEY (scope_workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY attached_browser_devices
    ADD CONSTRAINT attached_browser_devices_enrollment_fk FOREIGN KEY (workspace_id, enrollment_id) REFERENCES enrollments(workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY attached_browser_inventories
    ADD CONSTRAINT attached_browser_inventories_enrollment_fk FOREIGN KEY (workspace_id, enrollment_id) REFERENCES enrollments(workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY auth_runs
    ADD CONSTRAINT auth_runs_site_auth_connection_fk FOREIGN KEY (workspace_id, site_auth_connection_id) REFERENCES site_auth_connections(workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY automation_runs
    ADD CONSTRAINT automation_runs_event_fk FOREIGN KEY (workspace_id, source_id, event_id) REFERENCES automation_trigger_events(workspace_id, source_id, id) DEFERRABLE;

ALTER TABLE ONLY automation_runs
    ADD CONSTRAINT automation_runs_source_fk FOREIGN KEY (workspace_id, source_id) REFERENCES automation_sources(workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY automation_runs
    ADD CONSTRAINT automation_runs_trigger_revision_fk FOREIGN KEY (trigger_id, trigger_revision) REFERENCES automation_trigger_revisions(trigger_id, revision) DEFERRABLE;

ALTER TABLE ONLY automation_runs
    ADD CONSTRAINT automation_runs_trigger_source_fk FOREIGN KEY (workspace_id, trigger_id, source_id) REFERENCES automation_triggers(workspace_id, id, source_id) DEFERRABLE;

ALTER TABLE ONLY browser_identities
    ADD CONSTRAINT browser_identities_default_revision_fk FOREIGN KEY (id, default_revision_id) REFERENCES browser_revisions(identity_id, id) DEFERRABLE;

ALTER TABLE ONLY browser_revision_components
    ADD CONSTRAINT browser_revision_components_artifact_fk FOREIGN KEY (workspace_id, artifact_id, artifact_purpose, source_browser_session_id, kind) REFERENCES browser_state_artifacts(workspace_id, id, purpose, source_browser_session_id, kind) DEFERRABLE;

ALTER TABLE ONLY browser_revisions
    ADD CONSTRAINT browser_revisions_identity_fk FOREIGN KEY (workspace_id, identity_id) REFERENCES browser_identities(workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY browser_revisions
    ADD CONSTRAINT browser_revisions_parent_fk FOREIGN KEY (identity_id, parent_revision_id) REFERENCES browser_revisions(identity_id, id) DEFERRABLE;

ALTER TABLE ONLY browser_revisions
    ADD CONSTRAINT browser_revisions_publication_operation_fk FOREIGN KEY (workspace_id, publication_operation_id) REFERENCES interaction_operations(workspace_id, operation_id) DEFERRABLE;

ALTER TABLE ONLY browser_revisions
    ADD CONSTRAINT browser_revisions_source_session_fk FOREIGN KEY (workspace_id, source_browser_session_id) REFERENCES browser_sessions(workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY browser_sessions
    ADD CONSTRAINT browser_sessions_base_revision_fk FOREIGN KEY (identity_id, base_revision_id) REFERENCES browser_revisions(identity_id, id) DEFERRABLE;

ALTER TABLE ONLY browser_sessions
    ADD CONSTRAINT browser_sessions_create_operation_fk FOREIGN KEY (workspace_id, create_operation_id) REFERENCES interaction_operations(workspace_id, operation_id) DEFERRABLE;

ALTER TABLE ONLY browser_sessions
    ADD CONSTRAINT browser_sessions_identity_fk FOREIGN KEY (workspace_id, identity_id) REFERENCES browser_identities(workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY browser_sessions
    ADD CONSTRAINT browser_sessions_network_route_fk FOREIGN KEY (workspace_id, network_route_id) REFERENCES network_routes(workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY browser_sessions
    ADD CONSTRAINT browser_sessions_private_checkpoint_fk FOREIGN KEY (workspace_id, private_checkpoint_artifact_id) REFERENCES browser_state_artifacts(workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY browser_state_artifacts
    ADD CONSTRAINT browser_state_artifacts_source_session_fk FOREIGN KEY (workspace_id, source_browser_session_id) REFERENCES browser_sessions(workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY browser_state_uploads
    ADD CONSTRAINT browser_state_uploads_committed_artifact_fk FOREIGN KEY (workspace_id, committed_artifact_id, purpose, source_browser_session_id) REFERENCES browser_state_artifacts(workspace_id, id, purpose, source_browser_session_id) DEFERRABLE;

ALTER TABLE ONLY browser_state_uploads
    ADD CONSTRAINT browser_state_uploads_operation_fk FOREIGN KEY (workspace_id, operation_id) REFERENCES interaction_operations(workspace_id, operation_id) DEFERRABLE;

ALTER TABLE ONLY browser_state_uploads
    ADD CONSTRAINT browser_state_uploads_source_session_fk FOREIGN KEY (workspace_id, source_browser_session_id) REFERENCES browser_sessions(workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY capability_api_facets
    ADD CONSTRAINT capability_api_facets_integration_facet_id_fkey FOREIGN KEY (integration_facet_id) REFERENCES capability_integration_facets(facet_id) DEFERRABLE;

ALTER TABLE ONLY capability_facet_installations
    ADD CONSTRAINT capability_facet_installations_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES connections(id) DEFERRABLE;

ALTER TABLE ONLY capability_facet_installations
    ADD CONSTRAINT capability_facet_installations_facet_id_fkey FOREIGN KEY (facet_id) REFERENCES capability_facets(id) DEFERRABLE;

ALTER TABLE ONLY capability_mcp_facets
    ADD CONSTRAINT capability_mcp_facets_integration_facet_id_fkey FOREIGN KEY (integration_facet_id) REFERENCES capability_integration_facets(facet_id) DEFERRABLE;

ALTER TABLE ONLY capability_plugin_installations
    ADD CONSTRAINT capability_plugin_installations_plugin_id_fkey FOREIGN KEY (plugin_id) REFERENCES capability_plugins(id) DEFERRABLE;

ALTER TABLE ONLY capability_plugin_installations
    ADD CONSTRAINT capability_plugin_installations_plugin_version_fk FOREIGN KEY (plugin_id, plugin_version_id) REFERENCES capability_plugin_versions(plugin_id, id) DEFERRABLE;

ALTER TABLE ONLY company_brain_preference_proposal_receipts
    ADD CONSTRAINT company_brain_preference_proposal_re_knowledge_proposal_id_fkey FOREIGN KEY (knowledge_proposal_id) REFERENCES knowledge_change_proposals(id) DEFERRABLE;

ALTER TABLE ONLY company_profile_agent_automatic_activation_receipts
    ADD CONSTRAINT company_profile_agent_automatic_activations_proposal_fk FOREIGN KEY (proposal_receipt_id, account_id) REFERENCES company_profile_agent_proposal_receipts(id, account_id) DEFERRABLE;

ALTER TABLE ONLY company_profile_agent_confirmation_receipts
    ADD CONSTRAINT company_profile_agent_confirmations_proposal_fk FOREIGN KEY (proposal_receipt_id, account_id) REFERENCES company_profile_agent_proposal_receipts(id, account_id) DEFERRABLE;

ALTER TABLE ONLY composer_drafts
    ADD CONSTRAINT composer_drafts_source_turn_fk FOREIGN KEY (workspace_id, source_turn_id) REFERENCES session_turns(workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY computer_sessions
    ADD CONSTRAINT computer_sessions_create_operation_fk FOREIGN KEY (workspace_id, create_operation_id) REFERENCES interaction_operations(workspace_id, operation_id) DEFERRABLE;

ALTER TABLE ONLY document_chunks
    ADD CONSTRAINT document_chunks_authority_workspace_fk FOREIGN KEY (authority_workspace_id, account_id) REFERENCES workspaces(id, account_id) DEFERRABLE;

ALTER TABLE ONLY document_chunks
    ADD CONSTRAINT document_chunks_file_id_fkey FOREIGN KEY (file_id) REFERENCES files(id) DEFERRABLE;

ALTER TABLE ONLY documents
    ADD CONSTRAINT documents_authority_workspace_fk FOREIGN KEY (authority_workspace_id, account_id) REFERENCES workspaces(id, account_id) DEFERRABLE;

ALTER TABLE ONLY documents
    ADD CONSTRAINT documents_file_id_fkey FOREIGN KEY (file_id) REFERENCES files(id) DEFERRABLE;

ALTER TABLE ONLY generated_video_artifacts
    ADD CONSTRAINT generated_video_artifacts_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES video_generation_operations(id) DEFERRABLE;

ALTER TABLE ONLY generated_video_artifacts
    ADD CONSTRAINT generated_video_artifacts_primary_file_id_fkey FOREIGN KEY (primary_file_id) REFERENCES files(id) DEFERRABLE;

ALTER TABLE ONLY generated_video_artifacts
    ADD CONSTRAINT generated_video_artifacts_workspace_file_scope_fk FOREIGN KEY (account_id, workspace_id, primary_file_id) REFERENCES files(account_id, workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY google_drive_object_acl_evidence
    ADD CONSTRAINT google_drive_object_acl_evidence_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES connections(id) DEFERRABLE;

ALTER TABLE ONLY google_drive_object_acl_evidence
    ADD CONSTRAINT google_drive_object_acl_evidence_file_id_fkey FOREIGN KEY (file_id) REFERENCES files(id) DEFERRABLE;

ALTER TABLE ONLY governed_learning_activation_receipts
    ADD CONSTRAINT governed_learning_activation__knowledge_approval_review_id_fkey FOREIGN KEY (knowledge_approval_review_id) REFERENCES knowledge_claim_reviews(id) DEFERRABLE;

ALTER TABLE ONLY governed_learning_activation_receipts
    ADD CONSTRAINT governed_learning_activation__knowledge_previous_review_id_fkey FOREIGN KEY (knowledge_previous_review_id) REFERENCES knowledge_claim_reviews(id) DEFERRABLE;

ALTER TABLE ONLY governed_learning_activation_receipts
    ADD CONSTRAINT governed_learning_activation_receipts_claim_id_fkey FOREIGN KEY (claim_id) REFERENCES knowledge_claims(id) DEFERRABLE;

ALTER TABLE ONLY governed_learning_activation_receipts
    ADD CONSTRAINT governed_learning_activation_receipts_decision_receipt_id_fkey FOREIGN KEY (decision_receipt_id) REFERENCES governed_learning_decision_receipts(id) DEFERRABLE;

ALTER TABLE ONLY governed_learning_activation_receipts
    ADD CONSTRAINT governed_learning_activation_receipts_evidence_id_fkey FOREIGN KEY (evidence_id) REFERENCES knowledge_claim_evidence(id) DEFERRABLE;

ALTER TABLE ONLY governed_learning_activation_receipts
    ADD CONSTRAINT governed_learning_activation_receipts_policy_revision_id_fkey FOREIGN KEY (policy_revision_id) REFERENCES workspace_learning_policy_revisions(id) DEFERRABLE;

ALTER TABLE ONLY governed_learning_activation_receipts
    ADD CONSTRAINT governed_learning_activation_receipts_proposal_id_fkey FOREIGN KEY (proposal_id) REFERENCES knowledge_change_proposals(id) DEFERRABLE;

ALTER TABLE ONLY governed_learning_activation_undo_receipts
    ADD CONSTRAINT governed_learning_activation__knowledge_revocation_review__fkey FOREIGN KEY (knowledge_revocation_review_id) REFERENCES knowledge_claim_reviews(id) DEFERRABLE;

ALTER TABLE ONLY governed_learning_activation_undo_receipts
    ADD CONSTRAINT governed_learning_activation_knowledge_approval_review_id_fkey1 FOREIGN KEY (knowledge_approval_review_id) REFERENCES knowledge_claim_reviews(id) DEFERRABLE;

ALTER TABLE ONLY governed_learning_activation_undo_receipts
    ADD CONSTRAINT governed_learning_activation_undo_re_activation_receipt_id_fkey FOREIGN KEY (activation_receipt_id) REFERENCES governed_learning_activation_receipts(id) DEFERRABLE;

ALTER TABLE ONLY integration_facet_bindings
    ADD CONSTRAINT integration_facet_bindings_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES connections(id) DEFERRABLE;

ALTER TABLE ONLY integration_facet_bindings
    ADD CONSTRAINT integration_facet_bindings_facet_definition_id_fkey FOREIGN KEY (facet_definition_id) REFERENCES integration_facet_definitions(id) DEFERRABLE;

ALTER TABLE ONLY knowledge_change_proposals
    ADD CONSTRAINT knowledge_change_proposals_claim_fk FOREIGN KEY (account_id, claim_id, scope_key) REFERENCES knowledge_claims(account_id, id, scope_key) DEFERRABLE;

ALTER TABLE ONLY knowledge_change_proposals
    ADD CONSTRAINT knowledge_change_proposals_evidence_fk FOREIGN KEY (account_id, evidence_id, claim_id, scope_key) REFERENCES knowledge_claim_evidence(account_id, id, claim_id, scope_key) DEFERRABLE;

ALTER TABLE ONLY knowledge_claim_evidence
    ADD CONSTRAINT knowledge_claim_evidence_claim_fk FOREIGN KEY (account_id, claim_id, scope_key) REFERENCES knowledge_claims(account_id, id, scope_key) DEFERRABLE;

ALTER TABLE ONLY knowledge_claim_evidence
    ADD CONSTRAINT knowledge_claim_evidence_version_fk FOREIGN KEY (account_id, document_version_id, scope_key) REFERENCES knowledge_document_versions(account_id, id, scope_key) DEFERRABLE;

ALTER TABLE ONLY knowledge_claim_relations
    ADD CONSTRAINT knowledge_claim_relations_from_fk FOREIGN KEY (account_id, from_claim_id, scope_key) REFERENCES knowledge_claims(account_id, id, scope_key) DEFERRABLE;

ALTER TABLE ONLY knowledge_claim_relations
    ADD CONSTRAINT knowledge_claim_relations_to_fk FOREIGN KEY (account_id, to_claim_id, scope_key) REFERENCES knowledge_claims(account_id, id, scope_key) DEFERRABLE;

ALTER TABLE ONLY knowledge_claim_reviews
    ADD CONSTRAINT knowledge_claim_reviews_claim_fk FOREIGN KEY (account_id, claim_id, scope_key) REFERENCES knowledge_claims(account_id, id, scope_key) DEFERRABLE;

ALTER TABLE ONLY knowledge_claims
    ADD CONSTRAINT knowledge_claims_fact_fk FOREIGN KEY (account_id, fact_id, scope_key) REFERENCES knowledge_facts(account_id, id, scope_key) DEFERRABLE;

ALTER TABLE ONLY knowledge_document_versions
    ADD CONSTRAINT knowledge_document_versions_acl_fk FOREIGN KEY (account_id, source_id, acl_generation) REFERENCES knowledge_source_acl_versions(account_id, source_id, generation) DEFERRABLE;

ALTER TABLE ONLY knowledge_document_versions
    ADD CONSTRAINT knowledge_document_versions_object_fk FOREIGN KEY (account_id, object_id, source_id, scope_key) REFERENCES knowledge_source_objects(account_id, id, source_id, scope_key) DEFERRABLE;

ALTER TABLE ONLY knowledge_document_versions
    ADD CONSTRAINT knowledge_document_versions_source_fk FOREIGN KEY (account_id, source_id, scope_key) REFERENCES knowledge_sources(account_id, id, scope_key) DEFERRABLE;

ALTER TABLE ONLY knowledge_entity_aliases
    ADD CONSTRAINT knowledge_entity_aliases_entity_fk FOREIGN KEY (account_id, entity_id, scope_key, entity_type) REFERENCES knowledge_entities(account_id, id, scope_key, entity_type) DEFERRABLE;

ALTER TABLE ONLY knowledge_facts
    ADD CONSTRAINT knowledge_facts_object_entity_fk FOREIGN KEY (account_id, object_entity_id, scope_key) REFERENCES knowledge_entities(account_id, id, scope_key) DEFERRABLE;

ALTER TABLE ONLY knowledge_facts
    ADD CONSTRAINT knowledge_facts_subject_fk FOREIGN KEY (account_id, subject_entity_id, scope_key) REFERENCES knowledge_entities(account_id, id, scope_key) DEFERRABLE;

ALTER TABLE ONLY knowledge_lifecycle_events
    ADD CONSTRAINT knowledge_lifecycle_events_object_fk FOREIGN KEY (account_id, object_id, scope_key) REFERENCES knowledge_source_objects(account_id, id, scope_key) DEFERRABLE;

ALTER TABLE ONLY knowledge_lifecycle_events
    ADD CONSTRAINT knowledge_lifecycle_events_provider_fk FOREIGN KEY (account_id, provider_id, scope_key) REFERENCES knowledge_providers(account_id, id, scope_key) DEFERRABLE;

ALTER TABLE ONLY knowledge_lifecycle_events
    ADD CONSTRAINT knowledge_lifecycle_events_source_fk FOREIGN KEY (account_id, source_id, scope_key) REFERENCES knowledge_sources(account_id, id, scope_key) DEFERRABLE;

ALTER TABLE ONLY knowledge_memory_lifecycle_events
    ADD CONSTRAINT knowledge_memory_lifecycle_events_actor_attempt_fk FOREIGN KEY (workspace_id, actor_attempt_id) REFERENCES session_turn_attempts(workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY knowledge_memory_lifecycle_events
    ADD CONSTRAINT knowledge_memory_lifecycle_events_actor_session_fk FOREIGN KEY (workspace_id, actor_session_id) REFERENCES sessions(workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY knowledge_memory_lifecycle_events
    ADD CONSTRAINT knowledge_memory_lifecycle_events_actor_turn_fk FOREIGN KEY (workspace_id, actor_turn_id) REFERENCES session_turns(workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY knowledge_memory_lifecycle_events
    ADD CONSTRAINT knowledge_memory_lifecycle_events_related_fk FOREIGN KEY (workspace_id, related_memory_id) REFERENCES knowledge_memories(workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY knowledge_memory_lifecycle_events
    ADD CONSTRAINT knowledge_memory_lifecycle_events_relationship_fk FOREIGN KEY (workspace_id, relationship_id) REFERENCES knowledge_memory_relationships(workspace_id, id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY knowledge_memory_lifecycle_events
    ADD CONSTRAINT knowledge_memory_lifecycle_events_reverts_fk FOREIGN KEY (workspace_id, reverts_event_id) REFERENCES knowledge_memory_lifecycle_events(workspace_id, id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY knowledge_memory_lifecycle_events
    ADD CONSTRAINT knowledge_memory_lifecycle_events_target_fk FOREIGN KEY (workspace_id, target_memory_id) REFERENCES knowledge_memories(workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY knowledge_memory_relationships
    ADD CONSTRAINT knowledge_memory_relationships_created_event_fk FOREIGN KEY (workspace_id, created_by_event_id) REFERENCES knowledge_memory_lifecycle_events(workspace_id, id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY knowledge_memory_relationships
    ADD CONSTRAINT knowledge_memory_relationships_removed_event_fk FOREIGN KEY (workspace_id, removed_by_event_id) REFERENCES knowledge_memory_lifecycle_events(workspace_id, id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY knowledge_memory_relationships
    ADD CONSTRAINT knowledge_memory_relationships_source_fk FOREIGN KEY (workspace_id, source_memory_id) REFERENCES knowledge_memories(workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY knowledge_memory_relationships
    ADD CONSTRAINT knowledge_memory_relationships_target_fk FOREIGN KEY (workspace_id, target_memory_id) REFERENCES knowledge_memories(workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY knowledge_source_acl_versions
    ADD CONSTRAINT knowledge_source_acl_versions_source_fk FOREIGN KEY (account_id, source_id, source_scope_key) REFERENCES knowledge_sources(account_id, id, scope_key) DEFERRABLE;

ALTER TABLE ONLY knowledge_source_objects
    ADD CONSTRAINT knowledge_source_objects_current_version_fk FOREIGN KEY (account_id, id, current_version_id) REFERENCES knowledge_document_versions(account_id, object_id, id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY knowledge_source_objects
    ADD CONSTRAINT knowledge_source_objects_source_fk FOREIGN KEY (account_id, source_id, scope_key) REFERENCES knowledge_sources(account_id, id, scope_key) DEFERRABLE;

ALTER TABLE ONLY knowledge_sources
    ADD CONSTRAINT knowledge_sources_current_acl_fk FOREIGN KEY (account_id, id, current_acl_generation) REFERENCES knowledge_source_acl_versions(account_id, source_id, generation) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY knowledge_sources
    ADD CONSTRAINT knowledge_sources_provider_fk FOREIGN KEY (account_id, provider_id, scope_key) REFERENCES knowledge_providers(account_id, id, scope_key) DEFERRABLE;

ALTER TABLE ONLY knowledge_sync_runs
    ADD CONSTRAINT knowledge_sync_runs_source_fk FOREIGN KEY (account_id, source_id, scope_key) REFERENCES knowledge_sources(account_id, id, scope_key) DEFERRABLE;

ALTER TABLE ONLY machine_removal_operations
    ADD CONSTRAINT machine_removal_operations_enrollment_id_fkey FOREIGN KEY (enrollment_id) REFERENCES enrollments(id) DEFERRABLE;

ALTER TABLE ONLY memory_slack_publications
    ADD CONSTRAINT memory_slack_publications_configuration_id_fkey FOREIGN KEY (configuration_id) REFERENCES memory_slack_publication_configurations(id) DEFERRABLE;

ALTER TABLE ONLY organization_user_resource_grants
    ADD CONSTRAINT organization_user_resource_grants_session_workspace_fk FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY personal_document_once_consumption_receipts
    ADD CONSTRAINT personal_document_once_consumption_receipts_grant_fk FOREIGN KEY (grant_id, account_id) REFERENCES organization_user_resource_grants(id, account_id) DEFERRABLE;

ALTER TABLE ONLY personal_resource_once_consumption_receipts
    ADD CONSTRAINT personal_resource_once_consumption_receipts_grant_fk FOREIGN KEY (grant_id, account_id) REFERENCES organization_user_resource_grants(id, account_id) DEFERRABLE;

ALTER TABLE ONLY retained_screenshot_artifacts
    ADD CONSTRAINT retained_screenshot_artifacts_workspace_file_fk FOREIGN KEY (workspace_id, artifact_id) REFERENCES files(workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY sandbox_pty_sessions
    ADD CONSTRAINT sandbox_pty_sessions_retained_process_scope_fk FOREIGN KEY (account_id, workspace_id, session_id, lease_id, retained_process_id) REFERENCES sandbox_retained_processes(account_id, workspace_id, session_id, lease_id, id) DEFERRABLE;

ALTER TABLE ONLY sandbox_retained_processes
    ADD CONSTRAINT sandbox_retained_processes_parent_admission_scope_fk FOREIGN KEY (account_id, workspace_id, session_id, lease_id, parent_admission_id) REFERENCES sandbox_workspace_mutation_admissions(account_id, workspace_id, session_id, lease_id, id) DEFERRABLE;

ALTER TABLE ONLY sandbox_retained_processes
    ADD CONSTRAINT sandbox_retained_processes_workspace_session_fk FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY sandbox_workspace_mutation_admissions
    ADD CONSTRAINT sandbox_workspace_mutation_admissions_workspace_attempt_fk FOREIGN KEY (workspace_id, attempt_id) REFERENCES session_turn_attempts(workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY sandbox_workspace_mutation_admissions
    ADD CONSTRAINT sandbox_workspace_mutation_admissions_workspace_session_fk FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY sandbox_workspace_mutation_admissions
    ADD CONSTRAINT sandbox_workspace_mutation_admissions_workspace_turn_fk FOREIGN KEY (workspace_id, turn_id) REFERENCES session_turns(workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY scheduled_task_connection_authority_snapshots
    ADD CONSTRAINT scheduled_task_connection_authority_sn_grant_id_account_id_fkey FOREIGN KEY (grant_id, account_id) REFERENCES organization_user_resource_grants(id, account_id) DEFERRABLE;

ALTER TABLE ONLY scheduled_task_personal_resource_snapshots
    ADD CONSTRAINT scheduled_task_personal_resource_snapshots_grant_fk FOREIGN KEY (grant_id, account_id) REFERENCES organization_user_resource_grants(id, account_id) DEFERRABLE;

ALTER TABLE ONLY scheduled_task_run_connection_authority_snapshots
    ADD CONSTRAINT scheduled_task_run_connection_authorit_grant_id_account_id_fkey FOREIGN KEY (grant_id, account_id) REFERENCES organization_user_resource_grants(id, account_id) DEFERRABLE;

ALTER TABLE ONLY scheduled_task_run_personal_resource_admissions
    ADD CONSTRAINT scheduled_task_run_personal_resource_admissions_task_fk FOREIGN KEY (task_id, task_authority_revision) REFERENCES scheduled_task_personal_resource_authorities(task_id, task_authority_revision) DEFERRABLE;

ALTER TABLE ONLY scheduled_task_run_personal_resource_once_receipts
    ADD CONSTRAINT scheduled_task_run_personal_resource_once_receipts_grant_fk FOREIGN KEY (grant_id, account_id) REFERENCES organization_user_resource_grants(id, account_id) DEFERRABLE;

ALTER TABLE ONLY scheduled_task_run_personal_resource_snapshots
    ADD CONSTRAINT scheduled_task_run_personal_resource_snapshots_task_fk FOREIGN KEY (task_id, task_authority_revision, resource_kind, resource_id) REFERENCES scheduled_task_personal_resource_snapshots(task_id, task_authority_revision, resource_kind, resource_id) DEFERRABLE;

ALTER TABLE ONLY scheduled_tasks
    ADD CONSTRAINT scheduled_tasks_environment_id_fkey FOREIGN KEY (variable_set_id) REFERENCES workspace_variable_sets(id) DEFERRABLE;

ALTER TABLE ONLY session_attempt_connected_machine_authorizations
    ADD CONSTRAINT session_attempt_connected_machine_grant_fk FOREIGN KEY (grant_id, account_id) REFERENCES organization_user_resource_grants(id, account_id) DEFERRABLE;

ALTER TABLE ONLY session_attempt_interruptions
    ADD CONSTRAINT session_attempt_interruptions_attempt_fk FOREIGN KEY (workspace_id, attempt_id) REFERENCES session_turn_attempts(workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY session_attempt_interruptions
    ADD CONSTRAINT session_attempt_interruptions_operation_fk FOREIGN KEY (workspace_id, operation_id) REFERENCES session_command_receipts(workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY session_attempt_personal_document_snapshots
    ADD CONSTRAINT session_attempt_personal_document_snapshots_grant_fk FOREIGN KEY (grant_id, account_id) REFERENCES organization_user_resource_grants(id, account_id) DEFERRABLE;

ALTER TABLE ONLY session_attempt_personal_resource_snapshots
    ADD CONSTRAINT session_attempt_personal_resource_snapshots_grant_fk FOREIGN KEY (grant_id, account_id) REFERENCES organization_user_resource_grants(id, account_id) DEFERRABLE;

ALTER TABLE ONLY session_background_commands
    ADD CONSTRAINT session_background_commands_control_workspace_fk FOREIGN KEY (control_workspace_id, account_id) REFERENCES workspaces(id, account_id) DEFERRABLE;

ALTER TABLE ONLY session_background_commands
    ADD CONSTRAINT session_background_commands_process_fk FOREIGN KEY (retained_process_id) REFERENCES sandbox_retained_processes(id) DEFERRABLE;

ALTER TABLE ONLY session_command_receipts
    ADD CONSTRAINT session_command_receipts_actor_attempt_fk FOREIGN KEY (workspace_id, actor_attempt_id) REFERENCES session_turn_attempts(workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY session_command_receipts
    ADD CONSTRAINT session_command_receipts_target_turn_fk FOREIGN KEY (workspace_id, target_turn_id) REFERENCES session_turns(workspace_id, id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY session_events
    ADD CONSTRAINT session_events_duplicate_of_event_fk FOREIGN KEY (duplicate_of_event_id) REFERENCES session_events(id) DEFERRABLE;

ALTER TABLE ONLY session_events
    ADD CONSTRAINT session_events_workspace_attempt_fk FOREIGN KEY (workspace_id, turn_attempt_id) REFERENCES session_turn_attempts(workspace_id, id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY session_goal_revisions
    ADD CONSTRAINT session_goal_revisions_actor_attempt_fk FOREIGN KEY (workspace_id, actor_attempt_id) REFERENCES session_turn_attempts(workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY session_goal_revisions
    ADD CONSTRAINT session_goal_revisions_actor_turn_fk FOREIGN KEY (workspace_id, actor_turn_id) REFERENCES session_turns(workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY session_goal_revisions
    ADD CONSTRAINT session_goal_revisions_proposal_fk FOREIGN KEY (workspace_id, proposal_id) REFERENCES session_goal_revisions(workspace_id, id) DEFERRABLE;
