-- deployment-mode: rolling
-- A compute sandbox's running command is never polled.
--
-- Every message to a compute sandbox's agent wakes the sandbox, so the
-- connected-command reconciler's periodic provider probe would keep a sandbox
-- with a long-running command awake forever. Polling is also unnecessary
-- there: the agent pushes each completion and retries until it is
-- acknowledged, and the agent process outlives sleep, memory restores and
-- moves. A process that does not survive gets a new connection instance (the
-- claim then retires the command as op_connection_replaced) and a deleted
-- sandbox's enrollment is revoked (op_enrollment_revoked).
--
-- So a running command on a sandbox-kind enrollment is claimed only once it
-- has a pushed completion, a saved proof or a retirement reason. A stopping
-- command (Stop, Pause or Cancel) is claimed as before, since the claim is
-- what delivers the cancellation, and stopping lasts only until the agent
-- reports the exit. Commands on
-- Connected Machines are claimed exactly as before, with one exception: a
-- running command whose runner reports its own operation inventory and did
-- not answer a recovery request (last outcome provider_unanswered, recorded
-- only for such runners) is left to that runner, on any enrollment kind. It
-- is claimed again only once the runner reports it (a completion notice), it
-- is stopped, it has a proof, or its runner is retired, so recovery contacts
-- such a runner once. The due probe gets the same filter so it stays a
-- superset of the claim without reporting idle compute commands as work on
-- every tick.
--
-- The due probe reads the owner-only projections of its predicate columns
-- (0848), so the filter's columns are added to them first: a command's
-- completion_notified_at, reconcile_proof_outcome and last_reconcile_outcome
-- and an enrollment's kind. Their sync triggers are rebuilt from 0848's template with the wider
-- column lists, and the new columns are backfilled in the same owner-only
-- window 0848 uses, under the same source locks, so no write slips between.
--
-- The previous release never creates sandbox enrollments, so it is unaffected.

DO $compute_probe_columns$
DECLARE
  data_schema text := pg_catalog.current_schema();
  source record;
  projection text;
  projection_table regclass;
  source_table regclass;
  added text;
  forced boolean;
  columns_sql text;
  new_columns text;
  old_columns text;
  excluded_columns text;
  backfill_sql text;
BEGIN
  FOR source IN SELECT name FROM (VALUES ('enrollments'), ('session_background_commands'))
      sources(name) ORDER BY name LOOP
    EXECUTE format('LOCK TABLE %I.%I IN SHARE ROW EXCLUSIVE MODE', data_schema, source.name);
  END LOOP;

  FOR source IN SELECT * FROM (VALUES
    ('enrollments', 'id', ARRAY['kind']),
    ('session_background_commands', 'id',
      ARRAY['completion_notified_at', 'reconcile_proof_outcome', 'last_reconcile_outcome'])
  ) sources(name, key, additions) ORDER BY name LOOP
    projection := 'maintenance_probe_' || source.name;
    projection_table := format('opengeni_private.%I', projection)::regclass;
    source_table := format('%I.%I', data_schema, source.name)::regclass;
    FOREACH added IN ARRAY source.additions LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
          WHERE attrelid = projection_table AND attname = added AND NOT attisdropped) THEN
        EXECUTE format('ALTER TABLE %s ADD COLUMN %I %s', projection_table, added,
          (SELECT pg_catalog.format_type(atttypid, atttypmod) FROM pg_catalog.pg_attribute
            WHERE attrelid = source_table AND attname = added AND NOT attisdropped));
      END IF;
    END LOOP;

    SELECT string_agg(format('%I', attname), ', ' ORDER BY attnum),
      string_agg(format('NEW.%I', attname), ', ' ORDER BY attnum),
      string_agg(format('OLD.%I', attname), ', ' ORDER BY attnum),
      string_agg(format('EXCLUDED.%I', attname), ', ' ORDER BY attnum)
      INTO columns_sql, new_columns, old_columns, excluded_columns
      FROM pg_catalog.pg_attribute
      WHERE attrelid = projection_table AND attnum > 0 AND NOT attisdropped;

    EXECUTE format($function$
      CREATE OR REPLACE FUNCTION opengeni_private.%1$I() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
      AS $body$
      BEGIN
        IF TG_OP = 'TRUNCATE' THEN
          TRUNCATE opengeni_private.%5$I;
          RETURN NULL;
        END IF;
        IF TG_OP = 'UPDATE' AND ROW(%2$s) IS NOT DISTINCT FROM ROW(%3$s) THEN
          RETURN NULL;
        END IF;
        IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND OLD.%4$I IS DISTINCT FROM NEW.%4$I) THEN
          DELETE FROM opengeni_private.%5$I WHERE %4$I = OLD.%4$I;
        END IF;
        IF TG_OP <> 'DELETE' THEN
          INSERT INTO opengeni_private.%5$I (%6$s) VALUES (%2$s)
          ON CONFLICT (%4$I) DO UPDATE SET (%6$s) = (%7$s);
        END IF;
        RETURN NULL;
      END $body$;
    $function$, projection || '_sync', new_columns, old_columns, source.key,
      projection, columns_sql, excluded_columns);

    SELECT string_agg(format('%1$I = source_row.%1$I', a), ', ')
      INTO backfill_sql FROM unnest(source.additions) a;
    SELECT relforcerowsecurity INTO forced FROM pg_catalog.pg_class WHERE oid = source_table;
    EXECUTE format('ALTER TABLE %s NO FORCE ROW LEVEL SECURITY', source_table);
    EXECUTE format('UPDATE %s probe SET %s FROM %s source_row WHERE source_row.%I = probe.%I',
      projection_table, backfill_sql, source_table, source.key, source.key);
    IF forced THEN
      EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', source_table);
    END IF;
  END LOOP;
