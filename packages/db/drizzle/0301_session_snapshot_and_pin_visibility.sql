-- deployment-mode: rolling
-- Visibility-isolate the two session references that migration 0225's
-- foreign-key loop could not reach correctly.
--
-- 1. `session_list_snapshots.ordinary_session_ids` is a bare `uuid[]` with no
--    foreign key to `sessions`, so 0225's loop (which enumerates relations that
--    carry an FK to `sessions.id`) never installed `session_visibility_isolation`
--    on it. A cached list page captured while a session was `workspace_shared`
--    therefore keeps holding that session id for the snapshot's whole TTL after
--    the session transitions to `user_private` — the exact "cache stripping"
--    prerequisite `docs/organization-tenancy.md` phase F names.
--
--    An explicit visibility predicate over the array was rejected: a snapshot
--    holds up to 5,000 ids and a subject may hold up to 32 live snapshots, so a
--    RESTRICTIVE policy would have to evaluate up to 160,000 per-element
--    `session_reference_visible()` calls on the hot first-page read, it would
--    turn a partially stale cache into a hard 410 for the whole row, and (like
--    the pin defect below) it would make the row permanently undeletable. The
--    identity is instead stripped once, at the transition, where the cost is
--    bounded by the snapshots that actually name the session.
--
--    The stripped slot is REPLACED by the reserved all-zero UUID rather than
--    removed, so snapshot cardinality and every in-flight cursor offset stay
--    byte-stable. `gen_random_uuid()` never produces the nil UUID, so the slot
--    matches no session and the read path drops it exactly as it already drops
--    a session that RLS hid between pages. `array_remove` would shift every
--    later offset and silently skip one still-visible session.
--
-- 2. `session_pins` IS covered by 0225's loop, with a `FOR ALL` RESTRICTIVE
--    policy. That makes a non-owner's stale pin both invisible and permanently
--    undeletable by the member who created it: PostgreSQL applies SELECT
--    policies to a DELETE that reads any column, so a command-scoped
--    `FOR DELETE` exemption cannot work. The USING side therefore gains an
--    explicit owner escape. It discloses nothing new: the pre-existing
--    permissive `workspace_isolation` policy already limits every visible pin to
--    `subject_id = current_subject_id()`, and a pin row's only session-derived
--    field is an id that same subject supplied. The WITH CHECK side keeps the
--    strict predicate, so a member still cannot pin — or flip `pinned` on — a
--    session they cannot see, and INSERT cannot be used as a session-existence
--    oracle through the foreign key.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $session_visibility_cache_stripping$
DECLARE
  data_schema text := current_schema();
  capability_predicate text;
