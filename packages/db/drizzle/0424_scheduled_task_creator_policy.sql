-- deployment-mode: rolling
-- Scheduled tasks created by a live agent attempt freeze the creating
-- session's effective first-party tool selection, first-party permission set,
-- and session access policy. Sessions generated for such a task inherit that
-- frozen creator boundary instead of the deployment default catalog, so a
-- narrowed session cannot widen itself through a schedule. Human/API creates
-- leave every column NULL and keep today's deployment-default behaviour.
--
-- Rolling: additive nullable columns only. The execution digest keeps its
-- exact pre-0424 bytes for every existing row and for every NULL-policy task:
-- the digest functions strip the three keys while they are NULL and include
-- them only once a creator policy is actually frozen, so a run admitted before
-- this migration still matches its task head afterwards.

ALTER TABLE "scheduled_tasks"
  ADD COLUMN "creator_first_party_mcp_tools" jsonb,
  ADD COLUMN "creator_first_party_mcp_permissions" jsonb,
  ADD COLUMN "creator_session_policy" jsonb,
  ADD CONSTRAINT "scheduled_tasks_creator_first_party_mcp_tools_chk" CHECK (
    creator_first_party_mcp_tools IS NULL
    OR (
      jsonb_typeof(creator_first_party_mcp_tools) = 'array'
      AND octet_length(creator_first_party_mcp_tools::text) <= 16384
    )
  ),
  ADD CONSTRAINT "scheduled_tasks_creator_first_party_mcp_permissions_chk" CHECK (
    creator_first_party_mcp_permissions IS NULL
    OR (
      jsonb_typeof(creator_first_party_mcp_permissions) = 'array'
      AND octet_length(creator_first_party_mcp_permissions::text) <= 4096
    )
  ),
  ADD CONSTRAINT "scheduled_tasks_creator_session_policy_chk" CHECK (
    creator_session_policy IS NULL
    OR (
      jsonb_typeof(creator_session_policy) = 'object'
      AND octet_length(creator_session_policy::text) <= 4096
    )
  );

-- Same exclusion list as 0252; the three new keys are additionally excluded
-- only while NULL so legacy and human-created digests stay byte-identical.
CREATE OR REPLACE FUNCTION scheduled_task_execution_digest(
  p_task scheduled_tasks
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $scheduled_task_execution_digest$
  SELECT pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      (
        pg_catalog.to_jsonb(p_task)
          - ARRAY[
            'name',
            'status',
            'updated_at',
            'authority_revision',
            'execution_digest'
          ]::text[]
          - (CASE WHEN p_task.creator_first_party_mcp_tools IS NULL
              THEN ARRAY['creator_first_party_mcp_tools'] ELSE ARRAY[]::text[] END)
          - (CASE WHEN p_task.creator_first_party_mcp_permissions IS NULL
              THEN ARRAY['creator_first_party_mcp_permissions'] ELSE ARRAY[]::text[] END)
          - (CASE WHEN p_task.creator_session_policy IS NULL
              THEN ARRAY['creator_session_policy'] ELSE ARRAY[]::text[] END)
      )::text,
      'UTF8'
    )),
    'hex'
  )
$scheduled_task_execution_digest$;

CREATE OR REPLACE FUNCTION set_scheduled_task_execution_digest()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $set_scheduled_task_execution_digest$
BEGIN
  NEW.execution_digest := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      (
        pg_catalog.to_jsonb(NEW)
          - ARRAY[
            'name',
            'status',
            'updated_at',
            'authority_revision',
            'execution_digest'
          ]::text[]
          - (CASE WHEN NEW.creator_first_party_mcp_tools IS NULL
              THEN ARRAY['creator_first_party_mcp_tools'] ELSE ARRAY[]::text[] END)
          - (CASE WHEN NEW.creator_first_party_mcp_permissions IS NULL
              THEN ARRAY['creator_first_party_mcp_permissions'] ELSE ARRAY[]::text[] END)
          - (CASE WHEN NEW.creator_session_policy IS NULL
              THEN ARRAY['creator_session_policy'] ELSE ARRAY[]::text[] END)
      )::text,
      'UTF8'
    )),
    'hex'
  );
  RETURN NEW;
END
$set_scheduled_task_execution_digest$;

-- CREATE OR REPLACE resets proconfig to the inline clause above; re-pin the
-- trusted data schema exactly as 0252 hardened these routines.
DO $scheduled_task_creator_policy_search_path$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %1$I.scheduled_task_execution_digest(%1$I.scheduled_tasks) '
      || 'SET search_path = pg_catalog, %1$I, pg_temp',
    data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %1$I.set_scheduled_task_execution_digest() '
      || 'SET search_path = pg_catalog, %1$I, pg_temp',
    data_schema
  );
END
$scheduled_task_creator_policy_search_path$;

REVOKE ALL ON FUNCTION scheduled_task_execution_digest(scheduled_tasks) FROM PUBLIC;
REVOKE ALL ON FUNCTION set_scheduled_task_execution_digest() FROM PUBLIC;
