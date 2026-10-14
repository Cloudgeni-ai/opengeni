-- deployment-mode: rolling
-- Spreadsheet operation identities are an ordered list, not a set. The kernel
-- derives identity i of a committed transaction from the intent digest and
-- command index i, so the identities of a multi-command batch are lexically
-- unordered, and the operation at sequence_start + i carries identity i (the
-- commit trigger compares operation_ids ->> operation_index, and the canonical
-- OGACO002 bytes list them in command order). 0191 validated operation_ids
-- with the sorted-set validator meant for selective undo targets, which
-- rejected almost every valid multi-command spreadsheet transaction with a
-- generic commit failure.
--
-- Only that predicate changes: identities stay well-formed, nonzero, unique
-- and at most 4096, and keep their command order. The validator itself accepts
-- an empty list; the unchanged count clauses (operation_count BETWEEN 1 AND
-- 4096, equal to the list length) supply the lower bound. Selective undo
-- targets remain a canonically sorted set and every other clause is unchanged.
-- Every existing row already satisfies the stricter predicate, so the
-- constraint is added NOT VALID to avoid a history scan under the table lock;
-- it still checks every new or updated row. Expand only: rows from older
-- writers satisfy both.
--
-- Every transaction insert evaluates the new validator, so the configured
-- application roles receive EXECUTE in this migration rather than only at the
-- next role provisioning; otherwise a custom runtime login could not write any
-- editable transaction in between. Unknown configured names are skipped.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE OR REPLACE FUNCTION opengeni_private.editable_artifact_operation_id_list_valid(value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $body$
  SELECT CASE
    WHEN value IS NULL OR jsonb_typeof(value) IS DISTINCT FROM 'array' THEN false
    ELSE jsonb_array_length(value) <= 4096
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(value) AS entries(entry)
        WHERE jsonb_typeof(entry) <> 'string'
          OR entry #>> '{}' !~ '^[0-9a-f]{32}$'
          OR entry #>> '{}' ~ '^0+$'
      )
      AND (
        SELECT count(*) = count(DISTINCT entry #>> '{}')
        FROM jsonb_array_elements(value) AS entries(entry)
      )
  END;
$body$;

REVOKE ALL ON FUNCTION
  opengeni_private.editable_artifact_operation_id_list_valid(jsonb) FROM PUBLIC;
DO $grants$
DECLARE application_role text;
BEGIN
  FOR application_role IN
    SELECT role_value.rolname
    FROM jsonb_array_elements_text(coalesce(nullif(current_setting(
      'opengeni.migration_application_roles', true), ''), '[]')::jsonb) configured(value)
    JOIN pg_catalog.pg_roles role_value ON role_value.rolname = configured.value
    UNION SELECT 'opengeni_app'
    WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'opengeni_app')
  LOOP
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION opengeni_private.editable_artifact_operation_id_list_valid(jsonb) TO %I',
      application_role);
  END LOOP;
END
$grants$;

ALTER TABLE "editable_artifact_transactions"
  DROP CONSTRAINT "editable_artifact_transactions_frontiers_chk",
  ADD CONSTRAINT "editable_artifact_transactions_frontiers_chk" CHECK (
    ("modality" = 'spreadsheet'
      AND opengeni_private.editable_artifact_frontier_valid("causal_base")
      AND opengeni_private.editable_artifact_frontier_valid("resolved_causal_base")
      AND opengeni_private.editable_artifact_frontier_valid("resulting_causal_frontier")
      AND opengeni_private.editable_artifact_operation_id_list_valid("operation_ids")
      AND jsonb_array_length("operation_ids") = "operation_count"
      AND opengeni_private.editable_artifact_id_array_valid("selective_undo_targets"))
    OR ("modality" IN ('document', 'presentation')
      AND "causal_base" IS NULL AND "resolved_causal_base" IS NULL
      AND "resulting_causal_frontier" IS NULL AND "operation_ids" IS NULL
      AND "selective_undo_targets" IS NULL)
  ) NOT VALID;