BEGIN
  -- The lifecycle needs to strip OTHER subjects' cached pages, which the
  -- subject-scoped `workspace_isolation` policy forbids. Reuse 0225's
  -- transaction-local capability instead of a forgeable GUC marker: the
  -- capability row lives in `session_visibility_write_capabilities`, which is
  -- FORCE RLS, owner-only, and fully revoked from the runtime role, so the
  -- runtime role cannot mint one. `pg_current_xact_id_if_assigned()` keeps this
  -- predicate from assigning a transaction id on read-only traffic.
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.session_visibility_lifecycle_capability_held()
    RETURNS boolean
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = %1$I, pg_catalog
    AS $body$
      SELECT EXISTS (
        SELECT 1
        FROM session_visibility_write_capabilities capability
        WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
          AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability.capability_id = nullif(
            pg_catalog.current_setting(
              'opengeni.session_visibility_write_capability', true
            ),
            ''
          )::uuid
      )
    $body$;
  $ddl$, data_schema);
  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.session_visibility_lifecycle_capability_held() FROM PUBLIC',
    data_schema
  );
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.session_visibility_lifecycle_capability_held() TO opengeni_app',
      data_schema
    );
  END IF;

  -- The cheap GUC test short-circuits ordinary traffic before the capability
  -- lookup; the GUC alone is never authority.
  capability_predicate := format(
    'nullif(pg_catalog.current_setting('
      || '''opengeni.session_visibility_write_capability'', true), '''') IS NOT NULL '
      || 'AND %I.session_visibility_lifecycle_capability_held()',
    data_schema
  );
  EXECUTE format(
    'DROP POLICY IF EXISTS session_visibility_cache_stripping ON %I.session_list_snapshots',
    data_schema
  );
  EXECUTE format(
    'CREATE POLICY session_visibility_cache_stripping ON %I.session_list_snapshots '
      || 'FOR ALL USING (%s) WITH CHECK (%s)',
    data_schema,
    capability_predicate,
    capability_predicate
  );

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.strip_private_session_list_snapshots()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = %1$I, pg_catalog
    AS $body$
    BEGIN
      -- Every authorized visibility transition already holds the 0225 write
      -- capability (its own `sessions` UPDATE is impossible without it), so the
      -- strip rides on the exact same authority in the exact same transaction.
      -- The owner's own cached pages stay intact: the session remains visible to
      -- them, so their snapshot is not stale.
      UPDATE session_list_snapshots snapshot
      SET ordinary_session_ids = coalesce((
        SELECT pg_catalog.array_agg(
          CASE WHEN entry.element = NEW.id
            THEN '00000000-0000-0000-0000-000000000000'::uuid
            ELSE entry.element
          END
          ORDER BY entry.ordinality
        )
        FROM pg_catalog.unnest(snapshot.ordinary_session_ids)
          WITH ORDINALITY AS entry(element, ordinality)
      ), '{}'::uuid[])
      WHERE snapshot.account_id = NEW.account_id
        AND snapshot.workspace_id = NEW.workspace_id
        AND snapshot.subject_id IS DISTINCT FROM NEW.owner_subject_id
        AND NEW.id = ANY(snapshot.ordinary_session_ids);
      RETURN NULL;
    END;
    $body$;
  $ddl$, data_schema);
  EXECUTE format(
    'DROP TRIGGER IF EXISTS sessions_strip_private_list_snapshots ON %I.sessions',
    data_schema
  );
  EXECUTE format(
    'CREATE TRIGGER sessions_strip_private_list_snapshots '
      || 'AFTER UPDATE OF visibility ON %1$I.sessions '
      || 'FOR EACH ROW '
      || 'WHEN (NEW.visibility = ''user_private'' '
      || 'AND OLD.visibility IS DISTINCT FROM NEW.visibility) '
      || 'EXECUTE FUNCTION %1$I.strip_private_session_list_snapshots()',
    data_schema
  );

  EXECUTE format(
    'DROP POLICY IF EXISTS session_visibility_isolation ON %I.session_pins',
    data_schema
  );
  EXECUTE format(
    'CREATE POLICY session_visibility_isolation ON %1$I.session_pins AS RESTRICTIVE '
      || 'FOR ALL USING ('
      || '%1$I.session_reference_visible(account_id, workspace_id, session_id) '
      || 'OR subject_id = opengeni_private.current_subject_id()'
      || ') WITH CHECK ('
      || '%1$I.session_reference_visible(account_id, workspace_id, session_id)'
      || ')',
    data_schema
  );
END
$session_visibility_cache_stripping$;

COMMENT ON COLUMN "session_list_snapshots"."ordinary_session_ids" IS
  'Ordered slots of one short-lived cached list page. A slot holding the reserved all-zero UUID is a redacted session identity stripped by a visibility transition; it preserves cursor offsets and resolves to no session.';

COMMENT ON FUNCTION strip_private_session_list_snapshots() IS
  'Strips a session identity from every other subject''s cached list page when that session becomes user_private, under the 0225 visibility write capability.';

COMMENT ON FUNCTION session_visibility_lifecycle_capability_held() IS
  'True only inside a transaction holding an owner-minted session-visibility write capability; the runtime role cannot mint one.';
