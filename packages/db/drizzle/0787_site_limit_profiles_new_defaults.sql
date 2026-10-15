-- deployment-mode: rolling
-- Stored Site limit profiles move to the new limits model (docs/published-sites.md),
-- so existing Sites pick up the new defaults without a republish. Limits are
-- resolved from the stored profile and settings on every request; nothing
-- about them is held at the edge.
--
-- 1. `standard` replaces `free` (the API still accepts and reads `free` as
--    an alias, so a previous-release pod that writes `free` during the
--    rollout keeps working). Both CHECKs are widened, added NOT VALID: every
--    existing row already satisfies the wider predicate and new rows are
--    checked. Stored `free` rows become `standard`.
-- 2. The previous release saved a custom profile with all six of its fields
--    prefilled from the old free defaults. In every stored override object, a
--    field whose value equals that old default is removed so it takes the new
--    standard value: requestsPerMinutePerVisitor 120, guestWritesPerMinute 30,
--    agentsEnabled true, guestAgentsEnabled true, conversationsPerVisitorPerDay
--    10, conversationsPerSitePerDay 50, turnsPerConversation 20,
--    agentMicrosPerConversation 20000 ($0.02), agentMicrosPerVisitorPerDay
--    200000 ($0.20), agentMicrosPerSitePerMonth 2000000 ($2.00) and
--    agentModels null. So none of them turns on a per-person limit or a $0.02
--    conversation cap. The API ignores the same values when it reads a
--    profile, which covers rows an old pod writes after this runs.
-- 3. A custom profile left with no field of its own becomes `standard`.
--    Overrides on other kinds were never applied, and are removed.
-- 4. Fields an owner set to another value keep it. The new model reads them
--    by who they govern: agentMicrosPerSitePerMonth is the Site limit,
--    agentMicrosPerVisitorPerDay the per-person limit, and the conversation,
--    message and per-conversation caps are anonymous guests' bot guards.
--    Workspace members are never limited by any of them.
--
-- `credits` and `unlimited` keep their kind (they are derived from settings).
-- Both tables are FORCE RLS, so the backfill relaxes the owner-only posture
-- around it. The workspace defaults are rewritten before the Sites, so the
-- busier site_publications is locked last and for the shortest time.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE site_limit_profiles DROP CONSTRAINT IF EXISTS site_limit_profiles_kind_check;
ALTER TABLE site_limit_profiles
  ADD CONSTRAINT site_limit_profiles_kind_check
  CHECK (kind IN ('standard', 'free', 'credits', 'unlimited', 'custom')) NOT VALID;
ALTER TABLE site_limit_profiles NO FORCE ROW LEVEL SECURITY;
UPDATE site_limit_profiles AS profile
SET kind = CASE
    WHEN profile.kind = 'free' THEN 'standard'
    WHEN profile.kind = 'custom' AND rewritten.overrides IS NULL THEN 'standard'
    ELSE profile.kind
  END,
  overrides = CASE WHEN profile.kind = 'custom' THEN rewritten.overrides END
FROM (
  SELECT p.workspace_id, (
    SELECT jsonb_object_agg(field.key, field.value)
    FROM jsonb_each(p.overrides) AS field
    WHERE field.value IS DISTINCT FROM (
      '{"requestsPerMinutePerVisitor":120,"guestWritesPerMinute":30,"agentsEnabled":true,"guestAgentsEnabled":true,"conversationsPerVisitorPerDay":10,"conversationsPerSitePerDay":50,"turnsPerConversation":20,"agentMicrosPerConversation":20000,"agentMicrosPerVisitorPerDay":200000,"agentMicrosPerSitePerMonth":2000000,"agentModels":null}'::jsonb
      -> field.key
    )
  ) AS overrides
  FROM site_limit_profiles AS p
) AS rewritten
WHERE profile.workspace_id = rewritten.workspace_id
  AND (profile.kind IN ('free', 'custom') OR profile.overrides IS NOT NULL)
  AND (
    profile.kind = 'free'
    OR profile.overrides IS DISTINCT FROM CASE WHEN profile.kind = 'custom' THEN rewritten.overrides END
    OR (profile.kind = 'custom' AND rewritten.overrides IS NULL)
  );
ALTER TABLE site_limit_profiles FORCE ROW LEVEL SECURITY;

ALTER TABLE site_publications
  DROP CONSTRAINT IF EXISTS site_publications_limit_profile_kind_check;
ALTER TABLE site_publications
  ADD CONSTRAINT site_publications_limit_profile_kind_check CHECK (
    limit_profile_kind IS NULL
    OR limit_profile_kind IN ('standard', 'free', 'credits', 'unlimited', 'custom')
  ) NOT VALID;
ALTER TABLE site_publications NO FORCE ROW LEVEL SECURITY;
UPDATE site_publications AS publication
SET limit_profile_kind = CASE
    WHEN publication.limit_profile_kind = 'free' THEN 'standard'
    WHEN publication.limit_profile_kind = 'custom' AND rewritten.overrides IS NULL THEN 'standard'
    ELSE publication.limit_profile_kind
  END,
  limit_overrides = CASE
    WHEN publication.limit_profile_kind = 'custom' THEN rewritten.overrides
  END
FROM (
  SELECT p.site_id, (
    SELECT jsonb_object_agg(field.key, field.value)
    FROM jsonb_each(p.limit_overrides) AS field
    WHERE field.value IS DISTINCT FROM (
      '{"requestsPerMinutePerVisitor":120,"guestWritesPerMinute":30,"agentsEnabled":true,"guestAgentsEnabled":true,"conversationsPerVisitorPerDay":10,"conversationsPerSitePerDay":50,"turnsPerConversation":20,"agentMicrosPerConversation":20000,"agentMicrosPerVisitorPerDay":200000,"agentMicrosPerSitePerMonth":2000000,"agentModels":null}'::jsonb
      -> field.key
    )
  ) AS overrides
  FROM site_publications AS p
  WHERE p.limit_profile_kind IN ('free', 'custom') OR p.limit_overrides IS NOT NULL
) AS rewritten
WHERE publication.site_id = rewritten.site_id
  AND (
    publication.limit_profile_kind = 'free'
    OR publication.limit_overrides IS DISTINCT FROM CASE
      WHEN publication.limit_profile_kind = 'custom' THEN rewritten.overrides
    END
    OR (publication.limit_profile_kind = 'custom' AND rewritten.overrides IS NULL)
  );
ALTER TABLE site_publications FORCE ROW LEVEL SECURITY;
