-- deployment-mode: rolling
-- Automatic session titles are normalized in application code. Trigger DDL is
-- committed before the separately batched quarantine starts, so no heavyweight
-- table lock is held across a row scan. Unfenced old UPDATE writers are converted
-- to a no-op rather than raising, so a pre-policy scheduler still reaches
-- scheduled-occurrence delivery. Unfenced old create/fork/clone INSERTs receive
-- the neutral fallback.

SET LOCAL lock_timeout = '5s';

DROP TRIGGER IF EXISTS sessions_automatic_title_policy_v1_fence ON sessions;

-- FORCE RLS also binds the non-superuser table owner used by production
-- migrations. This persistent policy opens only an exact owner + transaction-
-- local capability seam; ordinary application roles cannot activate it. The
-- following migrations use that seam in one bounded statement per transaction.
DROP POLICY IF EXISTS sessions_automatic_title_quarantine_v1 ON sessions;
CREATE POLICY sessions_automatic_title_quarantine_v1 ON sessions
FOR ALL
USING (
  current_user = (
    SELECT pg_catalog.pg_get_userbyid(relation.relowner)
    FROM pg_catalog.pg_class relation
    WHERE relation.oid = 'sessions'::regclass
  )
  AND pg_catalog.current_setting(
    'opengeni.automatic_session_title_quarantine_v1',
    true
  ) = '1'
)
WITH CHECK (
  current_user = (
    SELECT pg_catalog.pg_get_userbyid(relation.relowner)
    FROM pg_catalog.pg_class relation
    WHERE relation.oid = 'sessions'::regclass
  )
  AND pg_catalog.current_setting(
    'opengeni.automatic_session_title_quarantine_v1',
    true
  ) = '1'
);

-- The quarantine advances the authoritative session sequence and appends a
-- safe title event in the same transaction. Give that INSERT the identical
-- owner/capability fence so rolling clients receive a superseding projection.
DROP POLICY IF EXISTS session_events_automatic_title_quarantine_v1 ON session_events;
CREATE POLICY session_events_automatic_title_quarantine_v1 ON session_events
FOR ALL
USING (
  current_user = (
    SELECT pg_catalog.pg_get_userbyid(relation.relowner)
    FROM pg_catalog.pg_class relation
    WHERE relation.oid = 'session_events'::regclass
  )
  AND pg_catalog.current_setting(
    'opengeni.automatic_session_title_quarantine_v1',
    true
  ) = '1'
)
WITH CHECK (
  current_user = (
    SELECT pg_catalog.pg_get_userbyid(relation.relowner)
    FROM pg_catalog.pg_class relation
    WHERE relation.oid = 'session_events'::regclass
  )
  AND pg_catalog.current_setting(
    'opengeni.automatic_session_title_quarantine_v1',
    true
  ) = '1'
);

