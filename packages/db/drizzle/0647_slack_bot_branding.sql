-- deployment-mode: rolling
-- Current branding is Opengeni. Retain the historical spellings for existing
-- installations and old binaries during a rolling release; never rewrite
-- accepted connection metadata or provider credentials.
ALTER TABLE slack_installation_bindings
  DROP CONSTRAINT slack_installation_bindings_identity_check;
ALTER TABLE slack_installation_bindings
  ADD CONSTRAINT slack_installation_bindings_identity_check CHECK (
    octet_length(slack_team_id) BETWEEN 1 AND 64
    AND octet_length(slack_team_name) BETWEEN 1 AND 256
    AND octet_length(bot_id) BETWEEN 1 AND 64
    AND octet_length(bot_user_id) BETWEEN 1 AND 64
    AND bot_display_name IN ('Opengeni', 'Opengeni Staging', 'OpenGeni', 'OpenGeni Staging')
  );

-- Preserve the exact verified-install/tenant fence, advisory lock and existing
-- function ACL. A new binding records its verified environment-specific name.
DO $migration$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_private.sync_slack_installation_binding()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    DECLARE
      existing_binding record;
      team_id text := NEW.metadata->>'slackTeamId';
      team_name text := NEW.metadata->>'slackTeamName';
      bot_id_value text := NEW.metadata->>'botId';
      bot_user_id_value text := NEW.metadata->>'botUserId';
      is_verified_bot boolean :=
        NEW.subject_id IS NULL
        AND NEW.provider_domain = 'slack.com'
        AND NEW.kind = 'app_install'
        AND NEW.verified_install_at IS NOT NULL
        AND NEW.verified_install_version = NEW.version
        AND NEW.metadata->>'credentialRole' = 'opengeni_slack_bot';
    BEGIN
      SELECT * INTO existing_binding
      FROM %1$I.slack_installation_bindings B
      WHERE B.connection_id = NEW.id;

      -- Composite `IS NOT NULL` is false when any nullable field is null. Use
      -- the SELECT result flag so active bindings with a null quarantine reason
      -- still take the existing-binding path on reinstall and safe updates.
      IF FOUND THEN
        IF team_id IS DISTINCT FROM existing_binding.slack_team_id
          OR bot_id_value IS DISTINCT FROM existing_binding.bot_id
          OR bot_user_id_value IS DISTINCT FROM existing_binding.bot_user_id
          OR NEW.account_id IS DISTINCT FROM existing_binding.account_id
          OR NEW.workspace_id IS DISTINCT FROM existing_binding.workspace_id
        THEN
          RAISE EXCEPTION USING
            ERRCODE = 'P0001',
            MESSAGE = 'OPENGENI_SLACK_BINDING_CONFLICT: bound Slack identity and tenant are immutable';
        END IF;
        IF is_verified_bot AND NEW.status = 'active' THEN
          UPDATE %1$I.slack_installation_bindings B
          SET slack_team_name = team_name,
              bot_display_name = NEW.metadata->>'botDisplayName',
              version = B.version + 1,
              updated_by_subject_id = NEW.updated_by_subject_id,
              updated_at = now()
          WHERE B.id = existing_binding.id;
        END IF;
        RETURN NEW;
      END IF;

      IF NOT is_verified_bot OR NEW.status <> 'active' THEN
        RETURN NEW;
      END IF;
      IF octet_length(team_id) NOT BETWEEN 1 AND 64
        OR octet_length(team_name) NOT BETWEEN 1 AND 256
        OR octet_length(bot_id_value) NOT BETWEEN 1 AND 64
        OR octet_length(bot_user_id_value) NOT BETWEEN 1 AND 64
        OR COALESCE(NEW.metadata->>'botDisplayName' NOT IN (
          'Opengeni', 'Opengeni Staging', 'OpenGeni', 'OpenGeni Staging'
        ), true)
      THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'OPENGENI_SLACK_BINDING_CONFLICT: invalid verified Slack identity';
      END IF;

      PERFORM pg_advisory_xact_lock(hashtextextended('opengeni:slack-install:' || team_id, 0));
      IF EXISTS (
        SELECT 1 FROM %1$I.slack_installation_bindings B
        WHERE B.slack_team_id = team_id
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'OPENGENI_SLACK_BINDING_CONFLICT: Slack team already bound or quarantined';
      END IF;

      INSERT INTO %1$I.slack_installation_bindings (
        account_id, workspace_id, connection_id, slack_team_id, slack_team_name,
        bot_id, bot_user_id, bot_display_name, state,
        created_by_subject_id, updated_by_subject_id
      ) VALUES (
        NEW.account_id, NEW.workspace_id, NEW.id, team_id, team_name,
        bot_id_value, bot_user_id_value, NEW.metadata->>'botDisplayName', 'active',
        NEW.created_by_subject_id, NEW.updated_by_subject_id
      );
      RETURN NEW;
    END
    $function$
  $ddl$, data_schema);
END
$migration$;
