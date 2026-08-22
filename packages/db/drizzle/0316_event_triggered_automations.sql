-- deployment-mode: rolling
-- Generic event-triggered automations. Sources authenticate ingress, immutable
-- trigger revisions own matching/session templates, events retain normalized
-- occurrence truth, and runs freeze the exact session execution admitted for
-- one logical occurrence. Agent execution remains an ordinary session.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE UNIQUE INDEX IF NOT EXISTS pack_installations_workspace_id_uq
  ON pack_installations(workspace_id, id);

CREATE TABLE automation_sources (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  endpoint_id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  adapter_id text NOT NULL,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  webhook_secret_encrypted text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  version integer NOT NULL DEFAULT 1,
  created_by_subject_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT automation_sources_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT automation_sources_shape_chk CHECK (
    status IN ('active', 'disabled') AND version > 0
    AND octet_length(name) BETWEEN 1 AND 512
    AND octet_length(adapter_id) BETWEEN 1 AND 128
    AND octet_length(created_by_subject_id) BETWEEN 1 AND 4096
    AND jsonb_typeof(configuration) = 'object'
  )
);
CREATE UNIQUE INDEX automation_sources_endpoint_uq ON automation_sources(endpoint_id);
CREATE UNIQUE INDEX automation_sources_workspace_id_uq ON automation_sources(workspace_id, id);
CREATE INDEX automation_sources_workspace_status_idx ON automation_sources(workspace_id, status);

