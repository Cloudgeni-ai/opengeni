-- deployment-mode: rolling
-- Replace the lease-wide OR join with one distinct set of referenced artifact
-- ids and an exact native-capture lookup. An empty GC pass must not compare
-- every artifact with every lease. Keep the 0849 capability wrapper, RLS,
-- stale-claim recovery, TTLs, Rig protections and SKIP LOCKED claim unchanged.
-- The read-only due probe already uses indexed projections (0848); leave its
-- early-exit plan intact. Only the claim reads the unindexed source references.
DO $install$
DECLARE
  data_schema text := current_schema();
  entry record;
  definition text;
  original_predicate text;
  replacement_predicate text;
BEGIN
  FOR entry IN SELECT * FROM (VALUES
    ('opengeni_private.maintenance_claim_checkpoint_gc_inner(uuid,integer,bigint)',
      format('%I.sandbox_leases', data_schema))
  ) routines(signature, lease_table) LOOP
    definition := pg_get_functiondef(entry.signature::regprocedure);
    original_predicate := format($predicate$SELECT 1 FROM %s lease
            WHERE lease.current_checkpoint_artifact_id = artifact.id
               OR lease.previous_checkpoint_artifact_id = artifact.id
               OR ($predicate$, entry.lease_table);
    replacement_predicate := format($predicate$SELECT 1
            FROM (
              SELECT current_checkpoint_artifact_id AS id
              FROM %1$s WHERE current_checkpoint_artifact_id IS NOT NULL
              UNION
              SELECT previous_checkpoint_artifact_id AS id
              FROM %1$s WHERE previous_checkpoint_artifact_id IS NOT NULL
            ) referenced
            WHERE referenced.id = artifact.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM %1$s lease
            WHERE ($predicate$, entry.lease_table);
    -- Fail closed if an earlier migration changed either predicate. Reusing
    -- the complete definition preserves its owner, grants and search_path.
    IF (length(definition) - length(replace(definition, original_predicate, '')))
        / length(original_predicate) <> 1 THEN
      RAISE EXCEPTION 'checkpoint GC reference predicate drift: %', entry.signature;
    END IF;
    EXECUTE replace(definition, original_predicate, replacement_predicate);
  END LOOP;
END $install$;
