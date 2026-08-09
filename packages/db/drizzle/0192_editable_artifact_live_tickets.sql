-- deployment-mode: rolling
-- Shared, one-use live admission tickets. Only token digests are persisted;
-- the opaque bearer token never crosses this storage boundary.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE "editable_artifact_live_tickets" (
  "token_digest" text PRIMARY KEY,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "artifact_id" text NOT NULL,
  "modality" text NOT NULL,
  "actor_kind" text NOT NULL,
  "actor_subject_id" text NOT NULL,
  "replica_id" text NOT NULL,
  "agent_session_id" text,
  "agent_turn_id" text,
  "agent_attempt_id" text,
  "agent_generation" integer,
  "service_name" text,
  "allow_edit" boolean NOT NULL,
  "protocol_version" integer NOT NULL,
  "issued_at" timestamptz NOT NULL,
  "expires_at" timestamptz NOT NULL,
  CONSTRAINT "editable_artifact_live_tickets_artifact_fk"
    FOREIGN KEY ("account_id", "workspace_id", "artifact_id")
    REFERENCES "editable_artifacts"("account_id", "workspace_id", "id")
    ON DELETE CASCADE,
  CONSTRAINT "editable_artifact_live_tickets_digest_chk" CHECK (
    "token_digest" ~ '^sha256:[0-9a-f]{64}$'
  ),
  CONSTRAINT "editable_artifact_live_tickets_identity_chk" CHECK (
    "artifact_id" ~ '^[0-9a-f]{32}$' AND "artifact_id" !~ '^0+$'
    AND "replica_id" ~ '^[0-9a-f]{16}$' AND "replica_id" !~ '^0+$'
  ),
  CONSTRAINT "editable_artifact_live_tickets_modality_chk" CHECK (
    "modality" IN ('spreadsheet', 'presentation', 'document')
  ),
  CONSTRAINT "editable_artifact_live_tickets_actor_chk" CHECK (
    octet_length("actor_subject_id") BETWEEN 1 AND 1024
    AND "actor_subject_id" = btrim("actor_subject_id")
    AND (
      ("actor_kind" = 'human'
        AND "agent_session_id" IS NULL
        AND "agent_turn_id" IS NULL
        AND "agent_attempt_id" IS NULL
        AND "agent_generation" IS NULL
        AND "service_name" IS NULL)
      OR
      ("actor_kind" = 'agent'
        AND "agent_session_id" IS NOT NULL
        AND octet_length("agent_session_id") BETWEEN 1 AND 1024
        AND "agent_session_id" = btrim("agent_session_id")
        AND "agent_turn_id" IS NOT NULL
        AND octet_length("agent_turn_id") BETWEEN 1 AND 1024
        AND "agent_turn_id" = btrim("agent_turn_id")
        AND "agent_attempt_id" IS NOT NULL
        AND octet_length("agent_attempt_id") BETWEEN 1 AND 1024
        AND "agent_attempt_id" = btrim("agent_attempt_id")
        AND "agent_generation" IS NOT NULL
        AND "agent_generation" BETWEEN 0 AND 2147483647
        AND "service_name" IS NULL)
      OR
      ("actor_kind" = 'service'
        AND "agent_session_id" IS NULL
        AND "agent_turn_id" IS NULL
        AND "agent_attempt_id" IS NULL
        AND "agent_generation" IS NULL
        AND "service_name" IS NOT NULL
        AND octet_length("service_name") BETWEEN 1 AND 1024
        AND "service_name" = btrim("service_name"))
    )
  ),
  CONSTRAINT "editable_artifact_live_tickets_lifetime_chk" CHECK (
    "protocol_version" BETWEEN 1 AND 2147483647
    AND "expires_at" >= "issued_at" + interval '1 second'
    AND "expires_at" <= "issued_at" + interval '60 seconds'
  )
);

CREATE INDEX "editable_artifact_live_tickets_expiry_idx"
  ON "editable_artifact_live_tickets" ("expires_at", "token_digest");

ALTER TABLE "editable_artifact_live_tickets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "editable_artifact_live_tickets" FORCE ROW LEVEL SECURITY;

DO $ticket_owner_policy$
DECLARE data_schema text := pg_catalog.current_schema();
DECLARE migration_owner text := current_user;
BEGIN
  EXECUTE pg_catalog.format(
    'CREATE POLICY editable_artifact_live_ticket_owner ON %I.editable_artifact_live_tickets '
    || 'FOR ALL USING (current_user = %L) WITH CHECK (current_user = %L)',
    data_schema, migration_owner, migration_owner
  );
