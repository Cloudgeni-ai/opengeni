-- deployment-mode: rolling
-- Statistics were populated in 0475's separate transaction, so this policy
-- DDL transaction does not retain its table lock across the ANALYZE scan.
-- Keep the migration-owner capability exactly as introduced by 0353. In
-- particular, ownership is resolved dynamically, not captured as a policy role.
-- Express the owner-only branch as one conditional: treating its owner and
-- capability terms as independent selectivity estimates can badly undercount
-- ordinary scoped reads and favor scanning/sorting an entire session history.
SET LOCAL lock_timeout = '5s';

ALTER POLICY session_events_automatic_title_quarantine_v1 ON session_events
USING (
  CASE WHEN current_user = (
    SELECT pg_catalog.pg_get_userbyid(relation.relowner)
    FROM pg_catalog.pg_class relation
    WHERE relation.oid = 'session_events'::regclass
  ) THEN pg_catalog.current_setting(
    'opengeni.automatic_session_title_quarantine_v1', true
  ) = '1' ELSE false END
)
WITH CHECK (
  CASE WHEN current_user = (
    SELECT pg_catalog.pg_get_userbyid(relation.relowner)
    FROM pg_catalog.pg_class relation
    WHERE relation.oid = 'session_events'::regclass
  ) THEN pg_catalog.current_setting(
    'opengeni.automatic_session_title_quarantine_v1', true
  ) = '1' ELSE false END
);