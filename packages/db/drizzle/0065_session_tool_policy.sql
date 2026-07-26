-- deployment-mode: rolling
-- Persist the origin of a session's tool allow-list. NULL is a
-- deliberate legacy marker for rows created before policy provenance existed.
ALTER TABLE "sessions"
  ADD COLUMN IF NOT EXISTS "tool_policy" jsonb;

ALTER TABLE "sessions"
  DROP CONSTRAINT IF EXISTS "sessions_tool_policy_shape_check";

ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_tool_policy_shape_check"
  CHECK (
    "tool_policy" IS NULL
    OR (
      jsonb_typeof("tool_policy") = 'object'
      AND "tool_policy" ? 'mode'
      AND ("tool_policy" ->> 'mode') IN ('workspace_default', 'explicit', 'inherited', 'legacy')
      AND "tool_policy" ? 'inheritedFromSessionId'
      AND (
        ("tool_policy" ->> 'inheritedFromSessionId') IS NULL
        OR ("tool_policy" ->> 'inheritedFromSessionId') ~ '^[0-9a-fA-F-]{36}$'
      )
    )
  ) NOT VALID;

-- Follow-up turns also need provenance: an omitted tools key inherits the
-- session policy, while an explicit array replaces it for that turn (subject
-- to the session subset fence). Existing turns used merge semantics and their
-- selected refs are already materialized on sessions.tools, so false preserves
-- their effective allow-list during the rolling upgrade.
ALTER TABLE "session_turns"
  ADD COLUMN IF NOT EXISTS "tools_provided" boolean NOT NULL DEFAULT false;

-- Human composer drafts need the same provenance across reloads. Without this,
-- [] cannot distinguish "inherit the session policy" from an intentional
-- per-turn empty selection.
ALTER TABLE "composer_drafts"
  ADD COLUMN IF NOT EXISTS "tools_provided" boolean NOT NULL DEFAULT false;
