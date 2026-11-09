-- deployment-mode: rolling
-- Turn timing profiles: where the wall time of each finished logical turn
-- went (queue, startup, dispatch, model inference/provider/network, tools,
-- sandbox, waits and the gaps between steps).
--
-- A control maintenance sweep computes one row per finished turn from the
-- session event log, under the turn's workspace RLS context, and writes it
-- here. Nothing on the turn's own path reads or writes this table.
--
-- Rolling: a new FORCE-RLS table the previous release never reads or writes,
-- with no new SECURITY DEFINER routine or trigger.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE turn_timing_profiles (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  version integer NOT NULL,
  status text NOT NULL,
  model text NOT NULL,
  provider text,
  reasoning_effort text NOT NULL,
  latency_mode text NOT NULL,
  surface text,
  source text NOT NULL,
  created_at timestamptz NOT NULL,
  started_at timestamptz,
  finished_at timestamptz NOT NULL,
  wall_ms bigint NOT NULL,
  queue_ms bigint NOT NULL,
  turn_start_ms bigint NOT NULL,
  dispatch_ms bigint NOT NULL,
  model_inference_ms bigint NOT NULL,
  model_provider_other_ms bigint NOT NULL,
  model_network_ms bigint NOT NULL,
  model_unsplit_ms bigint NOT NULL,
  model_stalled_ms bigint NOT NULL,
  web_search_ms bigint NOT NULL,
  mcp_tool_ms bigint NOT NULL,
  sandbox_tool_ms bigint NOT NULL,
  own_tool_ms bigint NOT NULL,
  sandbox_setup_ms bigint NOT NULL,
  human_wait_ms bigint NOT NULL,
  capacity_wait_ms bigint NOT NULL,
  after_model_ms bigint NOT NULL,
  after_tool_ms bigint NOT NULL,
  recovery_ms bigint NOT NULL,
  turn_end_ms bigint NOT NULL,
  attempts integer NOT NULL,
  model_requests integer NOT NULL,
  tool_calls integer NOT NULL,
  steps jsonb NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (workspace_id, turn_id),
  CONSTRAINT turn_timing_profiles_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT turn_timing_profiles_workspace_turn_fk FOREIGN KEY (workspace_id, turn_id)
    REFERENCES session_turns(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT turn_timing_profiles_steps_array_chk CHECK (jsonb_typeof(steps) = 'array')
);

CREATE INDEX turn_timing_profiles_workspace_finished_idx
  ON turn_timing_profiles (workspace_id, finished_at);
CREATE INDEX turn_timing_profiles_finished_idx ON turn_timing_profiles (finished_at);

ALTER TABLE turn_timing_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE turn_timing_profiles FORCE ROW LEVEL SECURITY;
REVOKE ALL ON turn_timing_profiles FROM PUBLIC;
CREATE POLICY workspace_isolation ON turn_timing_profiles
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
-- Same session visibility rule as the turn's events.
CREATE POLICY session_visibility_isolation ON turn_timing_profiles AS RESTRICTIVE
  USING (EXISTS (SELECT 1 FROM sessions session_row
    WHERE session_row.account_id = turn_timing_profiles.account_id
      AND session_row.workspace_id = turn_timing_profiles.workspace_id
      AND session_row.id = turn_timing_profiles.session_id OFFSET 0))
  WITH CHECK (EXISTS (SELECT 1 FROM sessions session_row
    WHERE session_row.account_id = turn_timing_profiles.account_id
      AND session_row.workspace_id = turn_timing_profiles.workspace_id
      AND session_row.id = turn_timing_profiles.session_id OFFSET 0));

DO $turn_timing_profiles_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    REVOKE ALL ON turn_timing_profiles FROM opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON turn_timing_profiles TO opengeni_app;
  END IF;
END
$turn_timing_profiles_grants$;