END;
$ticket_owner_policy$;

CREATE OR REPLACE FUNCTION opengeni_private.resolve_editable_artifact_ticket_data_schema(
  requested_schema name
) RETURNS name
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE data_schema name;
BEGIN
  data_schema := opengeni_private.resolve_editable_artifact_data_schema(requested_schema);
  PERFORM 1
  FROM pg_catalog.pg_namespace namespace
  JOIN pg_catalog.pg_class ticket_relation
    ON ticket_relation.relnamespace = namespace.oid
    AND ticket_relation.relname = 'editable_artifact_live_tickets'
    AND ticket_relation.relkind IN ('r', 'p')
  JOIN pg_catalog.pg_class artifact_relation
    ON artifact_relation.relnamespace = namespace.oid
    AND artifact_relation.relname = 'editable_artifacts'
    AND artifact_relation.relkind IN ('r', 'p')
    AND artifact_relation.relowner = ticket_relation.relowner
  JOIN pg_catalog.pg_roles owner_role
    ON owner_role.oid = ticket_relation.relowner
    AND owner_role.rolname = current_user
  WHERE namespace.nspname = data_schema
    AND ticket_relation.relrowsecurity
    AND ticket_relation.relforcerowsecurity;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'editable artifact live ticket data schema is unavailable or untrusted'
      USING ERRCODE = '42501';
  END IF;
  RETURN data_schema;
END;
$body$;

