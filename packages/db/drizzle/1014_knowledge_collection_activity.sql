-- deployment-mode: rolling
-- Newest-first Knowledge lists order a collection by the newest change inside it
-- (0999). Each read walked every member below every listed collection and ran
-- the visibility check for all of them, so Collections and unfiltered lists
-- slowed down with library size. Keep that newest change per collection, and
-- the direct member it came through, up to date as entries change. A published
-- read uses it after following the recorded members down to the change and
-- checking, for this reader, that every step is still a readable member in the
-- chosen scope; then the kept time is exactly what the walk would return. Any
-- collection that fails the check, reviewer queues (proposed membership) and
-- organizations not yet built still use the walk, so order, visibility, RLS and
-- cursors are unchanged. Existing binaries are unaffected.
--
-- The kept time is the newest change among non-archived members at their
-- published revision, reached through published membership of collections, as
-- the walk defines it before per-reader filters. It is maintained under the
-- existing per-organization publication lock, which every Knowledge write
-- already takes, so concurrent writes cannot leave it older than the data. An
-- organization is built by its first Knowledge write; until then reads walk.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE knowledge_collection_activity (
  account_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  changed_at timestamptz NOT NULL,
  via_entry_id uuid NOT NULL,
  PRIMARY KEY (account_id, entry_id),
  FOREIGN KEY (account_id, entry_id) REFERENCES knowledge_entries(account_id, id) ON DELETE CASCADE
);
-- Led by the member, so it is never a cheaper-looking scan of a whole
-- organization than the key when statistics underestimate an organization.
CREATE INDEX knowledge_collection_activity_via_idx ON knowledge_collection_activity (via_entry_id, account_id);
-- Organizations whose activity is complete ('built'), and those a write under
-- an older snapshot may have left behind ('stale'). A marker is inserted, never
-- updated or deleted, by such a write, so it holds whatever that snapshot saw.
-- Reads walk unless an organization is built and not stale; the next ordinary
-- write rebuilds it.
CREATE TABLE knowledge_collection_activity_accounts (
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('built','stale')),
  marked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, state)
);

