-- deployment-mode: rolling
SET lock_timeout = '5s';
SET statement_timeout = '10min';

-- Surface activation authority on preference descriptors.
--
-- `provenance.trust` is the frozen creation-time fact and stays exactly as it
-- is: a revision an agent proposed is `untrusted_proposal` forever, and both
-- activation adapters still require that value, so it cannot be repurposed to
-- mean "a human approved this". The separate question - did a human explicitly
-- confirm this activation, or did policy activate it automatically - already
-- has a durable answer in the governed-learning activation receipt. This
-- reads it at descriptor-build time rather than mutating any immutable row.
--
-- Snapshots written before this field existed keep their exact stored JSON and
-- their pinned descriptor hash; the contract parses their missing value as
-- null, which is the truthful reading.

CREATE OR REPLACE FUNCTION preference_registry_canonical_snapshot_at(p_account_id uuid, p_workspace_id uuid, p_initiating_human_subject_id text, p_accepted_at timestamp with time zone)
 RETURNS TABLE(canonical_descriptors jsonb, canonical_truncated boolean)
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
  canonical_descriptor jsonb;
  candidate_descriptors jsonb;
BEGIN
  canonical_descriptors := '[]'::jsonb;
  canonical_truncated := false;

  FOR canonical_descriptor IN
    WITH state_event AS (
      SELECT DISTINCT ON (event.preference_id)
        event.preference_id,
        event.type,
        event.new_revision_id
      FROM preference_registry_events event
      WHERE event.account_id = p_account_id
        AND event.created_at <= p_accepted_at
        AND event.type IN (
          'proposal_created',
          'activated',
          'corrected',
          'rejected',
          'deactivated',
          'superseded'
        )
      ORDER BY
        event.preference_id,
        event.created_at DESC,
        event.version DESC,
        event.id DESC
    ), scope_event AS (
      SELECT DISTINCT ON (event.preference_id)
        event.preference_id,
        event.new_scope AS scope,
        event.new_workspace_id AS scope_workspace_id,
        event.new_subject_id AS scope_subject_id
      FROM preference_registry_events event
      WHERE event.account_id = p_account_id
        AND event.created_at <= p_accepted_at
        AND event.new_scope IS NOT NULL
      ORDER BY
        event.preference_id,
        event.created_at DESC,
        event.version DESC,
        event.id DESC
    ), activation_version AS (
      SELECT
        event.preference_id,
        count(*)::integer AS value
      FROM preference_registry_events event
      WHERE event.account_id = p_account_id
        AND event.created_at <= p_accepted_at
        AND event.type IN ('activated', 'corrected', 'deactivated')
      GROUP BY event.preference_id
    )
    SELECT jsonb_build_object(
      'id', preference.id::text,
      'stableKey', preference.stable_key,
      'title', revision.title,
      'description', revision.description,
      'scope', scope.scope,
      'activeVersion', coalesce(activation.value, 0),
      'revisionId', revision.id::text,
      'contentHash', revision.content_hash,
      'precedence', jsonb_build_object(
        'tier', scope.scope,
        'rank', revision.precedence_rank,
        'conflictStrategy', revision.conflict_strategy,
        'conflictsWith', revision.conflicts_with
      ),
      'provenance', jsonb_build_object(
        'source', revision.provenance_source,
        'sourceIdHash', CASE
          WHEN revision.provenance_source_id IS NULL THEN NULL
          ELSE encode(
            sha256(convert_to(revision.provenance_source_id, 'UTF8')),
            'hex'
          )
        END,
        'trust', revision.trust
      ),
      -- How this exact revision became active. `trust` above stays the frozen
      -- creation-time fact; this is the separate activation question, read from
      -- the governed-learning receipt that activated this revision. NULL when
      -- the revision became active outside governed learning.
      'activationAuthority', (
        SELECT receipt.authority_kind
        FROM governed_learning_activation_receipts receipt
        WHERE receipt.account_id = p_account_id
          AND receipt.workspace_id = p_workspace_id
          AND receipt.destination = 'preference'
          AND receipt.destination_revision_id = revision.id
          AND NOT EXISTS (
            SELECT 1 FROM governed_learning_activation_undo_receipts undo
            WHERE undo.account_id = receipt.account_id
              AND undo.activation_receipt_id = receipt.id
          )
        ORDER BY receipt.created_at DESC, receipt.id DESC
        LIMIT 1
      ),
      'expiresAt', CASE
        WHEN revision.expires_at IS NULL THEN NULL
        ELSE to_char(
          revision.expires_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        )
      END,
      'retrievalHandle',
        'preference://' || preference.id::text || '/revisions/' || revision.id::text ||
        '?sha256=' || revision.content_hash
    )
    FROM state_event state
    JOIN scope_event scope ON scope.preference_id = state.preference_id
    JOIN preference_registry_preferences preference
      ON preference.account_id = p_account_id
      AND preference.id = state.preference_id
    JOIN preference_registry_revisions revision
      ON revision.account_id = preference.account_id
      AND revision.preference_id = preference.id
      AND revision.id = state.new_revision_id
    LEFT JOIN activation_version activation
      ON activation.preference_id = preference.id
    WHERE state.type IN ('activated', 'corrected')
      AND (revision.expires_at IS NULL OR revision.expires_at > p_accepted_at)
      AND (
        scope.scope = 'organization'
        OR (
          scope.scope = 'workspace'
          AND scope.scope_workspace_id = p_workspace_id
          AND scope.scope_subject_id IS NULL
        )
        OR (
          scope.scope = 'user'
          AND scope.scope_workspace_id IS NULL
          AND scope.scope_subject_id = p_initiating_human_subject_id
        )
      )
    ORDER BY CASE scope.scope
        WHEN 'organization' THEN 0
        WHEN 'workspace' THEN 1
        WHEN 'user' THEN 2
        ELSE 3
      END,
      revision.precedence_rank DESC,
      preference.stable_key,
      preference.id
  LOOP
    IF jsonb_array_length(canonical_descriptors) >= 64 THEN
      canonical_truncated := true;
      EXIT;
    END IF;
    candidate_descriptors := canonical_descriptors || jsonb_build_array(canonical_descriptor);
    IF octet_length(convert_to(candidate_descriptors::text, 'UTF8')) > 16384 THEN
      canonical_truncated := true;
      EXIT;
    END IF;
    canonical_descriptors := candidate_descriptors;
  END LOOP;

  RETURN NEXT;
