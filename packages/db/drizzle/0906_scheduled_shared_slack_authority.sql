-- deployment-mode: rolling
-- Organization-shared Slack bots already resolve at schedule setup and worker
-- recovery. Bring SQL admission and live claim fences into the same authority
-- model. Preserve immutable snapshots, exact versions, sharing generations,
-- target allowlists and FORCE RLS; no grants, stored data or row shape change.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $patch$
DECLARE definition text; anchor text; replacement text;
BEGIN
  definition := pg_get_functiondef('admit_scheduled_agent_run_execution()'::regprocedure);
  anchor := $old$      SELECT connection_value.id, connection_value.version,
          connection_value.verified_install_version, connection_value.metadata,
          connection_value.status, connection_value.subject_id,
          connection_value.provider_domain, connection_value.kind,
          connection_value.verified_install_at
        INTO generated_slack
      FROM connections connection_value
      WHERE connection_value.id = (task_row.agent_config ->> 'slackBotConnectionId')::uuid
        AND connection_value.account_id = NEW.account_id
        AND connection_value.workspace_id = NEW.workspace_id
      FOR SHARE;
      IF generated_slack.id IS NULL
        OR generated_slack.status <> 'active'
        OR generated_slack.subject_id IS NOT NULL
        OR generated_slack.provider_domain <> 'slack.com'
        OR generated_slack.kind <> 'app_install'
        OR generated_slack.verified_install_at IS NULL
        OR generated_slack.verified_install_version IS DISTINCT FROM generated_slack.version
        OR NEW.accepted_execution_snapshot -> 'resolvedSlackBotConnection' ->> 'id'
          IS DISTINCT FROM generated_slack.id::text
        OR (NEW.accepted_execution_snapshot -> 'resolvedSlackBotConnection' ->> 'version')::integer
          IS DISTINCT FROM generated_slack.version
        OR (NEW.accepted_execution_snapshot -> 'resolvedSlackBotConnection'
          ->> 'verifiedInstallVersion')::integer
          IS DISTINCT FROM generated_slack.verified_install_version
        OR NEW.accepted_execution_snapshot -> 'resolvedSlackBotConnection' -> 'metadata'
          IS DISTINCT FROM generated_slack.metadata
      THEN
        RAISE EXCEPTION 'scheduled Slack bot authority changed during admission'
          USING ERRCODE = '40001';
      END IF;$old$;
  replacement := $new$      IF NEW.accepted_execution_snapshot -> 'resolvedSlackBotConnection' ->> 'id'
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
      END;$new$;
  IF length(definition) - length(replace(definition, anchor, '')) <> length(anchor) THEN
    RAISE EXCEPTION 'admit_scheduled_agent_run_execution() Slack authority anchor changed';
  END IF;
  EXECUTE replace(definition, anchor, replacement);
END
$patch$;

DO $patch$
DECLARE definition text; anchor text; replacement text;
BEGIN
  definition := pg_get_functiondef('validate_scheduled_agent_run_live_authority(uuid,uuid,uuid)'::regprocedure);
  anchor := $old$  IF accepted -> 'resolvedSlackBotConnection' <> 'null'::jsonb
    AND NOT EXISTS (
      SELECT 1 FROM connections connection_value
      WHERE connection_value.id =
          (accepted -> 'resolvedSlackBotConnection' ->> 'id')::uuid
        AND connection_value.account_id = p_account_id
        AND connection_value.workspace_id = p_workspace_id
        AND connection_value.subject_id IS NULL
        AND connection_value.provider_domain = 'slack.com'
        AND connection_value.kind = 'app_install'
        AND connection_value.status = 'active'
        AND connection_value.verified_install_at IS NOT NULL
        AND connection_value.version =
          (accepted -> 'resolvedSlackBotConnection' ->> 'version')::integer
        AND connection_value.verified_install_version =
          (accepted -> 'resolvedSlackBotConnection'
            ->> 'verifiedInstallVersion')::integer
        AND connection_value.verified_install_version = connection_value.version
        AND connection_value.metadata IS NOT DISTINCT FROM
          accepted -> 'resolvedSlackBotConnection' -> 'metadata'
    )
  THEN PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(sender_prior_lifecycle, ''), true); RETURN 'scheduled_slack_bot_changed'; END IF;$old$;
  replacement := $new$$new$;
  IF length(definition) - length(replace(definition, anchor, '')) <> length(anchor) THEN
    RAISE EXCEPTION 'validate_scheduled_agent_run_live_authority(uuid,uuid,uuid) Slack authority anchor changed';
  END IF;
  EXECUTE replace(definition, anchor, replacement);
END
$patch$;

DO $patch$
DECLARE definition text; anchor text; replacement text;
BEGIN
  definition := pg_get_functiondef('validate_scheduled_agent_run_live_authority(uuid,uuid,uuid)'::regprocedure);
  anchor := $old$  PERFORM 1 FROM organization_user_resource_authorities authority
  WHERE authority.account_id = p_account_id$old$;
  replacement := $new$  IF accepted -> 'resolvedSlackBotConnection' <> 'null'::jsonb THEN
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
  WHERE authority.account_id = p_account_id$new$;
  IF length(definition) - length(replace(definition, anchor, '')) <> length(anchor) THEN
    RAISE EXCEPTION 'validate_scheduled_agent_run_live_authority(uuid,uuid,uuid) Slack authority anchor changed';
  END IF;
  EXECUTE replace(definition, anchor, replacement);
END
$patch$;