-- Credential-free routing only. The endpoint UUID discovers the tenant/source;
-- the FORCE-RLS source row and its encrypted secret still authenticate ingress.
CREATE TABLE automation_webhook_endpoints (
  endpoint_id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id uuid NOT NULL UNIQUE REFERENCES automation_sources(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT automation_webhook_endpoints_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE
);

CREATE TABLE automation_triggers (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id uuid NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  current_revision integer NOT NULL DEFAULT 1,
  pack_installation_id uuid,
  pack_template_id text,
  created_by_subject_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT automation_triggers_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT automation_triggers_source_fk FOREIGN KEY (workspace_id, source_id)
    REFERENCES automation_sources(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT automation_triggers_pack_installation_fk
    FOREIGN KEY (workspace_id, pack_installation_id)
    REFERENCES pack_installations(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT automation_triggers_shape_chk CHECK (
    status IN ('active', 'paused', 'disabled') AND current_revision > 0
    AND octet_length(name) BETWEEN 1 AND 512
    AND octet_length(created_by_subject_id) BETWEEN 1 AND 4096
    AND ((pack_installation_id IS NULL AND pack_template_id IS NULL)
      OR (pack_installation_id IS NOT NULL AND octet_length(pack_template_id) BETWEEN 1 AND 128))
  )
);
CREATE UNIQUE INDEX automation_triggers_workspace_id_uq ON automation_triggers(workspace_id, id);
CREATE UNIQUE INDEX automation_triggers_workspace_source_id_uq
  ON automation_triggers(workspace_id, id, source_id);
CREATE INDEX automation_triggers_workspace_status_idx ON automation_triggers(workspace_id, status);

CREATE TABLE automation_trigger_revisions (
  trigger_id uuid NOT NULL,
  revision integer NOT NULL,
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  adapter_id text NOT NULL,
  event_types jsonb NOT NULL,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
  session_template jsonb NOT NULL,
  created_by_subject_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trigger_id, revision),
  CONSTRAINT automation_trigger_revisions_trigger_fk FOREIGN KEY (workspace_id, trigger_id)
    REFERENCES automation_triggers(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT automation_trigger_revisions_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT automation_trigger_revisions_shape_chk CHECK (
    revision > 0 AND octet_length(adapter_id) BETWEEN 1 AND 128
    AND jsonb_typeof(event_types) = 'array' AND jsonb_array_length(event_types) BETWEEN 1 AND 64
    AND jsonb_typeof(configuration) = 'object'
    AND jsonb_typeof(parameters) = 'object'
    AND jsonb_typeof(session_template) = 'object'
  )
);

CREATE TABLE automation_trigger_events (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  source_id uuid NOT NULL,
  source_version integer NOT NULL,
  source_configuration jsonb NOT NULL,
  matched_trigger_revisions jsonb NOT NULL,
  delivery_key text NOT NULL,
  request_digest text NOT NULL,
  adapter_id text NOT NULL,
  event_type text NOT NULL,
  occurrence_key text NOT NULL,
  normalized_event jsonb NOT NULL,
  status text NOT NULL DEFAULT 'accepted',
  ignored_reason text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT automation_trigger_events_source_fk FOREIGN KEY (workspace_id, source_id)
    REFERENCES automation_sources(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT automation_trigger_events_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT automation_trigger_events_shape_chk CHECK (
    status IN ('accepted', 'ignored', 'failed')
    AND source_version > 0
    AND jsonb_typeof(source_configuration) = 'object'
    AND jsonb_typeof(matched_trigger_revisions) = 'array'
    AND jsonb_array_length(matched_trigger_revisions) <= 32
    AND request_digest ~ '^[0-9a-f]{64}$'
    AND octet_length(delivery_key) BETWEEN 1 AND 1024
    AND octet_length(event_type) BETWEEN 1 AND 256
    AND octet_length(occurrence_key) BETWEEN 1 AND 1024
    AND jsonb_typeof(normalized_event) = 'object'
  )
);
CREATE UNIQUE INDEX automation_trigger_events_source_delivery_uq
  ON automation_trigger_events(source_id, delivery_key);
CREATE INDEX automation_trigger_events_workspace_created_idx
  ON automation_trigger_events(workspace_id, created_at);
CREATE UNIQUE INDEX automation_trigger_events_workspace_source_id_uq
  ON automation_trigger_events(workspace_id, source_id, id);

CREATE TABLE automation_runs (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  source_id uuid NOT NULL,
  trigger_id uuid NOT NULL,
  trigger_revision integer NOT NULL,
  event_id uuid NOT NULL,
  occurrence_key text NOT NULL,
  accepted_execution jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT automation_runs_trigger_revision_fk FOREIGN KEY (trigger_id, trigger_revision)
    REFERENCES automation_trigger_revisions(trigger_id, revision) ON DELETE RESTRICT,
  CONSTRAINT automation_runs_source_fk FOREIGN KEY (workspace_id, source_id)
    REFERENCES automation_sources(workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT automation_runs_trigger_source_fk FOREIGN KEY (workspace_id, trigger_id, source_id)
    REFERENCES automation_triggers(workspace_id, id, source_id) ON DELETE RESTRICT,
  CONSTRAINT automation_runs_event_fk FOREIGN KEY (workspace_id, source_id, event_id)
    REFERENCES automation_trigger_events(workspace_id, source_id, id) ON DELETE RESTRICT,
  CONSTRAINT automation_runs_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT automation_runs_shape_chk CHECK (
    trigger_revision > 0
    AND status IN ('queued', 'dispatching', 'dispatched', 'skipped', 'failed')
    AND octet_length(occurrence_key) BETWEEN 1 AND 1024
    AND jsonb_typeof(accepted_execution) = 'object'
  )
);
CREATE UNIQUE INDEX automation_runs_trigger_occurrence_uq
  ON automation_runs(trigger_id, occurrence_key);
CREATE INDEX automation_runs_workspace_status_idx
  ON automation_runs(workspace_id, status, created_at);
CREATE UNIQUE INDEX automation_runs_workspace_trigger_id_uq
  ON automation_runs(workspace_id, trigger_id, id);

CREATE TABLE automation_run_event_links (
  run_id uuid NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES automation_trigger_events(id) ON DELETE CASCADE,
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  source_id uuid NOT NULL,
  trigger_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, event_id),
  CONSTRAINT automation_run_event_links_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT automation_run_event_links_run_fk FOREIGN KEY (workspace_id, trigger_id, run_id)
    REFERENCES automation_runs(workspace_id, trigger_id, id) ON DELETE CASCADE,
  CONSTRAINT automation_run_event_links_event_fk FOREIGN KEY (workspace_id, source_id, event_id)
    REFERENCES automation_trigger_events(workspace_id, source_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX automation_run_event_links_event_trigger_uq
  ON automation_run_event_links(event_id, trigger_id);

ALTER TABLE automation_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_sources FORCE ROW LEVEL SECURITY;
ALTER TABLE automation_triggers ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_triggers FORCE ROW LEVEL SECURITY;
ALTER TABLE automation_trigger_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_trigger_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE automation_trigger_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_trigger_events FORCE ROW LEVEL SECURITY;
ALTER TABLE automation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE automation_run_event_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_run_event_links FORCE ROW LEVEL SECURITY;

CREATE POLICY automation_sources_tenant ON automation_sources
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY automation_triggers_tenant ON automation_triggers
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY automation_trigger_revisions_tenant ON automation_trigger_revisions
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY automation_trigger_events_tenant ON automation_trigger_events
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY automation_runs_tenant ON automation_runs
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY automation_run_event_links_tenant ON automation_run_event_links
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY automation_runs_session_visibility ON automation_runs AS RESTRICTIVE
  USING (session_reference_visible(account_id, workspace_id, session_id))
  WITH CHECK (session_reference_visible(account_id, workspace_id, session_id));