END;
$function$;


-- The receipts table stays closed to the runtime role: reads go through a
-- definer accessor, exactly as the inspection surfaces in 0270 do. This one is
-- deliberately narrow - it answers only "how did these exact preference
-- revisions become active", never returning receipt bodies or any other
-- destination.
CREATE OR REPLACE FUNCTION preference_registry_activation_authority(
  p_workspace_id uuid,
  p_revision_ids uuid[]
) RETURNS TABLE (revision_id uuid, authority_kind text)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT DISTINCT ON (receipt.destination_revision_id)
    receipt.destination_revision_id, receipt.authority_kind
  FROM governed_learning_activation_receipts receipt
  WHERE receipt.workspace_id = p_workspace_id
    AND receipt.destination = 'preference'
    AND receipt.destination_revision_id = ANY(p_revision_ids)
    AND opengeni_private.workspace_rls_visible(receipt.account_id, receipt.workspace_id)
    -- An activation that was undone no longer describes how the revision is
    -- active now: a later ordinary activation of the same revision is not
    -- governed learning's doing, and must not inherit its authority.
    AND NOT EXISTS (
      SELECT 1 FROM governed_learning_activation_undo_receipts undo
      WHERE undo.account_id = receipt.account_id
        AND undo.activation_receipt_id = receipt.id
    )
  ORDER BY receipt.destination_revision_id, receipt.created_at DESC, receipt.id DESC;
$$;

DO $preference_activation_authority_access$
DECLARE
  data_schema text := current_schema();
  signature text := 'preference_registry_activation_authority(uuid,uuid[])';
BEGIN
  EXECUTE pg_catalog.format(
    'ALTER FUNCTION %I.%s SET search_path = pg_catalog, %I, pg_temp',
    data_schema, signature, data_schema
  );
  EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %I.%s FROM PUBLIC', data_schema, signature);
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION %I.%s TO opengeni_app', data_schema, signature
    );
  END IF;
END
$preference_activation_authority_access$;

RESET statement_timeout;
RESET lock_timeout;
