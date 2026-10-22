-- deployment-mode: rolling
-- 0057 duplicated the existing (workspace_id, id) unique indexes. Keep the
-- original indexes, which own the foreign-key dependencies and remain the
-- schema.ts definitions. This removes only redundant index maintenance.
-- A busy table aborts this migration promptly instead of queueing API writes.
SET LOCAL lock_timeout = '1s';
-- Hold the same relation locks required by DROP before inspecting names/OIDs.
-- Concurrent DDL cannot rename/replace an index or change replica identity
-- between the equivalence check and removal. No advisory fence follows these.
LOCK TABLE sessions, session_turns IN ACCESS EXCLUSIVE MODE;

DO $migration$
DECLARE
  pair record;
  redundant record;
  retained record;
BEGIN
  FOR pair IN SELECT * FROM (VALUES
    ('sessions_workspace_id_uq', 'sessions_workspace_id_idx', 'sessions'),
    ('session_turns_workspace_id_uq', 'session_turns_workspace_id_idx', 'session_turns')
  ) AS pairs(drop_name, keep_name, table_name)
  LOOP
    SELECT i.*, c.relam, c.reloptions, c.reltablespace INTO redundant
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE i.indexrelid = to_regclass(format('%I.%I', current_schema(), pair.drop_name));
    IF NOT FOUND THEN CONTINUE; END IF;

    SELECT i.*, c.relam, c.reloptions, c.reltablespace INTO retained
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE i.indexrelid = to_regclass(format('%I.%I', current_schema(), pair.keep_name));
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Cannot remove % without retained index %', pair.drop_name, pair.keep_name;
    END IF;

    IF redundant.indrelid <> to_regclass(format('%I.%I', current_schema(), pair.table_name))
      OR NOT redundant.indisunique OR NOT retained.indisunique
      OR NOT redundant.indisvalid OR NOT retained.indisvalid
      OR NOT redundant.indisready OR NOT retained.indisready
      OR NOT redundant.indislive OR NOT retained.indislive
      OR redundant.indisprimary OR redundant.indisexclusion
      OR redundant.indisreplident OR redundant.indisclustered
      OR ROW(redundant.indrelid, redundant.relam, redundant.indnatts, redundant.indnkeyatts,
        redundant.indkey, redundant.indclass, redundant.indcollation, redundant.indoption,
        redundant.indnullsnotdistinct, redundant.indimmediate,
        redundant.indexprs::text, redundant.indpred::text,
        redundant.reloptions, redundant.reltablespace)
        IS DISTINCT FROM
        ROW(retained.indrelid, retained.relam, retained.indnatts, retained.indnkeyatts,
        retained.indkey, retained.indclass, retained.indcollation, retained.indoption,
        retained.indnullsnotdistinct, retained.indimmediate,
        retained.indexprs::text, retained.indpred::text,
        retained.reloptions, retained.reltablespace)
    THEN
      RAISE EXCEPTION 'Refusing to remove non-equivalent index %', pair.drop_name;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_depend
      WHERE refclassid = 'pg_class'::regclass AND refobjid = redundant.indexrelid)
      OR EXISTS (SELECT 1 FROM pg_constraint WHERE conindid = redundant.indexrelid)
    THEN
      RAISE EXCEPTION 'Refusing to remove index % with dependencies', pair.drop_name;
    END IF;
    -- No CASCADE: PostgreSQL also refuses a dependency created concurrently.
    EXECUTE format('DROP INDEX %I.%I', current_schema(), pair.drop_name);
  END LOOP;
END
$migration$;