DO $tables$
DECLARE t text; runtime_role text;
BEGIN
  FOREACH t IN ARRAY ARRAY['knowledge_collection_activity','knowledge_collection_activity_accounts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY knowledge_tenant ON %I USING (account_id = nullif(current_setting(''opengeni.account_id'',true),'''')::uuid)',t);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',t);
    FOR runtime_role IN SELECT jsonb_array_elements_text(coalesce(nullif(current_setting('opengeni.migration_application_roles',true),''),'[]')::jsonb) LOOP
      IF runtime_role <> current_user AND EXISTS(SELECT 1 FROM pg_roles WHERE rolname=runtime_role) THEN
        EXECUTE format('REVOKE ALL ON %I FROM %I',t,runtime_role);
      END IF;
    END LOOP;
  END LOOP;
END $tables$;

-- Rebuild one organization from its current data: each collection's newest
-- direct member, then raised to anything newer below its sub-collections until
-- nothing changes (membership cycles converge). Marks the organization built.
-- It reads the whole organization, so it joins whole sets: a row estimate that
-- is off (an organization new to the table statistics) must not turn its joins
-- into repeated scans of the organization.
CREATE FUNCTION knowledge_collection_activity_rebuild(p_account uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT SET enable_nestloop = off AS $$
DECLARE raised integer; rounds integer:=0;
BEGIN
  DELETE FROM knowledge_collection_activity_accounts WHERE account_id=p_account;
  DELETE FROM knowledge_collection_activity WHERE account_id=p_account;
  INSERT INTO knowledge_collection_activity(account_id,entry_id,changed_at,via_entry_id)
  SELECT DISTINCT ON (l.target_entry_id) p_account,l.target_entry_id,coalesce(d.created_at,r.created_at),e.id
  FROM knowledge_entries e
  JOIN knowledge_entry_links l ON l.revision_id=e.published_revision_id AND l.account_id=e.account_id
    AND l.entry_id=e.id AND l.relation='group'
  JOIN knowledge_entries g ON g.account_id=l.account_id AND g.id=l.target_entry_id
  JOIN knowledge_entry_revisions r ON r.account_id=e.account_id AND r.entry_id=e.id AND r.id=e.published_revision_id
  LEFT JOIN LATERAL (SELECT v.created_at FROM knowledge_entry_decisions v WHERE v.account_id=e.account_id
    AND v.entry_id=e.id AND v.revision_id=r.id ORDER BY v.version DESC LIMIT 1) d ON true
  WHERE e.account_id=p_account AND NOT e.archived
  ORDER BY l.target_entry_id,coalesce(d.created_at,r.created_at) DESC,e.id;
  LOOP
    rounds:=rounds+1;
    -- Bounded: an unconverged organization stays unbuilt and its reads walk.
    IF rounds>1000 THEN RETURN; END IF;
    WITH offered AS (
      SELECT DISTINCT ON (l.target_entry_id) l.target_entry_id AS group_id,s.changed_at,e.id AS via
      FROM knowledge_entries e
      JOIN knowledge_entry_links l ON l.revision_id=e.published_revision_id AND l.account_id=e.account_id
        AND l.entry_id=e.id AND l.relation='group'
      JOIN knowledge_entry_revisions r ON r.account_id=e.account_id AND r.entry_id=e.id
        AND r.id=e.published_revision_id AND r.body->>'kind'='group'
      JOIN knowledge_collection_activity s ON s.account_id=e.account_id AND s.entry_id=e.id
      WHERE e.account_id=p_account AND NOT e.archived
      ORDER BY l.target_entry_id,s.changed_at DESC,e.id
    ) UPDATE knowledge_collection_activity t SET changed_at=o.changed_at,via_entry_id=o.via FROM offered o
      WHERE t.account_id=p_account AND t.entry_id=o.group_id AND o.changed_at>t.changed_at;
    GET DIAGNOSTICS raised=ROW_COUNT;
    EXIT WHEN raised=0;
  END LOOP;
  INSERT INTO knowledge_collection_activity_accounts(account_id,state) VALUES(p_account,'built') ON CONFLICT DO NOTHING;
END $$;

-- Bring the kept activity up to date after p_changed entries changed (their
-- publication, archive state, decisions or membership), and fully recompute
-- p_recompute collections. A collection takes a changed member's new offer when
-- it is newer. When the member it recorded changed and now offers less, that
-- collection and every collection whose kept time came through it are forgotten
-- and recomputed from their direct members, nearest first, then raised within
-- that set until it is stable, so a membership cycle cannot keep a time that
-- no longer exists. Changes then move to parent collections.
CREATE FUNCTION knowledge_collection_activity_refresh(p_account uuid, p_changed uuid[], p_recompute uuid[], p_build boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE changed_ids uuid[]:=p_changed; recompute_ids uuid[]:=coalesce(p_recompute,'{}'); steps integer:=0;
  reset_ids uuid[]; reset_previous timestamptz[]; level_ends integer[]; level_end integer; level_start integer;
  raised uuid[];
  tenant text:=current_setting('opengeni.account_id',true);
BEGIN
  IF p_account IS NULL OR coalesce(cardinality(changed_ids),0)+cardinality(recompute_ids)=0 THEN RETURN; END IF;
  -- The publication lock every Knowledge write takes first (re-entrant): one
  -- maintainer per organization, each seeing every earlier committed change.
  PERFORM pg_advisory_xact_lock(hashtextextended('knowledge-publication:'||p_account,0));
  -- The writer owns this organization's rows; the tenant fence must see them all.
  PERFORM set_config('opengeni.account_id',p_account::text,true);
  IF current_setting('transaction_isolation')<>'read committed' THEN
    -- An older snapshot can miss a concurrent change: walk until a rebuild.
    INSERT INTO knowledge_collection_activity_accounts(account_id,state) VALUES(p_account,'stale')
      ON CONFLICT DO NOTHING;
  ELSIF NOT EXISTS(SELECT 1 FROM knowledge_collection_activity_accounts WHERE account_id=p_account AND state='built')
    OR EXISTS(SELECT 1 FROM knowledge_collection_activity_accounts WHERE account_id=p_account AND state='stale') THEN
    IF p_build AND EXISTS(SELECT 1 FROM managed_accounts WHERE id=p_account) THEN
      PERFORM knowledge_collection_activity_rebuild(p_account);
    END IF;
  ELSE
    changed_ids:=coalesce(changed_ids,'{}');
    <<maintain>> WHILE cardinality(changed_ids)+cardinality(recompute_ids)>0 LOOP
      steps:=steps+cardinality(changed_ids)+cardinality(recompute_ids);
      IF steps>100000 THEN
        DELETE FROM knowledge_collection_activity_accounts WHERE account_id=p_account AND state='built';
        EXIT;
      END IF;
      -- Each set is driven from the changed entries and reaches every table by
      -- key, one table per step: no row estimate (an organization new to the
      -- table statistics) can turn a step into a scan of the organization, and
      -- a bulk change stays linear.
      WITH changed AS MATERIALIZED (
        SELECT DISTINCT c.id FROM unnest(changed_ids) AS c(id)
      ), recompute AS MATERIALIZED (
        SELECT DISTINCT c.id FROM unnest(recompute_ids) AS c(id)
      ), offered AS MATERIALIZED (
        -- What each changed member now offers every collection it belongs to.
        SELECT l.target_entry_id AS group_id,e.id AS member_id,
          greatest(r.changed_at,CASE WHEN r.kind='group' THEN (SELECT s.changed_at FROM knowledge_collection_activity s
            WHERE s.account_id=p_account AND s.entry_id=e.id) END) AS changed_at
        FROM changed c
        CROSS JOIN LATERAL (SELECT e.id,e.published_revision_id AS revision_id FROM knowledge_entries e
          WHERE e.account_id=p_account AND e.id=c.id AND NOT e.archived OFFSET 0) e
        CROSS JOIN LATERAL (SELECT r.body->>'kind' AS kind,coalesce((SELECT v.created_at FROM knowledge_entry_decisions v
            WHERE v.account_id=p_account AND v.entry_id=e.id AND v.revision_id=r.id ORDER BY v.version DESC LIMIT 1),
            r.created_at) AS changed_at
          FROM knowledge_entry_revisions r WHERE r.account_id=p_account AND r.entry_id=e.id AND r.id=e.revision_id OFFSET 0) r
        -- By revision: links are reached through their revision's key only.
        CROSS JOIN LATERAL (SELECT l.target_entry_id FROM knowledge_entry_links l
          WHERE l.revision_id=e.revision_id AND l.entry_id=e.id AND l.relation='group' OFFSET 0) l
      ), affected AS MATERIALIZED (
        -- Collections a change can move, with their kept time. Keep it when its
        -- member did not change; reset it when it was recomputed, or when its
        -- member changed and no longer offers as much.
        SELECT a.group_id,s.changed_at,s.via_entry_id,
          rc.id IS NULL AND vc.id IS NULL AS keep,
          rc.id IS NOT NULL OR (vc.id IS NOT NULL AND coalesce(ov.changed_at<s.changed_at,true)) AS reset
        FROM (
          SELECT o.group_id FROM offered o
          UNION SELECT s.entry_id FROM changed c
            -- By member only, the organization checked above the fence, so the
            -- organization-led key never looks cheaper than the member index.
            CROSS JOIN LATERAL (SELECT s.entry_id,s.account_id FROM knowledge_collection_activity s
              WHERE s.via_entry_id=c.id OFFSET 0) s
            WHERE s.account_id=p_account
          UNION SELECT r.id FROM recompute r) a
        CROSS JOIN LATERAL (SELECT g.id FROM knowledge_entries g WHERE g.account_id=p_account AND g.id=a.group_id OFFSET 0) g
        LEFT JOIN LATERAL (SELECT s.changed_at,s.via_entry_id FROM knowledge_collection_activity s
          WHERE s.account_id=p_account AND s.entry_id=a.group_id OFFSET 0) s ON true
        LEFT JOIN recompute rc ON rc.id=a.group_id
        LEFT JOIN changed vc ON vc.id=s.via_entry_id
        LEFT JOIN (SELECT o.group_id,o.member_id,max(o.changed_at) AS changed_at FROM offered o GROUP BY 1,2) ov
          ON ov.group_id=a.group_id AND ov.member_id=s.via_entry_id
      ), candidates AS (
        -- The others only gain: their kept time, or a changed member's offer.
        SELECT a.group_id,a.changed_at,a.via_entry_id AS via,0 AS preference FROM affected a
        WHERE a.keep AND a.changed_at IS NOT NULL
        UNION ALL SELECT o.group_id,o.changed_at,o.member_id,CASE WHEN o.member_id=a.via_entry_id THEN 0 ELSE 1 END
        FROM affected a JOIN offered o ON o.group_id=a.group_id WHERE NOT a.reset
      ), computed AS MATERIALIZED (
        -- The newest offer wins; on a tie the recorded member stays.
        SELECT a.group_id,a.changed_at AS previous,best.changed_at,best.via FROM affected a
        JOIN (SELECT DISTINCT ON (c.group_id) c.group_id,c.changed_at,c.via FROM candidates c
          ORDER BY c.group_id,c.changed_at DESC,c.preference,c.via) best ON best.group_id=a.group_id
        WHERE NOT a.reset
      ), written AS (
        INSERT INTO knowledge_collection_activity(account_id,entry_id,changed_at,via_entry_id)
        SELECT p_account,c.group_id,c.changed_at,c.via FROM computed c
        ON CONFLICT (account_id,entry_id) DO UPDATE SET changed_at=excluded.changed_at,via_entry_id=excluded.via_entry_id
        WHERE (knowledge_collection_activity.changed_at,knowledge_collection_activity.via_entry_id)
          IS DISTINCT FROM (excluded.changed_at,excluded.via_entry_id)
      ) SELECT coalesce((SELECT array_agg(c.group_id) FROM computed c WHERE c.changed_at IS DISTINCT FROM c.previous),'{}'),
          coalesce((SELECT array_agg(a.group_id) FROM affected a WHERE a.reset),'{}')
        INTO changed_ids,reset_ids;
      recompute_ids:='{}';
      CONTINUE WHEN cardinality(reset_ids)=0;
      -- Forget each reset collection and every collection whose kept time came
      -- through it, with its distance from the reset collection it depends on.
      -- Recorded members form a tree; the path only guards against a loop.
      WITH RECURSIVE reset AS MATERIALIZED (
        SELECT DISTINCT c.id FROM unnest(reset_ids) AS c(id)
      ), dependent(id,depth,path) AS (
        SELECT r.id,0,ARRAY[r.id] FROM reset r
        UNION ALL SELECT s.entry_id,d.depth+1,d.path||s.entry_id FROM dependent d
          CROSS JOIN LATERAL (SELECT s.entry_id,s.account_id FROM knowledge_collection_activity s
            WHERE s.via_entry_id=d.id OFFSET 0) s
        WHERE s.account_id=p_account AND NOT EXISTS(SELECT 1 FROM reset r WHERE r.id=s.entry_id)
          AND s.entry_id<>ALL(d.path)
      ), ordered AS MATERIALIZED (
        SELECT d.id,d.depth,(SELECT s.changed_at FROM knowledge_collection_activity s
          WHERE s.account_id=p_account AND s.entry_id=d.id) AS changed_at
        FROM (SELECT DISTINCT ON (d.id) d.id,d.depth FROM dependent d ORDER BY d.id,d.depth) d
      ) SELECT (SELECT array_agg(o.id ORDER BY o.depth,o.id) FROM ordered o),
          (SELECT array_agg(o.changed_at ORDER BY o.depth,o.id) FROM ordered o),
          (SELECT array_agg(x.last ORDER BY x.depth) FROM (SELECT o.depth,(sum(count(*)) OVER (ORDER BY o.depth))::integer AS last
            FROM ordered o GROUP BY o.depth) x)
        INTO reset_ids,reset_previous,level_ends;
      steps:=steps+cardinality(reset_ids);
      DELETE FROM knowledge_collection_activity t WHERE t.account_id=p_account AND t.entry_id=ANY(reset_ids);
      -- Recompute them from their direct members, nearest first, so along a
      -- chain each one already sees the member below it.
      level_start:=1;
      FOREACH level_end IN ARRAY level_ends LOOP
        INSERT INTO knowledge_collection_activity(account_id,entry_id,changed_at,via_entry_id)
        SELECT DISTINCT ON (m.group_id) p_account,m.group_id,m.changed_at,m.via FROM (
          SELECT c.id AS group_id,e.id AS via,
            greatest(r.changed_at,CASE WHEN r.kind='group' THEN (SELECT s.changed_at FROM knowledge_collection_activity s
              WHERE s.account_id=p_account AND s.entry_id=e.id) END) AS changed_at
          FROM unnest(reset_ids[level_start:level_end]) AS c(id)
          CROSS JOIN LATERAL (SELECT g.id FROM knowledge_entries g WHERE g.account_id=p_account AND g.id=c.id OFFSET 0) g
          CROSS JOIN LATERAL (SELECT l.entry_id,l.revision_id FROM knowledge_entry_links l
            WHERE l.account_id=p_account AND l.target_entry_id=c.id AND l.relation='group' OFFSET 0) l
          CROSS JOIN LATERAL (SELECT e.id FROM knowledge_entries e WHERE e.account_id=p_account AND e.id=l.entry_id
            AND e.published_revision_id=l.revision_id AND NOT e.archived OFFSET 0) e
          CROSS JOIN LATERAL (SELECT r.body->>'kind' AS kind,coalesce((SELECT v.created_at FROM knowledge_entry_decisions v
              WHERE v.account_id=p_account AND v.entry_id=e.id AND v.revision_id=r.id ORDER BY v.version DESC LIMIT 1),
              r.created_at) AS changed_at
            FROM knowledge_entry_revisions r WHERE r.account_id=p_account AND r.entry_id=e.id AND r.id=l.revision_id OFFSET 0) r
        ) m ORDER BY m.group_id,m.changed_at DESC,m.via;
        level_start:=level_end+1;
      END LOOP;
      -- Raise within the set until stable (cycles converge), each round taking
      -- offers only from the collections the previous round raised.
      raised:=reset_ids;
      LOOP
        WITH offered AS MATERIALIZED (
          SELECT DISTINCT ON (l.target_entry_id) l.target_entry_id AS group_id,s.changed_at,e.id AS via
          FROM unnest(raised) AS m(id)
          CROSS JOIN LATERAL (SELECT e.id,e.published_revision_id AS revision_id FROM knowledge_entries e
            WHERE e.account_id=p_account AND e.id=m.id AND NOT e.archived OFFSET 0) e
          CROSS JOIN LATERAL (SELECT r.id FROM knowledge_entry_revisions r WHERE r.account_id=p_account AND r.entry_id=e.id
            AND r.id=e.revision_id AND r.body->>'kind'='group' OFFSET 0) r
          CROSS JOIN LATERAL (SELECT s.changed_at FROM knowledge_collection_activity s
            WHERE s.account_id=p_account AND s.entry_id=e.id OFFSET 0) s
          CROSS JOIN LATERAL (SELECT l.target_entry_id FROM knowledge_entry_links l
            WHERE l.revision_id=e.revision_id AND l.entry_id=e.id AND l.relation='group' OFFSET 0) l
          ORDER BY l.target_entry_id,s.changed_at DESC,e.id
        ), updated AS (
          -- Every collection in the set that a member offers to has a row.
          INSERT INTO knowledge_collection_activity AS t(account_id,entry_id,changed_at,via_entry_id)
          SELECT p_account,o.group_id,o.changed_at,o.via FROM offered o
          WHERE EXISTS(SELECT 1 FROM unnest(reset_ids) AS c(id) WHERE c.id=o.group_id)
          ON CONFLICT (account_id,entry_id) DO UPDATE SET changed_at=excluded.changed_at,via_entry_id=excluded.via_entry_id
          WHERE excluded.changed_at>t.changed_at
          RETURNING t.entry_id
        ) SELECT coalesce(array_agg(u.entry_id),'{}') INTO raised FROM updated u;
        EXIT WHEN cardinality(raised)=0;
        steps:=steps+cardinality(raised);
        IF steps>100000 THEN
          DELETE FROM knowledge_collection_activity_accounts WHERE account_id=p_account AND state='built';
          EXIT maintain;
        END IF;
      END LOOP;
      -- Reset collections whose time moved change their parents in turn.
      SELECT changed_ids||coalesce(array_agg(c.id),'{}') INTO changed_ids
      FROM unnest(reset_ids,reset_previous) AS c(id,previous)
      WHERE (SELECT s.changed_at FROM knowledge_collection_activity s WHERE s.account_id=p_account AND s.entry_id=c.id)
        IS DISTINCT FROM c.previous;
    END LOOP;
  END IF;
  PERFORM set_config('opengeni.account_id',coalesce(tenant,''),true);
END $$;

-- Statement triggers, so a bulk change refreshes once per organization. They
-- run as the writer (Knowledge tables are written only through their owner's
-- routines and migrations) and reach the tables only through the refresh.
CREATE FUNCTION knowledge_collection_activity_entries_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT AS $$
DECLARE account uuid; changed uuid[];
BEGIN
  IF TG_OP='INSERT' THEN
    -- A new entry may already be named by links whose target check is deferred.
    FOR account,changed IN SELECT n.account_id,array_agg(n.id) FROM new_rows n GROUP BY n.account_id LOOP
      PERFORM knowledge_collection_activity_refresh(account,changed,changed,true);
    END LOOP;
  ELSIF TG_OP='UPDATE' THEN
    FOR account,changed IN SELECT n.account_id,array_agg(n.id) FROM new_rows n JOIN old_rows o ON o.id=n.id
      WHERE n.published_revision_id IS DISTINCT FROM o.published_revision_id OR n.archived IS DISTINCT FROM o.archived
      GROUP BY n.account_id LOOP
      PERFORM knowledge_collection_activity_refresh(account,changed,NULL,true);
    END LOOP;
  ELSE
    -- Deletion never builds: it is also how an organization is removed.
    FOR account,changed IN SELECT o.account_id,array_agg(o.id) FROM old_rows o GROUP BY o.account_id LOOP
      PERFORM knowledge_collection_activity_refresh(account,changed,NULL,false);
    END LOOP;
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION knowledge_collection_activity_members_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT AS $$
DECLARE account uuid; changed uuid[];
BEGIN
  -- New membership links or decisions: the named entries offer again.
  IF TG_TABLE_NAME='knowledge_entry_links' THEN
    FOR account,changed IN SELECT n.account_id,array_agg(DISTINCT n.entry_id) FROM new_rows n
      WHERE n.relation='group' GROUP BY n.account_id LOOP
      PERFORM knowledge_collection_activity_refresh(account,changed,NULL,true);
    END LOOP;
  ELSE
    FOR account,changed IN SELECT n.account_id,array_agg(DISTINCT n.entry_id) FROM new_rows n GROUP BY n.account_id LOOP
      PERFORM knowledge_collection_activity_refresh(account,changed,NULL,true);
    END LOOP;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER knowledge_collection_activity_insert AFTER INSERT ON knowledge_entries
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION knowledge_collection_activity_entries_changed();
CREATE TRIGGER knowledge_collection_activity_update AFTER UPDATE ON knowledge_entries
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION knowledge_collection_activity_entries_changed();
CREATE TRIGGER knowledge_collection_activity_delete AFTER DELETE ON knowledge_entries
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION knowledge_collection_activity_entries_changed();
CREATE TRIGGER knowledge_collection_activity_insert AFTER INSERT ON knowledge_entry_links
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION knowledge_collection_activity_members_changed();
CREATE TRIGGER knowledge_collection_activity_insert AFTER INSERT ON knowledge_entry_decisions
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION knowledge_collection_activity_members_changed();

DO $secure$
DECLARE
  owner_name text := pg_get_userbyid((SELECT proowner FROM pg_proc
    WHERE oid='knowledge_entry_read(uuid,uuid,jsonb,jsonb)'::regprocedure));
  routine text;
BEGIN
  FOREACH routine IN ARRAY ARRAY['knowledge_collection_activity_rebuild(uuid)',
    'knowledge_collection_activity_refresh(uuid,uuid[],uuid[],boolean)',
    'knowledge_collection_activity_entries_changed()','knowledge_collection_activity_members_changed()'] LOOP
    EXECUTE format('ALTER FUNCTION %I.%s OWNER TO %I',current_schema(),routine,owner_name);
    EXECUTE format('ALTER FUNCTION %I.%s SET search_path = %I, pg_catalog, pg_temp',current_schema(),routine,current_schema());
    EXECUTE format('REVOKE ALL ON FUNCTION %I.%s FROM PUBLIC',current_schema(),routine);
  END LOOP;
  EXECUTE format('ALTER TABLE %I.knowledge_collection_activity OWNER TO %I',current_schema(),owner_name);
  EXECUTE format('ALTER TABLE %I.knowledge_collection_activity_accounts OWNER TO %I',current_schema(),owner_name);
END
$secure$;

-- The read: kept activity first, the walk only for collections it cannot answer.
DO $migration$
DECLARE definition text; anchor text;
  procedure regprocedure := 'knowledge_entry_read(uuid,uuid,jsonb,jsonb)'::regprocedure;
BEGIN
  definition := pg_get_functiondef(procedure);

  -- 1. Follow each listed collection's recorded members down to the kept change.
  -- Every step must be a member the walk would use for this reader: published
  -- membership, not archived, in scope and, until the change, a collection. The
  -- member that made the change must pass the same batched visibility check.
  anchor := $old$  ), member_rows AS MATERIALIZED (
    WITH RECURSIVE walk(group_id,entry_id,revision_id,changed_at,is_group) AS ($old$;
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor) <> 1 THEN
    RAISE EXCEPTION 'Knowledge activity walk anchor changed';
  END IF;
  definition := replace(definition,anchor,$new$  ), activity_start AS MATERIALIZED (
    SELECT g.id AS group_id,s.changed_at,s.changed_at>coalesce(g.decided_at,g.revision_created_at) AS newer
    FROM candidates g
    -- Every lookup below is by key from the listed collection, one table per
    -- step, so no row estimate can turn a step into a scan of the organization.
    LEFT JOIN LATERAL (SELECT s.changed_at FROM knowledge_collection_activity s
      WHERE s.account_id=p_account AND s.entry_id=g.id OFFSET 0) s ON true
    -- Lists only: they have one row per entry (history has one per revision).
    WHERE p_request->>'order'='updated' AND coalesce(p_request->>'query','')='' AND NOT pending
      AND operation='list' AND g.body->>'kind'='group'
      AND EXISTS(SELECT 1 FROM knowledge_collection_activity_accounts b WHERE b.account_id=p_account AND b.state='built')
      AND NOT EXISTS(SELECT 1 FROM knowledge_collection_activity_accounts b WHERE b.account_id=p_account AND b.state='stale')
  ), activity_chain AS MATERIALIZED (
    WITH RECURSIVE chain(group_id,target,node,depth,witness_id,witness_revision) AS (
      SELECT a.group_id,a.changed_at,a.group_id,0,NULL::uuid,NULL::uuid FROM activity_start a WHERE a.newer
      UNION ALL
      SELECT c.group_id,c.target,e.id,c.depth+1,CASE WHEN r.changed_at=c.target THEN e.id END,
        CASE WHEN r.changed_at=c.target THEN r.id END
      FROM chain c
      CROSS JOIN LATERAL (SELECT s.via_entry_id FROM knowledge_collection_activity s
        WHERE s.account_id=p_account AND s.entry_id=c.node AND s.changed_at=c.target OFFSET 0) s
      CROSS JOIN LATERAL (SELECT e.id,e.published_revision_id AS revision_id FROM knowledge_entries e
        WHERE e.account_id=p_account AND e.id=s.via_entry_id AND NOT e.archived AND knowledge_scope_visible(e)
          AND (NOT(p_request ? 'scope') OR e.scope=p_request->>'scope') OFFSET 0) e
      CROSS JOIN LATERAL (SELECT r.id,r.body->>'kind' AS kind,coalesce((SELECT v.created_at FROM knowledge_entry_decisions v
          WHERE v.account_id=p_account AND v.entry_id=e.id AND v.revision_id=r.id ORDER BY v.version DESC LIMIT 1),
          r.created_at) AS changed_at
        FROM knowledge_entry_revisions r WHERE r.account_id=p_account AND r.entry_id=e.id AND r.id=e.revision_id OFFSET 0) r
      WHERE c.witness_id IS NULL AND c.depth<32
        AND (r.changed_at=c.target OR r.kind='group')
        -- Still a published member of the step above (a scalar lookup, never joined).
        AND (SELECT true FROM knowledge_entry_links l WHERE l.revision_id=r.id AND l.entry_id=e.id
          AND l.relation='group' AND l.target_entry_id=c.node LIMIT 1)
    ) SELECT DISTINCT group_id,target,witness_id,witness_revision FROM chain WHERE witness_id IS NOT NULL
  ), activity_allowed AS MATERIALIZED (
    SELECT v.* FROM (SELECT array_agg(w.witness_id) ids,array_agg(w.witness_revision) revisions FROM (
      SELECT DISTINCT w.witness_id,w.witness_revision FROM activity_chain w
      WHERE NOT EXISTS(SELECT 1 FROM allowed a WHERE a.entry_id=w.witness_id AND a.revision_id=w.witness_revision)) w) c
    CROSS JOIN LATERAL knowledge_revisions_visible(p_account,c.ids,c.revisions,
      pending OR (knowledge_entry_read.actor->>'kind'='human' AND knowledge_entry_read.actor->>'review'='true')) v
  ), activity_known AS MATERIALIZED (
    -- Nothing kept, or nothing newer than the collection itself: its own change.
    SELECT a.group_id,a.changed_at FROM activity_start a WHERE a.newer IS NOT TRUE
    UNION ALL SELECT DISTINCT w.group_id,w.target FROM activity_chain w
    WHERE EXISTS(SELECT 1 FROM allowed a WHERE a.entry_id=w.witness_id AND a.revision_id=w.witness_revision)
      OR EXISTS(SELECT 1 FROM activity_allowed a WHERE a.entry_id=w.witness_id AND a.revision_id=w.witness_revision)
  ), member_rows AS MATERIALIZED (
    WITH RECURSIVE walk(group_id,entry_id,revision_id,changed_at,is_group) AS ($new$);

  -- 2. The walk starts only from collections the kept activity did not answer.
  -- They are removed before any member is joined, and members are looked up by
  -- collection, so answered collections cost nothing whatever the row estimates.
  anchor := $old$      FROM candidates g
      JOIN knowledge_entry_links l ON l.account_id=p_account AND l.target_entry_id=g.id AND l.relation='group'$old$;
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor) <> 1 THEN
    RAISE EXCEPTION 'Knowledge activity start anchor changed';
  END IF;
  definition := replace(definition,anchor,$new$      FROM (SELECT g.* FROM candidates g
        WHERE NOT EXISTS(SELECT 1 FROM activity_known k WHERE k.group_id=g.id) OFFSET 0) g
      CROSS JOIN LATERAL (SELECT l.* FROM knowledge_entry_links l
        WHERE l.account_id=p_account AND l.target_entry_id=g.id AND l.relation='group' OFFSET 0) l$new$);

  -- 3. Activity is the kept time where it applied, the walk's elsewhere.
  anchor := $old$    GROUP BY m.group_id
  ), scored AS ($old$;
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor) <> 1 THEN
    RAISE EXCEPTION 'Knowledge activity result anchor changed';
  END IF;
  definition := replace(definition,anchor,$new$    GROUP BY m.group_id
    UNION ALL SELECT k.group_id,k.changed_at FROM activity_known k
  ), scored AS ($new$);

  EXECUTE definition;
END $migration$;

-- pg_get_functiondef preserves the read's owner, SECURITY DEFINER and hardened
-- search_path; CREATE OR REPLACE preserves its ACLs. No runtime grants: the
-- tables are reached only through these owner functions and the read.
