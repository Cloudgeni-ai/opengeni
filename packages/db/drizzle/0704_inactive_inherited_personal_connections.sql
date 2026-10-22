-- deployment-mode: rolling
-- A personal account that needs re-authorization or was revoked no longer
-- refuses a whole turn. Agent work inherits the exact personal accounts its
-- human accepted; when one of them later lapses, the turn used to be rejected
-- at insert, so a single expired account blocked every child session and
-- agent message that inherited it. A shared workspace account in the same
-- situation is already kept on the turn and denied at use.
--
-- Personal accounts now behave the same way. The capture keeps the accepted
-- selection on the turn but records no authority snapshot for an account that
-- is not active, so every use of it is denied and the account is never
-- revived. The owner, provider and kind must still match exactly: anything
-- else is refused as before. Work delivered into another turn's execution
-- context accepts the same gap only when that turn accepted this exact
-- selection without a snapshot.
--
-- The function is patched in place by earlier migrations, so this edits the
-- live definition and fails if either anchor drifted.
SET LOCAL lock_timeout = '5s';

DO $repair$
DECLARE
  target regprocedure;
  definition text;
  lapsed_anchor text;
  receipt_anchor text;
BEGIN
  target := pg_catalog.to_regprocedure(
    'opengeni_private.capture_accepted_turn_connection_authorities()'
  );
  IF target IS NULL THEN
    RAISE EXCEPTION '0704 connection capture function is missing' USING ERRCODE = '55000';
  END IF;
  definition := pg_catalog.pg_get_functiondef(target);
  lapsed_anchor :=
    E'    IF initiating_subject IS NULL OR connection_row.subject_id IS DISTINCT FROM initiating_subject\n'
    || E'      OR connection_row.status <> ''active''\n';
  receipt_anchor :=
    E'      THEN RAISE EXCEPTION ''receiving connection receipt is unavailable'' USING ERRCODE = ''42501''; END IF;\n';
  IF (pg_catalog.length(definition)
      - pg_catalog.length(pg_catalog.replace(definition, lapsed_anchor, '')))
      / pg_catalog.length(lapsed_anchor) <> 1
    OR (pg_catalog.length(definition)
      - pg_catalog.length(pg_catalog.replace(definition, receipt_anchor, '')))
      / pg_catalog.length(receipt_anchor) <> 1
  THEN
    RAISE EXCEPTION '0704 connection capture definition drift' USING ERRCODE = '55000';
  END IF;
  definition := pg_catalog.replace(
    definition,
    lapsed_anchor,
    E'    -- An exact owner account that lapsed stays accepted without authority.\n'
    || E'    IF initiating_subject IS NOT NULL\n'
    || E'      AND connection_row.subject_id IS NOT DISTINCT FROM initiating_subject\n'
    || E'      AND connection_row.status <> ''active''\n'
    || E'      AND lower(connection_row.provider_domain) IS NOT DISTINCT FROM lower(item ->> ''providerDomain'')\n'
    || E'      AND NOT (item ? ''kind'' AND connection_row.kind IS DISTINCT FROM item ->> ''kind'')\n'
    || E'    THEN\n'
    || E'      CONTINUE;\n'
    || E'    END IF;\n'
    || lapsed_anchor
  );
  definition := pg_catalog.replace(
    definition,
    receipt_anchor,
    E'        AND NOT EXISTS (SELECT 1 FROM session_turns lapsed_source\n'
    || E'          WHERE lapsed_source.id = NEW.execution_context_turn_id\n'
    || E'            AND lapsed_source.account_id = NEW.account_id\n'
    || E'            AND lapsed_source.workspace_id = NEW.workspace_id\n'
    || E'            AND lapsed_source.session_id = NEW.session_id\n'
    || E'            AND lapsed_source.personal_connection_delegations @> pg_catalog.jsonb_build_array(item)\n'
    || E'            AND NOT EXISTS (SELECT 1 FROM turn_connection_authority_snapshots lapsed\n'
    || E'              WHERE lapsed.turn_id = lapsed_source.id\n'
    || E'                AND lapsed.account_id = NEW.account_id\n'
    || E'                AND lapsed.workspace_id = NEW.workspace_id\n'
    || E'                AND lapsed.server_id = item ->> ''serverId''\n'
    || E'                AND lapsed.connection_id::text = item ->> ''connectionId''))\n'
    || receipt_anchor
  );
  EXECUTE definition;
END
$repair$;
