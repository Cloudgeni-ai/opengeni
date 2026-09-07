-- deployment-mode: rolling
-- Existing callers already carry the accepted source revision and exact generated
-- session key. Materialization advances the canonical producer's row, so admit
-- its concurrent adopter only through the existing immutable source/target receipt.
-- No table, grant, caller, or runtime-posture contract changes; old binaries use
-- the same trigger and retain all subsequent live-authority revalidation.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $scheduled_generated_producer_materialization$
DECLARE
  definition text;
  anchor constant text := $anchor$              AND canonical_run.task_authority_revision = OLD.task_authority_revision
              AND canonical_run.task_execution_digest = OLD.task_execution_digest$anchor$;
  replacement constant text := $replacement$              -- 0414 exact reusable producer materialization receipt
              AND (
                (canonical_run.task_authority_revision = OLD.task_authority_revision
                  AND canonical_run.task_execution_digest = OLD.task_execution_digest)
                OR EXISTS (
                  SELECT 1 FROM scheduled_task_reusable_connection_materializations receipt
                  WHERE receipt.run_id = canonical_generated_run_id
                    AND receipt.account_id = OLD.account_id
                    AND receipt.workspace_id = OLD.workspace_id
                    AND receipt.task_id = OLD.task_id
                    AND receipt.session_id = NEW.session_id
                    AND receipt.source_task_authority_revision = OLD.task_authority_revision
                    AND receipt.source_execution_digest = OLD.task_execution_digest
                    AND receipt.target_task_authority_revision = canonical_run.task_authority_revision
                    AND receipt.target_execution_digest = canonical_run.task_execution_digest
                )
              )$replacement$;
  occurrences integer;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(
    'fence_scheduled_task_run_connection_session_identity()'::regprocedure
  ) INTO definition;
  IF pg_catalog.strpos(definition, '0414 exact reusable producer materialization receipt') > 0 THEN
    IF pg_catalog.strpos(definition, replacement) = 0 THEN
      RAISE EXCEPTION '0414 scheduled producer receipt replay definition drift'
        USING ERRCODE = '55000';
    END IF;
    RETURN;
  END IF;
  occurrences := (pg_catalog.length(definition)
    - pg_catalog.length(pg_catalog.replace(definition, anchor, '')))
    / pg_catalog.length(anchor);
  IF occurrences <> 1 THEN
    RAISE EXCEPTION '0414 scheduled producer receipt prerequisite definition drift'
      USING ERRCODE = '55000';
  END IF;
  EXECUTE pg_catalog.replace(definition, anchor, replacement);
END
$scheduled_generated_producer_materialization$;
