-- deployment-mode: rolling
-- Return claimed child-lifecycle outbox rows in the order they were claimed.
--
-- The claim selects pending rows by (created_at, id), but it returned them
-- straight from `UPDATE ... FROM claimed ... RETURNING`, whose row order is
-- whatever the join plan produces. PostgreSQL hash-joins the claimed ids
-- against a sequential scan of the outbox, so the result followed the heap,
-- and free-space reuse or any earlier row update puts an older row after a
-- newer one there. The worker reconciler delivers rows in the returned order,
-- the parent orders pending machine input by its own insert time, and a newer
-- child notice supersedes an older pending one only when it is delivered
-- after it. A backlog could therefore reach the parent reversed: sibling
-- results claimed out of completion order, or an older progress notice
-- superseding a newer one.
--
-- Only the row order changes. The signature, SECURITY DEFINER posture, and
-- existing grants are preserved (CREATE OR REPLACE keeps the ACL), so old and
-- new binaries can run against either definition.
CREATE OR REPLACE FUNCTION opengeni_private.claim_session_system_update_outbox(p_limit integer)
RETURNS TABLE (
  id uuid, account_id uuid, workspace_id uuid, source_session_id uuid,
  target_session_id uuid, dedupe_key text, kind text, classification text,
  source_id text, summary text, summary_codec_version integer,
  payload jsonb, payload_codec_version integer, lineage jsonb,
  mcp_account_bindings jsonb, personal_connection_delegations jsonb,
  codex_provider_account_authority_snapshot jsonb,
  xai_provider_account_authority_snapshot jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
BEGIN
  RETURN QUERY
    WITH claimed AS (
      SELECT o.id FROM session_system_update_outbox o
      WHERE o.status = 'pending'
      ORDER BY o.created_at, o.id
      FOR UPDATE SKIP LOCKED
      LIMIT greatest(1, least(coalesce(p_limit, 100), 100))
    ), bumped AS (
      UPDATE session_system_update_outbox o
      SET attempts = o.attempts + 1, updated_at = now()
      FROM claimed c WHERE o.id = c.id
      RETURNING o.created_at, o.id, o.account_id, o.workspace_id, o.source_session_id,
        o.target_session_id, o.dedupe_key, o.kind, o.classification,
        o.source_id, o.summary, o.summary_codec_version,
        o.payload, o.payload_codec_version, o.lineage,
        o.mcp_account_bindings, o.personal_connection_delegations,
        o.codex_provider_account_authority_snapshot,
        o.xai_provider_account_authority_snapshot
    )
    SELECT b.id, b.account_id, b.workspace_id, b.source_session_id,
      b.target_session_id, b.dedupe_key, b.kind, b.classification,
      b.source_id, b.summary, b.summary_codec_version,
      b.payload, b.payload_codec_version, b.lineage,
      b.mcp_account_bindings, b.personal_connection_delegations,
      b.codex_provider_account_authority_snapshot,
      b.xai_provider_account_authority_snapshot
    FROM bumped b
    ORDER BY b.created_at, b.id;
END
$function$;

-- CREATE OR REPLACE drops the pinned search_path; restore it for this schema.
DO $outbox_claim_search_path$
BEGIN
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.claim_session_system_update_outbox(integer) SET search_path = pg_catalog, %I',
    current_schema()
  );
END
$outbox_claim_search_path$;

REVOKE ALL ON FUNCTION opengeni_private.claim_session_system_update_outbox(integer) FROM PUBLIC;
