-- One-time REPAIR of legacy orphaned tool-call RESULT rows (issue-61 self-heal).
--
-- Conversation truth is replayed verbatim into the model on every turn. The
-- Responses API rejects the whole request (HTTP 400 "No tool call found for
-- function call output with call_id <X>") when a tool-call RESULT row
-- (function_call_result / computer_call_result / shell_call_output /
-- apply_patch_call_output) has no matching CALL earlier in the active sequence.
-- Because the corrupt row is replayed every turn, one such orphan permanently
-- bricks the session across revival until the row is removed.
--
-- The read-path sanitizer (sanitizeHistoryItemsForModel) already filters these
-- in-memory so new turns survive, and the write-path watermark fix (seed from
-- the SANITIZED active length) stops new orphans from ever being persisted. But
-- sessions corrupted BEFORE those fixes still carry the orphaned row on disk;
-- the audit trail (session_get / session_events / exports) keeps surfacing a
-- result with no call, and the row needlessly re-triggers the sanitizer every
-- turn. This migration strips those already-persisted orphans once so corrupted
-- sessions self-heal on disk, paired and audited.
--
-- DEFINITION OF AN ORPHAN (mirrors the sanitizer's rule 1 exactly):
--   * The row is an ACTIVE result-type row (the live, model-facing sequence is
--     the only thing the read path replays; superseded prefix rows are audit
--     trail and never reach the model). active=false rows are left untouched.
--   * No ACTIVE row of the matching CALL type, with the same correlation id,
--     exists at a STRICTLY EARLIER position in the same (workspace, session).
--   * Correlation id is read from BOTH the SDK camelCase `callId` and the wire
--     snake_case `call_id`, matching the sanitizer's callIdOf().
--
-- We deliberately do NOT touch DANGLING CALLS (a call with no result yet): a
-- call awaiting a not-yet-settled result is valid mid-turn, not corruption; the
-- read-path sanitizer drops it transiently and it settles on the next pass.
--
-- Every deleted row is first copied verbatim into the permanent audit table
-- session_history_items_repair_audit, so the repair is reversible and auditable.

-- Permanent audit of every row this repair removed.
CREATE TABLE IF NOT EXISTS "session_history_items_repair_audit" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- The original session_history_items row, captured verbatim. No FK back to the
  -- source row: it is being deleted, and the audit must outlive it.
  "source_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "turn_id" uuid,
  "position" numeric NOT NULL,
  "item" jsonb NOT NULL,
  "source_created_at" timestamptz NOT NULL,
  "repair_reason" text NOT NULL,
  "repaired_at" timestamptz NOT NULL DEFAULT now()
);

-- Result-item types and the CALL type that settles each, kept in sync with the
-- runtime sanitizer's RESULT_TYPE_BY_CALL_TYPE. Built once as a CTE so the
-- DELETE and the audit INSERT share one definition of an orphan.
WITH "result_call_pairs" ("result_type", "call_type") AS (
  VALUES
    ('function_call_result', 'function_call'),
    ('computer_call_result', 'computer_call'),
    ('shell_call_output', 'shell_call'),
    ('apply_patch_call_output', 'apply_patch_call')
),
-- Every ACTIVE result-type row, with its correlation id and the call type that
-- would settle it.
"active_results" AS (
  SELECT
    h."id",
    h."account_id",
    h."workspace_id",
    h."session_id",
    h."turn_id",
    h."position",
    h."item",
    h."created_at",
    p."call_type",
    COALESCE(h."item" ->> 'callId', h."item" ->> 'call_id') AS "call_id"
  FROM "session_history_items" h
  JOIN "result_call_pairs" p
    ON p."result_type" = (h."item" ->> 'type')
  WHERE h."active" = true
    AND COALESCE(h."item" ->> 'callId', h."item" ->> 'call_id') IS NOT NULL
),
-- The orphans: an active result row with NO active matching call at a strictly
-- earlier position in the same session.
"orphans" AS (
  SELECT r.*
  FROM "active_results" r
  WHERE NOT EXISTS (
    SELECT 1
    FROM "session_history_items" c
    WHERE c."workspace_id" = r."workspace_id"
      AND c."session_id" = r."session_id"
      AND c."active" = true
      AND (c."item" ->> 'type') = r."call_type"
      AND COALESCE(c."item" ->> 'callId', c."item" ->> 'call_id') = r."call_id"
      AND c."position" < r."position"
  )
),
-- Audit every orphan before deleting it.
"audited" AS (
  INSERT INTO "session_history_items_repair_audit" (
    "source_id", "account_id", "workspace_id", "session_id", "turn_id",
    "position", "item", "source_created_at", "repair_reason"
  )
  SELECT
    o."id", o."account_id", o."workspace_id", o."session_id", o."turn_id",
    o."position", o."item", o."created_at",
    'orphaned_tool_call_result_no_matching_call'
  FROM "orphans" o
  RETURNING "source_id"
)
DELETE FROM "session_history_items" h
USING "audited" a
WHERE h."id" = a."source_id";

-- The audit table holds no workspace-scoped RLS (it is an operator/audit
-- artifact written only by this migration), but grant the app role the same
-- table access the rest of the schema gets so a later GRANT-ALL sweep is
-- idempotent and the role inventory stays uniform.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO opengeni_app;
  END IF;
END $$;
