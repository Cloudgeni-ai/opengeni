-- deployment-mode: rolling
-- Variable Sets were replaced by vaults and are no longer attached to sessions,
-- scheduled tasks or rig versions. Scheduled-run admission, its live re-check
-- at dispatch and the generated-session connection fence stop comparing the
-- retired Variable Set fields, so a task, rig version or target session that
-- still carries a legacy attachment admits like any other. The routines are
-- otherwise unchanged; the Variable Set tables and columns are dropped later.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $install$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION admit_scheduled_agent_run_execution() RETURNS trigger
        LANGUAGE plpgsql SECURITY DEFINER
        SET search_path TO 'pg_catalog', %1$I, 'pg_temp'
        AS $$
    DECLARE
      previous_membership_marker text := current_setting('opengeni.organization_tenancy_lifecycle', true);
      task_row record;
      target_row record;
      latest_started record;
      task_snapshot jsonb;
      target_snapshot jsonb;
      expected_target_session_id uuid;
      connection_subject text;
      connection_subject_count integer;
      personal_resource_subject text;
      personal_resource_subject_count integer;
      revision_authority_subject text;
      revision_authority_membership_id uuid;
      revision_authority_membership_revision bigint;
      accepted_causal_subject text;
      generated_rig record;
      generated_rig_version record;
      generated_slack record;
      workspace_settings jsonb;
      deployment_depth record;
      expected_depth integer;
      expected_depth_source text;
      expected_compaction_mode text;
    BEGIN
      PERFORM set_config('opengeni.organization_tenancy_lifecycle', 'personal_resource_grant_management', true);
      SELECT task.* INTO STRICT task_row
      FROM scheduled_tasks task
      WHERE task.id = NEW.task_id
        AND task.account_id = NEW.account_id
        AND task.workspace_id = NEW.workspace_id
      FOR UPDATE;
      IF task_row.status <> 'active'
        OR task_row.deleted_at IS NOT NULL
        OR NEW.action_kind IS DISTINCT FROM task_row.action ->> 'kind'
      THEN RAISE EXCEPTION 'scheduled run action or task lifecycle changed during admission'
        USING ERRCODE = '42501'; END IF;
      IF NEW.action_kind <> 'agent_turn' THEN
        IF NEW.accepted_execution_snapshot IS NOT NULL
          OR NEW.accepted_execution_digest IS NOT NULL
        THEN RAISE EXCEPTION 'non-agent scheduled run cannot carry agent execution truth'
          USING ERRCODE = '42501'; END IF;
        PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_membership_marker, ''), true); RETURN NEW;
      END IF;
      task_snapshot := NEW.accepted_execution_snapshot -> 'task';
      IF task_row.action ->> 'kind' IS DISTINCT FROM 'agent_turn'
        OR NEW.task_authority_revision IS DISTINCT FROM task_row.authority_revision
        OR NEW.task_execution_digest IS DISTINCT FROM task_row.execution_digest
        OR NEW.accepted_execution_snapshot ->> 'version' IS DISTINCT FROM '1'
        OR NEW.accepted_execution_snapshot -> 'task' ->> 'id' IS DISTINCT FROM NEW.task_id::text
        OR NEW.accepted_execution_snapshot -> 'task' ->> 'accountId'
          IS DISTINCT FROM NEW.account_id::text
        OR NEW.accepted_execution_snapshot -> 'task' ->> 'workspaceId'
          IS DISTINCT FROM NEW.workspace_id::text
        OR (NEW.accepted_execution_snapshot -> 'task' ->> 'authorityRevision')::bigint
          IS DISTINCT FROM NEW.task_authority_revision
        OR NEW.accepted_execution_snapshot -> 'task' ->> 'executionDigest'
          IS DISTINCT FROM NEW.task_execution_digest
        OR NEW.accepted_execution_snapshot -> 'task' ->> 'status' IS DISTINCT FROM 'active'
        OR NEW.accepted_execution_snapshot -> 'task' -> 'action' ->> 'kind'
          IS DISTINCT FROM 'agent_turn'
        OR task_snapshot -> 'schedule' IS DISTINCT FROM task_row.schedule
        OR task_snapshot ->> 'temporalScheduleId' IS DISTINCT FROM task_row.temporal_schedule_id
        OR task_snapshot ->> 'runMode' IS DISTINCT FROM task_row.run_mode
        OR task_snapshot ->> 'overlapPolicy' IS DISTINCT FROM task_row.overlap_policy
        OR task_snapshot -> 'action' IS DISTINCT FROM task_row.action
        OR task_snapshot -> 'agentConfig' IS DISTINCT FROM task_row.agent_config
        OR task_snapshot ->> 'createdBy' IS NULL
        OR task_snapshot -> 'createdBy' ->> 'kind' IS DISTINCT FROM task_row.created_by_kind
        OR task_snapshot -> 'createdBy' ->> 'subjectId'
          IS DISTINCT FROM task_row.created_by_subject_id
        OR task_snapshot -> 'createdByContext' IS DISTINCT FROM task_row.created_by_context
        OR task_snapshot -> 'metadata' IS DISTINCT FROM task_row.metadata
        OR nullif(task_snapshot ->> 'rigId', '')::uuid IS DISTINCT FROM task_row.rig_id
        OR (
          task_row.run_mode = 'existing_session'
          AND (
            nullif(task_snapshot ->> 'targetSessionId', '')::uuid
              IS DISTINCT FROM task_row.reusable_session_id
            OR nullif(task_snapshot ->> 'reusableSessionId', '')::uuid IS NOT NULL
          )
        )
        OR (
          task_row.run_mode <> 'existing_session'
          AND (
            nullif(task_snapshot ->> 'reusableSessionId', '')::uuid
              IS DISTINCT FROM task_row.reusable_session_id
            OR nullif(task_snapshot ->> 'targetSessionId', '')::uuid IS NOT NULL
          )
        )
        OR NEW.accepted_execution_snapshot -> 'xaiProviderAccountAuthoritySnapshot'
          IS DISTINCT FROM task_row.xai_provider_account_authority_snapshot
        OR coalesce(NEW.accepted_execution_snapshot -> 'claudeProviderAccountAuthoritySnapshot',
            '{"version":1,"scope":"workspace"}'::jsonb)
          IS DISTINCT FROM task_row.claude_provider_account_authority_snapshot
      THEN
        RAISE EXCEPTION 'scheduled agent run accepted execution changed during admission'
          USING ERRCODE = '40001';
      END IF;

      SELECT min(selected ->> 'ownerSubjectId'),
          count(DISTINCT selected ->> 'ownerSubjectId')::integer
        INTO connection_subject, connection_subject_count
      FROM jsonb_array_elements(NEW.accepted_execution_snapshot -> 'personalConnectionDelegations') selected
      WHERE nullif(btrim(selected ->> 'ownerSubjectId'), '') IS NOT NULL;
      SELECT min(authority.initiating_human_subject_id),
          count(DISTINCT authority.initiating_human_subject_id)::integer
        INTO personal_resource_subject, personal_resource_subject_count
      FROM scheduled_task_personal_resource_authorities authority
      WHERE authority.task_id = NEW.task_id
        AND authority.task_authority_revision = NEW.task_authority_revision
        AND authority.account_id = NEW.account_id
        AND authority.workspace_id = NEW.workspace_id;
      SELECT authority.subject_id, authority.organization_membership_id,
          authority.membership_authorization_revision
        INTO revision_authority_subject, revision_authority_membership_id,
          revision_authority_membership_revision
      FROM scheduled_task_revision_authorities authority
      WHERE authority.task_id = NEW.task_id
        AND authority.task_authority_revision = NEW.task_authority_revision
        AND authority.account_id = NEW.account_id
        AND authority.workspace_id = NEW.workspace_id;
      IF connection_subject_count > 1
        OR personal_resource_subject_count > 1
        OR NEW.accepted_execution_snapshot ->> 'connectionAuthoritySubjectId'
          IS DISTINCT FROM connection_subject
        OR NEW.accepted_execution_snapshot ->> 'personalResourceAuthoritySubjectId'
          IS DISTINCT FROM personal_resource_subject
        OR (
          revision_authority_subject IS NOT NULL
          AND personal_resource_subject IS NOT NULL
          AND revision_authority_subject IS DISTINCT FROM personal_resource_subject
        )
        OR (
          revision_authority_subject IS NOT NULL
          AND connection_subject IS NOT NULL
          AND revision_authority_subject IS DISTINCT FROM connection_subject
        )
        OR (
          connection_subject IS NOT NULL
          AND personal_resource_subject IS NOT NULL
          AND connection_subject IS DISTINCT FROM personal_resource_subject
        )
        OR (
          task_row.xai_provider_account_authority_snapshot ->> 'scope' = 'user'
          AND (
            task_row.created_by_kind <> 'subject'
            OR NEW.accepted_execution_snapshot ->> 'xaiAuthoritySubjectId'
              IS DISTINCT FROM task_row.created_by_subject_id
            OR (
              connection_subject IS NOT NULL
              AND connection_subject IS DISTINCT FROM task_row.created_by_subject_id
            )
            OR (
              personal_resource_subject IS NOT NULL
              AND personal_resource_subject IS DISTINCT FROM task_row.created_by_subject_id
            )
            OR (
              revision_authority_subject IS NOT NULL
              AND revision_authority_subject IS DISTINCT FROM task_row.created_by_subject_id
            )
          )
        )
        OR (
          task_row.xai_provider_account_authority_snapshot ->> 'scope' <> 'user'
          AND NEW.accepted_execution_snapshot ->> 'xaiAuthoritySubjectId' IS NOT NULL
        )
        OR (
          task_row.claude_provider_account_authority_snapshot ->> 'scope' = 'user'
          AND (
            task_row.owner_subject_id IS NULL
            OR NEW.accepted_execution_snapshot ->> 'claudeAuthoritySubjectId'
              IS DISTINCT FROM task_row.owner_subject_id
            OR (
              task_row.xai_provider_account_authority_snapshot ->> 'scope' = 'user'
              AND NEW.accepted_execution_snapshot ->> 'xaiAuthoritySubjectId'
                IS DISTINCT FROM task_row.owner_subject_id
            )
          )
        )
        OR (
          task_row.claude_provider_account_authority_snapshot ->> 'scope' <> 'user'
          AND NEW.accepted_execution_snapshot ->> 'claudeAuthoritySubjectId' IS NOT NULL
        )
      THEN
        RAISE EXCEPTION 'scheduled accepted causal subject differs from frozen authority'
          USING ERRCODE = '42501';
      END IF;
      accepted_causal_subject := coalesce(
        revision_authority_subject,
        personal_resource_subject,
        connection_subject,
        CASE WHEN task_row.xai_provider_account_authority_snapshot ->> 'scope' = 'user'
          THEN task_row.created_by_subject_id END
      );
      IF NEW.accepted_execution_snapshot ->> 'causalHumanSubjectId'
          IS DISTINCT FROM accepted_causal_subject
        OR NEW.accepted_execution_snapshot -> 'causalHumanAuthority'
          IS DISTINCT FROM (CASE WHEN revision_authority_subject IS NULL THEN 'null'::jsonb
            ELSE jsonb_build_object(
              'subjectId', revision_authority_subject,
              'organizationMembershipId', revision_authority_membership_id,
              'membershipAuthorizationRevision',
                revision_authority_membership_revision
            ) END)
        OR (
          NEW.status = 'queued'
          AND
          revision_authority_subject IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM organization_memberships membership
            WHERE membership.id = revision_authority_membership_id
              AND membership.account_id = NEW.account_id
              AND membership.subject_id = revision_authority_subject
              AND membership.status = 'active'
              AND membership.revoked_at IS NULL
              AND membership.authorization_revision =
                revision_authority_membership_revision
              AND (
                membership.personal_workspace_id = NEW.workspace_id
                OR EXISTS (
                  SELECT 1 FROM workspace_memberships workspace_membership
                  WHERE workspace_membership.account_id = NEW.account_id
                    AND workspace_membership.workspace_id = NEW.workspace_id
                    AND workspace_membership.subject_id = revision_authority_subject
                )
              )
          )
        )
        OR (
          (
            EXISTS (
              SELECT 1 FROM rigs rig
              WHERE rig.account_id = NEW.account_id
                AND rig.authority_scope = 'user'
                AND rig.id IN (
                  task_row.rig_id,
                  nullif(
                    NEW.accepted_execution_snapshot -> 'targetSessionExecution' ->> 'rigId', ''
                  )::uuid
                )
            )
          )
          AND accepted_causal_subject IS NULL
        )
      THEN
        RAISE EXCEPTION 'scheduled accepted causal human is invalid'
          USING ERRCODE = '42501';
      END IF;

      expected_target_session_id := CASE
        WHEN task_row.run_mode = 'existing_session' THEN task_row.reusable_session_id
        WHEN task_row.run_mode = 'reusable_session' THEN task_row.reusable_session_id
        ELSE NULL
      END;
      target_snapshot := NEW.accepted_execution_snapshot -> 'targetSessionExecution';
      -- A targeted occurrence whose exact session no longer exists is a
      -- deterministic terminal outcome for that occurrence, never a retry loop.
      IF task_row.run_mode = 'existing_session' AND expected_target_session_id IS NULL THEN
        NEW.status := 'failed';
        NEW.error := 'scheduled_target_session_unavailable';
        NEW.completed_at := clock_timestamp();
        PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_membership_marker, ''), true); RETURN NEW;
      END IF;
      IF expected_target_session_id IS NULL THEN
        IF target_snapshot IS DISTINCT FROM 'null'::jsonb
          OR NEW.accepted_execution_snapshot -> 'generatedSessionBinding' = 'null'::jsonb
          OR NEW.accepted_execution_snapshot -> 'generatedSessionBinding'
            ->> 'nestedAgentDepthPolicySource' NOT IN ('session','workspace','deployment','default')
          OR (NEW.accepted_execution_snapshot -> 'generatedSessionBinding'
            ->> 'effectiveMaxNestedAgentDepth')::integer < 0
          OR (
            task_row.agent_config ->> 'maxNestedAgentDepth' IS NOT NULL
            AND (
              NEW.accepted_execution_snapshot -> 'generatedSessionBinding'
                ->> 'nestedAgentDepthPolicySource' IS DISTINCT FROM 'session'
              OR (NEW.accepted_execution_snapshot -> 'generatedSessionBinding'
                ->> 'effectiveMaxNestedAgentDepth')::integer
                IS DISTINCT FROM (task_row.agent_config ->> 'maxNestedAgentDepth')::integer
            )
          )
          OR (
            task_row.agent_config ->> 'maxNestedAgentDepth' IS NULL
            AND NEW.accepted_execution_snapshot -> 'generatedSessionBinding'
              ->> 'nestedAgentDepthPolicySource' = 'session'
          )
          OR NEW.accepted_execution_snapshot -> 'generatedSessionBinding'
            ->> 'codexCompactionMode' NOT IN ('portable','remote_v2')
          OR (
            NEW.accepted_execution_snapshot ->> 'resolvedModel' NOT LIKE 'codex/%%'
            AND NEW.accepted_execution_snapshot -> 'generatedSessionBinding'
              ->> 'codexCompactionMode' <> 'portable'
          )
        THEN
          RAISE EXCEPTION 'generated scheduled run cannot carry target-session execution policy'
            USING ERRCODE = '42501';
        END IF;

        IF task_row.rig_id IS NULL THEN
          IF NEW.accepted_execution_snapshot -> 'resolvedRig' IS DISTINCT FROM 'null'::jsonb
          THEN
            RAISE EXCEPTION 'scheduled generated Rig changed during admission'
              USING ERRCODE = '40001';
          END IF;
        ELSE
          SELECT rig_value.id, rig_value.status INTO generated_rig
          FROM rigs rig_value
          WHERE rig_value.id = task_row.rig_id
            AND rig_value.account_id = NEW.account_id
          FOR SHARE;
          SELECT version_value.id
            INTO generated_rig_version
          FROM rig_versions version_value
          WHERE version_value.rig_id = task_row.rig_id
            AND version_value.account_id = NEW.account_id
            AND version_value.active
          FOR SHARE;
          IF generated_rig.id IS NULL
            OR generated_rig.status <> 'active'
            OR generated_rig_version.id IS NULL
            OR NEW.accepted_execution_snapshot -> 'resolvedRig' ->> 'id'
              IS DISTINCT FROM generated_rig.id::text
            OR NEW.accepted_execution_snapshot -> 'resolvedRig' ->> 'versionId'
              IS DISTINCT FROM generated_rig_version.id::text
          THEN
            RAISE EXCEPTION 'scheduled generated Rig changed during admission'
              USING ERRCODE = '40001';
          END IF;
        END IF;

        IF nullif(task_row.agent_config ->> 'slackBotConnectionId', '') IS NULL THEN
          IF NEW.accepted_execution_snapshot -> 'resolvedSlackBotConnection'
            IS DISTINCT FROM 'null'::jsonb
          THEN
            RAISE EXCEPTION 'scheduled Slack bot authority changed during admission'
              USING ERRCODE = '40001';
          END IF;
        ELSE
          IF NEW.accepted_execution_snapshot -> 'resolvedSlackBotConnection' ->> 'id'
            IS DISTINCT FROM task_row.agent_config ->> 'slackBotConnectionId' THEN
            RAISE EXCEPTION 'scheduled Slack bot authority changed during admission' USING ERRCODE = '40001';
          END IF;
          DECLARE
            bot_snapshot jsonb := (NEW.accepted_execution_snapshot -> 'resolvedSlackBotConnection');
            bot_account uuid := NEW.account_id;
            bot_target uuid := NEW.workspace_id;
            bot_home uuid := NEW.workspace_id;
            bot_generation bigint := ((NEW.accepted_execution_snapshot -> 'resolvedSlackBotConnection') -> 'metadata' ->> 'organizationSharingGeneration')::bigint;
            bot_prior_workspace text := current_setting('opengeni.workspace_id', true);
            bot_connection record;
            bot_valid boolean := false;
          BEGIN
            -- Discovery determines the home, never authority. Lock the connection before
            -- sharing, matching connection deletion and its access-row cascade.
            IF bot_generation IS NOT NULL THEN
              SELECT access.home_workspace_id INTO bot_home
              FROM opengeni_private.organization_slack_bot_access access
              WHERE access.connection_id = (bot_snapshot ->> 'id')::uuid
                AND access.account_id = bot_account
                AND access.home_workspace_id <> bot_target;
            END IF;
            IF bot_home IS NOT NULL THEN
              PERFORM set_config('opengeni.workspace_id', bot_home::text, true);
              SELECT connection_value.id, connection_value.status, connection_value.subject_id,
                  connection_value.provider_domain, connection_value.kind, connection_value.metadata,
                  connection_value.verified_install_at, connection_value.version,
                  connection_value.verified_install_version INTO bot_connection
              FROM connections connection_value
              WHERE connection_value.id = (bot_snapshot ->> 'id')::uuid
                AND connection_value.account_id = bot_account
                AND connection_value.workspace_id = bot_home
              FOR SHARE;
              PERFORM set_config('opengeni.workspace_id', coalesce(bot_prior_workspace, ''), true);
              bot_valid := bot_connection.id IS NOT NULL
                AND bot_connection.status = 'active'
                AND bot_connection.subject_id IS NULL
                AND bot_connection.provider_domain = 'slack.com'
                AND bot_connection.kind = 'app_install'
                AND bot_connection.metadata ->> 'credentialRole' = 'opengeni_slack_bot'
                AND bot_connection.verified_install_at IS NOT NULL
                AND bot_connection.verified_install_version = bot_connection.version
                AND bot_connection.version = (bot_snapshot ->> 'version')::integer
                AND bot_connection.verified_install_version = (bot_snapshot ->> 'verifiedInstallVersion')::integer
                AND (bot_connection.metadata || CASE WHEN bot_generation IS NULL THEN '{}'::jsonb
                  ELSE jsonb_build_object('organizationSharingGeneration', bot_generation) END)
                  IS NOT DISTINCT FROM bot_snapshot -> 'metadata';
              IF bot_generation IS NOT NULL THEN
                -- Recheck the frozen generation and target after taking the connection
                -- lock. A concurrent narrowing/revocation must win or wait for admission.
                PERFORM 1 FROM opengeni_private.organization_slack_bot_access access
                WHERE access.connection_id = bot_connection.id
                  AND access.account_id = bot_account AND access.home_workspace_id = bot_home
                  AND access.enabled AND access.generation = bot_generation
                  AND (access.workspace_ids IS NULL OR bot_target = ANY(access.workspace_ids))
                FOR SHARE;
                bot_valid := bot_valid AND FOUND;
              END IF;
            END IF;
            IF bot_valid IS NOT TRUE THEN
              RAISE EXCEPTION 'scheduled Slack bot authority changed during admission' USING ERRCODE = '40001';
            END IF;
          END;
        END IF;

        SELECT workspace_value.settings INTO STRICT workspace_settings
        FROM workspaces workspace_value
        WHERE workspace_value.id = NEW.workspace_id
          AND workspace_value.account_id = NEW.account_id
        FOR SHARE;
        SELECT configuration.max_nested_agent_depth, configuration.policy_source
          INTO STRICT deployment_depth
        FROM nested_agent_depth_configuration configuration
        WHERE configuration.singleton
        FOR SHARE;
        IF task_row.agent_config ->> 'maxNestedAgentDepth' IS NOT NULL THEN
          expected_depth := (task_row.agent_config ->> 'maxNestedAgentDepth')::integer;
          expected_depth_source := 'session';
        ELSIF jsonb_typeof(workspace_settings -> 'maxNestedAgentDepth') = 'number' THEN
          expected_depth := (workspace_settings ->> 'maxNestedAgentDepth')::integer;
          expected_depth_source := 'workspace';
        ELSE
          expected_depth := deployment_depth.max_nested_agent_depth;
          expected_depth_source := deployment_depth.policy_source;
        END IF;
        expected_compaction_mode := CASE
          WHEN NEW.accepted_execution_snapshot ->> 'resolvedModel' NOT LIKE 'codex/%%'
            THEN 'portable'
          WHEN workspace_settings ->> 'codexCompactionDefault' = 'portable'
            THEN 'portable'
          ELSE 'remote_v2'
        END;
        IF (NEW.accepted_execution_snapshot -> 'generatedSessionBinding'
              ->> 'effectiveMaxNestedAgentDepth')::integer IS DISTINCT FROM expected_depth
          OR NEW.accepted_execution_snapshot -> 'generatedSessionBinding'
              ->> 'nestedAgentDepthPolicySource' IS DISTINCT FROM expected_depth_source
          OR NEW.accepted_execution_snapshot -> 'generatedSessionBinding'
              ->> 'codexCompactionMode' IS DISTINCT FROM expected_compaction_mode
        THEN
          RAISE EXCEPTION 'scheduled generated policy changed during admission'
            USING ERRCODE = '40001';
        END IF;
      ELSE
        IF NEW.accepted_execution_snapshot -> 'generatedSessionBinding' IS DISTINCT FROM 'null'::jsonb
        THEN RAISE EXCEPTION 'targeted scheduled run cannot carry generated-session binding'
          USING ERRCODE = '42501'; END IF;
        SELECT session_value.* INTO target_row
        FROM sessions session_value
        WHERE session_value.id = expected_target_session_id
          AND session_value.account_id = NEW.account_id
          AND session_value.workspace_id = NEW.workspace_id
          AND session_value.status <> 'cancelled'
        FOR SHARE;
        IF NOT FOUND THEN
          -- The exact target was cancelled (or is no longer visible): settle this
          -- occurrence terminally instead of failing the activity.
          NEW.status := 'skipped';
          NEW.error := 'session_cancelled';
          NEW.completed_at := clock_timestamp();
          PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_membership_marker, ''), true); RETURN NEW;
        END IF;
        SELECT turn_value.* INTO latest_started
        FROM session_events event_value
        JOIN session_turns turn_value
          ON turn_value.workspace_id = event_value.workspace_id
         AND turn_value.session_id = event_value.session_id
         AND turn_value.id = event_value.turn_id
        WHERE event_value.workspace_id = NEW.workspace_id
          AND event_value.session_id = expected_target_session_id
          AND event_value.type = 'turn.started'
        ORDER BY event_value.sequence DESC
        LIMIT 1;
        IF target_snapshot ->> 'sessionId' IS DISTINCT FROM target_row.id::text
          OR NOT ((target_snapshot ->> 'authorityEpoch')::integer BETWEEN target_row.execution_authority_epoch AND target_row.authority_epoch)
          OR target_snapshot ->> 'model'
            IS DISTINCT FROM coalesce(latest_started.model, target_row.model)
          OR target_snapshot ->> 'reasoningEffort' IS DISTINCT FROM coalesce(
            latest_started.reasoning_effort,
            CASE WHEN target_row.metadata ->> 'reasoningEffort' IN (
              'none','minimal','low','medium','high','xhigh','max'
            )
              THEN target_row.metadata ->> 'reasoningEffort' ELSE 'medium' END
          )
          OR target_snapshot ->> 'latencyMode' IS DISTINCT FROM coalesce(
            latest_started.latency_mode,
            CASE WHEN target_row.metadata ->> 'latencyMode' IN ('standard','priority','fast')
              THEN target_row.metadata ->> 'latencyMode' ELSE 'standard' END
          )
          OR target_snapshot -> 'tools'
            IS DISTINCT FROM (CASE WHEN latest_started.tools_provided THEN latest_started.tools ELSE target_row.tools END)
          OR target_snapshot ->> 'sandboxBackend'
            IS DISTINCT FROM coalesce(latest_started.sandbox_backend, target_row.sandbox_backend)
          OR target_snapshot ->> 'sandboxOs'
            IS DISTINCT FROM coalesce(latest_started.sandbox_os, target_row.sandbox_os)
          OR target_snapshot -> 'firstPartyMcpTools'
            IS DISTINCT FROM target_row.first_party_mcp_tools
          OR target_snapshot -> 'firstPartyMcpPermissions'
            IS DISTINCT FROM coalesce(to_jsonb(target_row.first_party_mcp_permissions), 'null'::jsonb)
          OR target_snapshot -> 'toolPolicy' IS DISTINCT FROM target_row.tool_policy
          OR target_snapshot -> 'mcpServerIds' IS DISTINCT FROM (
            SELECT coalesce(jsonb_agg(server_value.server_id ORDER BY server_value.server_id), '[]'::jsonb)
            FROM session_mcp_servers server_value
            WHERE server_value.workspace_id = NEW.workspace_id
              AND server_value.session_id = target_row.id
          )
          OR (target_snapshot ->> 'toolPolicyVersion')::integer
            IS DISTINCT FROM target_row.tool_policy_version
          OR nullif(target_snapshot ->> 'rigId', '')::uuid IS DISTINCT FROM target_row.rig_id
          OR nullif(target_snapshot ->> 'rigVersionId', '')::uuid
            IS DISTINCT FROM target_row.rig_version_id
          OR nullif(target_snapshot ->> 'maxNestedAgentDepthOverride', '')::integer
            IS DISTINCT FROM target_row.max_nested_agent_depth_override
          OR (target_snapshot ->> 'effectiveMaxNestedAgentDepth')::integer
            IS DISTINCT FROM target_row.effective_max_nested_agent_depth
        THEN
          RAISE EXCEPTION 'scheduled target-session execution policy changed during admission'
            USING ERRCODE = '40001';
        END IF;
      END IF;
      IF (
        SELECT count(DISTINCT subject_id)
        FROM (
          SELECT authority.initiating_human_subject_id AS subject_id
          FROM scheduled_task_personal_resource_authorities authority
          WHERE authority.task_id = NEW.task_id
            AND authority.task_authority_revision = NEW.task_authority_revision
            AND authority.account_id = NEW.account_id
            AND authority.workspace_id = NEW.workspace_id
          UNION ALL
          SELECT selected ->> 'ownerSubjectId'
          FROM jsonb_array_elements(NEW.accepted_execution_snapshot -> 'personalConnectionDelegations') selected
        ) causal_subjects
      ) > 1 THEN
        RAISE EXCEPTION 'scheduled authority classes require one causal human'
          USING ERRCODE = '42501';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM scheduled_task_personal_resource_snapshots snapshot
        JOIN organization_user_resource_grants grant_value
          ON grant_value.id = snapshot.grant_id
         AND grant_value.account_id = snapshot.account_id
        WHERE snapshot.task_id = NEW.task_id
          AND snapshot.task_authority_revision = NEW.task_authority_revision
          AND snapshot.grant_mode = 'once'
          AND grant_value.status = 'consumed'
      ) THEN
        NEW.status := 'failed';
        NEW.error := 'scheduled_authority_exhausted';
        NEW.completed_at := clock_timestamp();
      END IF;
      PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_membership_marker, ''), true); RETURN NEW;
    END
    $$;
  $create$, data_schema);

  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION validate_scheduled_agent_run_live_authority(p_account_id uuid, p_workspace_id uuid, p_run_id uuid) RETURNS text
        LANGUAGE plpgsql SECURITY DEFINER
        SET search_path TO 'pg_catalog', %1$I, 'pg_temp'
        AS $$
    DECLARE
      sender_prior_lifecycle text := current_setting('opengeni.organization_tenancy_lifecycle', true);
      run_row record;
      accepted jsonb;
      causal jsonb;
      snapshot record;
      receipt_providers text[] := opengeni_private.subscription_authority_compat_providers();
      core_entries jsonb := '[]'::jsonb;
      core_entry jsonb;
    BEGIN
      PERFORM set_config('opengeni.organization_tenancy_lifecycle', 'personal_resource_grant_management', true);
      IF p_account_id IS DISTINCT FROM nullif(
          current_setting('opengeni.account_id', true), ''
        )::uuid
        OR p_workspace_id IS DISTINCT FROM nullif(
          current_setting('opengeni.workspace_id', true), ''
        )::uuid
      THEN PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(sender_prior_lifecycle, ''), true); RETURN 'scheduled_authority_scope_changed'; END IF;
      SELECT run.* INTO run_row
      FROM scheduled_task_runs run
      WHERE run.id = p_run_id
        AND run.account_id = p_account_id
        AND run.workspace_id = p_workspace_id
      FOR UPDATE;
      IF NOT FOUND OR run_row.accepted_execution_snapshot IS NULL THEN
        PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(sender_prior_lifecycle, ''), true); RETURN 'scheduled_authority_snapshot_missing';
      END IF;
      accepted := run_row.accepted_execution_snapshot;
      causal := accepted -> 'causalHumanAuthority';
      IF cardinality(receipt_providers) > 0 THEN
        core_entries := opengeni_subscription_internal.subscription_scheduled_run_personal_entries(
          p_account_id, p_workspace_id, p_run_id);
      END IF;

      -- Match task admission and organization lifecycle lock order. Claim must
      -- linearize before delivery: a concurrent suspension/revocation either
      -- completes first and is observed below, or waits until this claim commits.
      PERFORM 1 FROM organization_memberships membership
      WHERE membership.account_id = p_account_id
        AND membership.id IN (
          SELECT (causal ->> 'organizationMembershipId')::uuid
          WHERE causal IS NOT NULL AND causal <> 'null'::jsonb
          UNION
          SELECT frozen.owner_organization_membership_id
          FROM scheduled_task_run_connection_authority_snapshots frozen
          WHERE frozen.run_id = p_run_id
        )
      ORDER BY membership.id
      FOR SHARE;
      PERFORM 1 FROM workspace_memberships membership
      WHERE membership.account_id = p_account_id
        AND membership.workspace_id = p_workspace_id
        AND membership.subject_id IN (
          SELECT causal ->> 'subjectId'
          WHERE causal IS NOT NULL AND causal <> 'null'::jsonb
          UNION
          SELECT frozen.owner_subject_id
          FROM scheduled_task_run_connection_authority_snapshots frozen
          WHERE frozen.run_id = p_run_id
        )
      ORDER BY membership.subject_id
      FOR SHARE;
      PERFORM 1 FROM connections connection_value
      WHERE connection_value.account_id = p_account_id
        AND connection_value.id IN (
          SELECT frozen.connection_id
          FROM scheduled_task_run_connection_authority_snapshots frozen
          WHERE frozen.run_id = p_run_id
          UNION
          SELECT (accepted -> 'resolvedSlackBotConnection' ->> 'id')::uuid
          WHERE accepted -> 'resolvedSlackBotConnection' <> 'null'::jsonb
        )
      ORDER BY connection_value.id
      FOR SHARE;
      IF accepted -> 'resolvedSlackBotConnection' <> 'null'::jsonb THEN
        DECLARE
          bot_snapshot jsonb := (accepted -> 'resolvedSlackBotConnection');
          bot_account uuid := p_account_id;
          bot_target uuid := p_workspace_id;
          bot_home uuid := p_workspace_id;
          bot_generation bigint := ((accepted -> 'resolvedSlackBotConnection') -> 'metadata' ->> 'organizationSharingGeneration')::bigint;
          bot_prior_workspace text := current_setting('opengeni.workspace_id', true);
          bot_connection record;
          bot_valid boolean := false;
        BEGIN
          -- Discovery determines the home, never authority. Lock the connection before
          -- sharing, matching connection deletion and its access-row cascade.
          IF bot_generation IS NOT NULL THEN
            SELECT access.home_workspace_id INTO bot_home
            FROM opengeni_private.organization_slack_bot_access access
            WHERE access.connection_id = (bot_snapshot ->> 'id')::uuid
              AND access.account_id = bot_account
              AND access.home_workspace_id <> bot_target;
          END IF;
          IF bot_home IS NOT NULL THEN
            PERFORM set_config('opengeni.workspace_id', bot_home::text, true);
            SELECT connection_value.id, connection_value.status, connection_value.subject_id,
                connection_value.provider_domain, connection_value.kind, connection_value.metadata,
                connection_value.verified_install_at, connection_value.version,
                connection_value.verified_install_version INTO bot_connection
            FROM connections connection_value
            WHERE connection_value.id = (bot_snapshot ->> 'id')::uuid
              AND connection_value.account_id = bot_account
              AND connection_value.workspace_id = bot_home
            FOR SHARE;
            PERFORM set_config('opengeni.workspace_id', coalesce(bot_prior_workspace, ''), true);
            bot_valid := bot_connection.id IS NOT NULL
              AND bot_connection.status = 'active'
              AND bot_connection.subject_id IS NULL
              AND bot_connection.provider_domain = 'slack.com'
              AND bot_connection.kind = 'app_install'
              AND bot_connection.metadata ->> 'credentialRole' = 'opengeni_slack_bot'
              AND bot_connection.verified_install_at IS NOT NULL
              AND bot_connection.verified_install_version = bot_connection.version
              AND bot_connection.version = (bot_snapshot ->> 'version')::integer
              AND bot_connection.verified_install_version = (bot_snapshot ->> 'verifiedInstallVersion')::integer
              AND (bot_connection.metadata || CASE WHEN bot_generation IS NULL THEN '{}'::jsonb
                ELSE jsonb_build_object('organizationSharingGeneration', bot_generation) END)
                IS NOT DISTINCT FROM bot_snapshot -> 'metadata';
            IF bot_generation IS NOT NULL THEN
              -- Recheck the frozen generation and target after taking the connection
              -- lock. A concurrent narrowing/revocation must win or wait for admission.
              PERFORM 1 FROM opengeni_private.organization_slack_bot_access access
              WHERE access.connection_id = bot_connection.id
                AND access.account_id = bot_account AND access.home_workspace_id = bot_home
                AND access.enabled AND access.generation = bot_generation
                AND (access.workspace_ids IS NULL OR bot_target = ANY(access.workspace_ids))
              FOR SHARE;
              bot_valid := bot_valid AND FOUND;
            END IF;
          END IF;
          IF bot_valid IS NOT TRUE THEN
            PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(sender_prior_lifecycle, ''), true);
            RETURN 'scheduled_slack_bot_changed';
          END IF;
        END;
      END IF;

      PERFORM 1 FROM organization_user_resource_authorities authority
      WHERE authority.account_id = p_account_id
        AND authority.id IN (
          SELECT frozen.authority_id
          FROM scheduled_task_run_connection_authority_snapshots frozen
          WHERE frozen.run_id = p_run_id
          UNION
          SELECT xai_authority.id
          FROM organization_user_resource_authorities xai_authority
          WHERE accepted -> 'xaiProviderAccountAuthoritySnapshot' ->> 'scope' = 'user'
            AND causal IS NOT NULL AND causal <> 'null'::jsonb
            AND xai_authority.account_id = p_account_id
            AND xai_authority.organization_membership_id =
              (causal ->> 'organizationMembershipId')::uuid
            AND xai_authority.resource_kind = 'xai_subscription'
            AND xai_authority.generation =
              (accepted -> 'xaiProviderAccountAuthoritySnapshot'
                ->> 'authorityGeneration')::bigint
          UNION
          SELECT claude_authority.id
          FROM organization_user_resource_authorities claude_authority
          WHERE accepted -> 'claudeProviderAccountAuthoritySnapshot' ->> 'scope' = 'user'
            AND causal IS NOT NULL AND causal <> 'null'::jsonb
            AND claude_authority.account_id = p_account_id
            AND claude_authority.organization_membership_id =
              (causal ->> 'organizationMembershipId')::uuid
            AND claude_authority.resource_kind = 'claude_subscription'
            AND claude_authority.generation =
              (accepted -> 'claudeProviderAccountAuthoritySnapshot'
                ->> 'authorityGeneration')::bigint
          UNION
          SELECT core_authority.id
          FROM organization_user_resource_authorities core_authority
          JOIN jsonb_array_elements(core_entries) core(entry)
            ON core_authority.organization_membership_id::text = core.entry ->> 'ownerMembershipId'
          WHERE core_authority.account_id = p_account_id
            AND core_authority.resource_kind = 'subscription_connection'
            AND core_authority.generation::text = core.entry ->> 'authorityGeneration'
        )
      ORDER BY authority.id
      FOR SHARE;

      PERFORM 1 FROM rigs rig
      WHERE rig.account_id = p_account_id
        AND rig.id IN (
          SELECT (accepted -> 'resolvedRig' ->> 'id')::uuid
          WHERE accepted -> 'targetSessionExecution' = 'null'::jsonb
            AND accepted -> 'resolvedRig' <> 'null'::jsonb
          UNION
          SELECT (accepted -> 'targetSessionExecution' ->> 'rigId')::uuid
          WHERE accepted -> 'targetSessionExecution' <> 'null'::jsonb
            AND accepted -> 'targetSessionExecution' ->> 'rigId' IS NOT NULL
        )
      ORDER BY rig.id
      FOR SHARE;
      PERFORM 1 FROM rig_versions version_value
      WHERE version_value.account_id = p_account_id
        AND version_value.id IN (
          SELECT (accepted -> 'resolvedRig' ->> 'versionId')::uuid
          WHERE accepted -> 'targetSessionExecution' = 'null'::jsonb
            AND accepted -> 'resolvedRig' <> 'null'::jsonb
          UNION
          SELECT (accepted -> 'targetSessionExecution' ->> 'rigVersionId')::uuid
          WHERE accepted -> 'targetSessionExecution' <> 'null'::jsonb
            AND accepted -> 'targetSessionExecution' ->> 'rigVersionId' IS NOT NULL
        )
      ORDER BY version_value.id
      FOR SHARE;

      IF causal IS NOT NULL AND causal <> 'null'::jsonb AND NOT EXISTS (
        SELECT 1 FROM organization_memberships membership
        WHERE membership.id = (causal ->> 'organizationMembershipId')::uuid
          AND membership.account_id = p_account_id
          AND membership.subject_id = causal ->> 'subjectId'
          AND membership.status = 'active'
          AND membership.revoked_at IS NULL
          AND membership.authorization_revision =
            (causal ->> 'membershipAuthorizationRevision')::bigint
          AND (
            membership.personal_workspace_id = p_workspace_id
            OR EXISTS (
              SELECT 1 FROM workspace_memberships workspace_membership
              WHERE workspace_membership.account_id = p_account_id
                AND workspace_membership.workspace_id = p_workspace_id
                AND workspace_membership.subject_id = causal ->> 'subjectId'
            )
          )
      ) THEN PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(sender_prior_lifecycle, ''), true); RETURN 'scheduled_causal_membership_changed'; END IF;
      IF accepted -> 'xaiProviderAccountAuthoritySnapshot' ->> 'scope' = 'user'
        AND NOT 'xai' = ANY(receipt_providers)
        AND NOT EXISTS (
          SELECT 1 FROM organization_user_resource_authorities authority
          WHERE authority.account_id = p_account_id
            AND authority.organization_membership_id =
              (causal ->> 'organizationMembershipId')::uuid
            AND authority.resource_kind = 'xai_subscription'
            AND authority.generation =
              (accepted -> 'xaiProviderAccountAuthoritySnapshot'
                ->> 'authorityGeneration')::bigint
            AND authority.status = 'active'
            AND authority.revoked_at IS NULL
        )
      THEN PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(sender_prior_lifecycle, ''), true); RETURN 'scheduled_xai_authority_changed'; END IF;
      IF accepted -> 'claudeProviderAccountAuthoritySnapshot' ->> 'scope' = 'user'
        AND NOT 'claude' = ANY(receipt_providers)
        AND NOT EXISTS (
          SELECT 1 FROM organization_user_resource_authorities authority
          WHERE authority.account_id = p_account_id
            AND authority.organization_membership_id =
              (causal ->> 'organizationMembershipId')::uuid
            AND authority.resource_kind = 'claude_subscription'
            AND authority.generation =
              (accepted -> 'claudeProviderAccountAuthoritySnapshot'
                ->> 'authorityGeneration')::bigint
            AND authority.status = 'active'
            AND authority.revoked_at IS NULL
        )
      THEN PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(sender_prior_lifecycle, ''), true); RETURN 'scheduled_claude_authority_changed'; END IF;
      FOR core_entry IN SELECT listed.value FROM jsonb_array_elements(core_entries) listed(value) LOOP
        IF NOT opengeni_subscription_internal.subscription_personal_entry_serviceable(p_account_id, core_entry)
        THEN PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(sender_prior_lifecycle, ''), true); RETURN 'scheduled_' || (core_entry ->> 'provider') || '_authority_changed'; END IF;
      END LOOP;


      FOR snapshot IN
        SELECT value.* FROM scheduled_task_run_connection_authority_snapshots value
        WHERE value.run_id = p_run_id
        ORDER BY value.server_id
      LOOP
        IF snapshot.canonical_snapshot ->> 'authoritySource' IS DISTINCT FROM 'sender'
        THEN PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(sender_prior_lifecycle, ''), true); RETURN 'scheduled_connection_authority_changed'; END IF;
        IF NOT EXISTS (
          SELECT 1 FROM organization_memberships membership
          WHERE membership.id = snapshot.owner_organization_membership_id
            AND membership.account_id = p_account_id
            AND membership.subject_id = snapshot.owner_subject_id
            AND membership.status = 'active'
            AND membership.revoked_at IS NULL
            AND membership.authorization_revision = snapshot.membership_authorization_revision
            AND (
              membership.personal_workspace_id = p_workspace_id
              OR EXISTS (
                SELECT 1 FROM workspace_memberships workspace_membership
                WHERE workspace_membership.account_id = p_account_id
                  AND workspace_membership.workspace_id = p_workspace_id
                  AND workspace_membership.subject_id = snapshot.owner_subject_id
              )
            )
        ) THEN PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(sender_prior_lifecycle, ''), true); RETURN 'scheduled_connection_membership_changed'; END IF;
        IF NOT EXISTS (
          SELECT 1 FROM opengeni_private.read_sender_connection(
            p_account_id, snapshot.origin_workspace_id, snapshot.connection_id, snapshot.owner_subject_id
          ) connection_value
          WHERE connection_value.id = snapshot.connection_id
            AND connection_value.account_id = p_account_id
            AND connection_value.workspace_id = snapshot.origin_workspace_id
            AND connection_value.subject_id = snapshot.owner_subject_id
            AND connection_value.owner_organization_membership_id =
              snapshot.owner_organization_membership_id
            AND connection_value.authority_scope = 'user'
            AND connection_value.authority_generation = snapshot.connection_generation
            AND connection_value.status = 'active'
            AND lower(connection_value.provider_domain) = snapshot.provider_domain
            AND connection_value.kind = snapshot.connection_kind
        ) THEN PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(sender_prior_lifecycle, ''), true); RETURN 'scheduled_connection_changed'; END IF;
        IF NOT EXISTS (
          SELECT 1 FROM organization_user_resource_authorities authority
          WHERE authority.id = snapshot.authority_id
            AND authority.account_id = p_account_id
            AND authority.organization_membership_id =
              snapshot.owner_organization_membership_id
            AND authority.resource_kind = 'connection'
            AND authority.resource_id = snapshot.connection_id
            AND authority.origin_workspace_id = snapshot.origin_workspace_id
            AND authority.generation = snapshot.authority_generation
            AND authority.status = 'active'
            AND authority.revoked_at IS NULL
        ) THEN PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(sender_prior_lifecycle, ''), true); RETURN 'scheduled_connection_authority_changed'; END IF;
      END LOOP;

      IF accepted -> 'targetSessionExecution' = 'null'::jsonb THEN
        IF accepted -> 'resolvedRig' <> 'null'::jsonb AND NOT EXISTS (
          SELECT 1 FROM rigs rig
          JOIN rig_versions version_value
            ON version_value.id = (accepted -> 'resolvedRig' ->> 'versionId')::uuid
           AND version_value.rig_id = rig.id
           AND version_value.account_id = rig.account_id
          WHERE rig.id = (accepted -> 'resolvedRig' ->> 'id')::uuid
            AND rig.account_id = p_account_id
            AND rig.status = 'active'
        ) THEN PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(sender_prior_lifecycle, ''), true); RETURN 'scheduled_rig_changed'; END IF;
      END IF;
      PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(sender_prior_lifecycle, ''), true); RETURN NULL;
    EXCEPTION WHEN OTHERS THEN RAISE;
    END
    $$;
  $create$, data_schema);

  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION fence_scheduled_task_run_connection_session_identity() RETURNS trigger
        LANGUAGE plpgsql SECURITY DEFINER
        SET search_path TO 'pg_catalog', %1$I, 'public', 'pg_temp'
        AS $$
    DECLARE
      accepted jsonb;
      task_snapshot jsonb;
      target_policy jsonb;
      generated_binding jsonb;
      expected_generated_metadata jsonb;
      expected_generated_creator_context jsonb;
      canonical_generated_run_id uuid;
      session_row record;
    BEGIN
      IF NEW.id IS DISTINCT FROM OLD.id
        OR NEW.account_id IS DISTINCT FROM OLD.account_id
        OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
        OR NEW.task_id IS DISTINCT FROM OLD.task_id
        OR NEW.trigger_type IS DISTINCT FROM OLD.trigger_type
        OR NEW.producer_key IS DISTINCT FROM OLD.producer_key
        OR NEW.scheduled_at IS DISTINCT FROM OLD.scheduled_at
        OR NEW.fired_at IS DISTINCT FROM OLD.fired_at
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
      THEN RAISE EXCEPTION 'scheduled run immutable identity changed'
        USING ERRCODE = '42501'; END IF;
      IF NEW.action_kind IS DISTINCT FROM OLD.action_kind THEN
        RAISE EXCEPTION 'scheduled run action identity is immutable'
          USING ERRCODE = '42501';
      END IF;
      IF (
        NEW.task_authority_revision IS DISTINCT FROM OLD.task_authority_revision
        OR NEW.task_execution_digest IS DISTINCT FROM OLD.task_execution_digest
      ) AND NOT opengeni_private.scheduled_personal_resource_capability_active('run_admit')
      THEN RAISE EXCEPTION 'scheduled run authority binding is lifecycle-only'
        USING ERRCODE = '42501'; END IF;
      IF OLD.action_kind = 'agent_turn' AND (
        NEW.status IS DISTINCT FROM OLD.status
        OR NEW.session_id IS DISTINCT FROM OLD.session_id
        OR NEW.trigger_event_id IS DISTINCT FROM OLD.trigger_event_id
        OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
        OR NEW.error IS DISTINCT FROM OLD.error
      ) AND NOT opengeni_private.scheduled_personal_resource_capability_active('run_lifecycle')
      THEN RAISE EXCEPTION 'scheduled agent run transition is lifecycle-only'
        USING ERRCODE = '42501'; END IF;
      IF NEW.accepted_execution_snapshot IS DISTINCT FROM OLD.accepted_execution_snapshot
        OR NEW.accepted_execution_digest IS DISTINCT FROM OLD.accepted_execution_digest
      THEN
        RAISE EXCEPTION 'scheduled run accepted execution is immutable'
          USING ERRCODE = '42501';
      END IF;
      IF OLD.session_id IS NOT NULL AND NEW.session_id IS DISTINCT FROM OLD.session_id THEN
        RAISE EXCEPTION 'scheduled agent run session identity is immutable'
          USING ERRCODE = '42501';
      END IF;
      IF OLD.session_id IS NULL AND NEW.session_id IS NOT NULL THEN
        accepted := OLD.accepted_execution_snapshot;
        task_snapshot := accepted -> 'task';
        target_policy := accepted -> 'targetSessionExecution';
        generated_binding := accepted -> 'generatedSessionBinding';
        SELECT session_value.* INTO STRICT session_row
        FROM sessions session_value
        WHERE session_value.id = NEW.session_id
          AND session_value.account_id = OLD.account_id
          AND session_value.workspace_id = OLD.workspace_id
          AND session_value.status <> 'cancelled'
        FOR SHARE;
        IF target_policy <> 'null'::jsonb THEN
          IF target_policy ->> 'sessionId' IS DISTINCT FROM NEW.session_id::text
            OR target_policy ->> 'visibility' IS DISTINCT FROM session_row.visibility
            OR (target_policy ->> 'authorityEpoch')::integer
              IS DISTINCT FROM session_row.authority_epoch
          THEN RAISE EXCEPTION 'scheduled run target session changed'
            USING ERRCODE = '42501'; END IF;
        ELSE
          canonical_generated_run_id := nullif(
            session_row.metadata ->> 'scheduledTaskRunId', ''
          )::uuid;
          IF canonical_generated_run_id IS NULL
            OR (
              task_snapshot ->> 'runMode' = 'new_session_per_run'
              AND canonical_generated_run_id IS DISTINCT FROM OLD.id
              AND NOT (
                accepted -> 'alertOccurrenceLabels' IS DISTINCT FROM 'null'::jsonb
                AND EXISTS (
                  SELECT 1 FROM scheduled_task_runs canonical_run
                  WHERE canonical_run.id = canonical_generated_run_id
                    AND canonical_run.task_id = OLD.task_id
                    AND canonical_run.account_id = OLD.account_id
                    AND canonical_run.workspace_id = OLD.workspace_id
                    AND canonical_run.task_authority_revision = OLD.task_authority_revision
                    AND canonical_run.task_execution_digest = OLD.task_execution_digest
                    AND canonical_run.session_id = NEW.session_id
                    AND canonical_run.accepted_execution_snapshot
                      -> 'generatedSessionBinding' ->> 'createIdempotencyKey'
                      IS NOT DISTINCT FROM generated_binding ->> 'createIdempotencyKey'
                    AND canonical_run.accepted_execution_snapshot -> 'alertOccurrenceLabels'
                      IS NOT DISTINCT FROM accepted -> 'alertOccurrenceLabels'
                )
              )
            )
            OR (
              task_snapshot ->> 'runMode' = 'reusable_session'
              AND canonical_generated_run_id IS DISTINCT FROM OLD.id
              AND NOT EXISTS (
                SELECT 1 FROM scheduled_task_runs canonical_run
                WHERE canonical_run.id = canonical_generated_run_id
                  AND canonical_run.task_id = OLD.task_id
                  AND canonical_run.account_id = OLD.account_id
                  AND canonical_run.workspace_id = OLD.workspace_id
                  -- 0414 exact reusable producer materialization receipt
                  AND (
                    (canonical_run.task_authority_revision = OLD.task_authority_revision
                      AND canonical_run.task_execution_digest = OLD.task_execution_digest)
                    OR EXISTS (
                      SELECT 1 FROM scheduled_task_reusable_connection_materializations receipt
                      WHERE receipt.run_id = canonical_generated_run_id
                        AND receipt.account_id = OLD.account_id
                        AND receipt.workspace_id = OLD.workspace_id
                        AND receipt.task_id = OLD.task_id
                        AND receipt.session_id = NEW.session_id
                        AND receipt.source_task_authority_revision = OLD.task_authority_revision
                        AND receipt.source_execution_digest = OLD.task_execution_digest
                        AND receipt.target_task_authority_revision = canonical_run.task_authority_revision
                        AND receipt.target_execution_digest = canonical_run.task_execution_digest
                    )
                  )
                  AND canonical_run.session_id = NEW.session_id
                  AND canonical_run.accepted_execution_snapshot
                    -> 'generatedSessionBinding' ->> 'createIdempotencyKey'
                    IS NOT DISTINCT FROM generated_binding ->> 'createIdempotencyKey'
              )
            )
          THEN
            RAISE EXCEPTION 'scheduled generated session producer identity changed'
              USING ERRCODE = '42501';
          END IF;
          expected_generated_creator_context := pg_catalog.jsonb_build_object(
            'label', 'OpenGeni scheduler',
            'scheduledTaskId', OLD.task_id::text,
            'scheduledTaskRunId', canonical_generated_run_id::text
          );
          expected_generated_metadata :=
            (coalesce(task_snapshot -> 'agentConfig' -> 'metadata', '{}'::jsonb)
              - 'opengeniSlackBotConnectionId')
            || pg_catalog.jsonb_build_object(
              'model', accepted ->> 'resolvedModel',
              'reasoningEffort', accepted ->> 'resolvedReasoningEffort',
              'scheduledTaskId', OLD.task_id::text,
              'scheduledTaskRunMode', task_snapshot ->> 'runMode',
              'scheduledTaskRunId', canonical_generated_run_id::text
            );
          IF task_snapshot -> 'agentConfig' -> 'goal' IS NOT NULL THEN
            expected_generated_metadata := expected_generated_metadata
              || pg_catalog.jsonb_build_object(
                'scheduledTaskGoal', task_snapshot -> 'agentConfig' -> 'goal'
              );
          END IF;
          IF accepted -> 'resolvedSlackBotConnection' <> 'null'::jsonb THEN
            expected_generated_metadata := expected_generated_metadata
              || pg_catalog.jsonb_build_object(
                'opengeniSlackBotConnectionId',
                accepted -> 'resolvedSlackBotConnection' ->> 'id'
              );
          END IF;
          expected_generated_metadata := expected_generated_metadata
            - '_opengeni_session_create_agent_config_v1';
          IF accepted -> 'resolvedAgentConfig' IS NOT NULL
            AND accepted -> 'resolvedAgentConfig' <> 'null'::jsonb THEN
            expected_generated_metadata := expected_generated_metadata
              || pg_catalog.jsonb_build_object(
                '_opengeni_session_create_agent_config_v1',
                (accepted -> 'resolvedAgentConfig') - 'source'
              );
          END IF;
          IF EXISTS (
            SELECT 1 FROM scheduled_tasks creator_task
            WHERE creator_task.id = OLD.task_id
              AND creator_task.account_id = OLD.account_id
              AND creator_task.workspace_id = OLD.workspace_id
              AND creator_task.creator_session_policy ->> 'credentialRestriction' = 'developer_setup'
          ) THEN
            IF accepted -> 'turnExecutionPolicy' ->> 'credentialRestriction'
                IS DISTINCT FROM 'developer_setup' THEN
              RAISE EXCEPTION 'scheduled setup creator policy differs from accepted execution'
                USING ERRCODE = '42501';
            END IF;
            expected_generated_metadata := expected_generated_metadata
              || pg_catalog.jsonb_build_object(
                'turnExecutionPolicyV1', accepted -> 'turnExecutionPolicy'
              );
          END IF;
          IF generated_binding = 'null'::jsonb
            OR generated_binding ->> 'createIdempotencyKey'
              IS DISTINCT FROM session_row.create_idempotency_key
            OR session_row.visibility IS DISTINCT FROM (CASE
              WHEN (task_snapshot#>>'{agentConfig,knowledgeSource,destination,kind}'='personal'
                OR (task_snapshot->>'visibility'='private'
                  AND task_snapshot->>'ownerSubjectId' IS NOT DISTINCT FROM accepted->>'causalHumanSubjectId'
                  AND accepted#>>'{causalHumanAuthority,subjectId}' IS NOT DISTINCT FROM accepted->>'causalHumanSubjectId'
                  AND accepted->>'causalHumanSubjectId' IS NOT NULL)) THEN 'user_private' ELSE 'workspace_shared' END)
            OR session_row.authority_epoch <> 1
            OR session_row.owner_organization_membership_id IS DISTINCT FROM (CASE
              WHEN (task_snapshot#>>'{agentConfig,knowledgeSource,destination,kind}'='personal'
                OR (task_snapshot->>'visibility'='private'
                  AND task_snapshot->>'ownerSubjectId' IS NOT DISTINCT FROM accepted->>'causalHumanSubjectId'
                  AND accepted#>>'{causalHumanAuthority,subjectId}' IS NOT DISTINCT FROM accepted->>'causalHumanSubjectId'
                  AND accepted->>'causalHumanSubjectId' IS NOT NULL))
                THEN (accepted#>>'{causalHumanAuthority,organizationMembershipId}')::uuid END)
            OR session_row.owner_subject_id IS DISTINCT FROM (CASE
              WHEN (task_snapshot#>>'{agentConfig,knowledgeSource,destination,kind}'='personal'
                OR (task_snapshot->>'visibility'='private'
                  AND task_snapshot->>'ownerSubjectId' IS NOT DISTINCT FROM accepted->>'causalHumanSubjectId'
                  AND accepted#>>'{causalHumanAuthority,subjectId}' IS NOT DISTINCT FROM accepted->>'causalHumanSubjectId'
                  AND accepted->>'causalHumanSubjectId' IS NOT NULL))
                THEN accepted->>'causalHumanSubjectId' END)
            OR (task_snapshot#>>'{agentConfig,knowledgeSource,destination,kind}'='personal' AND (
              accepted->>'causalHumanSubjectId' IS NULL
              OR task_snapshot#>>'{agentConfig,knowledgeSource,destination,subjectId}' IS DISTINCT FROM accepted->>'causalHumanSubjectId'
              OR task_snapshot#>>'{agentConfig,knowledgeSource,initiatingSubjectId}' IS DISTINCT FROM accepted->>'causalHumanSubjectId'
              OR task_snapshot#>>'{agentConfig,knowledgeSource,connection,ownerSubjectId}' IS DISTINCT FROM accepted->>'causalHumanSubjectId'
              OR accepted#>>'{causalHumanAuthority,subjectId}' IS DISTINCT FROM accepted->>'causalHumanSubjectId'
              OR task_snapshot->>'runMode'<>'new_session_per_run'))
            OR session_row.initial_model_context IS NOT NULL
            OR session_row.instructions IS DISTINCT FROM
              accepted ->> 'resolvedAgentInstructions'
            OR session_row.agent_config IS DISTINCT FROM
              nullif(accepted -> 'resolvedAgentConfig', 'null'::jsonb)
            OR session_row.policy_role IS NOT NULL
            OR session_row.skills IS DISTINCT FROM '[]'::jsonb
            OR session_row.tool_policy IS DISTINCT FROM coalesce(
              generated_binding -> 'toolPolicy',
              '{"mode":"explicit","inheritedFromSessionId":null}'::jsonb)
            OR session_row.tool_policy_version <> 1
            OR session_row.initial_personal_connection_delegations IS DISTINCT FROM '[]'::jsonb
            OR session_row.parent_session_id IS NOT NULL
            OR session_row.parent_turn_id IS NOT NULL
            OR session_row.root_session_id IS DISTINCT FROM session_row.id
            OR session_row.sandbox_group_id IS DISTINCT FROM session_row.id
            OR session_row.channel_id IS NOT NULL
            OR session_row.nested_agent_depth <> 0
            OR session_row.effective_max_nested_agent_depth IS DISTINCT FROM
              (generated_binding ->> 'effectiveMaxNestedAgentDepth')::integer
            OR session_row.nested_agent_depth_policy_source IS DISTINCT FROM
              generated_binding ->> 'nestedAgentDepthPolicySource'
            OR session_row.nested_agent_depth_policy_session_id IS DISTINCT FROM (CASE
              WHEN generated_binding ->> 'nestedAgentDepthPolicySource' = 'session'
                THEN session_row.id
              ELSE NULL
            END)
            OR session_row.codex_compaction_mode IS DISTINCT FROM
              generated_binding ->> 'codexCompactionMode'
            OR session_row.forked_from_session_id IS NOT NULL
            OR session_row.forked_from_authority_epoch IS NOT NULL
            OR session_row.forked_from_visibility IS NOT NULL
            OR session_row.forked_at IS NOT NULL
            OR session_row.forked_by_organization_membership_id IS NOT NULL
            OR session_row.initial_message IS DISTINCT FROM task_snapshot -> 'agentConfig' ->> 'prompt'
            OR session_row.resources IS DISTINCT FROM task_snapshot -> 'agentConfig' -> 'resources'
            OR session_row.tools IS DISTINCT FROM accepted -> 'resolvedTools'
            OR session_row.model IS DISTINCT FROM accepted ->> 'resolvedModel'
            OR session_row.sandbox_backend IS DISTINCT FROM accepted ->> 'resolvedSandboxBackend'
            OR session_row.sandbox_os IS DISTINCT FROM accepted ->> 'resolvedSandboxOs'
            OR session_row.first_party_mcp_tools
              IS DISTINCT FROM accepted -> 'resolvedFirstPartyMcpTools'
            OR coalesce(to_jsonb(session_row.first_party_mcp_permissions), 'null'::jsonb)
              IS DISTINCT FROM accepted -> 'resolvedFirstPartyMcpPermissions'
            OR session_row.rig_id IS DISTINCT FROM
              nullif(accepted -> 'resolvedRig' ->> 'id', '')::uuid
            OR session_row.rig_version_id IS DISTINCT FROM
              nullif(accepted -> 'resolvedRig' ->> 'versionId', '')::uuid
            OR session_row.initial_xai_provider_account_authority_snapshot
              IS DISTINCT FROM accepted -> 'xaiProviderAccountAuthoritySnapshot'
            OR session_row.initial_claude_provider_account_authority_snapshot
              IS DISTINCT FROM coalesce(accepted -> 'claudeProviderAccountAuthoritySnapshot',
                '{"version":1,"scope":"workspace"}'::jsonb)
            OR session_row.max_nested_agent_depth_override IS DISTINCT FROM
              nullif(task_snapshot -> 'agentConfig' ->> 'maxNestedAgentDepth', '')::integer
            OR session_row.created_by_kind <> 'service'
            OR session_row.created_by_subject_id <> 'scheduler'
            OR session_row.created_by_context IS DISTINCT FROM expected_generated_creator_context
            OR session_row.metadata IS DISTINCT FROM expected_generated_metadata
            OR EXISTS (
              SELECT 1 FROM session_mcp_servers server_value
              WHERE server_value.session_id = session_row.id
                AND server_value.account_id = session_row.account_id
                AND server_value.workspace_id = session_row.workspace_id
            )
          THEN RAISE EXCEPTION 'scheduled generated session differs from accepted execution'
            USING ERRCODE = '42501'; END IF;
        END IF;
        IF EXISTS (
          SELECT 1 FROM scheduled_task_run_personal_resource_admissions admission
          WHERE admission.run_id = OLD.id
            AND admission.target_session_id IS NOT NULL
            AND admission.target_session_id IS DISTINCT FROM NEW.session_id
        ) OR EXISTS (
          SELECT 1 FROM scheduled_task_run_connection_authority_snapshots snapshot
          WHERE snapshot.run_id = OLD.id AND snapshot.target_session_id IS NOT NULL
            AND snapshot.target_session_id IS DISTINCT FROM NEW.session_id
        ) THEN
          RAISE EXCEPTION 'scheduled authority run target session changed'
            USING ERRCODE = '42501';
        END IF;
      END IF;
      RETURN NEW;
    END
    $$;
  $create$, data_schema);
END
$install$;