-- Migration-created title events have no application process available to
-- perform the ordinary post-commit NATS publish. Persist that obligation next
-- to the event so the existing deployment-wide workflow-wake dispatcher can
-- fan it out after any migration/worker crash. This is deliberately one
-- bounded global outbox, not one durable poll per open SSE connection.
CREATE TABLE opengeni_private.automatic_session_title_fanout_outbox_v1 (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL,
  event_id uuid NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT automatic_title_fanout_attempts_chk CHECK (attempts >= 0),
  CONSTRAINT automatic_title_fanout_workspace_account_fk
    FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT automatic_title_fanout_workspace_session_fk
    FOREIGN KEY (workspace_id, session_id)
    REFERENCES sessions(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT automatic_title_fanout_workspace_event_fk
    FOREIGN KEY (workspace_id, event_id)
    REFERENCES session_events(workspace_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX automatic_title_fanout_event_uq
  ON opengeni_private.automatic_session_title_fanout_outbox_v1(event_id);
CREATE INDEX automatic_title_fanout_pending_idx
  ON opengeni_private.automatic_session_title_fanout_outbox_v1(created_at, id)
  WHERE delivered_at IS NULL;

ALTER TABLE opengeni_private.automatic_session_title_fanout_outbox_v1
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE opengeni_private.automatic_session_title_fanout_outbox_v1
  FORCE ROW LEVEL SECURITY;
CREATE POLICY automatic_title_fanout_owner_v1
ON opengeni_private.automatic_session_title_fanout_outbox_v1
FOR ALL
USING (
  current_user = (
    SELECT pg_catalog.pg_get_userbyid(relation.relowner)
    FROM pg_catalog.pg_class relation
    WHERE relation.oid =
      'opengeni_private.automatic_session_title_fanout_outbox_v1'::regclass
  )
)
WITH CHECK (
  current_user = (
    SELECT pg_catalog.pg_get_userbyid(relation.relowner)
    FROM pg_catalog.pg_class relation
    WHERE relation.oid =
      'opengeni_private.automatic_session_title_fanout_outbox_v1'::regclass
  )
);

REVOKE ALL ON TABLE
  opengeni_private.automatic_session_title_fanout_outbox_v1
  FROM PUBLIC;

-- Keep the batched backfill as one WITH statement while preserving the old
-- runtime posture's all-private-routines EXECUTE rule. This helper is
-- deliberately SECURITY INVOKER: the application role may execute it but the
-- table ACL and owner-only FORCE-RLS policy deny its INSERT, while the
-- non-superuser table owner running migration 0355 can enqueue the exact event
-- identity.
CREATE OR REPLACE FUNCTION opengeni_private.enqueue_automatic_session_title_fanout_v1(
  p_account_id uuid,
  p_workspace_id uuid,
  p_session_id uuid,
  p_event_id uuid
)
RETURNS boolean
LANGUAGE sql
SECURITY INVOKER
SET search_path FROM CURRENT
AS $automatic_title_fanout_enqueue$
  WITH enqueued AS (
    INSERT INTO opengeni_private.automatic_session_title_fanout_outbox_v1 (
      account_id,
      workspace_id,
      session_id,
      event_id
    ) VALUES (
      p_account_id,
      p_workspace_id,
      p_session_id,
      p_event_id
    )
    ON CONFLICT (event_id) DO NOTHING
    RETURNING true AS changed
  )
  SELECT coalesce((SELECT changed FROM enqueued), false);
$automatic_title_fanout_enqueue$;

CREATE OR REPLACE FUNCTION opengeni_private.claim_automatic_session_title_fanout_v1(
  p_limit integer
)
RETURNS TABLE (
  outbox_id uuid,
  account_id uuid,
  workspace_id uuid,
  session_id uuid,
  event_id uuid,
  sequence integer,
  type text,
  payload jsonb,
  payload_codec_version integer,
  occurred_at timestamptz,
  client_event_id text,
  turn_id uuid,
  turn_generation integer,
  turn_attempt_id uuid,
  turn_association text,
  duplicate_of_event_id uuid,
  duplicate_reason text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $automatic_title_fanout_claim$
  WITH candidates AS MATERIALIZED (
    SELECT pending.id
    FROM opengeni_private.automatic_session_title_fanout_outbox_v1 pending
    WHERE pending.delivered_at IS NULL
    ORDER BY pending.created_at, pending.id
    FOR UPDATE SKIP LOCKED
    LIMIT greatest(1, least(coalesce(p_limit, 100), 1000))
  ),
  claimed AS (
    UPDATE opengeni_private.automatic_session_title_fanout_outbox_v1 pending
    SET attempts = pending.attempts + 1,
        updated_at = pg_catalog.clock_timestamp()
    FROM candidates
    WHERE pending.id = candidates.id
      AND pending.delivered_at IS NULL
    RETURNING pending.id, pending.event_id
  )
  SELECT
    claimed.id,
    event.account_id,
    event.workspace_id,
    event.session_id,
    event.id,
    event.sequence,
    event.type,
    event.payload,
    event.payload_codec_version,
    event.occurred_at,
    event.client_event_id,
    event.turn_id,
    event.turn_generation,
    event.turn_attempt_id,
    event.turn_association,
    event.duplicate_of_event_id,
    event.duplicate_reason
  FROM claimed
  JOIN session_events event ON event.id = claimed.event_id
  ORDER BY event.workspace_id, event.session_id, event.sequence;
$automatic_title_fanout_claim$;

CREATE OR REPLACE FUNCTION opengeni_private.mark_automatic_session_title_fanout_delivered_v1(
  p_outbox_id uuid,
  p_event_id uuid
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $automatic_title_fanout_delivered$
  WITH delivered AS (
    UPDATE opengeni_private.automatic_session_title_fanout_outbox_v1 pending
    SET delivered_at = pg_catalog.clock_timestamp(),
        last_error = NULL,
        updated_at = pg_catalog.clock_timestamp()
    WHERE pending.id = p_outbox_id
      AND pending.event_id = p_event_id
      AND pending.delivered_at IS NULL
    RETURNING true AS changed
  )
  SELECT coalesce((SELECT changed FROM delivered), false);
$automatic_title_fanout_delivered$;

CREATE OR REPLACE FUNCTION opengeni_private.mark_automatic_session_title_fanout_failed_v1(
  p_outbox_id uuid,
  p_event_id uuid,
  p_error text
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $automatic_title_fanout_failed$
  WITH failed AS (
    UPDATE opengeni_private.automatic_session_title_fanout_outbox_v1 pending
    SET last_error = pg_catalog.left(coalesce(p_error, 'unknown failure'), 500),
        updated_at = pg_catalog.clock_timestamp()
    WHERE pending.id = p_outbox_id
      AND pending.event_id = p_event_id
      AND pending.delivered_at IS NULL
    RETURNING true AS changed
  )
  SELECT coalesce((SELECT changed FROM failed), false);
$automatic_title_fanout_failed$;

REVOKE ALL ON FUNCTION
  opengeni_private.enqueue_automatic_session_title_fanout_v1(uuid, uuid, uuid, uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  opengeni_private.claim_automatic_session_title_fanout_v1(integer)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  opengeni_private.mark_automatic_session_title_fanout_delivered_v1(uuid, uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  opengeni_private.mark_automatic_session_title_fanout_failed_v1(uuid, uuid, text)
  FROM PUBLIC;

-- The 0345 session-tenancy trigger requires every non-superuser migration
-- owner to hold the affected workspace fence before PostgreSQL takes a session
-- row lock. Discover only the workspaces represented by the next bounded id
-- batch, then acquire their shared fences in canonical UUID order. Return the
-- exact locked set so the later row-locking query cannot race into a newly
-- eligible workspace that this invocation did not fence.
DROP FUNCTION IF EXISTS acquire_automatic_session_title_quarantine_fences_v1(integer);
CREATE FUNCTION acquire_automatic_session_title_quarantine_fences_v1(
  p_batch_size integer
)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $automatic_title_quarantine_fences$
DECLARE
  workspace_id_value uuid;
  workspace_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  IF p_batch_size IS NULL OR p_batch_size <= 0 THEN
    RETURN workspace_ids;
  END IF;

  PERFORM pg_catalog.set_config(
    'opengeni.automatic_session_title_quarantine_v1',
    '1',
    true
  );
  FOR workspace_id_value IN
    SELECT DISTINCT bounded.workspace_id
    FROM (
      SELECT session.id, session.workspace_id
      FROM sessions session
      WHERE session.title_source IS DISTINCT FROM 'user'
        AND (
          session.title IS DISTINCT FROM 'New conversation'
          OR session.title_source IS DISTINCT FROM 'agent'
        )
      ORDER BY session.id
      LIMIT p_batch_size
    ) bounded
    WHERE bounded.workspace_id IS NOT NULL
    ORDER BY bounded.workspace_id
  LOOP
    PERFORM acquire_session_tenancy_fence(workspace_id_value);
    workspace_ids := pg_catalog.array_append(workspace_ids, workspace_id_value);
  END LOOP;

  RETURN workspace_ids;
END
$automatic_title_quarantine_fences$;

REVOKE ALL ON FUNCTION
  acquire_automatic_session_title_quarantine_fences_v1(integer)
  FROM PUBLIC;

CREATE OR REPLACE FUNCTION opengeni_private.enforce_automatic_session_title_policy_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  candidate text := nullif(
    pg_catalog.current_setting('opengeni.automatic_session_title_v1_candidate', true),
    ''
  );
BEGIN
  IF TG_OP = 'INSERT'
     AND NEW.title_source IS DISTINCT FROM 'user'
     AND (
       NEW.title IS DISTINCT FROM 'New conversation'
       OR NEW.title_source IS DISTINCT FROM 'agent'
     )
     AND (candidate IS NULL OR candidate IS DISTINCT FROM NEW.title)
  THEN
    -- Old create/fork/clone paths remain rolling- and rollback-compatible, but
    -- no unversioned automatic title crosses the new display boundary.
    NEW.title := 'New conversation';
    NEW.title_source := 'agent';
  ELSIF TG_OP = 'UPDATE'
     AND (OLD.title IS DISTINCT FROM NEW.title
      OR OLD.title_source IS DISTINCT FROM NEW.title_source)
     AND NEW.title_source = 'agent'
     AND (NEW.title IS DISTINCT FROM 'New conversation' OR OLD.title_source = 'user')
     AND (candidate IS NULL OR candidate IS DISTINCT FROM NEW.title)
  THEN
    -- Returning OLD title fields makes the pre-policy helper's RETURNING row
    -- and subsequent title event safe while allowing the dispatch to continue.
    NEW.title := OLD.title;
    NEW.title_source := OLD.title_source;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION opengeni_private.enforce_automatic_session_title_policy_v1()
FROM PUBLIC;

-- Pre-policy API and worker binaries require EXECUTE on every non-artifact
-- opengeni_private routine during startup/readiness. Preserve that rolling and
-- rollback posture for every exact runtime login supplied to the migration
-- runner. PUBLIC remains revoked, the app roles receive no direct outbox table
-- privileges, the enqueue helper remains SECURITY INVOKER, and PostgreSQL
-- trigger functions cannot be called as ordinary functions.
DO $automatic_title_rolling_compatibility_grants$
DECLARE
  configured_roles_text text := nullif(
    pg_catalog.current_setting('opengeni.migration_application_roles', true), ''
  );
  configured_roles jsonb;
  role_name text;
  routine_signature text;
BEGIN
  IF configured_roles_text IS NULL THEN
    RAISE EXCEPTION
      '0353 automatic session title policy requires an explicit application database role list'
      USING ERRCODE = '55000';
  END IF;
  BEGIN
    configured_roles := configured_roles_text::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION
      '0353 automatic session title policy received a malformed application database role list'
      USING ERRCODE = '55000';
  END;
  IF pg_catalog.jsonb_typeof(configured_roles) <> 'array'
    OR pg_catalog.jsonb_array_length(configured_roles) NOT BETWEEN 1 AND 16
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_array_elements(configured_roles) AS roles(value)
      WHERE pg_catalog.jsonb_typeof(value) <> 'string'
        OR pg_catalog.btrim(value #>> '{}') = ''
        OR pg_catalog.octet_length(value #>> '{}') > 63
    )
    OR (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.jsonb_array_elements_text(configured_roles)
    ) <> (
      SELECT pg_catalog.count(DISTINCT value)
      FROM pg_catalog.jsonb_array_elements_text(configured_roles) AS roles(value)
    )
  THEN
    RAISE EXCEPTION
      '0353 automatic session title policy received an invalid application database role list'
      USING ERRCODE = '55000';
  END IF;

  FOR role_name IN
    SELECT value
    FROM pg_catalog.jsonb_array_elements_text(configured_roles) AS roles(value)
    ORDER BY value COLLATE "C"
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles role_row WHERE role_row.rolname = role_name
    ) THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE opengeni_private.automatic_session_title_fanout_outbox_v1 FROM %I',
        role_name
      );
      FOREACH routine_signature IN ARRAY ARRAY[
        'enqueue_automatic_session_title_fanout_v1(uuid, uuid, uuid, uuid)',
        'claim_automatic_session_title_fanout_v1(integer)',
        'mark_automatic_session_title_fanout_delivered_v1(uuid, uuid)',
        'mark_automatic_session_title_fanout_failed_v1(uuid, uuid, text)',
        'enforce_automatic_session_title_policy_v1()'
      ]
      LOOP
        EXECUTE pg_catalog.format(
          'GRANT EXECUTE ON FUNCTION opengeni_private.%s TO %I',
          routine_signature,
          role_name
        );
      END LOOP;
    END IF;
  END LOOP;
END
$automatic_title_rolling_compatibility_grants$;

CREATE TRIGGER sessions_automatic_title_policy_v1_fence
BEFORE INSERT OR UPDATE OF title, title_source ON sessions
FOR EACH ROW
EXECUTE FUNCTION opengeni_private.enforce_automatic_session_title_policy_v1();