CREATE OR REPLACE FUNCTION opengeni_private.put_editable_artifact_live_ticket(
  p_token_digest text,
  p_account_id uuid,
  p_workspace_id uuid,
  p_artifact_id text,
  p_modality text,
  p_actor_kind text,
  p_actor_subject_id text,
  p_replica_id text,
  p_agent_session_id text,
  p_agent_turn_id text,
  p_agent_attempt_id text,
  p_agent_generation integer,
  p_service_name text,
  p_allow_edit boolean,
  p_protocol_version integer,
  p_issued_at timestamptz,
  p_expires_at timestamptz,
  p_data_schema name DEFAULT pg_catalog.current_schema()
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE data_schema name;
DECLARE stored boolean;
BEGIN
  IF NOT opengeni_private.editable_artifact_scope_matches_context(
    p_account_id, p_workspace_id
  ) THEN
    RAISE EXCEPTION 'editable artifact live ticket scope does not match context'
      USING ERRCODE = '42501';
  END IF;
  IF p_issued_at < pg_catalog.clock_timestamp() - interval '60 seconds'
    OR p_issued_at > pg_catalog.clock_timestamp() + interval '5 seconds'
    OR p_expires_at <= pg_catalog.clock_timestamp()
    OR p_expires_at > pg_catalog.clock_timestamp() + interval '60 seconds'
  THEN
    RAISE EXCEPTION 'editable artifact live ticket lifetime is outside database bounds'
      USING ERRCODE = '22023';
  END IF;
  data_schema := opengeni_private.resolve_editable_artifact_ticket_data_schema(
    p_data_schema
  );
  EXECUTE pg_catalog.format($query$
    SELECT true
    FROM %I.editable_artifacts
    WHERE account_id = $1 AND workspace_id = $2 AND id = $3
      AND modality = $4 AND lifecycle_state = 'active'
  $query$, data_schema)
    INTO stored
    USING p_account_id, p_workspace_id, p_artifact_id, p_modality;
  IF stored IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'editable artifact live ticket target is unavailable'
      USING ERRCODE = '23503';
  END IF;
  EXECUTE pg_catalog.format($query$
    INSERT INTO %I.editable_artifact_live_tickets (
      token_digest, account_id, workspace_id, artifact_id, modality,
      actor_kind, actor_subject_id, replica_id,
      agent_session_id, agent_turn_id, agent_attempt_id, agent_generation,
      service_name, allow_edit, protocol_version, issued_at, expires_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8,
      $9, $10, $11, $12, $13, $14, $15, $16, $17
    )
  $query$, data_schema) USING
    p_token_digest, p_account_id, p_workspace_id, p_artifact_id, p_modality,
    p_actor_kind, p_actor_subject_id, p_replica_id,
    p_agent_session_id, p_agent_turn_id, p_agent_attempt_id, p_agent_generation,
    p_service_name, p_allow_edit, p_protocol_version, p_issued_at, p_expires_at;
END;
$body$;

CREATE OR REPLACE FUNCTION opengeni_private.consume_editable_artifact_live_ticket(
  p_token_digest text,
  p_data_schema name DEFAULT pg_catalog.current_schema()
) RETURNS TABLE (
  token_digest text,
  account_id uuid,
  workspace_id uuid,
  artifact_id text,
  modality text,
  actor_kind text,
  actor_subject_id text,
  replica_id text,
  agent_session_id text,
  agent_turn_id text,
  agent_attempt_id text,
  agent_generation integer,
  service_name text,
  allow_edit boolean,
  protocol_version integer,
  issued_at timestamptz,
  expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE data_schema name;
BEGIN
  IF p_token_digest !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'editable artifact live ticket digest is malformed'
      USING ERRCODE = '22023';
  END IF;
  data_schema := opengeni_private.resolve_editable_artifact_ticket_data_schema(
    p_data_schema
  );
  RETURN QUERY EXECUTE pg_catalog.format($query$
    WITH consumed AS (
      DELETE FROM %I.editable_artifact_live_tickets ticket
      WHERE ticket.token_digest = $1
      RETURNING ticket.token_digest, ticket.account_id, ticket.workspace_id,
        ticket.artifact_id, ticket.modality, ticket.actor_kind,
        ticket.actor_subject_id, ticket.replica_id, ticket.agent_session_id,
        ticket.agent_turn_id, ticket.agent_attempt_id, ticket.agent_generation,
        ticket.service_name, ticket.allow_edit, ticket.protocol_version,
        ticket.issued_at, ticket.expires_at
    )
    SELECT consumed.*
    FROM consumed
    WHERE consumed.expires_at > pg_catalog.clock_timestamp()
  $query$, data_schema) USING p_token_digest;
END;
$body$;

CREATE OR REPLACE FUNCTION opengeni_private.cleanup_expired_editable_artifact_live_tickets(
  p_limit integer,
  p_data_schema name DEFAULT pg_catalog.current_schema()
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE data_schema name;
DECLARE removed integer;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 10000 THEN
    RAISE EXCEPTION 'editable artifact live ticket cleanup limit is invalid'
      USING ERRCODE = '22023';
  END IF;
  data_schema := opengeni_private.resolve_editable_artifact_ticket_data_schema(
    p_data_schema
  );
  EXECUTE pg_catalog.format($query$
    WITH expired AS (
      SELECT ticket.token_digest
      FROM %I.editable_artifact_live_tickets ticket
      WHERE ticket.expires_at <= pg_catalog.clock_timestamp()
      ORDER BY ticket.expires_at, ticket.token_digest
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM %I.editable_artifact_live_tickets ticket
    USING expired
    WHERE ticket.token_digest = expired.token_digest
  $query$, data_schema, data_schema) USING p_limit;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$body$;

REVOKE ALL ON TABLE "editable_artifact_live_tickets" FROM PUBLIC;
REVOKE ALL ON FUNCTION
  opengeni_private.resolve_editable_artifact_ticket_data_schema(name) FROM PUBLIC;
REVOKE ALL ON FUNCTION
  opengeni_private.put_editable_artifact_live_ticket(
    text, uuid, uuid, text, text, text, text, text,
    text, text, text, integer, text, boolean, integer, timestamptz, timestamptz, name
  ) FROM PUBLIC;
REVOKE ALL ON FUNCTION
  opengeni_private.consume_editable_artifact_live_ticket(text, name) FROM PUBLIC;
REVOKE ALL ON FUNCTION
  opengeni_private.cleanup_expired_editable_artifact_live_tickets(integer, name)
  FROM PUBLIC;

DO $runtime_ticket_grants$
DECLARE data_schema name := pg_catalog.current_schema();
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'opengeni_app'
  ) THEN
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON TABLE %I.editable_artifact_live_tickets FROM opengeni_app',
      data_schema
    );
    GRANT EXECUTE ON FUNCTION
      opengeni_private.put_editable_artifact_live_ticket(
        text, uuid, uuid, text, text, text, text, text,
        text, text, text, integer, text, boolean, integer, timestamptz, timestamptz, name
      ) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION
      opengeni_private.consume_editable_artifact_live_ticket(text, name)
      TO opengeni_app;
    GRANT EXECUTE ON FUNCTION
      opengeni_private.cleanup_expired_editable_artifact_live_tickets(integer, name)
      TO opengeni_app;
  END IF;
END;
$runtime_ticket_grants$;

RESET statement_timeout;
RESET lock_timeout;