END $compute_probe_columns$;

DO $compute_command_settlement$
DECLARE
  claim_definition text := pg_catalog.pg_get_functiondef(
    'opengeni_private.claim_connected_machine_background_commands(uuid,integer,bigint,timestamp with time zone)'::regprocedure
  );
  claim_anchor text := 'ORDER BY command.reconcile_after, command.started_at, command.id';
  claim_replacement text :=
    'AND ((enrollment.kind <> ''sandbox'''
    || ' AND (command.state <> ''running'''
    || ' OR command.last_reconcile_outcome IS DISTINCT FROM ''provider_unanswered''))'
    || ' OR enrollment.status = ''revoked'''
    || ' OR (enrollment.connection_instance_id IS NOT NULL'
    || ' AND enrollment.connection_instance_id <> command.connection_instance_id)'
    || ' OR command.state = ''stopping'''
    || ' OR command.completion_notified_at IS NOT NULL'
    || ' OR command.reconcile_proof_outcome IS NOT NULL)'
    || E'\n        ' || claim_anchor;
  due_definition text := pg_catalog.pg_get_functiondef(
    'opengeni_private.connected_command_reconciliation_due_v1()'::regprocedure
  );
  due_anchor text := 'AND command.provider = ''connected_machine''';
  due_replacement text := due_anchor
    || E'\n          AND NOT EXISTS (SELECT 1 FROM opengeni_private.maintenance_probe_enrollments enrollment'
    || ' WHERE enrollment.id = command.enrollment_id'
    || ' AND enrollment.workspace_id = command.control_workspace_id'
    || ' AND (enrollment.kind = ''sandbox'''
    || ' OR command.last_reconcile_outcome = ''provider_unanswered'')'
    || ' AND enrollment.status <> ''revoked'''
    || ' AND (enrollment.connection_instance_id IS NULL'
    || ' OR enrollment.connection_instance_id = command.connection_instance_id)'
    || ' AND command.state = ''running'''
    || ' AND command.completion_notified_at IS NULL'
    || ' AND command.reconcile_proof_outcome IS NULL)';
BEGIN
  IF strpos(claim_definition, 'enrollment.kind <> ''sandbox''') = 0 THEN
    IF (length(claim_definition) - length(replace(claim_definition, claim_anchor, '')))
        / length(claim_anchor) <> 1 THEN
      RAISE EXCEPTION '0857 connected-command claim prerequisite drift' USING ERRCODE = '55000';
    END IF;
    EXECUTE replace(claim_definition, claim_anchor, claim_replacement);
  END IF;
  IF strpos(due_definition, 'opengeni_private.maintenance_probe_session_background_commands command') = 0 THEN
    RAISE EXCEPTION '0857 connected-command due probe does not read its projection' USING ERRCODE = '55000';
  END IF;
  IF strpos(due_definition, 'enrollment.kind = ''sandbox''') = 0 THEN
    IF (length(due_definition) - length(replace(due_definition, due_anchor, '')))
        / length(due_anchor) <> 1 THEN
      RAISE EXCEPTION '0857 connected-command due probe prerequisite drift' USING ERRCODE = '55000';
    END IF;
    EXECUTE replace(due_definition, due_anchor, due_replacement);
  END IF;
END;
$compute_command_settlement$;
