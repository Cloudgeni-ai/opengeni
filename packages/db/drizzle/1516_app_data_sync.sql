-- deployment-mode: rolling
-- App data sync (docs/app-sync.md): an automation action that calls one
-- connected tool with fixed arguments and upserts the kept fields of each
-- returned record by key into a collection of an App's (Site's) data, with no
-- model run.
--
--   1. scheduled_tasks.action and scheduled_task_runs.action_kind accept
--      `app_sync`. A sync task has the same shape as every non-agent task
--      (new chat per run, no reusable chat, variable set or rig, skip or
--      buffer_one overlap).
--   2. scheduled_task_runs.sync_summary: what a sync run read and wrote.
--   3. app_sync_subscriptions: the people who opted in to a personal sync,
--      with each person's own last run (time, status, error, counts).
--   4. app_sync_queue: sync runs waiting for the API to execute them. Rows
--      hold only ids, a lease and a chain depth. The API's executor finds due
--      rows across workspaces through a read-only policy that applies only
--      outside any workspace or account context, and then claims, reads and
--      writes everything else under that workspace's row-level security.
--
-- Rolling: the previous release never writes `app_sync`, never reads the new
-- column or tables, and its readers of the checked columns are unaffected.
-- The two checks are replaced NOT VALID (like 1133) because every existing
-- row already satisfies the wider lists.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE scheduled_tasks DROP CONSTRAINT scheduled_tasks_action_chk;
ALTER TABLE scheduled_tasks ADD CONSTRAINT scheduled_tasks_action_chk CHECK (
  jsonb_typeof(action) = 'object'
  AND (action ->> 'kind') = ANY (ARRAY['agent_turn', 'knowledge_source_sync', 'app_sync']::text[])
  AND octet_length(convert_to(action::text, 'UTF8')) <= 32768
  AND (
    (action ->> 'kind') = 'agent_turn'
    OR (
      run_mode = 'new_session_per_run'
      AND reusable_session_id IS NULL
      AND variable_set_id IS NULL
      AND rig_id IS NULL
      AND overlap_policy = ANY (ARRAY['skip', 'buffer_one']::text[])
    )
  )
) NOT VALID;

ALTER TABLE scheduled_task_runs DROP CONSTRAINT scheduled_task_runs_action_chk;
ALTER TABLE scheduled_task_runs ADD CONSTRAINT scheduled_task_runs_action_chk CHECK (
  action_kind = ANY (ARRAY['agent_turn', 'knowledge_source_sync', 'app_sync']::text[])
  AND (
    knowledge_summary IS NULL
    OR (
      jsonb_typeof(knowledge_summary) = 'object'
      AND octet_length(convert_to(knowledge_summary::text, 'UTF8')) <= 16384
    )
  )
) NOT VALID;

ALTER TABLE scheduled_task_runs ADD COLUMN sync_summary jsonb;
ALTER TABLE scheduled_task_runs ADD CONSTRAINT scheduled_task_runs_sync_summary_chk CHECK (
  sync_summary IS NULL
  OR (
    jsonb_typeof(sync_summary) = 'object'
    AND octet_length(convert_to(sync_summary::text, 'UTF8')) <= 4096
  )
) NOT VALID;

CREATE TABLE app_sync_subscriptions (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  task_id uuid NOT NULL,
  subject_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_run_at timestamptz,
  last_status text,
  last_error text,
  last_summary jsonb,
  CONSTRAINT app_sync_subscriptions_pkey PRIMARY KEY (workspace_id, task_id, subject_id),
  CONSTRAINT app_sync_subscriptions_subject_check
    CHECK (char_length(subject_id) BETWEEN 1 AND 1024),
  CONSTRAINT app_sync_subscriptions_status_check
    CHECK (last_status IS NULL OR last_status IN ('succeeded', 'failed')),
  CONSTRAINT app_sync_subscriptions_error_check
    CHECK (last_error IS NULL OR char_length(last_error) <= 2000),
  CONSTRAINT app_sync_subscriptions_summary_check
    CHECK (
      last_summary IS NULL
      OR (jsonb_typeof(last_summary) = 'object' AND octet_length(last_summary::text) <= 4096)
    ),
  CONSTRAINT app_sync_subscriptions_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT app_sync_subscriptions_task_fk FOREIGN KEY (task_id)
    REFERENCES scheduled_tasks(id) ON DELETE CASCADE
);
CREATE INDEX app_sync_subscriptions_task_idx ON app_sync_subscriptions (task_id);
COMMENT ON TABLE app_sync_subscriptions IS 'People who opted in to a personal App data sync, with their own last run.';

CREATE TABLE app_sync_queue (
  run_id uuid NOT NULL,
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  task_id uuid NOT NULL,
  queued_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  -- The automation chain depth of a run an automation's agent started.
  chain_depth smallint NOT NULL DEFAULT 1,
  CONSTRAINT app_sync_queue_pkey PRIMARY KEY (run_id),
  CONSTRAINT app_sync_queue_attempts_check CHECK (attempts >= 0),
  CONSTRAINT app_sync_queue_chain_depth_check CHECK (chain_depth >= 0),
  CONSTRAINT app_sync_queue_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT app_sync_queue_run_fk FOREIGN KEY (run_id)
    REFERENCES scheduled_task_runs(id) ON DELETE CASCADE
);
CREATE INDEX app_sync_queue_due_idx ON app_sync_queue (queued_at);
CREATE INDEX app_sync_queue_task_idx ON app_sync_queue (task_id);
COMMENT ON TABLE app_sync_queue IS 'App data sync runs waiting for the API executor (ids only).';

ALTER TABLE app_sync_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_sync_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON app_sync_subscriptions
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

ALTER TABLE app_sync_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_sync_queue FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON app_sync_queue
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
-- The executor lists due runs across workspaces outside any workspace
-- context. A query inside a workspace or account context sees only that
-- workspace's rows; every claim and write needs the workspace's own context.
CREATE POLICY executor_read ON app_sync_queue FOR SELECT USING (
  opengeni_private.current_workspace_id() IS NULL
  AND opengeni_private.current_account_id() IS NULL
);

REVOKE ALL ON TABLE app_sync_subscriptions FROM PUBLIC;
REVOKE ALL ON TABLE app_sync_queue FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE app_sync_subscriptions TO opengeni_app';
    EXECUTE 'GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE app_sync_queue TO opengeni_app';
  END IF;
END
$$;
