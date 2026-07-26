-- One-way production remediation after the 0057 session-control cutover.
--
-- 1. Provider response usage has exactly one authoritative current event. SDK
--    wrapper duplicates stay in the audit log with an explicit association.
-- 2. Workflow repair enrolls every durable state that needs a session workflow,
--    including approval/capacity waits and pending control settlement.

ALTER TABLE "session_events"
  DROP CONSTRAINT "session_events_turn_association_check";

ALTER TABLE "session_events"
  ADD COLUMN "duplicate_of_event_id" uuid,
  ADD COLUMN "duplicate_reason" text;

ALTER TABLE "session_events"
  ADD CONSTRAINT "session_events_duplicate_of_event_fk"
  FOREIGN KEY ("duplicate_of_event_id")
  REFERENCES "session_events"("id") ON DELETE RESTRICT;

ALTER TABLE "session_events"
  ADD CONSTRAINT "session_events_turn_association_check"
  CHECK (
    "turn_association" IS NULL
    OR "turn_association" IN ('current', 'late_rejected', 'duplicate')
  );

-- Keep the earliest event as the authoritative observation. Every later event
-- for the same turn/provider-response source remains queryable and points to
-- that canonical row; nothing is deleted or disguised as a late attempt write.
WITH ranked AS (
  SELECT
    e."id",
    first_value(e."id") OVER (
      PARTITION BY
        e."workspace_id",
        e."session_id",
        e."turn_id",
        e."payload" ->> 'sourceKey'
      ORDER BY e."sequence", e."id"
    ) AS "canonical_id",
    row_number() OVER (
      PARTITION BY
        e."workspace_id",
        e."session_id",
        e."turn_id",
        e."payload" ->> 'sourceKey'
      ORDER BY e."sequence", e."id"
    ) AS "ordinal"
  FROM "session_events" e
  WHERE e."type" = 'agent.model.usage'
    AND e."turn_association" = 'current'
    AND e."turn_id" IS NOT NULL
    AND nullif(e."payload" ->> 'sourceKey', '') IS NOT NULL
)
UPDATE "session_events" e
SET "turn_association" = 'duplicate',
    "duplicate_of_event_id" = ranked."canonical_id",
    "duplicate_reason" = 'duplicate_provider_response_usage'
FROM ranked
WHERE e."id" = ranked."id"
  AND ranked."ordinal" > 1;

ALTER TABLE "session_events"
  ADD CONSTRAINT "session_events_duplicate_classification_check"
  CHECK (
    (
      "turn_association" = 'duplicate'
      AND "type" = 'agent.model.usage'
      AND "duplicate_of_event_id" IS NOT NULL
      AND "duplicate_of_event_id" <> "id"
      AND nullif("duplicate_reason", '') IS NOT NULL
    )
    OR (
      "turn_association" IS DISTINCT FROM 'duplicate'
      AND "duplicate_of_event_id" IS NULL
      AND "duplicate_reason" IS NULL
    )
  );

CREATE UNIQUE INDEX "session_events_current_model_usage_source_uq"
  ON "session_events" (
    "workspace_id",
    "session_id",
    "turn_id",
    (("payload" ->> 'sourceKey'))
  )
  WHERE "type" = 'agent.model.usage'
    AND "turn_association" = 'current'
    AND "turn_id" IS NOT NULL
    AND nullif("payload" ->> 'sourceKey', '') IS NOT NULL;

-- The old name described database claimability, not the actual operational
-- contract. A workflow must also be enrolled while it waits for approval or
-- capacity, and any pending Pause/Steer control needs a workflow to settle it.
DROP FUNCTION opengeni_private.list_claimable_sessions(integer);

CREATE FUNCTION opengeni_private.list_enrollable_sessions(p_limit integer)
RETURNS TABLE (
  account_id uuid,
  workspace_id uuid,
  session_id uuid,
  temporal_workflow_id text
)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT DISTINCT
    s.account_id,
    s.workspace_id,
    s.id,
    coalesce(s.temporal_workflow_id, 'session-' || s.id::text)
  FROM sessions s
  JOIN workspaces w ON w.id = s.workspace_id
  WHERE
    -- Controls are durable intent. Even a closed inference gate must enroll a
    -- workflow long enough to settle the pending Pause/Steer fence.
    s.pending_control_event_id IS NOT NULL
    OR (
      s.control_state = 'active'
      AND (
        w.inference_state = 'active'
        OR s.workspace_run_exception_generation = w.inference_generation
      )
      AND (
        EXISTS (
          SELECT 1 FROM session_turns t
          WHERE t.workspace_id = s.workspace_id
            AND t.session_id = s.id
            AND t.status IN ('queued', 'recovering', 'waiting_capacity', 'requires_action')
        )
        OR EXISTS (
          SELECT 1 FROM session_system_updates u
          WHERE u.workspace_id = s.workspace_id
            AND u.session_id = s.id
            AND u.state = 'pending'
        )
        OR EXISTS (
          SELECT 1 FROM session_goals g
          WHERE g.workspace_id = s.workspace_id
            AND g.session_id = s.id
            AND g.status = 'active'
        )
      )
    )
  ORDER BY s.id
  LIMIT greatest(1, least(coalesce(p_limit, 1000), 10000));
$$;

REVOKE ALL ON FUNCTION opengeni_private.list_enrollable_sessions(integer) FROM PUBLIC;

DO $$
DECLARE target_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.list_enrollable_sessions(integer)
      TO opengeni_app;
  END IF;
END $$;
