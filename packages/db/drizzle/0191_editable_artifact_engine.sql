-- deployment-mode: rolling
-- Additive durable authority for collaborative editable artifacts. Canonical
-- model bytes remain in object storage; Postgres owns scoped identity,
-- idempotency, causality, delivery order, immutable history, and job/outbox
-- state. No existing table or behavior is changed by this migration.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE SCHEMA IF NOT EXISTS opengeni_private;

CREATE OR REPLACE FUNCTION opengeni_private.editable_artifact_frontier_valid(value jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE entry jsonb;
DECLARE replica text;
DECLARE counter_text text;
DECLARE previous_replica text;
BEGIN
  IF value IS NULL
    OR jsonb_typeof(value) IS DISTINCT FROM 'array'
    OR jsonb_array_length(value) > 65536
    OR pg_column_size(value) > 1048576
    OR octet_length(value::text) > 1048576
  THEN
    RETURN false;
  END IF;
  FOR entry IN SELECT item FROM jsonb_array_elements(value) AS items(item) LOOP
    IF jsonb_typeof(entry) <> 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(entry)) <> 2
      OR NOT (entry ? 'replicaId' AND entry ? 'counter')
      OR jsonb_typeof(entry->'replicaId') <> 'string'
      OR jsonb_typeof(entry->'counter') <> 'number'
    THEN
      RETURN false;
    END IF;
    replica := entry->>'replicaId';
    counter_text := entry->>'counter';
    IF replica !~ '^[0-9a-f]{16}$' OR replica ~ '^0+$'
      OR counter_text !~ '^[1-9][0-9]{0,15}$'
      OR counter_text::numeric > 9007199254740991
      OR (previous_replica IS NOT NULL
        AND convert_to(replica, 'UTF8') <= convert_to(previous_replica, 'UTF8'))
    THEN
      RETURN false;
    END IF;
    previous_replica := replica;
  END LOOP;
  RETURN true;
EXCEPTION WHEN others THEN
  RETURN false;
END;
$body$;

CREATE OR REPLACE FUNCTION opengeni_private.editable_artifact_id_array_valid(value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $body$
  SELECT CASE
    WHEN value IS NULL OR jsonb_typeof(value) IS DISTINCT FROM 'array' THEN false
    ELSE jsonb_array_length(value) <= 10000
      AND pg_column_size(value) <= 1048576
      AND octet_length(value::text) <= 1048576
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
      AND NOT EXISTS (
        SELECT 1
        FROM (
          SELECT entry #>> '{}' AS current_value,
            lag(entry #>> '{}') OVER (ORDER BY ordinal) AS previous_value
          FROM jsonb_array_elements(value) WITH ORDINALITY AS entries(entry, ordinal)
        ) ordered
        WHERE previous_value IS NOT NULL
          AND convert_to(previous_value, 'UTF8') >= convert_to(current_value, 'UTF8')
      )
  END;
$body$;

CREATE OR REPLACE FUNCTION opengeni_private.editable_artifact_frontier_dominates(
  candidate jsonb,
  required jsonb
) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $body$
BEGIN
  IF NOT opengeni_private.editable_artifact_frontier_valid(candidate)
    OR NOT opengeni_private.editable_artifact_frontier_valid(required)
  THEN
    RETURN false;
  END IF;
  RETURN NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(required) AS required_entries(entry)
    LEFT JOIN jsonb_array_elements(candidate) AS candidate_entries(candidate_entry)
      ON candidate_entry->>'replicaId' = entry->>'replicaId'
    WHERE candidate_entry IS NULL
      OR (candidate_entry->>'counter')::bigint < (entry->>'counter')::bigint
  );
END;
$body$;

CREATE OR REPLACE FUNCTION opengeni_private.editable_artifact_frontier_merge_dot_equals(
  result_frontier jsonb,
  left_frontier jsonb,
  right_frontier jsonb,
  dot_replica_id text,
  dot_counter bigint
) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE matches boolean;
BEGIN
  IF NOT opengeni_private.editable_artifact_frontier_valid(result_frontier)
    OR NOT opengeni_private.editable_artifact_frontier_valid(left_frontier)
    OR NOT opengeni_private.editable_artifact_frontier_valid(right_frontier)
    OR dot_replica_id !~ '^[0-9a-f]{16}$'
    OR dot_replica_id ~ '^0+$'
    OR dot_counter NOT BETWEEN 0 AND 9007199254740991
  THEN
    RETURN false;
  END IF;
  WITH entries AS (
    SELECT entry->>'replicaId' AS replica_id, (entry->>'counter')::bigint AS counter
    FROM jsonb_array_elements(left_frontier) AS left_entries(entry)
    UNION ALL
    SELECT entry->>'replicaId', (entry->>'counter')::bigint
    FROM jsonb_array_elements(right_frontier) AS right_entries(entry)
    UNION ALL
    SELECT dot_replica_id, dot_counter WHERE dot_counter > 0
  ), merged AS (
    SELECT replica_id, max(counter) AS counter
    FROM entries
    GROUP BY replica_id
  ), canonical AS (
    SELECT coalesce(
      jsonb_agg(
        jsonb_build_object('replicaId', replica_id, 'counter', counter)
        ORDER BY convert_to(replica_id, 'UTF8')
      ),
      '[]'::jsonb
    ) AS value
    FROM merged
  )
  SELECT result_frontier = canonical.value INTO matches FROM canonical;
  RETURN matches;
END;
$body$;

CREATE OR REPLACE FUNCTION opengeni_private.editable_artifact_object_has_exact_keys(
  value jsonb,
  expected text[]
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $body$
  SELECT jsonb_typeof(value) = 'object'
    AND (SELECT array_agg(key ORDER BY convert_to(key, 'UTF8'))
         FROM jsonb_object_keys(value) AS keys(key))
      = (SELECT array_agg(key ORDER BY convert_to(key, 'UTF8'))
         FROM unnest(expected) AS keys(key));
$body$;

-- Match JavaScript boundedIdentity for PostgreSQL-representable text: 1..256
-- UTF-16 code units, no ECMAScript trim character at either edge, and the
-- redundant 1024-byte UTF-8 safety envelope. PostgreSQL UTF-8 text already
-- excludes unpaired UTF-16 surrogates.
CREATE OR REPLACE FUNCTION opengeni_private.editable_artifact_identity_valid(value text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE code_units integer;
BEGIN
  IF value IS NULL OR value = '' OR octet_length(convert_to(value, 'UTF8')) > 1024
    OR value <> btrim(
      value,
      U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'
    )
  THEN
    RETURN false;
  END IF;
  SELECT sum(CASE WHEN ascii(character) > 65535 THEN 2 ELSE 1 END)::integer
  INTO code_units
  FROM unnest(string_to_array(value, NULL)) AS characters(character);
  RETURN code_units BETWEEN 1 AND 256;
EXCEPTION WHEN others THEN
  RETURN false;
END;
$body$;

-- PostgreSQL marks convert_to(text, name) STABLE because the target encoding is
-- an argument. This fixed-UTF8 wrapper is genuinely immutable and therefore
-- safe in stored generated digest columns.
CREATE OR REPLACE FUNCTION opengeni_private.editable_artifact_text_sha256(value text)
RETURNS bytea
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, pg_temp
AS $body$
  SELECT pg_catalog.sha256(pg_catalog.convert_to(value, 'UTF8'));
$body$;

CREATE OR REPLACE FUNCTION opengeni_private.editable_artifact_actor_key_matches(
  value text,
  actor_kind text,
  actor_subject_id text,
  agent_session_id text,
  agent_turn_id text,
  agent_attempt_id text,
  agent_generation integer,
  service_name text
) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE parsed jsonb;
BEGIN
  IF octet_length(convert_to(value, 'UTF8')) NOT BETWEEN 1 AND 8192 THEN
    RETURN false;
  END IF;
  IF NOT opengeni_private.editable_artifact_identity_valid(actor_subject_id) THEN
    RETURN false;
  END IF;
  parsed := value::jsonb;
  IF actor_kind = 'human' THEN
    RETURN parsed = jsonb_build_array('human', actor_subject_id)
      AND value = '[' || to_json('human'::text)::text || ','
        || to_json(actor_subject_id)::text || ']';
  ELSIF actor_kind = 'agent' THEN
    IF NOT opengeni_private.editable_artifact_identity_valid(agent_session_id)
      OR NOT opengeni_private.editable_artifact_identity_valid(agent_turn_id)
      OR NOT opengeni_private.editable_artifact_identity_valid(agent_attempt_id)
    THEN
      RETURN false;
    END IF;
    RETURN parsed = jsonb_build_array(
        'agent', actor_subject_id, agent_session_id, agent_turn_id,
        agent_attempt_id, agent_generation
      ) AND value = '[' || to_json('agent'::text)::text || ','
        || to_json(actor_subject_id)::text || ',' || to_json(agent_session_id)::text
        || ',' || to_json(agent_turn_id)::text || ',' || to_json(agent_attempt_id)::text
        || ',' || agent_generation::text || ']';
  ELSIF actor_kind = 'service' THEN
    IF NOT opengeni_private.editable_artifact_identity_valid(service_name) THEN
      RETURN false;
    END IF;
    RETURN parsed = jsonb_build_array('service', actor_subject_id, service_name)
      AND value = '[' || to_json('service'::text)::text || ','
        || to_json(actor_subject_id)::text || ',' || to_json(service_name)::text || ']';
  END IF;
  RETURN false;
EXCEPTION WHEN others THEN
  RETURN false;
END;
$body$;

CREATE OR REPLACE FUNCTION opengeni_private.reject_editable_artifact_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $body$
BEGIN
  RAISE EXCEPTION '% is immutable; use an explicit maintenance migration', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$body$;

CREATE TABLE "editable_artifact_scope_authorization_heads" (
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "create_revision" bigint NOT NULL DEFAULT 1,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "editable_artifact_scope_authorization_heads_pk"
    PRIMARY KEY ("account_id", "workspace_id"),
  CONSTRAINT "editable_artifact_scope_authorization_heads_workspace_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "editable_artifact_scope_authorization_heads_revision_chk" CHECK (
    "create_revision" BETWEEN 1 AND 9007199254740991
  )
);

CREATE TABLE "editable_artifacts" (
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "id" text NOT NULL,
  "modality" text NOT NULL,
  "title" text NOT NULL,
  "lifecycle_state" text NOT NULL DEFAULT 'active',
  "authorization_revision" bigint NOT NULL,
  "head_sequence" bigint NOT NULL DEFAULT 0,
  "causal_frontier" jsonb,
  "state_hash" text NOT NULL,
  "current_snapshot_id" text,
  "created_by_subject_id" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "editable_artifacts_pk" PRIMARY KEY ("account_id", "workspace_id", "id"),
  CONSTRAINT "editable_artifacts_workspace_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE RESTRICT,
  CONSTRAINT "editable_artifacts_identity_chk" CHECK (
    "id" ~ '^[0-9a-f]{32}$' AND "id" !~ '^0+$'
  ),
  CONSTRAINT "editable_artifacts_modality_chk" CHECK (
    "modality" IN ('spreadsheet', 'presentation', 'document')
  ),
  CONSTRAINT "editable_artifacts_title_chk" CHECK (
    octet_length(convert_to("title", 'UTF8')) BETWEEN 1 AND 512
    AND "title" = btrim("title")
  ),
  CONSTRAINT "editable_artifacts_lifecycle_chk" CHECK (
    "lifecycle_state" IN ('active', 'archived')
  ),
  CONSTRAINT "editable_artifacts_authorization_revision_chk" CHECK (
    "authorization_revision" BETWEEN 1 AND 9007199254740991
  ),
  CONSTRAINT "editable_artifacts_head_chk" CHECK (
    "head_sequence" BETWEEN 0 AND 9007199254740991
  ),
  CONSTRAINT "editable_artifacts_frontier_chk" CHECK (
    ("modality" = 'spreadsheet'
      AND opengeni_private.editable_artifact_frontier_valid("causal_frontier"))
    OR ("modality" IN ('document', 'presentation') AND "causal_frontier" IS NULL)
  ),
  CONSTRAINT "editable_artifacts_hash_chk" CHECK (
    "state_hash" ~ '^sha256:[0-9a-f]{64}$'
  ),
  CONSTRAINT "editable_artifacts_snapshot_id_chk" CHECK (
    "current_snapshot_id" IS NULL OR (
      "current_snapshot_id" ~ '^[0-9a-f]{32}$'
      AND "current_snapshot_id" !~ '^0+$'
    )
  ),
  CONSTRAINT "editable_artifacts_actor_chk" CHECK (
    opengeni_private.editable_artifact_identity_valid("created_by_subject_id")
  )
);

CREATE INDEX "editable_artifacts_workspace_timeline_idx"
  ON "editable_artifacts" ("workspace_id", "lifecycle_state", "updated_at" DESC, "id");

CREATE TABLE "editable_artifact_transactions" (
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "artifact_id" text NOT NULL,
  "modality" text NOT NULL,
  "id" text NOT NULL,
  "client_transaction_id" text NOT NULL,
  "previous_local_transaction_id" text,
  "request_hash" text NOT NULL,
  "intent_hash" text NOT NULL,
  "intent_envelope_version" integer NOT NULL,
  "intent_protocol_version" integer NOT NULL,
  "command_protocol_version" integer NOT NULL,
  "intent_byte_size" integer NOT NULL,
  "intent_bytes" bytea NOT NULL,
  "parent_head_sequence" bigint NOT NULL,
  "sequence_start" bigint NOT NULL,
  "sequence_end" bigint NOT NULL,
  "prior_state_hash" text NOT NULL,
  "causal_base" jsonb,
  "resolved_causal_base" jsonb,
  "resulting_causal_frontier" jsonb,
  "selective_undo_targets" jsonb,
  "state_hash" text NOT NULL,
  "operation_count" integer,
  "operation_ids" jsonb,
  "actor_kind" text NOT NULL,
  "actor_subject_id" text NOT NULL,
  "actor_key" text NOT NULL,
  "actor_key_digest" bytea GENERATED ALWAYS AS (
    opengeni_private.editable_artifact_text_sha256("actor_key")
  ) STORED,
  "replica_id" text NOT NULL,
  "replica_counter" bigint NOT NULL,
  "agent_session_id" text,
  "agent_turn_id" text,
  "agent_attempt_id" text,
  "agent_generation" integer,
  "service_name" text,
  "kernel_version" text NOT NULL,
  "model_schema_version" integer NOT NULL,
  "operation_protocol_version" integer,
  "commit_protocol_version" integer,
  "prior_native_revision" bigint,
  "native_revision" bigint,
  "command_count" integer,
  "native_receipt_byte_size" integer,
  "native_receipt_hash" text,
  "native_receipt_bytes" bytea,
  "committed_transaction_byte_size" integer NOT NULL,
  "committed_transaction_hash" text NOT NULL,
  "committed_transaction_bytes" bytea NOT NULL,
  "committed_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "editable_artifact_transactions_pk"
    PRIMARY KEY ("account_id", "workspace_id", "artifact_id", "id"),
  CONSTRAINT "editable_artifact_transactions_artifact_fk"
    FOREIGN KEY ("account_id", "workspace_id", "artifact_id")
    REFERENCES "editable_artifacts"("account_id", "workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "editable_artifact_transactions_id_chk" CHECK (
    "id" ~ '^[0-9a-f]{32}$' AND "id" !~ '^0+$'
  ),
  CONSTRAINT "editable_artifact_transactions_modality_chk" CHECK (
    "modality" IN ('spreadsheet', 'presentation', 'document')
  ),
  CONSTRAINT "editable_artifact_transactions_client_id_chk" CHECK (
    octet_length("client_transaction_id") BETWEEN 1 AND 200
    AND "client_transaction_id" ~ '^[A-Za-z0-9._:-]+$'
    AND ("previous_local_transaction_id" IS NULL OR (
      octet_length("previous_local_transaction_id") BETWEEN 1 AND 200
      AND "previous_local_transaction_id" ~ '^[A-Za-z0-9._:-]+$'
      AND "previous_local_transaction_id" <> "client_transaction_id"
    ))
  ),
  CONSTRAINT "editable_artifact_transactions_intent_chk" CHECK (
    "request_hash" ~ '^sha256:[0-9a-f]{64}$'
    AND "intent_hash" = "request_hash"
    AND "intent_hash" = 'sha256:' || encode(sha256("intent_bytes"), 'hex')
    AND "intent_envelope_version" = 1
    AND "intent_protocol_version" = 1
    AND "command_protocol_version" > 0
    AND "intent_byte_size" BETWEEN 8 AND 5242880
    AND octet_length("intent_bytes") = "intent_byte_size"
    AND substring("intent_bytes" FROM 1 FOR 8) = convert_to('OGATX001', 'UTF8')
  ),
  CONSTRAINT "editable_artifact_transactions_sequence_chk" CHECK (
    "parent_head_sequence" BETWEEN 0 AND 9007199254740991
    AND "sequence_start" = "parent_head_sequence" + 1
    AND "sequence_end" <= 9007199254740991
    AND (("modality" = 'spreadsheet'
      AND "operation_count" BETWEEN 1 AND 4096
      AND "sequence_end" = "parent_head_sequence" + "operation_count")
      OR ("modality" IN ('document', 'presentation')
        AND "operation_count" IS NULL
        AND "sequence_end" = "sequence_start"))
  ),
  CONSTRAINT "editable_artifact_transactions_frontiers_chk" CHECK (
    ("modality" = 'spreadsheet'
      AND opengeni_private.editable_artifact_frontier_valid("causal_base")
      AND opengeni_private.editable_artifact_frontier_valid("resolved_causal_base")
      AND opengeni_private.editable_artifact_frontier_valid("resulting_causal_frontier")
      AND opengeni_private.editable_artifact_id_array_valid("operation_ids")
      AND jsonb_array_length("operation_ids") = "operation_count"
      AND opengeni_private.editable_artifact_id_array_valid("selective_undo_targets"))
    OR ("modality" IN ('document', 'presentation')
      AND "causal_base" IS NULL AND "resolved_causal_base" IS NULL
      AND "resulting_causal_frontier" IS NULL AND "operation_ids" IS NULL
      AND "selective_undo_targets" IS NULL)
  ),
  CONSTRAINT "editable_artifact_transactions_result_chk" CHECK (
    "prior_state_hash" ~ '^sha256:[0-9a-f]{64}$'
    AND "state_hash" ~ '^sha256:[0-9a-f]{64}$'
    AND octet_length("kernel_version") BETWEEN 1 AND 512
    AND "model_schema_version" > 0
    AND "committed_transaction_byte_size" BETWEEN 1 AND 8388608
    AND octet_length("committed_transaction_bytes") = "committed_transaction_byte_size"
    AND "committed_transaction_hash" ~ '^sha256:[0-9a-f]{64}$'
    AND "committed_transaction_hash" =
      'sha256:' || encode(sha256("committed_transaction_bytes"), 'hex')
    AND (("modality" = 'spreadsheet'
      AND "operation_protocol_version" = 1
      AND "commit_protocol_version" IS NULL
      AND "prior_native_revision" IS NULL AND "native_revision" IS NULL
      AND "command_count" IS NULL AND "native_receipt_byte_size" IS NULL
      AND "native_receipt_hash" IS NULL AND "native_receipt_bytes" IS NULL
      AND substring("committed_transaction_bytes" FROM 1 FOR 8) = convert_to('OGACO001', 'UTF8'))
      OR ("modality" IN ('document', 'presentation')
        AND "operation_protocol_version" IS NULL
        AND "commit_protocol_version" = 1
        AND "prior_native_revision" BETWEEN 0 AND 9007199254740991
        AND (("modality" = 'document' AND (
          ("native_revision" = "prior_native_revision" AND "state_hash" = "prior_state_hash")
          OR ("native_revision" = "prior_native_revision" + 1
            AND "state_hash" <> "prior_state_hash")
        )) OR ("modality" = 'presentation'
          AND "native_revision" = "prior_native_revision" + 1
          AND "state_hash" <> "prior_state_hash"))
        AND "command_count" BETWEEN 1 AND 4096
        AND "native_receipt_byte_size" BETWEEN 1 AND 524288
        AND octet_length("native_receipt_bytes") = "native_receipt_byte_size"
        AND "native_receipt_hash" ~ '^sha256:[0-9a-f]{64}$'
        AND "native_receipt_hash" = 'sha256:' || encode(sha256("native_receipt_bytes"), 'hex')
        AND substring("committed_transaction_bytes" FROM 1 FOR 8) = convert_to('OGAST001', 'UTF8')
        AND get_byte("committed_transaction_bytes", 12) =
          CASE "modality" WHEN 'document' THEN 1 ELSE 2 END
        AND get_byte("committed_transaction_bytes", 13) = 0
        AND get_byte("committed_transaction_bytes", 14) = 0
        AND get_byte("committed_transaction_bytes", 15) = 0
        AND substring("native_receipt_bytes" FROM 1 FOR 8) = convert_to(
          CASE "modality" WHEN 'document' THEN 'OGADR001' ELSE 'OGAPR001' END,
          'UTF8'
        )))
  ),
  CONSTRAINT "editable_artifact_transactions_replica_chk" CHECK (
    "replica_id" ~ '^[0-9a-f]{16}$' AND "replica_id" !~ '^0+$'
    AND "replica_counter" BETWEEN 1 AND 9007199254740991
    AND (("replica_counter" = 1 AND "previous_local_transaction_id" IS NULL)
      OR ("replica_counter" > 1 AND "previous_local_transaction_id" IS NOT NULL))
  ),
  CONSTRAINT "editable_artifact_transactions_actor_chk" CHECK (
    opengeni_private.editable_artifact_identity_valid("actor_subject_id")
    AND (
      ("actor_kind" = 'human'
        AND "agent_session_id" IS NULL AND "agent_turn_id" IS NULL
        AND "agent_attempt_id" IS NULL AND "agent_generation" IS NULL
        AND "service_name" IS NULL)
      OR
      ("actor_kind" = 'agent'
        AND "agent_session_id" IS NOT NULL
        AND "agent_turn_id" IS NOT NULL
        AND "agent_attempt_id" IS NOT NULL
        AND "agent_generation" IS NOT NULL
        AND opengeni_private.editable_artifact_identity_valid("agent_session_id")
        AND opengeni_private.editable_artifact_identity_valid("agent_turn_id")
        AND opengeni_private.editable_artifact_identity_valid("agent_attempt_id")
        AND "agent_generation" BETWEEN 0 AND 2147483647
        AND "service_name" IS NULL)
      OR
      ("actor_kind" = 'service'
        AND "agent_session_id" IS NULL AND "agent_turn_id" IS NULL
        AND "agent_attempt_id" IS NULL AND "agent_generation" IS NULL
        AND "service_name" IS NOT NULL
        AND opengeni_private.editable_artifact_identity_valid("service_name"))
    )
    AND opengeni_private.editable_artifact_actor_key_matches(
      "actor_key", "actor_kind", "actor_subject_id", "agent_session_id",
      "agent_turn_id", "agent_attempt_id", "agent_generation", "service_name"
    ) IS TRUE
  ),
  CONSTRAINT "editable_artifact_transactions_actor_client_uq"
    UNIQUE (
      "account_id", "workspace_id", "artifact_id", "actor_key_digest",
      "client_transaction_id"
    ),
  CONSTRAINT "editable_artifact_transactions_replica_counter_uq"
    UNIQUE ("account_id", "workspace_id", "artifact_id", "replica_id", "replica_counter"),
  CONSTRAINT "editable_artifact_transactions_predecessor_identity_uq"
    UNIQUE (
      "account_id", "workspace_id", "artifact_id", "actor_key_digest", "replica_id",
      "client_transaction_id"
    ),
  CONSTRAINT "editable_artifact_transactions_exact_receipt_authority_uq"
    UNIQUE (
      "account_id", "workspace_id", "artifact_id", "id", "actor_key_digest",
      "client_transaction_id", "request_hash"
    ),
  CONSTRAINT "editable_artifact_transactions_sequence_uq"
    UNIQUE ("account_id", "workspace_id", "artifact_id", "sequence_start", "sequence_end")
);

ALTER TABLE "editable_artifact_transactions"
  ADD CONSTRAINT "editable_artifact_transactions_predecessor_fk"
  FOREIGN KEY (
    "account_id", "workspace_id", "artifact_id", "actor_key_digest", "replica_id",
    "previous_local_transaction_id"
  ) REFERENCES "editable_artifact_transactions" (
    "account_id", "workspace_id", "artifact_id", "actor_key_digest", "replica_id",
    "client_transaction_id"
  ) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX "editable_artifact_transactions_replay_idx"
  ON "editable_artifact_transactions" ("workspace_id", "artifact_id", "sequence_start");

CREATE TABLE "editable_artifact_operations" (
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "artifact_id" text NOT NULL,
  "transaction_id" text NOT NULL,
  "operation_id" text NOT NULL,
  "operation_index" integer NOT NULL,
  "sequence" bigint NOT NULL,
  "dot_replica_id" text NOT NULL,
  "dot_counter" bigint NOT NULL,
  "actor_key" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "editable_artifact_operations_pk" PRIMARY KEY (
    "account_id", "workspace_id", "artifact_id", "transaction_id",
    "operation_index"
  ),
  CONSTRAINT "editable_artifact_operations_transaction_fk"
    FOREIGN KEY ("account_id", "workspace_id", "artifact_id", "transaction_id")
    REFERENCES "editable_artifact_transactions"(
      "account_id", "workspace_id", "artifact_id", "id"
    ) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "editable_artifact_operations_ids_chk" CHECK (
    "transaction_id" ~ '^[0-9a-f]{32}$' AND "transaction_id" !~ '^0+$'
    AND "operation_id" ~ '^[0-9a-f]{32}$' AND "operation_id" !~ '^0+$'
  ),
  CONSTRAINT "editable_artifact_operations_position_chk" CHECK (
    "operation_index" BETWEEN 0 AND 4095
    AND "sequence" BETWEEN 1 AND 9007199254740991
  ),
  CONSTRAINT "editable_artifact_operations_dot_chk" CHECK (
    "dot_replica_id" ~ '^[0-9a-f]{16}$' AND "dot_replica_id" !~ '^0+$'
    AND "dot_counter" BETWEEN 1 AND 9007199254740991
    AND octet_length(convert_to("actor_key", 'UTF8')) BETWEEN 1 AND 8192
  )
);

CREATE UNIQUE INDEX "editable_artifact_operations_sequence_uq"
  ON "editable_artifact_operations"
  ("account_id", "workspace_id", "artifact_id", "sequence");
CREATE UNIQUE INDEX "editable_artifact_operations_operation_uq"
  ON "editable_artifact_operations"
  ("account_id", "workspace_id", "artifact_id", "operation_id");
CREATE UNIQUE INDEX "editable_artifact_operations_dot_operation_uq"
  ON "editable_artifact_operations"
  ("account_id", "workspace_id", "artifact_id", "dot_replica_id", "dot_counter", "operation_index");
CREATE INDEX "editable_artifact_operations_replay_idx"
  ON "editable_artifact_operations" ("workspace_id", "artifact_id", "sequence");

CREATE TABLE "editable_artifact_idempotency_receipts" (
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "id" text NOT NULL,
  "artifact_id" text NOT NULL,
  "operation_kind" text NOT NULL,
  "authority_key" text NOT NULL,
  "authority_key_digest" bytea GENERATED ALWAYS AS (
    opengeni_private.editable_artifact_text_sha256("authority_key")
  ) STORED,
  "idempotency_key" text NOT NULL,
  "request_hash" text NOT NULL,
  "resource_type" text NOT NULL,
  "resource_id" text NOT NULL,
  "server_transaction_id" text,
  "result" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "editable_artifact_idempotency_receipts_pk"
    PRIMARY KEY ("account_id", "workspace_id", "id"),
  CONSTRAINT "editable_artifact_idempotency_receipts_artifact_fk"
    FOREIGN KEY ("account_id", "workspace_id", "artifact_id")
    REFERENCES "editable_artifacts"("account_id", "workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "editable_artifact_idempotency_receipts_transaction_fk"
    FOREIGN KEY ("account_id", "workspace_id", "artifact_id", "server_transaction_id")
    REFERENCES "editable_artifact_transactions"(
      "account_id", "workspace_id", "artifact_id", "id"
    ) ON DELETE RESTRICT,
  CONSTRAINT "editable_artifact_idempotency_receipts_exact_transaction_fk"
    FOREIGN KEY (
      "account_id", "workspace_id", "artifact_id", "server_transaction_id",
      "authority_key_digest", "idempotency_key", "request_hash"
    ) REFERENCES "editable_artifact_transactions"(
      "account_id", "workspace_id", "artifact_id", "id", "actor_key_digest",
      "client_transaction_id", "request_hash"
    ) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "editable_artifact_idempotency_receipts_identity_chk" CHECK (
    "id" ~ '^[0-9a-f]{32}$' AND "id" !~ '^0+$'
    AND "artifact_id" ~ '^[0-9a-f]{32}$' AND "artifact_id" !~ '^0+$'
    AND "resource_id" ~ '^[0-9a-f]{32}$' AND "resource_id" !~ '^0+$'
    AND "request_hash" ~ '^sha256:[0-9a-f]{64}$'
  ),
  CONSTRAINT "editable_artifact_idempotency_receipts_key_chk" CHECK (
    "operation_kind" IN ('create', 'import', 'edit', 'snapshot', 'materialize')
    AND octet_length(convert_to("authority_key", 'UTF8')) BETWEEN 1 AND 8192
    AND octet_length("idempotency_key") BETWEEN 1 AND 256
    AND "idempotency_key" = btrim("idempotency_key")
  ),
  CONSTRAINT "editable_artifact_idempotency_receipts_resource_chk" CHECK (
    "resource_type" IN ('artifact', 'transaction', 'snapshot', 'materialization_job')
    AND (
      ("operation_kind" = 'create' AND "resource_type" = 'artifact'
        AND "resource_id" = "artifact_id" AND "server_transaction_id" IS NULL)
      OR ("operation_kind" = 'edit' AND "resource_type" = 'transaction'
        AND "resource_id" = "server_transaction_id")
      OR ("operation_kind" = 'snapshot' AND "resource_type" = 'snapshot'
        AND "server_transaction_id" IS NULL)
      OR ("operation_kind" = 'materialize' AND "resource_type" = 'materialization_job'
        AND "server_transaction_id" IS NULL)
      OR ("operation_kind" = 'import' AND "resource_type" = 'artifact'
        AND "resource_id" = "artifact_id" AND "server_transaction_id" IS NULL)
    )
  ),
  CONSTRAINT "editable_artifact_idempotency_receipts_result_chk" CHECK (
    jsonb_typeof("result") = 'object'
    AND octet_length("result"::text) <= 65536
  )
);

CREATE UNIQUE INDEX "editable_artifact_idempotency_receipts_creation_request_uq"
  ON "editable_artifact_idempotency_receipts"
  (
    "account_id", "workspace_id", "operation_kind", "authority_key_digest",
    "idempotency_key"
  )
  WHERE "operation_kind" IN ('create', 'import');
CREATE UNIQUE INDEX "editable_artifact_idempotency_receipts_artifact_request_uq"
  ON "editable_artifact_idempotency_receipts"
  (
    "account_id", "workspace_id", "artifact_id", "operation_kind",
    "authority_key_digest", "idempotency_key"
  )
  WHERE "operation_kind" IN ('edit', 'snapshot', 'materialize');
CREATE UNIQUE INDEX "editable_artifact_idempotency_receipts_origin_uq"
  ON "editable_artifact_idempotency_receipts"
  ("account_id", "workspace_id", "artifact_id")
  WHERE "operation_kind" IN ('create', 'import') AND "resource_type" = 'artifact';

CREATE INDEX "editable_artifact_idempotency_receipts_transaction_idx"
  ON "editable_artifact_idempotency_receipts"
  ("workspace_id", "artifact_id", "server_transaction_id");

CREATE TABLE "editable_artifact_undo_claims" (
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "artifact_id" text NOT NULL,
  "target_operation_id" text NOT NULL,
  "claiming_transaction_id" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "editable_artifact_undo_claims_pk" PRIMARY KEY (
    "account_id", "workspace_id", "artifact_id", "target_operation_id"
  ),
  CONSTRAINT "editable_artifact_undo_claims_transaction_fk"
    FOREIGN KEY ("account_id", "workspace_id", "artifact_id", "claiming_transaction_id")
    REFERENCES "editable_artifact_transactions"(
      "account_id", "workspace_id", "artifact_id", "id"
    ) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "editable_artifact_undo_claims_ids_chk" CHECK (
    "target_operation_id" ~ '^[0-9a-f]{32}$' AND "target_operation_id" !~ '^0+$'
    AND "claiming_transaction_id" ~ '^[0-9a-f]{32}$'
    AND "claiming_transaction_id" !~ '^0+$'
  )
);

CREATE INDEX "editable_artifact_undo_claims_transaction_idx"
  ON "editable_artifact_undo_claims"
  (
    "account_id", "workspace_id", "artifact_id", "claiming_transaction_id",
    "target_operation_id"
  );

CREATE TABLE "editable_artifact_sequence_checkpoints" (
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "artifact_id" text NOT NULL,
  "modality" text NOT NULL,
  "head_sequence" bigint NOT NULL,
  "transaction_id" text,
  "causal_frontier" jsonb,
  "native_revision" bigint,
  "state_hash" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "editable_artifact_sequence_checkpoints_pk" PRIMARY KEY (
    "account_id", "workspace_id", "artifact_id", "head_sequence"
  ),
  CONSTRAINT "editable_artifact_sequence_checkpoints_artifact_fk"
    FOREIGN KEY ("account_id", "workspace_id", "artifact_id")
    REFERENCES "editable_artifacts"("account_id", "workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "editable_artifact_sequence_checkpoints_transaction_fk"
    FOREIGN KEY ("account_id", "workspace_id", "artifact_id", "transaction_id")
    REFERENCES "editable_artifact_transactions"(
      "account_id", "workspace_id", "artifact_id", "id"
    ) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "editable_artifact_sequence_checkpoints_shape_chk" CHECK (
    "head_sequence" BETWEEN 0 AND 9007199254740991
    AND (("head_sequence" = 0 AND "transaction_id" IS NULL)
      OR ("head_sequence" > 0 AND "transaction_id" IS NOT NULL))
    AND (("modality" = 'spreadsheet'
      AND opengeni_private.editable_artifact_frontier_valid("causal_frontier")
      AND "native_revision" IS NULL)
      OR ("modality" IN ('document', 'presentation')
        AND "causal_frontier" IS NULL
        AND "native_revision" BETWEEN 0 AND 9007199254740991))
    AND "state_hash" ~ '^sha256:[0-9a-f]{64}$'
  )
);

CREATE UNIQUE INDEX "editable_artifact_sequence_checkpoints_transaction_uq"
  ON "editable_artifact_sequence_checkpoints"
  ("account_id", "workspace_id", "artifact_id", "transaction_id")
  WHERE "transaction_id" IS NOT NULL;

ALTER TABLE "editable_artifact_transactions"
  ADD CONSTRAINT "editable_artifact_transactions_parent_checkpoint_fk"
  FOREIGN KEY ("account_id", "workspace_id", "artifact_id", "parent_head_sequence")
  REFERENCES "editable_artifact_sequence_checkpoints"(
    "account_id", "workspace_id", "artifact_id", "head_sequence"
  ) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE "editable_artifact_blob_refs" (
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "artifact_id" text NOT NULL,
  "id" text NOT NULL,
  "kind" text NOT NULL,
  "object_reference" text NOT NULL,
  "byte_size" bigint NOT NULL,
  "content_hash" text NOT NULL,
  "mime_type" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "editable_artifact_blob_refs_pk" PRIMARY KEY (
    "account_id", "workspace_id", "artifact_id", "id"
  ),
  CONSTRAINT "editable_artifact_blob_refs_artifact_fk"
    FOREIGN KEY ("account_id", "workspace_id", "artifact_id")
    REFERENCES "editable_artifacts"("account_id", "workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "editable_artifact_blob_refs_identity_chk" CHECK (
    "id" ~ '^[0-9a-f]{32}$' AND "id" !~ '^0+$'
    AND "kind" IN (
      'snapshot', 'original_import', 'media', 'loss_envelope', 'materialization'
    )
  ),
  CONSTRAINT "editable_artifact_blob_refs_facts_chk" CHECK (
    octet_length("object_reference") BETWEEN 1 AND 1024
    AND "object_reference" = btrim("object_reference")
    AND "byte_size" BETWEEN 1 AND 9007199254740991
    AND "content_hash" ~ '^sha256:[0-9a-f]{64}$'
    AND octet_length("mime_type") BETWEEN 1 AND 256
    AND "mime_type" = btrim("mime_type")
  ),
  CONSTRAINT "editable_artifact_blob_refs_content_uq" UNIQUE (
    "account_id", "workspace_id", "artifact_id", "kind", "content_hash"
  ),
  CONSTRAINT "editable_artifact_blob_refs_exact_facts_uq" UNIQUE (
    "account_id", "workspace_id", "artifact_id", "id", "byte_size",
    "content_hash", "mime_type"
  )
);

CREATE TABLE "editable_artifact_snapshots" (
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "artifact_id" text NOT NULL,
  "modality" text NOT NULL,
  "id" text NOT NULL,
  "blob_ref_id" text NOT NULL,
  "byte_size" bigint NOT NULL,
  "content_hash" text NOT NULL,
  "mime_type" text NOT NULL DEFAULT 'application/vnd.opengeni.editable-artifact-snapshot',
  "covered_head_sequence" bigint NOT NULL,
  "covered_causal_frontier" jsonb,
  "state_hash" text NOT NULL,
  "model_schema_version" integer NOT NULL,
  "operation_protocol_version" integer,
  "kernel_version" text NOT NULL,
  "crdt_state_version" integer,
  "native_revision" bigint,
  "verified_at" timestamptz NOT NULL,
  "published_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "editable_artifact_snapshots_pk" PRIMARY KEY (
    "account_id", "workspace_id", "artifact_id", "id"
  ),
  CONSTRAINT "editable_artifact_snapshots_artifact_fk"
    FOREIGN KEY ("account_id", "workspace_id", "artifact_id")
    REFERENCES "editable_artifacts"("account_id", "workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "editable_artifact_snapshots_blob_fk"
    FOREIGN KEY ("account_id", "workspace_id", "artifact_id", "blob_ref_id")
    REFERENCES "editable_artifact_blob_refs"(
      "account_id", "workspace_id", "artifact_id", "id"
    ) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "editable_artifact_snapshots_blob_facts_fk"
    FOREIGN KEY (
      "account_id", "workspace_id", "artifact_id", "blob_ref_id", "byte_size",
      "content_hash", "mime_type"
    ) REFERENCES "editable_artifact_blob_refs"(
      "account_id", "workspace_id", "artifact_id", "id", "byte_size",
      "content_hash", "mime_type"
    ) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "editable_artifact_snapshots_checkpoint_fk"
    FOREIGN KEY ("account_id", "workspace_id", "artifact_id", "covered_head_sequence")
    REFERENCES "editable_artifact_sequence_checkpoints"(
      "account_id", "workspace_id", "artifact_id", "head_sequence"
    ) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "editable_artifact_snapshots_identity_chk" CHECK (
    "id" ~ '^[0-9a-f]{32}$' AND "id" !~ '^0+$'
    AND "blob_ref_id" ~ '^[0-9a-f]{32}$' AND "blob_ref_id" !~ '^0+$'
  ),
  CONSTRAINT "editable_artifact_snapshots_facts_chk" CHECK (
    "byte_size" BETWEEN 1 AND 67108864
    AND "content_hash" ~ '^sha256:[0-9a-f]{64}$'
    AND "mime_type" = 'application/vnd.opengeni.editable-artifact-snapshot'
    AND "covered_head_sequence" BETWEEN 0 AND 9007199254740991
    AND "state_hash" ~ '^sha256:[0-9a-f]{64}$'
    AND "model_schema_version" > 0
    AND (("modality" = 'spreadsheet'
      AND opengeni_private.editable_artifact_frontier_valid("covered_causal_frontier")
      AND "operation_protocol_version" > 0
      AND "crdt_state_version" > 0
      AND "native_revision" IS NULL)
      OR ("modality" IN ('document', 'presentation')
        AND "covered_causal_frontier" IS NULL
        AND "operation_protocol_version" IS NULL
        AND "crdt_state_version" IS NULL
        AND "native_revision" BETWEEN 0 AND 9007199254740991))
    AND octet_length("kernel_version") BETWEEN 1 AND 512
    AND "verified_at" <= "published_at"
  ),
  CONSTRAINT "editable_artifact_snapshots_content_uq" UNIQUE (
    "account_id", "workspace_id", "artifact_id", "content_hash", "covered_head_sequence"
  ),
  CONSTRAINT "editable_artifact_snapshots_source_manifest_uq" UNIQUE (
    "account_id", "workspace_id", "artifact_id", "id", "covered_head_sequence", "state_hash"
  )
);

CREATE INDEX "editable_artifact_snapshots_coverage_idx"
  ON "editable_artifact_snapshots"
  ("workspace_id", "artifact_id", "covered_head_sequence" DESC);

ALTER TABLE "editable_artifacts"
  ADD CONSTRAINT "editable_artifacts_current_snapshot_fk"
  FOREIGN KEY ("account_id", "workspace_id", "id", "current_snapshot_id")
  REFERENCES "editable_artifact_snapshots"(
    "account_id", "workspace_id", "artifact_id", "id"
  ) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE "editable_artifact_versions" (
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "artifact_id" text NOT NULL,
  "id" text NOT NULL,
  "snapshot_id" text,
  "head_sequence" bigint NOT NULL,
  "causal_frontier" jsonb NOT NULL,
  "state_hash" text NOT NULL,
  "name" text NOT NULL,
  "pinned" boolean NOT NULL DEFAULT true,
  "created_by_subject_id" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "editable_artifact_versions_pk" PRIMARY KEY (
    "account_id", "workspace_id", "artifact_id", "id"
  ),
  CONSTRAINT "editable_artifact_versions_artifact_fk"
    FOREIGN KEY ("account_id", "workspace_id", "artifact_id")
    REFERENCES "editable_artifacts"("account_id", "workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "editable_artifact_versions_snapshot_fk"
    FOREIGN KEY ("account_id", "workspace_id", "artifact_id", "snapshot_id")
    REFERENCES "editable_artifact_snapshots"(
      "account_id", "workspace_id", "artifact_id", "id"
    ) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "editable_artifact_versions_checkpoint_fk"
    FOREIGN KEY ("account_id", "workspace_id", "artifact_id", "head_sequence")
    REFERENCES "editable_artifact_sequence_checkpoints"(
      "account_id", "workspace_id", "artifact_id", "head_sequence"
    ) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "editable_artifact_versions_identity_chk" CHECK (
    "id" ~ '^[0-9a-f]{32}$' AND "id" !~ '^0+$'
    AND ("snapshot_id" IS NULL OR (
      "snapshot_id" ~ '^[0-9a-f]{32}$' AND "snapshot_id" !~ '^0+$'
    ))
  ),
  CONSTRAINT "editable_artifact_versions_facts_chk" CHECK (
    "head_sequence" BETWEEN 0 AND 9007199254740991
    AND opengeni_private.editable_artifact_frontier_valid("causal_frontier")
    AND "state_hash" ~ '^sha256:[0-9a-f]{64}$'
    AND octet_length(convert_to("name", 'UTF8')) BETWEEN 1 AND 256
    AND "name" = btrim("name")
    AND opengeni_private.editable_artifact_identity_valid("created_by_subject_id")
  )
);

CREATE INDEX "editable_artifact_versions_timeline_idx"
  ON "editable_artifact_versions" ("workspace_id", "artifact_id", "created_at" DESC, "id");

CREATE TABLE "editable_artifact_materialization_jobs" (
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "artifact_id" text NOT NULL,
  "id" text NOT NULL,
  "version_id" text,
  "input_snapshot_id" text NOT NULL,
  "target_head_sequence" bigint NOT NULL,
  "state_hash" text NOT NULL,
  "format" text NOT NULL,
  "normalized_options" text NOT NULL,
  "options_hash" text GENERATED ALWAYS AS (
    'sha256:' || encode(
      opengeni_private.editable_artifact_text_sha256("normalized_options"), 'hex'
    )
  ) STORED,
  "codec_id" text NOT NULL,
  "codec_version" text NOT NULL,
  "kernel_version" text NOT NULL,
  "font_registry_hash" text NOT NULL,
  "policy_hash" text NOT NULL,
  "state" text NOT NULL DEFAULT 'pending',
  "attempt_count" integer NOT NULL DEFAULT 0,
  "lease_owner" text,
  "lease_expires_at" timestamptz,
  "settled_by_owner" text,
  "error_code" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "started_at" timestamptz,
  "completed_at" timestamptz,
  CONSTRAINT "editable_artifact_materialization_jobs_pk" PRIMARY KEY (
    "account_id", "workspace_id", "artifact_id", "id"
  ),
  CONSTRAINT "editable_artifact_materialization_jobs_artifact_fk"
    FOREIGN KEY ("account_id", "workspace_id", "artifact_id")
    REFERENCES "editable_artifacts"("account_id", "workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "editable_artifact_materialization_jobs_version_fk"
    FOREIGN KEY ("account_id", "workspace_id", "artifact_id", "version_id")
    REFERENCES "editable_artifact_versions"(
      "account_id", "workspace_id", "artifact_id", "id"
    ) ON DELETE RESTRICT,
  CONSTRAINT "editable_artifact_materialization_jobs_checkpoint_fk"
    FOREIGN KEY ("account_id", "workspace_id", "artifact_id", "target_head_sequence")
    REFERENCES "editable_artifact_sequence_checkpoints"(
      "account_id", "workspace_id", "artifact_id", "head_sequence"
    ) ON DELETE RESTRICT,
  CONSTRAINT "editable_artifact_materialization_jobs_source_snapshot_fk"
    FOREIGN KEY (
      "account_id", "workspace_id", "artifact_id", "input_snapshot_id",
      "target_head_sequence", "state_hash"
    ) REFERENCES "editable_artifact_snapshots"(
      "account_id", "workspace_id", "artifact_id", "id",
      "covered_head_sequence", "state_hash"
    ) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "editable_artifact_materialization_jobs_identity_chk" CHECK (
    "id" ~ '^[0-9a-f]{32}$' AND "id" !~ '^0+$'
    AND "input_snapshot_id" ~ '^[0-9a-f]{32}$' AND "input_snapshot_id" !~ '^0+$'
    AND ("version_id" IS NULL OR (
      "version_id" ~ '^[0-9a-f]{32}$' AND "version_id" !~ '^0+$'
    ))
  ),
  CONSTRAINT "editable_artifact_materialization_jobs_cache_facts_chk" CHECK (
    "target_head_sequence" BETWEEN 0 AND 9007199254740991
    AND "state_hash" ~ '^sha256:[0-9a-f]{64}$'
    AND "format" IN ('xlsx', 'pptx', 'docx', 'pdf', 'png', 'webp')
    AND "options_hash" ~ '^sha256:[0-9a-f]{64}$'
    AND "font_registry_hash" ~ '^sha256:[0-9a-f]{64}$'
    AND "policy_hash" ~ '^sha256:[0-9a-f]{64}$'
    AND octet_length(convert_to("normalized_options", 'UTF8')) BETWEEN 2 AND 262144
    AND "normalized_options" = btrim("normalized_options")
    AND jsonb_typeof("normalized_options"::jsonb) = 'object'
    AND octet_length(convert_to("codec_id", 'UTF8')) BETWEEN 1 AND 128
    AND "codec_id" = btrim("codec_id")
    AND octet_length("codec_version") BETWEEN 1 AND 128
    AND "codec_version" = btrim("codec_version")
    AND octet_length("kernel_version") BETWEEN 1 AND 512
    AND "kernel_version" = btrim("kernel_version")
  ),
  CONSTRAINT "editable_artifact_materialization_jobs_state_chk" CHECK (
    "state" IN ('pending', 'running', 'succeeded', 'failed')
    AND "attempt_count" BETWEEN 0 AND 1000
    AND ("lease_owner" IS NULL) = ("lease_expires_at" IS NULL)
    AND ("lease_owner" IS NULL OR octet_length("lease_owner") BETWEEN 1 AND 256)
    AND ("settled_by_owner" IS NULL
      OR octet_length("settled_by_owner") BETWEEN 1 AND 256)
    AND ("error_code" IS NULL OR octet_length("error_code") BETWEEN 1 AND 256)
    AND (("state" = 'pending' AND "attempt_count" = 0
        AND "lease_owner" IS NULL AND "settled_by_owner" IS NULL
        AND "started_at" IS NULL AND "completed_at" IS NULL)
      OR ("state" = 'running' AND "attempt_count" > 0
        AND "lease_owner" IS NOT NULL AND "started_at" IS NOT NULL
        AND "lease_expires_at" > "started_at" AND "settled_by_owner" IS NULL
        AND "completed_at" IS NULL)
      OR ("state" IN ('succeeded', 'failed')
        AND "attempt_count" > 0 AND "started_at" IS NOT NULL
        AND "completed_at" IS NOT NULL AND "completed_at" >= "started_at"
        AND "settled_by_owner" IS NOT NULL
        AND "lease_owner" IS NULL AND "lease_expires_at" IS NULL))
    AND (("state" = 'failed' AND "error_code" IS NOT NULL)
      OR ("state" <> 'failed' AND "error_code" IS NULL))
  ),
  CONSTRAINT "editable_artifact_materialization_jobs_cache_uq" UNIQUE (
    "account_id", "workspace_id", "artifact_id", "input_snapshot_id", "state_hash", "format",
    "options_hash", "codec_id", "codec_version", "kernel_version",
    "font_registry_hash", "policy_hash"
  )
);

CREATE INDEX "editable_artifact_materialization_jobs_claim_idx"
  ON "editable_artifact_materialization_jobs" (
    (coalesce("lease_expires_at", "created_at")), "created_at",
    "account_id", "workspace_id", "artifact_id", "id"
  )
  WHERE "state" IN ('pending', 'running');

CREATE TABLE "editable_artifact_materialization_results" (
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "artifact_id" text NOT NULL,
  "id" text NOT NULL,
  "job_id" text NOT NULL,
  "blob_ref_id" text NOT NULL,
  "byte_size" bigint NOT NULL,
  "content_hash" text NOT NULL,
  "mime_type" text NOT NULL,
  "verified_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "editable_artifact_materialization_results_pk" PRIMARY KEY (
    "account_id", "workspace_id", "artifact_id", "id"
  ),
  CONSTRAINT "editable_artifact_materialization_results_job_fk"
    FOREIGN KEY ("account_id", "workspace_id", "artifact_id", "job_id")
    REFERENCES "editable_artifact_materialization_jobs"(
      "account_id", "workspace_id", "artifact_id", "id"
    ) ON DELETE RESTRICT,
  CONSTRAINT "editable_artifact_materialization_results_blob_fk"
    FOREIGN KEY ("account_id", "workspace_id", "artifact_id", "blob_ref_id")
    REFERENCES "editable_artifact_blob_refs"(
      "account_id", "workspace_id", "artifact_id", "id"
    ) ON DELETE RESTRICT,
  CONSTRAINT "editable_artifact_materialization_results_blob_facts_fk"
    FOREIGN KEY (
      "account_id", "workspace_id", "artifact_id", "blob_ref_id", "byte_size",
      "content_hash", "mime_type"
    ) REFERENCES "editable_artifact_blob_refs"(
      "account_id", "workspace_id", "artifact_id", "id", "byte_size",
      "content_hash", "mime_type"
    ) ON DELETE RESTRICT,
  CONSTRAINT "editable_artifact_materialization_results_identity_chk" CHECK (
    "id" ~ '^[0-9a-f]{32}$' AND "id" !~ '^0+$'
    AND "job_id" ~ '^[0-9a-f]{32}$' AND "job_id" !~ '^0+$'
    AND "blob_ref_id" ~ '^[0-9a-f]{32}$' AND "blob_ref_id" !~ '^0+$'
  ),
  CONSTRAINT "editable_artifact_materialization_results_facts_chk" CHECK (
    "byte_size" BETWEEN 1 AND 9007199254740991
    AND "content_hash" ~ '^sha256:[0-9a-f]{64}$'
    AND octet_length("mime_type") BETWEEN 1 AND 256
    AND "mime_type" = btrim("mime_type")
    AND "verified_at" <= "created_at"
  ),
  CONSTRAINT "editable_artifact_materialization_results_job_uq" UNIQUE (
    "account_id", "workspace_id", "artifact_id", "job_id"
  )
);

CREATE TABLE "editable_artifact_live_outbox" (
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "artifact_id" text NOT NULL,
  "id" text NOT NULL,
  "transaction_id" text,
  "snapshot_id" text,
  "event_kind" text NOT NULL,
  "event" jsonb NOT NULL,
  "state" text NOT NULL DEFAULT 'pending',
  "attempt_count" integer NOT NULL DEFAULT 0,
  "lease_owner" text,
  "lease_expires_at" timestamptz,
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "last_error_code" text,
  "published_at" timestamptz,
  "dead_lettered_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "editable_artifact_live_outbox_pk" PRIMARY KEY (
    "account_id", "workspace_id", "artifact_id", "id"
  ),
  CONSTRAINT "editable_artifact_live_outbox_artifact_fk"
    FOREIGN KEY ("account_id", "workspace_id", "artifact_id")
    REFERENCES "editable_artifacts"("account_id", "workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "editable_artifact_live_outbox_transaction_fk"
    FOREIGN KEY ("account_id", "workspace_id", "artifact_id", "transaction_id")
    REFERENCES "editable_artifact_transactions"(
      "account_id", "workspace_id", "artifact_id", "id"
    ) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "editable_artifact_live_outbox_snapshot_fk"
    FOREIGN KEY ("account_id", "workspace_id", "artifact_id", "snapshot_id")
    REFERENCES "editable_artifact_snapshots"(
      "account_id", "workspace_id", "artifact_id", "id"
    ) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "editable_artifact_live_outbox_identity_chk" CHECK (
    "id" ~ '^[0-9a-f]{32}$' AND "id" !~ '^0+$'
  ),
  CONSTRAINT "editable_artifact_live_outbox_event_chk" CHECK (
    "event_kind" IN ('transaction_committed', 'snapshot_published')
    AND jsonb_typeof("event") = 'object'
    AND octet_length("event"::text) <= 65536
    AND jsonb_typeof("event"->'kind') = 'string'
    AND jsonb_typeof("event"->'schemaVersion') = 'number'
    AND "event"->>'kind' = "event_kind"
    AND "event"->>'schemaVersion' = '1'
    AND opengeni_private.editable_artifact_object_has_exact_keys(
      "event"->'scope', ARRAY['accountId', 'workspaceId']
    )
    AND "event"#>>'{scope,accountId}' = "account_id"::text
    AND "event"#>>'{scope,workspaceId}' = "workspace_id"::text
    AND jsonb_typeof("event"->'artifactId') = 'string'
    AND "event"->>'artifactId' = "artifact_id"
    AND jsonb_typeof("event"->'modality') = 'string'
    AND "event"->>'modality' IN ('spreadsheet', 'document', 'presentation')
    AND (("event_kind" = 'transaction_committed'
      AND "transaction_id" IS NOT NULL AND "snapshot_id" IS NULL
      AND (("event"->>'modality' = 'spreadsheet'
        AND opengeni_private.editable_artifact_object_has_exact_keys(
          "event", ARRAY[
            'artifactId', 'committedAt', 'kind', 'modality', 'operationProtocolVersion',
            'schemaVersion', 'scope', 'sequenceEnd',
            'sequenceStart', 'serverTransactionId', 'stateHash'
          ]
        )
        AND jsonb_typeof("event"->'operationProtocolVersion') = 'number'
        AND ("event"->>'operationProtocolVersion') ~ '^[1-9][0-9]{0,9}$')
        OR ("event"->>'modality' IN ('document', 'presentation')
          AND opengeni_private.editable_artifact_object_has_exact_keys(
            "event", ARRAY[
              'artifactId', 'commitProtocolVersion', 'committedAt', 'kind', 'modality',
              'schemaVersion', 'scope', 'sequenceEnd',
              'sequenceStart', 'serverTransactionId', 'stateHash'
            ]
          )
          AND jsonb_typeof("event"->'commitProtocolVersion') = 'number'
          AND ("event"->>'commitProtocolVersion') ~ '^[1-9][0-9]{0,9}$'))
      AND jsonb_typeof("event"->'serverTransactionId') = 'string'
      AND "event"->>'serverTransactionId' = "transaction_id")
      OR ("event_kind" = 'snapshot_published'
        AND "transaction_id" IS NULL AND "snapshot_id" IS NOT NULL
        AND (("event"->>'modality' = 'spreadsheet'
          AND opengeni_private.editable_artifact_object_has_exact_keys(
            "event", ARRAY[
              'artifactId', 'coveredHeadSequence', 'kind', 'modality',
              'operationProtocolVersion', 'publishedAt', 'schemaVersion',
              'scope', 'snapshotId', 'stateHash'
            ]
          )
          AND jsonb_typeof("event"->'operationProtocolVersion') = 'number'
          AND ("event"->>'operationProtocolVersion') ~ '^[1-9][0-9]{0,9}$')
          OR ("event"->>'modality' IN ('document', 'presentation')
            AND opengeni_private.editable_artifact_object_has_exact_keys(
              "event", ARRAY[
                'artifactId', 'coveredHeadSequence', 'kind', 'modality',
                'publishedAt', 'schemaVersion', 'scope', 'snapshotId', 'stateHash'
              ]
            )))
        AND jsonb_typeof("event"->'snapshotId') = 'string'
        AND "event"->>'snapshotId' = "snapshot_id"))
    AND jsonb_typeof("event"->'stateHash') = 'string'
    AND "event"->>'stateHash' ~ '^sha256:[0-9a-f]{64}$'
    AND (("event_kind" = 'transaction_committed'
      AND jsonb_typeof("event"->'sequenceStart') = 'number'
      AND jsonb_typeof("event"->'sequenceEnd') = 'number'
      AND ("event"->>'sequenceStart') ~ '^[1-9][0-9]{0,15}$'
      AND ("event"->>'sequenceEnd') ~ '^[1-9][0-9]{0,15}$'
      AND jsonb_typeof("event"->'committedAt') = 'string'
      AND "event"->>'committedAt'
        ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$')
      OR ("event_kind" = 'snapshot_published'
        AND jsonb_typeof("event"->'coveredHeadSequence') = 'number'
        AND ("event"->>'coveredHeadSequence') ~ '^(0|[1-9][0-9]{0,15})$'
        AND jsonb_typeof("event"->'publishedAt') = 'string'
        AND "event"->>'publishedAt'
          ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'))
  ),
  CONSTRAINT "editable_artifact_live_outbox_state_chk" CHECK (
    "state" IN ('pending', 'publishing', 'published', 'dead_lettered')
    AND "attempt_count" BETWEEN 0 AND 1000000
    AND ("lease_owner" IS NULL) = ("lease_expires_at" IS NULL)
    AND ("lease_owner" IS NULL OR octet_length("lease_owner") BETWEEN 1 AND 256)
    AND ("last_error_code" IS NULL OR octet_length("last_error_code") BETWEEN 1 AND 256)
    AND (("state" = 'pending' AND "lease_owner" IS NULL
          AND "published_at" IS NULL AND "dead_lettered_at" IS NULL)
      OR ("state" = 'publishing' AND "lease_owner" IS NOT NULL
          AND "published_at" IS NULL AND "dead_lettered_at" IS NULL)
      OR ("state" = 'published' AND "lease_owner" IS NULL
          AND "published_at" IS NOT NULL AND "dead_lettered_at" IS NULL
          AND "last_error_code" IS NULL)
      OR ("state" = 'dead_lettered' AND "lease_owner" IS NULL
          AND "published_at" IS NULL AND "dead_lettered_at" IS NOT NULL
          AND "last_error_code" IN ('invalid_hint', 'oversized_hint', 'attempts_exhausted')))
  )
);

CREATE UNIQUE INDEX "editable_artifact_live_outbox_id_uq"
  ON "editable_artifact_live_outbox" ("id");
CREATE UNIQUE INDEX "editable_artifact_live_outbox_transaction_uq"
  ON "editable_artifact_live_outbox"
  ("account_id", "workspace_id", "artifact_id", "transaction_id")
  WHERE "event_kind" = 'transaction_committed';
CREATE UNIQUE INDEX "editable_artifact_live_outbox_snapshot_uq"
  ON "editable_artifact_live_outbox"
  ("account_id", "workspace_id", "artifact_id", "snapshot_id")
  WHERE "event_kind" = 'snapshot_published';

CREATE INDEX "editable_artifact_live_outbox_pending_claim_idx"
  ON "editable_artifact_live_outbox" ("next_attempt_at", "created_at", "id")
  WHERE "state" = 'pending';
CREATE INDEX "editable_artifact_live_outbox_publishing_claim_idx"
  ON "editable_artifact_live_outbox" ("lease_expires_at", "created_at", "id")
  WHERE "state" = 'publishing';

CREATE TABLE "editable_artifact_replica_leases" (
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "artifact_id" text NOT NULL,
  "modality" text NOT NULL,
  "replica_id" text NOT NULL,
  "actor_key" text NOT NULL,
  "applied_head_sequence" bigint NOT NULL,
  "causal_frontier" jsonb,
  "native_revision" bigint,
  "lease_expires_at" timestamptz NOT NULL,
  "last_seen_at" timestamptz NOT NULL DEFAULT now(),
  "revoked_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "editable_artifact_replica_leases_pk" PRIMARY KEY (
    "account_id", "workspace_id", "artifact_id", "replica_id"
  ),
  CONSTRAINT "editable_artifact_replica_leases_artifact_fk"
    FOREIGN KEY ("account_id", "workspace_id", "artifact_id")
    REFERENCES "editable_artifacts"("account_id", "workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "editable_artifact_replica_leases_checkpoint_fk"
    FOREIGN KEY ("account_id", "workspace_id", "artifact_id", "applied_head_sequence")
    REFERENCES "editable_artifact_sequence_checkpoints"(
      "account_id", "workspace_id", "artifact_id", "head_sequence"
    ) ON DELETE RESTRICT,
  CONSTRAINT "editable_artifact_replica_leases_replica_chk" CHECK (
    "replica_id" ~ '^[0-9a-f]{16}$' AND "replica_id" !~ '^0+$'
    AND octet_length(convert_to("actor_key", 'UTF8')) BETWEEN 1 AND 8192
    AND (("modality" = 'spreadsheet'
      AND opengeni_private.editable_artifact_frontier_valid("causal_frontier")
      AND "native_revision" IS NULL)
      OR ("modality" IN ('document', 'presentation')
        AND "causal_frontier" IS NULL
        AND "native_revision" BETWEEN 0 AND 9007199254740991))
  ),
  CONSTRAINT "editable_artifact_replica_leases_cursor_chk" CHECK (
    "applied_head_sequence" BETWEEN 0 AND 9007199254740991
    AND "last_seen_at" >= "created_at"
    AND "lease_expires_at" > "last_seen_at"
    AND ("revoked_at" IS NULL OR "revoked_at" >= "created_at")
  )
);

CREATE INDEX "editable_artifact_replica_leases_expiry_idx"
  ON "editable_artifact_replica_leases" ("lease_expires_at", "replica_id")
  WHERE "revoked_at" IS NULL;

CREATE OR REPLACE FUNCTION opengeni_private.validate_editable_artifact_transaction_commit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE tx record;
DECLARE parent_checkpoint record;
DECLARE predecessor record;
DECLARE predecessor_resolved_causal_base jsonb := '[]'::jsonb;
DECLARE parent_replica_counter bigint;
DECLARE resolved_replica_counter bigint;
DECLARE result_replica_counter bigint;
DECLARE operation_rows integer;
DECLARE undo_rows integer;
DECLARE artifact_modality text;
BEGIN
  PERFORM set_config(
    'search_path', 'pg_catalog,' || quote_ident(TG_TABLE_SCHEMA) || ',pg_temp', true
  );
  SELECT * INTO tx FROM editable_artifact_transactions candidate
  WHERE candidate.account_id = NEW.account_id
    AND candidate.workspace_id = NEW.workspace_id
    AND candidate.artifact_id = NEW.artifact_id
    AND candidate.id = NEW.id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'editable artifact transaction dependency is missing'
      USING ERRCODE = '23503';
  END IF;

  SELECT artifact.modality INTO artifact_modality
  FROM editable_artifacts artifact
  WHERE artifact.account_id = tx.account_id
    AND artifact.workspace_id = tx.workspace_id
    AND artifact.id = tx.artifact_id;
  IF artifact_modality IS NULL OR artifact_modality <> tx.modality THEN
    RAISE EXCEPTION 'transaction modality differs from its durable artifact'
      USING ERRCODE = '23514';
  END IF;

  IF tx.replica_counter > 1 THEN
    SELECT * INTO predecessor
    FROM editable_artifact_transactions candidate
    WHERE candidate.account_id = tx.account_id
      AND candidate.workspace_id = tx.workspace_id
      AND candidate.artifact_id = tx.artifact_id
      AND candidate.actor_key = tx.actor_key
      AND candidate.replica_id = tx.replica_id
      AND candidate.client_transaction_id = tx.previous_local_transaction_id;
    IF NOT FOUND
      OR predecessor.replica_counter <> tx.replica_counter - 1
      OR predecessor.sequence_end > tx.parent_head_sequence
    THEN
      RAISE EXCEPTION 'transaction predecessor is not the prior committed local replica counter'
        USING ERRCODE = '23514';
    END IF;
    predecessor_resolved_causal_base := predecessor.resolved_causal_base;
  END IF;

  SELECT * INTO parent_checkpoint
  FROM editable_artifact_sequence_checkpoints checkpoint
  WHERE checkpoint.account_id = tx.account_id
    AND checkpoint.workspace_id = tx.workspace_id
    AND checkpoint.artifact_id = tx.artifact_id
    AND checkpoint.head_sequence = tx.parent_head_sequence;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transaction parent checkpoint is missing'
      USING ERRCODE = '23514';
  END IF;

  IF parent_checkpoint.modality <> tx.modality
    OR parent_checkpoint.state_hash <> tx.prior_state_hash
  THEN
    RAISE EXCEPTION 'transaction parent checkpoint modality or state differs'
      USING ERRCODE = '23514';
  END IF;

  IF tx.modality = 'spreadsheet' THEN
    SELECT (entry->>'counter')::bigint INTO resolved_replica_counter
    FROM jsonb_array_elements(tx.resolved_causal_base) AS entries(entry)
    WHERE entry->>'replicaId' = tx.replica_id;
    SELECT (entry->>'counter')::bigint INTO result_replica_counter
    FROM jsonb_array_elements(tx.resulting_causal_frontier) AS entries(entry)
    WHERE entry->>'replicaId' = tx.replica_id;
    SELECT (entry->>'counter')::bigint INTO parent_replica_counter
    FROM jsonb_array_elements(parent_checkpoint.causal_frontier) AS entries(entry)
    WHERE entry->>'replicaId' = tx.replica_id;
    IF coalesce(parent_replica_counter, 0) <> tx.replica_counter - 1
      OR coalesce(resolved_replica_counter, 0) <> tx.replica_counter - 1
      OR result_replica_counter IS DISTINCT FROM tx.replica_counter
      OR NOT opengeni_private.editable_artifact_frontier_merge_dot_equals(
        tx.resolved_causal_base, tx.causal_base, predecessor_resolved_causal_base,
        tx.replica_id, tx.replica_counter - 1
      )
      OR NOT opengeni_private.editable_artifact_frontier_merge_dot_equals(
        tx.resulting_causal_frontier, parent_checkpoint.causal_frontier,
        tx.resolved_causal_base, tx.replica_id, tx.replica_counter
      )
      OR NOT opengeni_private.editable_artifact_frontier_dominates(
        parent_checkpoint.causal_frontier, tx.resolved_causal_base
      )
    THEN
      RAISE EXCEPTION 'transaction causal frontiers do not match parent, predecessor, and dot'
        USING ERRCODE = '23514';
    END IF;
  ELSIF parent_checkpoint.native_revision <> tx.prior_native_revision THEN
    RAISE EXCEPTION 'serialized transaction native revision differs from its parent checkpoint'
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO operation_rows
  FROM editable_artifact_operations operation
  WHERE operation.account_id = tx.account_id
    AND operation.workspace_id = tx.workspace_id
    AND operation.artifact_id = tx.artifact_id
    AND operation.transaction_id = tx.id;
  IF (tx.modality = 'spreadsheet' AND operation_rows <> tx.operation_count)
    OR (tx.modality <> 'spreadsheet' AND operation_rows <> 0)
  THEN
    RAISE EXCEPTION 'transaction operation coverage is incomplete'
      USING ERRCODE = '23514';
  END IF;

  IF tx.modality = 'spreadsheet' AND EXISTS (
    SELECT 1
    FROM editable_artifact_operations operation
    WHERE operation.account_id = tx.account_id
      AND operation.workspace_id = tx.workspace_id
      AND operation.artifact_id = tx.artifact_id
      AND operation.transaction_id = tx.id
      AND (
        operation.sequence <> tx.sequence_start + operation.operation_index
        OR operation.operation_index >= tx.operation_count
        OR operation.operation_id <> tx.operation_ids ->> operation.operation_index
        OR operation.dot_replica_id <> tx.replica_id
        OR operation.dot_counter <> tx.replica_counter
        OR operation.actor_key <> tx.actor_key
        OR operation.created_at <> tx.committed_at
      )
  ) THEN
    RAISE EXCEPTION 'operation metadata differs from canonical transaction projection'
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO undo_rows
  FROM editable_artifact_undo_claims claim
  WHERE claim.account_id = tx.account_id
    AND claim.workspace_id = tx.workspace_id
    AND claim.artifact_id = tx.artifact_id
    AND claim.claiming_transaction_id = tx.id;
  IF (tx.modality <> 'spreadsheet' AND undo_rows <> 0)
    OR (tx.modality = 'spreadsheet' AND (
      undo_rows <> jsonb_array_length(tx.selective_undo_targets)
    OR EXISTS (
      WITH targets AS MATERIALIZED (
        SELECT operation_id
        FROM jsonb_array_elements_text(tx.selective_undo_targets) target(operation_id)
      ), frontier AS MATERIALIZED (
        SELECT entry->>'replicaId' AS replica_id,
          (entry->>'counter')::bigint AS counter
        FROM jsonb_array_elements(tx.resolved_causal_base) AS entries(entry)
      )
      SELECT 1
      FROM targets target
      LEFT JOIN editable_artifact_undo_claims claim
        ON claim.account_id = tx.account_id
        AND claim.workspace_id = tx.workspace_id
        AND claim.artifact_id = tx.artifact_id
        AND claim.claiming_transaction_id = tx.id
        AND claim.target_operation_id = target.operation_id
      LEFT JOIN editable_artifact_operations operation
        ON operation.account_id = tx.account_id
        AND operation.workspace_id = tx.workspace_id
        AND operation.artifact_id = tx.artifact_id
        AND operation.operation_id = target.operation_id
      LEFT JOIN frontier
        ON frontier.replica_id = operation.dot_replica_id
      WHERE claim.target_operation_id IS NULL
        OR operation.operation_id IS NULL
        OR operation.actor_key <> tx.actor_key
        OR operation.sequence > tx.parent_head_sequence
        OR coalesce(frontier.counter, 0) < operation.dot_counter
    )))
  THEN
    RAISE EXCEPTION 'selective undo claims do not exactly match durable targets'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM editable_artifact_sequence_checkpoints checkpoint
    WHERE checkpoint.account_id = tx.account_id
      AND checkpoint.workspace_id = tx.workspace_id
      AND checkpoint.artifact_id = tx.artifact_id
      AND checkpoint.head_sequence = tx.sequence_end
      AND checkpoint.transaction_id = tx.id
      AND checkpoint.modality = tx.modality
      AND ((tx.modality = 'spreadsheet'
        AND checkpoint.causal_frontier = tx.resulting_causal_frontier
        AND checkpoint.native_revision IS NULL)
        OR (tx.modality IN ('document', 'presentation')
          AND checkpoint.causal_frontier IS NULL
          AND checkpoint.native_revision = tx.native_revision))
      AND checkpoint.state_hash = tx.state_hash
  ) THEN
    RAISE EXCEPTION 'transaction terminal checkpoint is missing or inconsistent'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM editable_artifact_live_outbox outbox
    WHERE outbox.account_id = tx.account_id
      AND outbox.workspace_id = tx.workspace_id
      AND outbox.artifact_id = tx.artifact_id
      AND outbox.event_kind = 'transaction_committed'
      AND outbox.transaction_id = tx.id
  ) THEN
    RAISE EXCEPTION 'transaction committed outbox event is missing'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM editable_artifact_idempotency_receipts receipt
    WHERE receipt.account_id = tx.account_id
      AND receipt.workspace_id = tx.workspace_id
      AND receipt.artifact_id = tx.artifact_id
      AND receipt.operation_kind = 'edit'
      AND receipt.authority_key = tx.actor_key
      AND receipt.idempotency_key = tx.client_transaction_id
      AND receipt.request_hash = tx.request_hash
      AND receipt.resource_type = 'transaction'
      AND receipt.resource_id = tx.id
      AND receipt.server_transaction_id = tx.id
  ) THEN
    RAISE EXCEPTION 'transaction idempotency receipt is missing or inconsistent'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM editable_artifacts artifact
    WHERE artifact.account_id = tx.account_id
      AND artifact.workspace_id = tx.workspace_id
      AND artifact.id = tx.artifact_id
      AND artifact.lifecycle_state = 'active'
      AND artifact.head_sequence >= tx.sequence_end
  ) THEN
    RAISE EXCEPTION 'artifact head was not advanced through committed transaction'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$body$;

CREATE CONSTRAINT TRIGGER editable_artifact_transactions_commit_guard
AFTER INSERT ON "editable_artifact_transactions"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION opengeni_private.validate_editable_artifact_transaction_commit();

-- The aggregate validator above runs exactly once per transaction header. These
-- constant-cost guards prevent immutable children from being appended after the
-- owning transaction has published its head, without rescanning the transaction
-- once per operation projection row.
CREATE OR REPLACE FUNCTION opengeni_private.guard_editable_artifact_transaction_child_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE owner_transaction_id text;
DECLARE owner_sequence_end bigint;
DECLARE owner_modality text;
DECLARE published_head bigint;
BEGIN
  PERFORM set_config(
    'search_path', 'pg_catalog,' || quote_ident(TG_TABLE_SCHEMA) || ',pg_temp', true
  );
  IF TG_TABLE_NAME = 'editable_artifact_operations' THEN
    owner_transaction_id := NEW.transaction_id;
  ELSIF TG_TABLE_NAME = 'editable_artifact_idempotency_receipts' THEN
    IF NEW.operation_kind <> 'edit' THEN RETURN NEW; END IF;
    owner_transaction_id := NEW.server_transaction_id;
  ELSIF TG_TABLE_NAME = 'editable_artifact_undo_claims' THEN
    owner_transaction_id := NEW.claiming_transaction_id;
  ELSIF TG_TABLE_NAME = 'editable_artifact_sequence_checkpoints' THEN
    IF NEW.transaction_id IS NULL THEN RETURN NEW; END IF;
    owner_transaction_id := NEW.transaction_id;
  ELSIF TG_TABLE_NAME = 'editable_artifact_live_outbox' THEN
    IF NEW.event_kind <> 'transaction_committed' THEN RETURN NEW; END IF;
    owner_transaction_id := NEW.transaction_id;
  END IF;

  SELECT transaction.sequence_end, transaction.modality
  INTO owner_sequence_end, owner_modality
  FROM editable_artifact_transactions transaction
  WHERE transaction.account_id = NEW.account_id
    AND transaction.workspace_id = NEW.workspace_id
    AND transaction.artifact_id = NEW.artifact_id
    AND transaction.id = owner_transaction_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transaction child must follow its transaction header'
      USING ERRCODE = '23503';
  END IF;
  IF TG_TABLE_NAME IN ('editable_artifact_operations', 'editable_artifact_undo_claims')
    AND owner_modality <> 'spreadsheet'
  THEN
    RAISE EXCEPTION 'serialized artifact transactions cannot receive CRDT children'
      USING ERRCODE = '23514';
  END IF;

  SELECT artifact.head_sequence INTO published_head
  FROM editable_artifacts artifact
  WHERE artifact.account_id = NEW.account_id
    AND artifact.workspace_id = NEW.workspace_id
    AND artifact.id = NEW.artifact_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transaction child artifact is missing'
      USING ERRCODE = '23503';
  END IF;
  IF published_head >= owner_sequence_end THEN
    RAISE EXCEPTION 'committed transaction history cannot receive additional children'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$body$;

CREATE TRIGGER editable_artifact_operations_insert_guard
BEFORE INSERT ON "editable_artifact_operations"
FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_editable_artifact_transaction_child_insert();
CREATE TRIGGER editable_artifact_receipts_insert_guard
BEFORE INSERT ON "editable_artifact_idempotency_receipts"
FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_editable_artifact_transaction_child_insert();
CREATE TRIGGER editable_artifact_undo_claims_insert_guard
BEFORE INSERT ON "editable_artifact_undo_claims"
FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_editable_artifact_transaction_child_insert();
CREATE TRIGGER editable_artifact_checkpoints_insert_guard
BEFORE INSERT ON "editable_artifact_sequence_checkpoints"
FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_editable_artifact_transaction_child_insert();
CREATE TRIGGER editable_artifact_live_outbox_transaction_insert_guard
BEFORE INSERT ON "editable_artifact_live_outbox"
FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_editable_artifact_transaction_child_insert();

CREATE OR REPLACE FUNCTION opengeni_private.validate_editable_artifact_projection()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE checkpoint record;
DECLARE blob record;
DECLARE tx record;
DECLARE snapshot record;
DECLARE job record;
DECLARE artifact_modality text;
BEGIN
  PERFORM set_config(
    'search_path', 'pg_catalog,' || quote_ident(TG_TABLE_SCHEMA) || ',pg_temp', true
  );
  IF TG_TABLE_NAME = 'editable_artifacts' THEN
    SELECT * INTO checkpoint FROM editable_artifact_sequence_checkpoints candidate
    WHERE candidate.account_id = NEW.account_id
      AND candidate.workspace_id = NEW.workspace_id
      AND candidate.artifact_id = NEW.id
      AND candidate.head_sequence = NEW.head_sequence;
    IF NOT FOUND OR checkpoint.modality <> NEW.modality
      OR checkpoint.state_hash <> NEW.state_hash
      OR (NEW.modality = 'spreadsheet'
        AND checkpoint.causal_frontier IS DISTINCT FROM NEW.causal_frontier)
      OR (NEW.modality IN ('document', 'presentation')
        AND checkpoint.native_revision IS NULL)
    THEN
      RAISE EXCEPTION 'artifact head lacks an exact durable checkpoint'
        USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'INSERT' THEN
      IF NEW.head_sequence <> 0 OR NEW.current_snapshot_id IS NULL THEN
        RAISE EXCEPTION 'editable artifact must begin at its genesis snapshot'
          USING ERRCODE = '23514';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM editable_artifact_idempotency_receipts receipt
        WHERE receipt.account_id = NEW.account_id
          AND receipt.workspace_id = NEW.workspace_id
          AND receipt.artifact_id = NEW.id
          AND receipt.operation_kind IN ('create', 'import')
          AND receipt.resource_type = 'artifact'
          AND receipt.resource_id = NEW.id
          AND opengeni_private.editable_artifact_object_has_exact_keys(
            receipt.result, ARRAY['artifactId', 'genesisSnapshotId', 'schemaVersion']
          )
          AND jsonb_typeof(receipt.result->'schemaVersion') = 'number'
          AND receipt.result->>'schemaVersion' = '1'
          AND jsonb_typeof(receipt.result->'artifactId') = 'string'
          AND receipt.result->>'artifactId' = NEW.id
          AND jsonb_typeof(receipt.result->'genesisSnapshotId') = 'string'
          AND receipt.result->>'genesisSnapshotId' = NEW.current_snapshot_id
      ) THEN
        RAISE EXCEPTION 'editable artifact exact genesis receipt is missing'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    IF NEW.current_snapshot_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM editable_artifact_snapshots current_snapshot
      WHERE current_snapshot.account_id = NEW.account_id
        AND current_snapshot.workspace_id = NEW.workspace_id
        AND current_snapshot.artifact_id = NEW.id
        AND current_snapshot.id = NEW.current_snapshot_id
        AND current_snapshot.modality = NEW.modality
        AND current_snapshot.covered_head_sequence <= NEW.head_sequence
    ) THEN
      RAISE EXCEPTION 'artifact current snapshot is ahead of or outside its head'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'editable_artifact_snapshots' THEN
    SELECT * INTO checkpoint FROM editable_artifact_sequence_checkpoints candidate
    WHERE candidate.account_id = NEW.account_id
      AND candidate.workspace_id = NEW.workspace_id
      AND candidate.artifact_id = NEW.artifact_id
      AND candidate.head_sequence = NEW.covered_head_sequence;
    SELECT * INTO blob FROM editable_artifact_blob_refs candidate
    WHERE candidate.account_id = NEW.account_id
      AND candidate.workspace_id = NEW.workspace_id
      AND candidate.artifact_id = NEW.artifact_id
      AND candidate.id = NEW.blob_ref_id;
    IF checkpoint.head_sequence IS NULL
      OR checkpoint.modality <> NEW.modality
      OR (NEW.modality = 'spreadsheet'
        AND checkpoint.causal_frontier IS DISTINCT FROM NEW.covered_causal_frontier)
      OR (NEW.modality IN ('document', 'presentation')
        AND checkpoint.native_revision IS DISTINCT FROM NEW.native_revision)
      OR checkpoint.state_hash <> NEW.state_hash
      OR blob.id IS NULL OR blob.kind <> 'snapshot'
      OR blob.byte_size <> NEW.byte_size OR blob.content_hash <> NEW.content_hash
      OR blob.mime_type <> NEW.mime_type
    THEN
      RAISE EXCEPTION 'snapshot does not exactly match its checkpoint and blob facts'
        USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM editable_artifact_live_outbox outbox
      WHERE outbox.account_id = NEW.account_id
        AND outbox.workspace_id = NEW.workspace_id
        AND outbox.artifact_id = NEW.artifact_id
        AND outbox.event_kind = 'snapshot_published'
        AND outbox.snapshot_id = NEW.id
    ) THEN
      RAISE EXCEPTION 'snapshot published outbox event is missing'
        USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM editable_artifacts artifact
      WHERE artifact.account_id = NEW.account_id
        AND artifact.workspace_id = NEW.workspace_id
        AND artifact.id = NEW.artifact_id
        AND artifact.modality = NEW.modality
        AND artifact.current_snapshot_id = NEW.id
    ) THEN
      RAISE EXCEPTION 'published snapshot is not the artifact current snapshot'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'editable_artifact_versions' THEN
    SELECT artifact.modality INTO artifact_modality
    FROM editable_artifacts artifact
    WHERE artifact.account_id = NEW.account_id
      AND artifact.workspace_id = NEW.workspace_id
      AND artifact.id = NEW.artifact_id;
    SELECT * INTO checkpoint FROM editable_artifact_sequence_checkpoints candidate
    WHERE candidate.account_id = NEW.account_id
      AND candidate.workspace_id = NEW.workspace_id
      AND candidate.artifact_id = NEW.artifact_id
      AND candidate.head_sequence = NEW.head_sequence;
    IF artifact_modality <> 'spreadsheet'
      OR checkpoint.head_sequence IS NULL
      OR checkpoint.causal_frontier <> NEW.causal_frontier
      OR checkpoint.state_hash <> NEW.state_hash
      OR (NEW.snapshot_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM editable_artifact_snapshots version_snapshot
        WHERE version_snapshot.account_id = NEW.account_id
          AND version_snapshot.workspace_id = NEW.workspace_id
          AND version_snapshot.artifact_id = NEW.artifact_id
          AND version_snapshot.id = NEW.snapshot_id
          AND version_snapshot.covered_head_sequence <= NEW.head_sequence
          AND opengeni_private.editable_artifact_frontier_dominates(
            NEW.causal_frontier, version_snapshot.covered_causal_frontier
          )
          AND (version_snapshot.covered_head_sequence < NEW.head_sequence OR (
            version_snapshot.covered_causal_frontier = NEW.causal_frontier
            AND version_snapshot.state_hash = NEW.state_hash
          ))
      ))
    THEN
      RAISE EXCEPTION 'artifact version does not exactly identify a durable checkpoint'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'editable_artifact_materialization_results' THEN
    SELECT * INTO blob FROM editable_artifact_blob_refs candidate
    WHERE candidate.account_id = NEW.account_id
      AND candidate.workspace_id = NEW.workspace_id
      AND candidate.artifact_id = NEW.artifact_id
      AND candidate.id = NEW.blob_ref_id;
    SELECT * INTO job FROM editable_artifact_materialization_jobs candidate
    WHERE candidate.account_id = NEW.account_id
      AND candidate.workspace_id = NEW.workspace_id
      AND candidate.artifact_id = NEW.artifact_id
      AND candidate.id = NEW.job_id;
    IF blob.id IS NULL OR blob.kind <> 'materialization'
      OR blob.byte_size <> NEW.byte_size OR blob.content_hash <> NEW.content_hash
      OR blob.mime_type <> NEW.mime_type
      OR job.id IS NULL OR job.state <> 'succeeded'
      OR NEW.mime_type <> (CASE job.format
        WHEN 'xlsx' THEN 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        WHEN 'pptx' THEN 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        WHEN 'docx' THEN 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        WHEN 'pdf' THEN 'application/pdf'
        WHEN 'png' THEN 'image/png'
        WHEN 'webp' THEN 'image/webp'
      END)
    THEN
      RAISE EXCEPTION 'materialization result does not match a succeeded job and blob facts'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'editable_artifact_materialization_jobs' THEN
    SELECT * INTO checkpoint FROM editable_artifact_sequence_checkpoints candidate
    WHERE candidate.account_id = NEW.account_id
      AND candidate.workspace_id = NEW.workspace_id
      AND candidate.artifact_id = NEW.artifact_id
      AND candidate.head_sequence = NEW.target_head_sequence;
    SELECT * INTO snapshot FROM editable_artifact_snapshots candidate
    WHERE candidate.account_id = NEW.account_id
      AND candidate.workspace_id = NEW.workspace_id
      AND candidate.artifact_id = NEW.artifact_id
      AND candidate.id = NEW.input_snapshot_id;
    IF snapshot.id IS NOT NULL THEN
      SELECT * INTO blob FROM editable_artifact_blob_refs candidate
      WHERE candidate.account_id = snapshot.account_id
        AND candidate.workspace_id = snapshot.workspace_id
        AND candidate.artifact_id = snapshot.artifact_id
        AND candidate.id = snapshot.blob_ref_id;
    END IF;
    SELECT artifact.modality INTO artifact_modality
    FROM editable_artifacts artifact
    WHERE artifact.account_id = NEW.account_id
      AND artifact.workspace_id = NEW.workspace_id
      AND artifact.id = NEW.artifact_id;
    IF checkpoint.head_sequence IS NULL OR checkpoint.state_hash <> NEW.state_hash
      OR snapshot.id IS NULL
      OR snapshot.covered_head_sequence <> NEW.target_head_sequence
      OR snapshot.state_hash <> NEW.state_hash
      OR blob.id IS NULL OR blob.kind <> 'snapshot'
      OR blob.id <> snapshot.blob_ref_id
      OR blob.byte_size <> snapshot.byte_size
      OR blob.content_hash <> snapshot.content_hash
      OR blob.mime_type <> snapshot.mime_type
      OR artifact_modality IS NULL
      OR NOT ((artifact_modality = 'spreadsheet' AND NEW.format IN ('xlsx', 'pdf', 'png', 'webp'))
        OR (artifact_modality = 'presentation' AND NEW.format IN ('pptx', 'pdf', 'png', 'webp'))
        OR (artifact_modality = 'document' AND NEW.format IN ('docx', 'pdf', 'png', 'webp')))
      OR (NEW.version_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM editable_artifact_versions version
        WHERE version.account_id = NEW.account_id
          AND version.workspace_id = NEW.workspace_id
          AND version.artifact_id = NEW.artifact_id
          AND version.id = NEW.version_id
          AND version.head_sequence = NEW.target_head_sequence
          AND version.state_hash = NEW.state_hash
      ))
    THEN
      RAISE EXCEPTION 'materialization job manifest differs from its pinned source/checkpoint/version'
        USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM editable_artifact_idempotency_receipts receipt
      WHERE receipt.account_id = NEW.account_id
        AND receipt.workspace_id = NEW.workspace_id
        AND receipt.artifact_id = NEW.artifact_id
        AND receipt.operation_kind = 'materialize'
        AND receipt.resource_type = 'materialization_job'
        AND receipt.resource_id = NEW.id
        AND receipt.server_transaction_id IS NULL
    ) THEN
      RAISE EXCEPTION 'materialization job idempotency receipt is missing'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.state = 'succeeded' AND NOT EXISTS (
      SELECT 1 FROM editable_artifact_materialization_results result
      WHERE result.account_id = NEW.account_id
        AND result.workspace_id = NEW.workspace_id
        AND result.artifact_id = NEW.artifact_id
        AND result.job_id = NEW.id
    ) THEN
      RAISE EXCEPTION 'succeeded materialization job lacks its immutable result'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'editable_artifact_replica_leases' THEN
    SELECT artifact.modality INTO artifact_modality
    FROM editable_artifacts artifact
    WHERE artifact.account_id = NEW.account_id
      AND artifact.workspace_id = NEW.workspace_id
      AND artifact.id = NEW.artifact_id;
    SELECT * INTO checkpoint FROM editable_artifact_sequence_checkpoints candidate
    WHERE candidate.account_id = NEW.account_id
      AND candidate.workspace_id = NEW.workspace_id
      AND candidate.artifact_id = NEW.artifact_id
      AND candidate.head_sequence = NEW.applied_head_sequence;
    IF artifact_modality IS NULL OR NEW.modality <> artifact_modality
      OR checkpoint.head_sequence IS NULL OR checkpoint.modality <> NEW.modality
      OR (NEW.modality = 'spreadsheet'
        AND checkpoint.causal_frontier IS DISTINCT FROM NEW.causal_frontier)
      OR (NEW.modality IN ('document', 'presentation')
        AND checkpoint.native_revision IS DISTINCT FROM NEW.native_revision)
    THEN
      RAISE EXCEPTION 'replica lease cursor differs from its durable checkpoint'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'editable_artifact_idempotency_receipts' THEN
    IF (NEW.resource_type = 'artifact' AND NOT EXISTS (
      SELECT 1 FROM editable_artifacts artifact
      WHERE artifact.account_id = NEW.account_id
        AND artifact.workspace_id = NEW.workspace_id
        AND artifact.id = NEW.artifact_id
        AND artifact.id = NEW.resource_id
    )) OR (NEW.resource_type = 'snapshot' AND NOT EXISTS (
      SELECT 1 FROM editable_artifact_snapshots receipt_snapshot
      WHERE receipt_snapshot.account_id = NEW.account_id
        AND receipt_snapshot.workspace_id = NEW.workspace_id
        AND receipt_snapshot.artifact_id = NEW.artifact_id
        AND receipt_snapshot.id = NEW.resource_id
    )) OR (NEW.resource_type = 'materialization_job' AND NOT EXISTS (
      SELECT 1 FROM editable_artifact_materialization_jobs receipt_job
      WHERE receipt_job.account_id = NEW.account_id
        AND receipt_job.workspace_id = NEW.workspace_id
        AND receipt_job.artifact_id = NEW.artifact_id
        AND receipt_job.id = NEW.resource_id
    ))
    THEN
      RAISE EXCEPTION 'idempotency receipt resource does not exist in its exact scope'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.operation_kind IN ('create', 'import') AND NOT EXISTS (
      SELECT 1 FROM editable_artifacts artifact
      WHERE artifact.account_id = NEW.account_id
        AND artifact.workspace_id = NEW.workspace_id
        AND artifact.id = NEW.artifact_id
        AND artifact.head_sequence = 0
        AND artifact.current_snapshot_id IS NOT NULL
        AND opengeni_private.editable_artifact_object_has_exact_keys(
          NEW.result, ARRAY['artifactId', 'genesisSnapshotId', 'schemaVersion']
        )
        AND jsonb_typeof(NEW.result->'schemaVersion') = 'number'
        AND NEW.result->>'schemaVersion' = '1'
        AND jsonb_typeof(NEW.result->'artifactId') = 'string'
        AND NEW.result->>'artifactId' = artifact.id
        AND jsonb_typeof(NEW.result->'genesisSnapshotId') = 'string'
        AND NEW.result->>'genesisSnapshotId' = artifact.current_snapshot_id
    ) THEN
      RAISE EXCEPTION 'creation/import receipt differs from exact artifact genesis'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'editable_artifact_live_outbox' THEN
    IF NEW.event_kind = 'transaction_committed' THEN
      SELECT * INTO tx FROM editable_artifact_transactions candidate
      WHERE candidate.account_id = NEW.account_id
        AND candidate.workspace_id = NEW.workspace_id
        AND candidate.artifact_id = NEW.artifact_id
        AND candidate.id = NEW.transaction_id;
      IF tx.id IS NULL
        OR NEW.event->>'modality' <> tx.modality
        OR NEW.event->>'sequenceStart' <> tx.sequence_start::text
        OR NEW.event->>'sequenceEnd' <> tx.sequence_end::text
        OR NEW.event->>'stateHash' <> tx.state_hash
        OR (tx.modality = 'spreadsheet'
          AND NEW.event->>'operationProtocolVersion' <> tx.operation_protocol_version::text)
        OR (tx.modality IN ('document', 'presentation')
          AND NEW.event->>'commitProtocolVersion' <> tx.commit_protocol_version::text)
        OR (NEW.event->>'committedAt')::timestamptz <> tx.committed_at
        OR NEW.created_at <> tx.committed_at
      THEN
        RAISE EXCEPTION 'transaction outbox event differs from durable transaction'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      SELECT * INTO snapshot FROM editable_artifact_snapshots candidate
      WHERE candidate.account_id = NEW.account_id
        AND candidate.workspace_id = NEW.workspace_id
        AND candidate.artifact_id = NEW.artifact_id
        AND candidate.id = NEW.snapshot_id;
      IF snapshot.id IS NULL
        OR NEW.event->>'modality' <> snapshot.modality
        OR NEW.event->>'coveredHeadSequence' <> snapshot.covered_head_sequence::text
        OR NEW.event->>'stateHash' <> snapshot.state_hash
        OR (snapshot.modality = 'spreadsheet'
          AND NEW.event->>'operationProtocolVersion'
            <> snapshot.operation_protocol_version::text)
        OR (NEW.event->>'publishedAt')::timestamptz <> snapshot.published_at
        OR NEW.created_at <> snapshot.published_at
      THEN
        RAISE EXCEPTION 'snapshot outbox event differs from durable snapshot'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END;
$body$;

CREATE CONSTRAINT TRIGGER editable_artifacts_projection_guard
AFTER INSERT OR UPDATE ON "editable_artifacts"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION opengeni_private.validate_editable_artifact_projection();
CREATE CONSTRAINT TRIGGER editable_artifact_snapshots_projection_guard
AFTER INSERT ON "editable_artifact_snapshots"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION opengeni_private.validate_editable_artifact_projection();
CREATE CONSTRAINT TRIGGER editable_artifact_versions_projection_guard
AFTER INSERT ON "editable_artifact_versions"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION opengeni_private.validate_editable_artifact_projection();
CREATE CONSTRAINT TRIGGER editable_artifact_materialization_results_projection_guard
AFTER INSERT ON "editable_artifact_materialization_results"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION opengeni_private.validate_editable_artifact_projection();
CREATE CONSTRAINT TRIGGER editable_artifact_materialization_jobs_projection_guard
AFTER INSERT OR UPDATE ON "editable_artifact_materialization_jobs"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION opengeni_private.validate_editable_artifact_projection();
CREATE CONSTRAINT TRIGGER editable_artifact_replica_leases_projection_guard
AFTER INSERT OR UPDATE ON "editable_artifact_replica_leases"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION opengeni_private.validate_editable_artifact_projection();
CREATE CONSTRAINT TRIGGER editable_artifact_idempotency_receipts_projection_guard
AFTER INSERT ON "editable_artifact_idempotency_receipts"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION opengeni_private.validate_editable_artifact_projection();
CREATE CONSTRAINT TRIGGER editable_artifact_live_outbox_projection_guard
AFTER INSERT ON "editable_artifact_live_outbox"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION opengeni_private.validate_editable_artifact_projection();

CREATE OR REPLACE FUNCTION opengeni_private.guard_editable_artifact_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE old_snapshot_coverage bigint;
DECLARE new_snapshot_coverage bigint;
DECLARE table_owner name;
BEGIN
  PERFORM set_config(
    'search_path', 'pg_catalog,' || quote_ident(TG_TABLE_SCHEMA) || ',pg_temp', true
  );
  IF NEW.account_id <> OLD.account_id OR NEW.workspace_id <> OLD.workspace_id
    OR NEW.id <> OLD.id OR NEW.modality <> OLD.modality
    OR NEW.created_by_subject_id <> OLD.created_by_subject_id
    OR NEW.created_at <> OLD.created_at
    OR NEW.head_sequence < OLD.head_sequence
    OR NEW.updated_at < OLD.updated_at
    OR (NEW.head_sequence = OLD.head_sequence AND (
      NEW.causal_frontier IS DISTINCT FROM OLD.causal_frontier
      OR NEW.state_hash <> OLD.state_hash
    ))
  THEN
    RAISE EXCEPTION 'invalid editable artifact head or identity mutation'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.authorization_revision < OLD.authorization_revision THEN
    RAISE EXCEPTION 'editable artifact authorization revision cannot regress'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.authorization_revision > OLD.authorization_revision THEN
    SELECT pg_catalog.pg_get_userbyid(relation.relowner) INTO table_owner
    FROM pg_catalog.pg_class relation
    WHERE relation.oid = TG_RELID;
    IF table_owner IS NULL OR current_user <> table_owner THEN
      RAISE EXCEPTION 'editable artifact authorization revision requires its owner capability'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.title <> OLD.title
      OR NEW.lifecycle_state <> OLD.lifecycle_state
      OR NEW.head_sequence <> OLD.head_sequence
      OR NEW.causal_frontier IS DISTINCT FROM OLD.causal_frontier
      OR NEW.state_hash <> OLD.state_hash
      OR NEW.current_snapshot_id IS DISTINCT FROM OLD.current_snapshot_id
    THEN
      RAISE EXCEPTION 'editable artifact authorization revision must advance independently'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF OLD.lifecycle_state = 'archived' AND NEW.lifecycle_state <> 'archived' THEN
    RAISE EXCEPTION 'archived editable artifact cannot be reactivated implicitly'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.lifecycle_state = 'archived' AND (
    NEW.head_sequence <> OLD.head_sequence
    OR NEW.causal_frontier IS DISTINCT FROM OLD.causal_frontier
    OR NEW.state_hash <> OLD.state_hash
  ) THEN
    RAISE EXCEPTION 'archived editable artifact authority cannot advance'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.current_snapshot_id IS DISTINCT FROM OLD.current_snapshot_id THEN
    IF NEW.current_snapshot_id IS NULL THEN
      RAISE EXCEPTION 'editable artifact current snapshot cannot be cleared'
        USING ERRCODE = '23514';
    END IF;
    SELECT snapshot.covered_head_sequence INTO new_snapshot_coverage
    FROM editable_artifact_snapshots snapshot
    WHERE snapshot.account_id = NEW.account_id
      AND snapshot.workspace_id = NEW.workspace_id
      AND snapshot.artifact_id = NEW.id
      AND snapshot.id = NEW.current_snapshot_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'editable artifact current snapshot is missing'
        USING ERRCODE = '23503';
    END IF;
    IF OLD.current_snapshot_id IS NOT NULL THEN
      SELECT snapshot.covered_head_sequence INTO old_snapshot_coverage
      FROM editable_artifact_snapshots snapshot
      WHERE snapshot.account_id = OLD.account_id
        AND snapshot.workspace_id = OLD.workspace_id
        AND snapshot.artifact_id = OLD.id
        AND snapshot.id = OLD.current_snapshot_id;
      IF NOT FOUND OR new_snapshot_coverage <= old_snapshot_coverage THEN
        RAISE EXCEPTION 'editable artifact current snapshot coverage must advance'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$body$;

CREATE TRIGGER editable_artifacts_update_guard
BEFORE UPDATE ON "editable_artifacts"
FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_editable_artifact_update();

CREATE OR REPLACE FUNCTION opengeni_private.guard_editable_artifact_mutable_state()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $body$
BEGIN
  PERFORM set_config(
    'search_path', 'pg_catalog,' || quote_ident(TG_TABLE_SCHEMA) || ',pg_temp', true
  );
  IF TG_TABLE_NAME = 'editable_artifact_materialization_jobs' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.state <> 'pending' OR NEW.attempt_count <> 0
        OR NEW.lease_owner IS NOT NULL OR NEW.lease_expires_at IS NOT NULL
        OR NEW.settled_by_owner IS NOT NULL OR NEW.error_code IS NOT NULL
        OR NEW.started_at IS NOT NULL
        OR NEW.completed_at IS NOT NULL
      THEN
        RAISE EXCEPTION 'materialization jobs must begin pending and unleased'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.account_id <> OLD.account_id OR NEW.workspace_id <> OLD.workspace_id
      OR NEW.artifact_id <> OLD.artifact_id OR NEW.id <> OLD.id
      OR NEW.version_id IS DISTINCT FROM OLD.version_id
      OR NEW.input_snapshot_id <> OLD.input_snapshot_id
      OR NEW.target_head_sequence <> OLD.target_head_sequence
      OR NEW.state_hash <> OLD.state_hash OR NEW.format <> OLD.format
      OR NEW.normalized_options <> OLD.normalized_options
      OR NEW.options_hash <> OLD.options_hash OR NEW.codec_id <> OLD.codec_id
      OR NEW.codec_version <> OLD.codec_version
      OR NEW.kernel_version <> OLD.kernel_version
      OR NEW.font_registry_hash <> OLD.font_registry_hash OR NEW.policy_hash <> OLD.policy_hash
      OR NEW.created_at <> OLD.created_at
    THEN
      RAISE EXCEPTION 'invalid materialization job mutation' USING ERRCODE = '23514';
    END IF;
    IF OLD.state IN ('succeeded', 'failed') THEN
      RAISE EXCEPTION 'terminal materialization job is immutable' USING ERRCODE = '23514';
    ELSIF OLD.state = 'pending' THEN
      IF NEW.state <> 'running' OR NEW.attempt_count <> OLD.attempt_count + 1
        OR NEW.settled_by_owner IS NOT NULL
      THEN
        RAISE EXCEPTION 'pending materialization job must be claimed exactly once'
          USING ERRCODE = '23514';
      END IF;
    ELSIF OLD.state = 'running' AND NEW.state = 'running' THEN
      IF NOT (
        -- Heartbeats extend one still-live claim without changing its fencing
        -- token. They cannot resurrect an expired lease or move ownership.
        (NEW.attempt_count = OLD.attempt_count
          AND NEW.lease_owner IS NOT DISTINCT FROM OLD.lease_owner
          AND NEW.started_at IS NOT DISTINCT FROM OLD.started_at
          AND OLD.lease_expires_at > pg_catalog.statement_timestamp()
          AND NEW.lease_expires_at > OLD.lease_expires_at
          AND NEW.settled_by_owner IS NULL)
        OR
        -- Reclaim is a distinct transition: only an expired claim may advance
        -- the attempt-count fence and reset its owner/start/expiration.
        (NEW.attempt_count = OLD.attempt_count + 1
          AND OLD.lease_expires_at <= pg_catalog.statement_timestamp()
          AND NEW.started_at >= OLD.started_at
          AND NEW.settled_by_owner IS NULL)
      )
      THEN
        RAISE EXCEPTION 'invalid materialization renewal or reclaim transition'
          USING ERRCODE = '23514';
      END IF;
    ELSIF OLD.state = 'running' AND NEW.state IN ('succeeded', 'failed') THEN
      IF NOT (
        (NEW.attempt_count = OLD.attempt_count
          AND NEW.started_at IS NOT DISTINCT FROM OLD.started_at
          AND NEW.settled_by_owner IS NOT DISTINCT FROM OLD.lease_owner
          AND OLD.lease_expires_at > pg_catalog.statement_timestamp())
        OR
        (NEW.state = 'failed' AND NEW.error_code = 'attempts_exhausted'
          AND NEW.attempt_count = 1000
          AND NEW.started_at IS NOT DISTINCT FROM OLD.started_at
          AND NEW.settled_by_owner IS NOT DISTINCT FROM OLD.lease_owner
          AND OLD.lease_expires_at <= pg_catalog.statement_timestamp())
      ) THEN
        RAISE EXCEPTION 'materialization settlement attempt is inconsistent'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      RAISE EXCEPTION 'invalid materialization job state transition' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'editable_artifact_live_outbox' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.state <> 'pending' OR NEW.attempt_count <> 0
        OR NEW.lease_owner IS NOT NULL OR NEW.lease_expires_at IS NOT NULL
        OR NEW.next_attempt_at IS DISTINCT FROM NEW.created_at
        OR NEW.last_error_code IS NOT NULL OR NEW.published_at IS NOT NULL
        OR NEW.dead_lettered_at IS NOT NULL
      THEN
        RAISE EXCEPTION 'outbox events must begin pending and unleased'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.account_id <> OLD.account_id OR NEW.workspace_id <> OLD.workspace_id
      OR NEW.artifact_id <> OLD.artifact_id OR NEW.id <> OLD.id
      OR NEW.transaction_id IS DISTINCT FROM OLD.transaction_id
      OR NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id
      OR NEW.event_kind <> OLD.event_kind OR NEW.event <> OLD.event
      OR NEW.created_at <> OLD.created_at OR NEW.attempt_count < OLD.attempt_count
      OR NEW.attempt_count > OLD.attempt_count + 1
      OR OLD.state IN ('published', 'dead_lettered')
    THEN
      RAISE EXCEPTION 'invalid editable artifact outbox mutation' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'editable_artifact_replica_leases' THEN
    IF NEW.account_id <> OLD.account_id OR NEW.workspace_id <> OLD.workspace_id
      OR NEW.artifact_id <> OLD.artifact_id OR NEW.replica_id <> OLD.replica_id
      OR NEW.modality <> OLD.modality
      OR NEW.actor_key <> OLD.actor_key OR NEW.created_at <> OLD.created_at
      OR NEW.applied_head_sequence < OLD.applied_head_sequence
      OR NEW.last_seen_at < OLD.last_seen_at
      OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
    THEN
      RAISE EXCEPTION 'invalid editable artifact replica lease mutation'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$body$;

CREATE TRIGGER editable_artifact_materialization_jobs_update_guard
BEFORE INSERT OR UPDATE ON "editable_artifact_materialization_jobs"
FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_editable_artifact_mutable_state();
CREATE TRIGGER editable_artifact_live_outbox_update_guard
BEFORE INSERT OR UPDATE ON "editable_artifact_live_outbox"
FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_editable_artifact_mutable_state();
CREATE TRIGGER editable_artifact_replica_leases_update_guard
BEFORE UPDATE ON "editable_artifact_replica_leases"
FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_editable_artifact_mutable_state();

DO $immutable_history$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'editable_artifact_transactions',
    'editable_artifact_operations',
    'editable_artifact_idempotency_receipts',
    'editable_artifact_undo_claims',
    'editable_artifact_sequence_checkpoints',
    'editable_artifact_blob_refs',
    'editable_artifact_snapshots',
    'editable_artifact_versions',
    'editable_artifact_materialization_results'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I '
      || 'FOR EACH ROW EXECUTE FUNCTION '
      || 'opengeni_private.reject_editable_artifact_history_mutation()',
      table_name || '_immutable_guard', table_name
    );
  END LOOP;
END;
$immutable_history$;

-- Validate the explicit/defaulted caller schema before privileged access. The
-- public functions default this final argument from current_schema() at their
-- call site, before their hardened SECURITY DEFINER search_path takes effect.
CREATE OR REPLACE FUNCTION opengeni_private.editable_artifact_scope_matches_context(
  p_account_id uuid,
  p_workspace_id uuid
) RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, pg_temp
AS $body$
BEGIN
  IF p_account_id IS NULL OR p_workspace_id IS NULL THEN RETURN false; END IF;
  RETURN p_account_id = nullif(
      pg_catalog.current_setting('opengeni.account_id', true), ''
    )::uuid
    AND p_workspace_id = nullif(
      pg_catalog.current_setting('opengeni.workspace_id', true), ''
    )::uuid;
EXCEPTION WHEN others THEN
  RETURN false;
END;
$body$;

CREATE OR REPLACE FUNCTION opengeni_private.resolve_editable_artifact_data_schema(
  requested_schema name
)
RETURNS name
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE data_schema name;
BEGIN
  IF requested_schema IS NULL THEN
    RAISE EXCEPTION 'editable artifact data schema is unavailable or untrusted'
      USING ERRCODE = '42501';
  END IF;
  SELECT namespace.nspname INTO data_schema
  FROM pg_catalog.pg_namespace namespace
  JOIN pg_catalog.pg_class relation
    ON relation.relnamespace = namespace.oid
    AND relation.relname = 'editable_artifact_live_outbox'
    AND relation.relkind IN ('r', 'p')
  JOIN pg_catalog.pg_class artifact_relation
    ON artifact_relation.relnamespace = namespace.oid
    AND artifact_relation.relname = 'editable_artifacts'
    AND artifact_relation.relkind IN ('r', 'p')
    AND artifact_relation.relowner = relation.relowner
  JOIN pg_catalog.pg_class scope_authority_relation
    ON scope_authority_relation.relnamespace = namespace.oid
    AND scope_authority_relation.relname = 'editable_artifact_scope_authorization_heads'
    AND scope_authority_relation.relkind IN ('r', 'p')
    AND scope_authority_relation.relowner = relation.relowner
  JOIN pg_catalog.pg_class job_relation
    ON job_relation.relnamespace = namespace.oid
    AND job_relation.relname = 'editable_artifact_materialization_jobs'
    AND job_relation.relkind IN ('r', 'p')
    AND job_relation.relowner = relation.relowner
  JOIN pg_catalog.pg_class result_relation
    ON result_relation.relnamespace = namespace.oid
    AND result_relation.relname = 'editable_artifact_materialization_results'
    AND result_relation.relkind IN ('r', 'p')
    AND result_relation.relowner = relation.relowner
  JOIN pg_catalog.pg_class blob_relation
    ON blob_relation.relnamespace = namespace.oid
    AND blob_relation.relname = 'editable_artifact_blob_refs'
    AND blob_relation.relkind IN ('r', 'p')
    AND blob_relation.relowner = relation.relowner
  JOIN pg_catalog.pg_roles owner_role
    ON owner_role.oid = relation.relowner
    AND owner_role.rolname = current_user
  WHERE namespace.nspname = requested_schema
    AND namespace.nspname !~ '^pg_'
    AND namespace.nspname <> 'information_schema'
    AND relation.relrowsecurity
    AND relation.relforcerowsecurity
    AND artifact_relation.relrowsecurity
    AND artifact_relation.relforcerowsecurity
    AND scope_authority_relation.relrowsecurity
    AND scope_authority_relation.relforcerowsecurity
    AND job_relation.relrowsecurity
    AND job_relation.relforcerowsecurity
    AND result_relation.relrowsecurity
    AND result_relation.relforcerowsecurity
    AND blob_relation.relrowsecurity
    AND blob_relation.relforcerowsecurity
    AND pg_catalog.has_schema_privilege(session_user, namespace.oid, 'USAGE');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'editable artifact data schema is unavailable or untrusted'
      USING ERRCODE = '42501';
  END IF;
  RETURN data_schema;
END;
$body$;

CREATE OR REPLACE FUNCTION opengeni_private.ensure_editable_artifact_scope_authorization_head(
  p_account_id uuid,
  p_workspace_id uuid,
  p_data_schema name DEFAULT pg_catalog.current_schema()
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE data_schema name;
DECLARE current_revision bigint;
BEGIN
  IF p_account_id IS NULL OR p_workspace_id IS NULL OR p_data_schema IS NULL
    OR NOT opengeni_private.editable_artifact_scope_matches_context(
      p_account_id, p_workspace_id
    )
  THEN
    RAISE EXCEPTION 'editable artifact scope authorization context is unavailable'
      USING ERRCODE = '42501';
  END IF;
  data_schema := opengeni_private.resolve_editable_artifact_data_schema(p_data_schema);
  EXECUTE pg_catalog.format($query$
    INSERT INTO %I.editable_artifact_scope_authorization_heads (
      account_id, workspace_id, create_revision
    ) VALUES ($1, $2, 1)
    ON CONFLICT (account_id, workspace_id) DO NOTHING
  $query$, data_schema) USING p_account_id, p_workspace_id;
  EXECUTE pg_catalog.format($query$
    SELECT create_revision
    FROM %I.editable_artifact_scope_authorization_heads
    WHERE account_id = $1 AND workspace_id = $2
    FOR SHARE
  $query$, data_schema) INTO current_revision USING p_account_id, p_workspace_id;
  IF current_revision IS NULL THEN
    RAISE EXCEPTION 'editable artifact scope authorization head is unavailable'
      USING ERRCODE = '55000';
  END IF;
  RETURN current_revision;
END;
$body$;

CREATE OR REPLACE FUNCTION opengeni_private.advance_editable_artifact_scope_authorization_revision(
  p_account_id uuid,
  p_workspace_id uuid,
  p_expected_revision bigint,
  p_next_revision bigint,
  p_data_schema name DEFAULT pg_catalog.current_schema()
) RETURNS TABLE (
  applied boolean,
  authorization_revision bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE data_schema name;
DECLARE current_revision bigint;
BEGIN
  IF p_account_id IS NULL OR p_workspace_id IS NULL OR p_data_schema IS NULL
    OR p_expected_revision IS NULL
    OR p_expected_revision NOT BETWEEN 1 AND 9007199254740991
    OR p_next_revision IS NULL
    OR p_next_revision NOT BETWEEN 1 AND 9007199254740991
    OR p_next_revision <= p_expected_revision
    OR NOT opengeni_private.editable_artifact_scope_matches_context(
      p_account_id, p_workspace_id
    )
  THEN
    RAISE EXCEPTION 'invalid editable artifact scope authorization revision bounds'
      USING ERRCODE = '22023';
  END IF;
  data_schema := opengeni_private.resolve_editable_artifact_data_schema(p_data_schema);
  -- Ensure the default head exists before the compare-and-swap. Both statements
  -- remain in the caller transaction, so create's FOR SHARE and this UPDATE
  -- serialize revocation against genesis publication.
  PERFORM opengeni_private.ensure_editable_artifact_scope_authorization_head(
    p_account_id, p_workspace_id, data_schema
  );
  EXECUTE pg_catalog.format($query$
    UPDATE %I.editable_artifact_scope_authorization_heads target
    SET create_revision = $3,
      updated_at = GREATEST(target.updated_at, pg_catalog.statement_timestamp())
    WHERE target.account_id = $1
      AND target.workspace_id = $2
      AND target.create_revision = $4
    RETURNING target.create_revision
  $query$, data_schema)
  INTO current_revision
  USING p_account_id, p_workspace_id, p_next_revision, p_expected_revision;
  IF current_revision IS NOT NULL THEN
    RETURN QUERY SELECT true, current_revision;
    RETURN;
  END IF;
  EXECUTE pg_catalog.format($query$
    SELECT target.create_revision
    FROM %I.editable_artifact_scope_authorization_heads target
    WHERE target.account_id = $1 AND target.workspace_id = $2
  $query$, data_schema) INTO current_revision USING p_account_id, p_workspace_id;
  RETURN QUERY SELECT false, current_revision;
END;
$body$;

-- Authorization policy projection is a separate owner capability. Ordinary
-- artifact-head UPDATEs retain their existing ACL but the row trigger rejects
-- any authorization revision change unless this SECURITY DEFINER owner path is
-- used. Exact expected-revision matching is the CAS fence consumed by edit and
-- snapshot authorization checks.
CREATE OR REPLACE FUNCTION opengeni_private.advance_editable_artifact_authorization_revision(
  p_account_id uuid,
  p_workspace_id uuid,
  p_artifact_id text,
  p_expected_revision bigint,
  p_next_revision bigint,
  p_data_schema name DEFAULT pg_catalog.current_schema()
) RETURNS TABLE (
  applied boolean,
  authorization_revision bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE affected integer;
DECLARE current_revision bigint;
DECLARE data_schema name;
BEGIN
  IF p_account_id IS NULL OR p_workspace_id IS NULL OR p_artifact_id IS NULL
    OR p_data_schema IS NULL
    OR p_artifact_id !~ '^[0-9a-f]{32}$' OR p_artifact_id ~ '^0+$'
    OR p_expected_revision IS NULL
    OR p_expected_revision NOT BETWEEN 0 AND 9007199254740991
    OR p_next_revision IS NULL
    OR p_next_revision NOT BETWEEN 1 AND 9007199254740991
    OR p_next_revision <= p_expected_revision
  THEN
    RAISE EXCEPTION 'invalid editable artifact authorization revision bounds'
      USING ERRCODE = '22023';
  END IF;
  IF NOT opengeni_private.editable_artifact_scope_matches_context(
    p_account_id, p_workspace_id
  ) THEN
    RAISE EXCEPTION 'editable artifact authorization scope is unavailable'
      USING ERRCODE = '42501';
  END IF;
  data_schema := opengeni_private.resolve_editable_artifact_data_schema(p_data_schema);
  EXECUTE pg_catalog.format($query$
    UPDATE %I.editable_artifacts target
    SET authorization_revision = $4,
      updated_at = GREATEST(
        target.updated_at, pg_catalog.statement_timestamp()
      )
    WHERE target.account_id = $1
      AND target.workspace_id = $2
      AND target.id = $3
      AND target.authorization_revision = $5
    RETURNING target.authorization_revision
  $query$, data_schema)
  INTO current_revision
  USING p_account_id, p_workspace_id, p_artifact_id, p_next_revision, p_expected_revision;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected = 1 THEN
    RETURN QUERY SELECT true, current_revision;
    RETURN;
  END IF;
  EXECUTE pg_catalog.format($query$
    SELECT target.authorization_revision
    FROM %I.editable_artifacts target
    WHERE target.account_id = $1
      AND target.workspace_id = $2
      AND target.id = $3
  $query$, data_schema)
  INTO current_revision
  USING p_account_id, p_workspace_id, p_artifact_id;
  RETURN QUERY SELECT false, current_revision;
END;
$body$;

CREATE OR REPLACE FUNCTION opengeni_private.claim_editable_artifact_live_outbox(
  p_owner text,
  p_lease_duration_ms integer,
  p_limit integer,
  p_data_schema name
) RETURNS TABLE (
  outbox_id text,
  account_id uuid,
  workspace_id uuid,
  artifact_id text,
  transaction_id text,
  snapshot_id text,
  event_kind text,
  event jsonb,
  state text,
  attempt_count integer,
  lease_owner text,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz,
  last_error_code text,
  published_at timestamptz,
  dead_lettered_at timestamptz,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE data_schema name;
BEGIN
  IF p_owner IS NULL OR pg_catalog.octet_length(p_owner) NOT BETWEEN 1 AND 256
    OR p_lease_duration_ms IS NULL
    OR p_lease_duration_ms NOT BETWEEN 1 AND 86400000
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000
    OR p_data_schema IS NULL
  THEN
    RAISE EXCEPTION 'invalid editable artifact outbox claim bounds'
      USING ERRCODE = '22023';
  END IF;
  data_schema := opengeni_private.resolve_editable_artifact_data_schema(p_data_schema);
  RETURN QUERY EXECUTE pg_catalog.format($query$
    WITH exhausted_candidates AS MATERIALIZED (
      SELECT candidate.id
      FROM %1$I.editable_artifact_live_outbox candidate
      WHERE candidate.attempt_count >= 1000000
        AND ((candidate.state = 'pending'
            AND candidate.next_attempt_at <= pg_catalog.statement_timestamp())
          OR (candidate.state = 'publishing'
            AND candidate.lease_expires_at <= pg_catalog.statement_timestamp()))
      ORDER BY candidate.next_attempt_at, candidate.created_at, candidate.id
      FOR UPDATE SKIP LOCKED
      LIMIT $1
    ), exhausted AS (
      UPDATE %1$I.editable_artifact_live_outbox target
      SET state = 'dead_lettered', lease_owner = NULL, lease_expires_at = NULL,
        last_error_code = 'attempts_exhausted',
        dead_lettered_at = pg_catalog.statement_timestamp()
      FROM exhausted_candidates
      WHERE target.id = exhausted_candidates.id
      RETURNING target.id
    ), candidates AS (
      SELECT candidate.id
      FROM %1$I.editable_artifact_live_outbox candidate
      WHERE candidate.attempt_count < 1000000
        AND ((candidate.state = 'pending'
            AND candidate.next_attempt_at <= pg_catalog.statement_timestamp())
          OR (candidate.state = 'publishing'
            AND candidate.lease_expires_at <= pg_catalog.statement_timestamp()))
      ORDER BY candidate.next_attempt_at, candidate.created_at, candidate.id
      FOR UPDATE SKIP LOCKED
      LIMIT $1
    ), claimed AS (
      UPDATE %1$I.editable_artifact_live_outbox target
      SET state = 'publishing',
        attempt_count = target.attempt_count + 1,
        lease_owner = $2,
        lease_expires_at = pg_catalog.statement_timestamp()
          + pg_catalog.make_interval(secs => $3 / 1000.0),
        last_error_code = NULL
      FROM candidates
      WHERE target.id = candidates.id
      RETURNING target.*
    )
    SELECT claimed.id, claimed.account_id, claimed.workspace_id,
      claimed.artifact_id, claimed.transaction_id, claimed.snapshot_id,
      claimed.event_kind, claimed.event, claimed.state, claimed.attempt_count,
      claimed.lease_owner, claimed.lease_expires_at, claimed.next_attempt_at,
      claimed.last_error_code, claimed.published_at, claimed.dead_lettered_at,
      claimed.created_at
    FROM claimed
    CROSS JOIN (SELECT count(*) FROM exhausted) exhausted_barrier
    ORDER BY claimed.created_at, claimed.id
  $query$, data_schema) USING p_limit, p_owner, p_lease_duration_ms;
END;
$body$;

CREATE OR REPLACE FUNCTION opengeni_private.renew_editable_artifact_live_outbox(
  p_outbox_id text,
  p_owner text,
  p_attempt_count integer,
  p_lease_duration_ms integer,
  p_data_schema name
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE affected integer;
DECLARE data_schema name;
BEGIN
  IF p_outbox_id IS NULL OR p_outbox_id !~ '^[0-9a-f]{32}$' OR p_outbox_id ~ '^0+$'
    OR p_owner IS NULL OR pg_catalog.octet_length(p_owner) NOT BETWEEN 1 AND 256
    OR p_attempt_count IS NULL OR p_attempt_count NOT BETWEEN 1 AND 1000000
    OR p_lease_duration_ms IS NULL OR p_lease_duration_ms NOT BETWEEN 1 AND 86400000
    OR p_data_schema IS NULL
  THEN
    RAISE EXCEPTION 'invalid editable artifact outbox renewal bounds'
      USING ERRCODE = '22023';
  END IF;
  data_schema := opengeni_private.resolve_editable_artifact_data_schema(p_data_schema);
  EXECUTE pg_catalog.format($query$
    UPDATE %I.editable_artifact_live_outbox target
    SET lease_expires_at = pg_catalog.statement_timestamp()
      + pg_catalog.make_interval(secs => $4 / 1000.0)
    WHERE target.id = $1
      AND target.state = 'publishing'
      AND target.lease_owner = $2
      AND target.attempt_count = $3
      AND target.lease_expires_at > pg_catalog.statement_timestamp()
  $query$, data_schema)
  USING p_outbox_id, p_owner, p_attempt_count, p_lease_duration_ms;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected = 1;
END;
$body$;

CREATE OR REPLACE FUNCTION opengeni_private.retry_editable_artifact_live_outbox(
  p_outbox_id text,
  p_owner text,
  p_attempt_count integer,
  p_retry_delay_ms integer,
  p_error_code text,
  p_data_schema name
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE affected integer;
DECLARE data_schema name;
BEGIN
  IF p_outbox_id IS NULL OR p_outbox_id !~ '^[0-9a-f]{32}$' OR p_outbox_id ~ '^0+$'
    OR p_owner IS NULL OR pg_catalog.octet_length(p_owner) NOT BETWEEN 1 AND 256
    OR p_attempt_count IS NULL OR p_attempt_count NOT BETWEEN 1 AND 1000000
    OR p_retry_delay_ms IS NULL OR p_retry_delay_ms NOT BETWEEN 1 AND 86400000
    OR p_error_code NOT IN ('broker_unavailable', 'broker_backpressure', 'publish_timeout')
    OR p_data_schema IS NULL
  THEN
    RAISE EXCEPTION 'invalid editable artifact outbox retry bounds'
      USING ERRCODE = '22023';
  END IF;
  data_schema := opengeni_private.resolve_editable_artifact_data_schema(p_data_schema);
  EXECUTE pg_catalog.format($query$
    UPDATE %I.editable_artifact_live_outbox target
    SET state = 'pending', lease_owner = NULL, lease_expires_at = NULL,
      next_attempt_at = pg_catalog.statement_timestamp()
        + pg_catalog.make_interval(secs => $4 / 1000.0),
      last_error_code = $5
    WHERE target.id = $1
      AND target.state = 'publishing'
      AND target.lease_owner = $2
      AND target.attempt_count = $3
      AND target.lease_expires_at > pg_catalog.statement_timestamp()
      AND target.lease_expires_at > pg_catalog.statement_timestamp()
  $query$, data_schema)
  USING p_outbox_id, p_owner, p_attempt_count, p_retry_delay_ms, p_error_code;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected = 1 THEN RETURN true; END IF;
  EXECUTE pg_catalog.format($query$
    SELECT count(*)::integer
    FROM %I.editable_artifact_live_outbox target
    WHERE target.id = $1 AND target.state = 'pending'
      AND target.attempt_count = $2 AND target.last_error_code = $3
  $query$, data_schema) INTO affected
  USING p_outbox_id, p_attempt_count, p_error_code;
  RETURN affected = 1;
END;
$body$;

CREATE OR REPLACE FUNCTION opengeni_private.dead_letter_editable_artifact_live_outbox(
  p_outbox_id text,
  p_owner text,
  p_attempt_count integer,
  p_error_code text,
  p_data_schema name
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE affected integer;
DECLARE data_schema name;
BEGIN
  IF p_outbox_id IS NULL OR p_outbox_id !~ '^[0-9a-f]{32}$' OR p_outbox_id ~ '^0+$'
    OR p_owner IS NULL OR pg_catalog.octet_length(p_owner) NOT BETWEEN 1 AND 256
    OR p_attempt_count IS NULL OR p_attempt_count NOT BETWEEN 1 AND 1000000
    OR p_error_code NOT IN ('invalid_hint', 'oversized_hint')
    OR p_data_schema IS NULL
  THEN
    RAISE EXCEPTION 'invalid editable artifact outbox dead-letter bounds'
      USING ERRCODE = '22023';
  END IF;
  data_schema := opengeni_private.resolve_editable_artifact_data_schema(p_data_schema);
  EXECUTE pg_catalog.format($query$
    UPDATE %I.editable_artifact_live_outbox target
    SET state = 'dead_lettered', lease_owner = NULL, lease_expires_at = NULL,
      last_error_code = $4, dead_lettered_at = pg_catalog.statement_timestamp()
    WHERE target.id = $1
      AND target.state = 'publishing'
      AND target.lease_owner = $2
      AND target.attempt_count = $3
      AND target.lease_expires_at > pg_catalog.statement_timestamp()
  $query$, data_schema)
  USING p_outbox_id, p_owner, p_attempt_count, p_error_code;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected = 1 THEN RETURN true; END IF;
  EXECUTE pg_catalog.format($query$
    SELECT count(*)::integer
    FROM %I.editable_artifact_live_outbox target
    WHERE target.id = $1 AND target.state = 'dead_lettered'
      AND target.attempt_count = $2 AND target.last_error_code = $3
  $query$, data_schema) INTO affected
  USING p_outbox_id, p_attempt_count, p_error_code;
  RETURN affected = 1;
END;
$body$;

CREATE OR REPLACE FUNCTION opengeni_private.mark_editable_artifact_live_outbox_published(
  p_outbox_id text,
  p_owner text,
  p_attempt_count integer,
  p_data_schema name
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE affected integer;
DECLARE data_schema name;
BEGIN
  IF p_outbox_id IS NULL
    OR p_outbox_id !~ '^[0-9a-f]{32}$' OR p_outbox_id ~ '^0+$'
    OR p_owner IS NULL OR pg_catalog.octet_length(p_owner) NOT BETWEEN 1 AND 256
    OR p_attempt_count IS NULL OR p_attempt_count NOT BETWEEN 1 AND 1000000
    OR p_data_schema IS NULL
  THEN
    RAISE EXCEPTION 'invalid editable artifact outbox settlement bounds'
      USING ERRCODE = '22023';
  END IF;
  data_schema := opengeni_private.resolve_editable_artifact_data_schema(p_data_schema);
  EXECUTE pg_catalog.format($query$
    UPDATE %I.editable_artifact_live_outbox target
    SET state = 'published', published_at = pg_catalog.statement_timestamp(),
      lease_owner = NULL, lease_expires_at = NULL, last_error_code = NULL
    WHERE target.id = $1
      AND target.state = 'publishing'
      AND target.lease_owner = $2
      AND target.attempt_count = $3
      AND target.lease_expires_at > pg_catalog.statement_timestamp()
  $query$, data_schema) USING p_outbox_id, p_owner, p_attempt_count;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected = 1 THEN RETURN true; END IF;
  EXECUTE pg_catalog.format($query$
    SELECT count(*)::integer
    FROM %I.editable_artifact_live_outbox target
    WHERE target.id = $1
      AND target.attempt_count = $2
      AND target.state = 'published'
  $query$, data_schema) INTO affected USING p_outbox_id, p_attempt_count;
  RETURN affected = 1;
END;
$body$;

CREATE OR REPLACE FUNCTION opengeni_private.release_editable_artifact_live_outbox(
  p_outbox_id text,
  p_owner text,
  p_attempt_count integer,
  p_data_schema name
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE affected integer;
DECLARE data_schema name;
BEGIN
  IF p_outbox_id IS NULL
    OR p_outbox_id !~ '^[0-9a-f]{32}$' OR p_outbox_id ~ '^0+$'
    OR p_owner IS NULL OR pg_catalog.octet_length(p_owner) NOT BETWEEN 1 AND 256
    OR p_attempt_count IS NULL OR p_attempt_count NOT BETWEEN 1 AND 1000000
    OR p_data_schema IS NULL
  THEN
    RAISE EXCEPTION 'invalid editable artifact outbox release bounds'
      USING ERRCODE = '22023';
  END IF;
  data_schema := opengeni_private.resolve_editable_artifact_data_schema(p_data_schema);
  EXECUTE pg_catalog.format($query$
    UPDATE %I.editable_artifact_live_outbox target
    SET state = 'pending', lease_owner = NULL, lease_expires_at = NULL,
      next_attempt_at = pg_catalog.statement_timestamp()
    WHERE target.id = $1
      AND target.state = 'publishing'
      AND target.lease_owner = $2
      AND target.attempt_count = $3
      AND target.lease_expires_at > pg_catalog.statement_timestamp()
  $query$, data_schema) USING p_outbox_id, p_owner, p_attempt_count;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected = 1 THEN RETURN true; END IF;
  EXECUTE pg_catalog.format($query$
    SELECT count(*)::integer
    FROM %I.editable_artifact_live_outbox target
    WHERE target.id = $1
      AND target.attempt_count = $2
      AND ((target.state = 'pending' AND target.lease_owner IS NULL)
        OR target.state = 'published')
  $query$, data_schema) INTO affected USING p_outbox_id, p_attempt_count;
  RETURN affected = 1;
END;
$body$;

-- Cross-workspace materialization is a dedicated database capability. The
-- worker owns no table privileges: these SECURITY DEFINER routines are the only
-- path from a global claim to an exact, lease-fenced terminal projection.
CREATE OR REPLACE FUNCTION opengeni_private.claim_editable_artifact_materializations(
  p_owner text,
  p_lease_duration_ms integer,
  p_limit integer,
  p_data_schema name
) RETURNS TABLE (
  account_id uuid,
  workspace_id uuid,
  artifact_id text,
  job_id text,
  version_id text,
  modality text,
  input_snapshot_id text,
  target_head_sequence bigint,
  state_hash text,
  source_object_reference text,
  source_byte_size bigint,
  source_content_hash text,
  source_mime_type text,
  model_schema_version integer,
  operation_protocol_version integer,
  snapshot_protocol_version integer,
  format text,
  codec_id text,
  normalized_options text,
  options_hash text,
  codec_version text,
  kernel_version text,
  font_registry_hash text,
  policy_hash text,
  attempt_count integer,
  lease_owner text,
  lease_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE data_schema name;
BEGIN
  IF p_owner IS NULL OR pg_catalog.octet_length(p_owner) NOT BETWEEN 1 AND 256
    OR p_owner <> pg_catalog.btrim(p_owner)
    OR p_lease_duration_ms IS NULL
    OR p_lease_duration_ms NOT BETWEEN 1 AND 86400000
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000
    OR p_data_schema IS NULL
  THEN
    RAISE EXCEPTION 'invalid editable artifact materialization claim bounds'
      USING ERRCODE = '22023';
  END IF;
  data_schema := opengeni_private.resolve_editable_artifact_data_schema(p_data_schema);
  RETURN QUERY EXECUTE pg_catalog.format($query$
    WITH exhausted_candidates AS MATERIALIZED (
      SELECT candidate.account_id, candidate.workspace_id,
        candidate.artifact_id, candidate.id
      FROM %1$I.editable_artifact_materialization_jobs candidate
      WHERE candidate.state = 'running'
        AND candidate.attempt_count >= 1000
        AND candidate.lease_expires_at <= pg_catalog.statement_timestamp()
      ORDER BY candidate.lease_expires_at, candidate.created_at,
        candidate.account_id, candidate.workspace_id, candidate.artifact_id, candidate.id
      FOR UPDATE OF candidate SKIP LOCKED
      LIMIT $1
    ), exhausted AS (
      UPDATE %1$I.editable_artifact_materialization_jobs target
      SET state = 'failed', settled_by_owner = target.lease_owner,
        lease_owner = NULL, lease_expires_at = NULL,
        error_code = 'attempts_exhausted',
        completed_at = pg_catalog.statement_timestamp()
      FROM exhausted_candidates
      WHERE target.account_id = exhausted_candidates.account_id
        AND target.workspace_id = exhausted_candidates.workspace_id
        AND target.artifact_id = exhausted_candidates.artifact_id
        AND target.id = exhausted_candidates.id
      RETURNING target.id
    ), candidates AS (
      SELECT candidate.account_id, candidate.workspace_id,
        candidate.artifact_id, candidate.id
      FROM %1$I.editable_artifact_materialization_jobs candidate
      WHERE candidate.attempt_count < 1000
        AND (candidate.state = 'pending' OR (
          candidate.state = 'running'
          AND candidate.lease_expires_at <= pg_catalog.statement_timestamp()
        ))
      ORDER BY COALESCE(candidate.lease_expires_at, candidate.created_at),
        candidate.created_at, candidate.account_id, candidate.workspace_id,
        candidate.artifact_id, candidate.id
      FOR UPDATE OF candidate SKIP LOCKED
      LIMIT $1
    ), claimed AS (
      UPDATE %1$I.editable_artifact_materialization_jobs target
      SET state = 'running', attempt_count = target.attempt_count + 1,
        lease_owner = $2,
        lease_expires_at = pg_catalog.statement_timestamp()
          + pg_catalog.make_interval(secs => $3 / 1000.0),
        settled_by_owner = NULL, error_code = NULL,
        started_at = pg_catalog.statement_timestamp(), completed_at = NULL
      FROM candidates
      WHERE target.account_id = candidates.account_id
        AND target.workspace_id = candidates.workspace_id
        AND target.artifact_id = candidates.artifact_id
        AND target.id = candidates.id
      RETURNING target.*
    )
    SELECT claimed.account_id, claimed.workspace_id, claimed.artifact_id,
      claimed.id, claimed.version_id, artifact.modality, claimed.input_snapshot_id,
      claimed.target_head_sequence, claimed.state_hash,
      source_blob.object_reference, source_blob.byte_size,
      source_blob.content_hash, source_blob.mime_type,
      source_snapshot.model_schema_version, source_snapshot.operation_protocol_version,
      source_snapshot.crdt_state_version,
      claimed.format, claimed.codec_id, claimed.normalized_options,
      claimed.options_hash, claimed.codec_version, claimed.kernel_version,
      claimed.font_registry_hash, claimed.policy_hash, claimed.attempt_count,
      claimed.lease_owner, claimed.lease_expires_at
    FROM claimed
    CROSS JOIN (SELECT count(*) FROM exhausted) exhausted_barrier
    JOIN %1$I.editable_artifacts artifact
      ON artifact.account_id = claimed.account_id
     AND artifact.workspace_id = claimed.workspace_id
     AND artifact.id = claimed.artifact_id
    JOIN %1$I.editable_artifact_snapshots source_snapshot
      ON source_snapshot.account_id = claimed.account_id
     AND source_snapshot.workspace_id = claimed.workspace_id
     AND source_snapshot.artifact_id = claimed.artifact_id
     AND source_snapshot.id = claimed.input_snapshot_id
     AND source_snapshot.covered_head_sequence = claimed.target_head_sequence
     AND source_snapshot.state_hash = claimed.state_hash
    JOIN %1$I.editable_artifact_blob_refs source_blob
      ON source_blob.account_id = source_snapshot.account_id
     AND source_blob.workspace_id = source_snapshot.workspace_id
     AND source_blob.artifact_id = source_snapshot.artifact_id
     AND source_blob.id = source_snapshot.blob_ref_id
     AND source_blob.kind = 'snapshot'
     AND source_blob.byte_size = source_snapshot.byte_size
     AND source_blob.content_hash = source_snapshot.content_hash
     AND source_blob.mime_type = source_snapshot.mime_type
    ORDER BY claimed.created_at, claimed.account_id, claimed.workspace_id,
      claimed.artifact_id, claimed.id
  $query$, data_schema) USING p_limit, p_owner, p_lease_duration_ms;
END;
$body$;

CREATE OR REPLACE FUNCTION opengeni_private.renew_editable_artifact_materialization(
  p_account_id uuid,
  p_workspace_id uuid,
  p_artifact_id text,
  p_job_id text,
  p_owner text,
  p_attempt_count integer,
  p_lease_duration_ms integer,
  p_data_schema name
) RETURNS TABLE (
  account_id uuid,
  workspace_id uuid,
  artifact_id text,
  job_id text,
  lease_owner text,
  attempt_count integer,
  lease_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE data_schema name;
BEGIN
  IF p_account_id IS NULL OR p_workspace_id IS NULL
    OR p_artifact_id IS NULL OR p_artifact_id !~ '^[0-9a-f]{32}$'
    OR p_artifact_id ~ '^0+$'
    OR p_job_id IS NULL OR p_job_id !~ '^[0-9a-f]{32}$' OR p_job_id ~ '^0+$'
    OR p_owner IS NULL OR pg_catalog.octet_length(p_owner) NOT BETWEEN 1 AND 256
    OR p_owner <> pg_catalog.btrim(p_owner)
    OR p_attempt_count IS NULL OR p_attempt_count NOT BETWEEN 1 AND 1000
    OR p_lease_duration_ms IS NULL
    OR p_lease_duration_ms NOT BETWEEN 1 AND 86400000
    OR p_data_schema IS NULL
  THEN
    RAISE EXCEPTION 'invalid editable artifact materialization renewal bounds'
      USING ERRCODE = '22023';
  END IF;
  data_schema := opengeni_private.resolve_editable_artifact_data_schema(p_data_schema);
  RETURN QUERY EXECUTE pg_catalog.format($query$
    UPDATE %I.editable_artifact_materialization_jobs target
    SET lease_expires_at = GREATEST(
      target.lease_expires_at + interval '1 microsecond',
      pg_catalog.statement_timestamp()
        + pg_catalog.make_interval(secs => $7 / 1000.0)
    )
    WHERE target.account_id = $1 AND target.workspace_id = $2
      AND target.artifact_id = $3 AND target.id = $4
      AND target.state = 'running' AND target.lease_owner = $5
      AND target.attempt_count = $6
      AND target.lease_expires_at > pg_catalog.statement_timestamp()
    RETURNING target.account_id, target.workspace_id, target.artifact_id,
      target.id, target.lease_owner, target.attempt_count,
      target.lease_expires_at
  $query$, data_schema)
  USING p_account_id, p_workspace_id, p_artifact_id, p_job_id, p_owner,
    p_attempt_count, p_lease_duration_ms;
END;
$body$;

CREATE OR REPLACE FUNCTION opengeni_private.succeed_editable_artifact_materialization(
  p_account_id uuid,
  p_workspace_id uuid,
  p_artifact_id text,
  p_job_id text,
  p_owner text,
  p_attempt_count integer,
  p_result_id text,
  p_blob_ref_id text,
  p_object_reference text,
  p_byte_size bigint,
  p_content_hash text,
  p_mime_type text,
  p_verified_at timestamptz,
  p_data_schema name
) RETURNS TABLE (
  outcome text,
  account_id uuid,
  workspace_id uuid,
  artifact_id text,
  job_id text,
  result_id text,
  blob_ref_id text,
  object_reference text,
  byte_size bigint,
  content_hash text,
  mime_type text,
  verified_at timestamptz,
  created_at timestamptz,
  settled_by_owner text,
  attempt_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE data_schema name;
DECLARE affected integer := 0;
DECLARE job_state text;
DECLARE job_attempt integer;
DECLARE job_owner text;
DECLARE job_lease_expires_at timestamptz;
DECLARE job_format text;
BEGIN
  IF p_account_id IS NULL OR p_workspace_id IS NULL
    OR p_artifact_id IS NULL OR p_artifact_id !~ '^[0-9a-f]{32}$'
    OR p_artifact_id ~ '^0+$'
    OR p_job_id IS NULL OR p_job_id !~ '^[0-9a-f]{32}$' OR p_job_id ~ '^0+$'
    OR p_owner IS NULL OR pg_catalog.octet_length(p_owner) NOT BETWEEN 1 AND 256
    OR p_owner <> pg_catalog.btrim(p_owner)
    OR p_attempt_count IS NULL OR p_attempt_count NOT BETWEEN 1 AND 1000
    OR p_result_id IS NULL OR p_result_id !~ '^[0-9a-f]{32}$'
    OR p_result_id ~ '^0+$'
    OR p_blob_ref_id IS NULL OR p_blob_ref_id !~ '^[0-9a-f]{32}$'
    OR p_blob_ref_id ~ '^0+$'
    OR p_object_reference IS NULL
    OR pg_catalog.octet_length(p_object_reference) NOT BETWEEN 1 AND 1024
    OR p_object_reference <> pg_catalog.btrim(p_object_reference)
    OR p_byte_size IS NULL OR p_byte_size NOT BETWEEN 1 AND 9007199254740991
    OR p_content_hash IS NULL OR p_content_hash !~ '^sha256:[0-9a-f]{64}$'
    OR p_mime_type NOT IN (
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/pdf', 'image/png', 'image/webp'
    )
    OR p_verified_at IS NULL
    OR p_verified_at > pg_catalog.clock_timestamp() + interval '5 minutes'
    OR p_data_schema IS NULL
  THEN
    RAISE EXCEPTION 'invalid editable artifact materialization success bounds'
      USING ERRCODE = '22023';
  END IF;
  data_schema := opengeni_private.resolve_editable_artifact_data_schema(p_data_schema);

  job_state := NULL;
  EXECUTE pg_catalog.format($query$
    SELECT target.state, target.attempt_count, target.lease_owner,
      target.lease_expires_at, target.format
    FROM %I.editable_artifact_materialization_jobs target
    WHERE target.account_id = $1 AND target.workspace_id = $2
      AND target.artifact_id = $3 AND target.id = $4
    FOR UPDATE
  $query$, data_schema)
  INTO job_state, job_attempt, job_owner, job_lease_expires_at, job_format
  USING p_account_id, p_workspace_id, p_artifact_id, p_job_id;
  IF job_state IS NULL THEN RETURN; END IF;

  -- A lost successful response is replayable only when every immutable output
  -- fact and the exact settled lease fence match. A stale/different caller gets
  -- no row and is surfaced as lease_fenced by the repository.
  IF job_state = 'succeeded' THEN
    RETURN QUERY EXECUTE pg_catalog.format($query$
      SELECT 'replayed'::text, job.account_id, job.workspace_id,
        job.artifact_id, job.id, result.id, result.blob_ref_id,
        blob.object_reference, result.byte_size, result.content_hash,
        result.mime_type, result.verified_at, result.created_at,
        job.settled_by_owner, job.attempt_count
      FROM %1$I.editable_artifact_materialization_jobs job
      JOIN %1$I.editable_artifact_materialization_results result
        ON result.account_id = job.account_id
        AND result.workspace_id = job.workspace_id
        AND result.artifact_id = job.artifact_id AND result.job_id = job.id
      JOIN %1$I.editable_artifact_blob_refs blob
        ON blob.account_id = result.account_id
        AND blob.workspace_id = result.workspace_id
        AND blob.artifact_id = result.artifact_id AND blob.id = result.blob_ref_id
      WHERE job.account_id = $1 AND job.workspace_id = $2
        AND job.artifact_id = $3 AND job.id = $4
        AND job.state = 'succeeded' AND job.settled_by_owner = $5
        AND job.attempt_count = $6 AND result.id = $7
        AND result.blob_ref_id = $8 AND blob.kind = 'materialization'
        AND blob.object_reference = $9 AND result.byte_size = $10
        AND result.content_hash = $11 AND result.mime_type = $12
        AND result.verified_at = $13
        AND blob.byte_size = result.byte_size
        AND blob.content_hash = result.content_hash
        AND blob.mime_type = result.mime_type
    $query$, data_schema)
    USING p_account_id, p_workspace_id, p_artifact_id, p_job_id, p_owner,
      p_attempt_count, p_result_id, p_blob_ref_id, p_object_reference,
      p_byte_size, p_content_hash, p_mime_type, p_verified_at;
    RETURN;
  END IF;

  IF job_state <> 'running' OR job_owner IS DISTINCT FROM p_owner
    OR job_attempt IS DISTINCT FROM p_attempt_count
    OR job_lease_expires_at <= pg_catalog.statement_timestamp()
  THEN
    RETURN;
  END IF;
  IF p_mime_type <> (CASE job_format
    WHEN 'xlsx' THEN 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    WHEN 'pptx' THEN 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    WHEN 'docx' THEN 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    WHEN 'pdf' THEN 'application/pdf'
    WHEN 'png' THEN 'image/png'
    WHEN 'webp' THEN 'image/webp'
  END) THEN
    RAISE EXCEPTION 'materialization MIME type differs from the claimed format'
      USING ERRCODE = '22023';
  END IF;

  EXECUTE pg_catalog.format($query$
    INSERT INTO %I.editable_artifact_blob_refs (
      account_id, workspace_id, artifact_id, id, kind, object_reference,
      byte_size, content_hash, mime_type, created_at
    ) VALUES ($1, $2, $3, $4, 'materialization', $5, $6, $7, $8,
      pg_catalog.statement_timestamp())
    ON CONFLICT DO NOTHING
  $query$, data_schema)
  USING p_account_id, p_workspace_id, p_artifact_id, p_blob_ref_id,
    p_object_reference, p_byte_size, p_content_hash, p_mime_type;
  EXECUTE pg_catalog.format($query$
    SELECT pg_catalog.count(*)::integer
    FROM %I.editable_artifact_blob_refs blob
    WHERE blob.account_id = $1 AND blob.workspace_id = $2
      AND blob.artifact_id = $3 AND blob.id = $4
      AND blob.kind = 'materialization' AND blob.object_reference = $5
      AND blob.byte_size = $6 AND blob.content_hash = $7 AND blob.mime_type = $8
  $query$, data_schema) INTO affected
  USING p_account_id, p_workspace_id, p_artifact_id, p_blob_ref_id,
    p_object_reference, p_byte_size, p_content_hash, p_mime_type;
  IF affected <> 1 THEN
    RAISE EXCEPTION 'materialization blob identity conflicts with immutable facts'
      USING ERRCODE = '23505';
  END IF;

  EXECUTE pg_catalog.format($query$
    UPDATE %I.editable_artifact_materialization_jobs target
    SET state = 'succeeded', settled_by_owner = target.lease_owner,
      lease_owner = NULL, lease_expires_at = NULL, error_code = NULL,
      completed_at = pg_catalog.statement_timestamp()
    WHERE target.account_id = $1 AND target.workspace_id = $2
      AND target.artifact_id = $3 AND target.id = $4
      AND target.state = 'running' AND target.lease_owner = $5
      AND target.attempt_count = $6
      AND target.lease_expires_at > pg_catalog.statement_timestamp()
  $query$, data_schema)
  USING p_account_id, p_workspace_id, p_artifact_id, p_job_id, p_owner,
    p_attempt_count;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RETURN; END IF;

  EXECUTE pg_catalog.format($query$
    INSERT INTO %I.editable_artifact_materialization_results (
      account_id, workspace_id, artifact_id, id, job_id, blob_ref_id,
      byte_size, content_hash, mime_type, verified_at, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
      GREATEST(pg_catalog.statement_timestamp(), $10))
  $query$, data_schema)
  USING p_account_id, p_workspace_id, p_artifact_id, p_result_id, p_job_id,
    p_blob_ref_id, p_byte_size, p_content_hash, p_mime_type, p_verified_at;

  RETURN QUERY EXECUTE pg_catalog.format($query$
    SELECT 'committed'::text, job.account_id, job.workspace_id,
      job.artifact_id, job.id, result.id, result.blob_ref_id,
      blob.object_reference, result.byte_size, result.content_hash,
      result.mime_type, result.verified_at, result.created_at,
      job.settled_by_owner, job.attempt_count
    FROM %1$I.editable_artifact_materialization_jobs job
    JOIN %1$I.editable_artifact_materialization_results result
      ON result.account_id = job.account_id AND result.workspace_id = job.workspace_id
      AND result.artifact_id = job.artifact_id AND result.job_id = job.id
    JOIN %1$I.editable_artifact_blob_refs blob
      ON blob.account_id = result.account_id AND blob.workspace_id = result.workspace_id
      AND blob.artifact_id = result.artifact_id AND blob.id = result.blob_ref_id
    WHERE job.account_id = $1 AND job.workspace_id = $2
      AND job.artifact_id = $3 AND job.id = $4 AND result.id = $5
  $query$, data_schema)
  USING p_account_id, p_workspace_id, p_artifact_id, p_job_id, p_result_id;
END;
$body$;

CREATE OR REPLACE FUNCTION opengeni_private.fail_editable_artifact_materialization(
  p_account_id uuid,
  p_workspace_id uuid,
  p_artifact_id text,
  p_job_id text,
  p_owner text,
  p_attempt_count integer,
  p_error_code text,
  p_data_schema name
) RETURNS TABLE (
  outcome text,
  account_id uuid,
  workspace_id uuid,
  artifact_id text,
  job_id text,
  settled_by_owner text,
  attempt_count integer,
  error_code text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE data_schema name;
DECLARE affected integer := 0;
DECLARE job_state text;
DECLARE job_attempt integer;
DECLARE job_owner text;
DECLARE job_lease_expires_at timestamptz;
DECLARE job_settled_by_owner text;
DECLARE job_error_code text;
BEGIN
  IF p_account_id IS NULL OR p_workspace_id IS NULL
    OR p_artifact_id IS NULL OR p_artifact_id !~ '^[0-9a-f]{32}$'
    OR p_artifact_id ~ '^0+$'
    OR p_job_id IS NULL OR p_job_id !~ '^[0-9a-f]{32}$' OR p_job_id ~ '^0+$'
    OR p_owner IS NULL OR pg_catalog.octet_length(p_owner) NOT BETWEEN 1 AND 256
    OR p_owner <> pg_catalog.btrim(p_owner)
    OR p_attempt_count IS NULL OR p_attempt_count NOT BETWEEN 1 AND 1000
    OR p_error_code IS NULL OR p_error_code !~ '^[a-z][a-z0-9_.-]{0,127}$'
    OR p_data_schema IS NULL
  THEN
    RAISE EXCEPTION 'invalid editable artifact materialization failure bounds'
      USING ERRCODE = '22023';
  END IF;
  data_schema := opengeni_private.resolve_editable_artifact_data_schema(p_data_schema);
  job_state := NULL;
  EXECUTE pg_catalog.format($query$
    SELECT target.state, target.attempt_count, target.lease_owner,
      target.lease_expires_at, target.settled_by_owner, target.error_code
    FROM %I.editable_artifact_materialization_jobs target
    WHERE target.account_id = $1 AND target.workspace_id = $2
      AND target.artifact_id = $3 AND target.id = $4
    FOR UPDATE
  $query$, data_schema)
  INTO job_state, job_attempt, job_owner, job_lease_expires_at,
    job_settled_by_owner, job_error_code
  USING p_account_id, p_workspace_id, p_artifact_id, p_job_id;

  IF job_state = 'failed' AND job_attempt = p_attempt_count
    AND job_settled_by_owner = p_owner AND job_error_code = p_error_code
  THEN
    RETURN QUERY SELECT 'replayed'::text, p_account_id, p_workspace_id,
      p_artifact_id, p_job_id, job_settled_by_owner, job_attempt, job_error_code;
    RETURN;
  END IF;
  IF job_state <> 'running' OR job_owner IS DISTINCT FROM p_owner
    OR job_attempt IS DISTINCT FROM p_attempt_count
    OR job_lease_expires_at <= pg_catalog.statement_timestamp()
  THEN
    RETURN QUERY SELECT 'fenced'::text, p_account_id, p_workspace_id,
      p_artifact_id, p_job_id, p_owner, p_attempt_count, p_error_code;
    RETURN;
  END IF;

  EXECUTE pg_catalog.format($query$
    UPDATE %I.editable_artifact_materialization_jobs target
    SET state = 'failed', settled_by_owner = target.lease_owner,
      lease_owner = NULL, lease_expires_at = NULL, error_code = $7,
      completed_at = pg_catalog.statement_timestamp()
    WHERE target.account_id = $1 AND target.workspace_id = $2
      AND target.artifact_id = $3 AND target.id = $4
      AND target.state = 'running' AND target.lease_owner = $5
      AND target.attempt_count = $6
      AND target.lease_expires_at > pg_catalog.statement_timestamp()
  $query$, data_schema)
  USING p_account_id, p_workspace_id, p_artifact_id, p_job_id, p_owner,
    p_attempt_count, p_error_code;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RETURN QUERY SELECT 'fenced'::text, p_account_id, p_workspace_id,
      p_artifact_id, p_job_id, p_owner, p_attempt_count, p_error_code;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'failed'::text, p_account_id, p_workspace_id,
    p_artifact_id, p_job_id, p_owner, p_attempt_count, p_error_code;
END;
$body$;

REVOKE ALL ON FUNCTION
  opengeni_private.claim_editable_artifact_materializations(text, integer, integer, name)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  opengeni_private.renew_editable_artifact_materialization(
    uuid, uuid, text, text, text, integer, integer, name
  ) FROM PUBLIC;
REVOKE ALL ON FUNCTION
  opengeni_private.succeed_editable_artifact_materialization(
    uuid, uuid, text, text, text, integer, text, text, text, bigint,
    text, text, timestamptz, name
  ) FROM PUBLIC;
REVOKE ALL ON FUNCTION
  opengeni_private.fail_editable_artifact_materialization(
    uuid, uuid, text, text, text, integer, text, name
  ) FROM PUBLIC;
REVOKE ALL ON FUNCTION
  opengeni_private.ensure_editable_artifact_scope_authorization_head(uuid, uuid, name)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  opengeni_private.advance_editable_artifact_scope_authorization_revision(
    uuid, uuid, bigint, bigint, name
  ) FROM PUBLIC;
REVOKE ALL ON FUNCTION
  opengeni_private.claim_editable_artifact_live_outbox(text, integer, integer, name)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  opengeni_private.mark_editable_artifact_live_outbox_published(text, text, integer, name)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  opengeni_private.renew_editable_artifact_live_outbox(text, text, integer, integer, name)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  opengeni_private.retry_editable_artifact_live_outbox(
    text, text, integer, integer, text, name
  ) FROM PUBLIC;
REVOKE ALL ON FUNCTION
  opengeni_private.dead_letter_editable_artifact_live_outbox(
    text, text, integer, text, name
  ) FROM PUBLIC;
REVOKE ALL ON FUNCTION
  opengeni_private.release_editable_artifact_live_outbox(text, text, integer, name)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  opengeni_private.advance_editable_artifact_authorization_revision(
    uuid, uuid, text, bigint, bigint, name
  ) FROM PUBLIC;
REVOKE ALL ON FUNCTION
  opengeni_private.resolve_editable_artifact_data_schema(name) FROM PUBLIC;
REVOKE ALL ON FUNCTION
  opengeni_private.editable_artifact_frontier_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION
  opengeni_private.editable_artifact_id_array_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION
  opengeni_private.editable_artifact_frontier_dominates(jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION
  opengeni_private.editable_artifact_frontier_merge_dot_equals(
    jsonb, jsonb, jsonb, text, bigint
  ) FROM PUBLIC;
REVOKE ALL ON FUNCTION
  opengeni_private.editable_artifact_object_has_exact_keys(jsonb, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION
  opengeni_private.editable_artifact_actor_key_matches(
    text, text, text, text, text, text, integer, text
  ) FROM PUBLIC;

DO $rls$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'editable_artifact_scope_authorization_heads',
    'editable_artifacts',
    'editable_artifact_transactions',
    'editable_artifact_operations',
    'editable_artifact_idempotency_receipts',
    'editable_artifact_undo_claims',
    'editable_artifact_sequence_checkpoints',
    'editable_artifact_blob_refs',
    'editable_artifact_snapshots',
    'editable_artifact_versions',
    'editable_artifact_materialization_jobs',
    'editable_artifact_materialization_results',
    'editable_artifact_live_outbox',
    'editable_artifact_replica_leases'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY workspace_isolation ON %I '
      || 'USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) '
      || 'WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id))',
      table_name
    );
  END LOOP;
END;
$rls$;

-- FORCE RLS also applies to a table owner. This narrow owner-only policy lets
-- the audited SECURITY DEFINER outbox capability claim across workspaces while
-- ordinary runtime SQL remains constrained by workspace_isolation.
DO $outbox_dispatch_policy$
DECLARE data_schema text := current_schema();
DECLARE migration_owner text := current_user;
BEGIN
  EXECUTE format(
    'CREATE POLICY editable_artifact_outbox_dispatcher ON %I.editable_artifact_live_outbox '
    || 'FOR ALL USING (current_user = %L) WITH CHECK (current_user = %L)',
    data_schema, migration_owner, migration_owner
  );
END;
$outbox_dispatch_policy$;

-- The materializer's definer owner needs a deliberately narrow FORCE-RLS path
-- for its global claim and atomic projection. The login role itself receives
-- no table privilege and therefore cannot exercise these policies directly.
DO $artifact_materializer_policy$
DECLARE data_schema text := current_schema();
DECLARE migration_owner text := current_user;
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'editable_artifact_materialization_jobs',
    'editable_artifact_materialization_results',
    'editable_artifact_blob_refs'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY editable_artifact_materializer_owner ON %I.%I FOR ALL '
      || 'USING (current_user = %L) WITH CHECK (current_user = %L)',
      data_schema, table_name, migration_owner, migration_owner
    );
  END LOOP;
  FOREACH table_name IN ARRAY ARRAY[
    'editable_artifact_sequence_checkpoints',
    'editable_artifact_versions',
    'editable_artifact_idempotency_receipts'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY editable_artifact_materializer_owner ON %I.%I FOR SELECT '
      || 'USING (current_user = %L)',
      data_schema, table_name, migration_owner
    );
  END LOOP;
END;
$artifact_materializer_policy$;

-- The runtime may read the local create-policy fence, but only the narrow
-- owner functions may initialize or advance it across FORCE RLS.
DO $artifact_scope_authority_policy$
DECLARE data_schema text := current_schema();
DECLARE migration_owner text := current_user;
BEGIN
  EXECUTE format(
    'CREATE POLICY editable_artifact_scope_authority_owner '
    || 'ON %I.editable_artifact_scope_authorization_heads FOR ALL '
    || 'USING (current_user = %L) WITH CHECK (current_user = %L)',
    data_schema, migration_owner, migration_owner
  );
END;
$artifact_scope_authority_policy$;

-- PostgreSQL grants EXECUTE to PUBLIC on new functions by default. The private
-- schema is an explicit capability boundary: callers receive named grants,
-- never ambient PUBLIC execution. Preserve that invariant for future helpers
-- created by this migration owner as well.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA opengeni_private FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA opengeni_private
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

DO $runtime_grants$
DECLARE data_schema text := current_schema();
DECLARE table_name text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA opengeni_private TO opengeni_app;
    FOREACH table_name IN ARRAY ARRAY[
      'editable_artifact_scope_authorization_heads',
      'editable_artifacts',
      'editable_artifact_transactions',
      'editable_artifact_operations',
      'editable_artifact_idempotency_receipts',
      'editable_artifact_undo_claims',
      'editable_artifact_sequence_checkpoints',
      'editable_artifact_blob_refs',
      'editable_artifact_snapshots',
      'editable_artifact_versions',
      'editable_artifact_materialization_jobs',
      'editable_artifact_materialization_results',
      'editable_artifact_live_outbox',
      'editable_artifact_replica_leases'
    ] LOOP
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM opengeni_app',
        data_schema, table_name
      );
    END LOOP;
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE ON TABLE %I.editable_artifacts TO opengeni_app',
      data_schema
    );
    FOREACH table_name IN ARRAY ARRAY[
      'editable_artifact_transactions',
      'editable_artifact_operations',
      'editable_artifact_idempotency_receipts',
      'editable_artifact_undo_claims',
      'editable_artifact_sequence_checkpoints',
      'editable_artifact_blob_refs',
      'editable_artifact_snapshots',
      'editable_artifact_versions',
      'editable_artifact_materialization_results'
    ] LOOP
      EXECUTE format(
        'GRANT SELECT, INSERT ON TABLE %I.%I TO opengeni_app', data_schema, table_name
      );
    END LOOP;
    EXECUTE format(
      'GRANT SELECT, INSERT ON TABLE %I.editable_artifact_materialization_jobs '
      || 'TO opengeni_app', data_schema
    );
    EXECUTE format(
      'GRANT SELECT, INSERT ON TABLE %I.editable_artifact_live_outbox TO opengeni_app',
      data_schema
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.editable_artifact_replica_leases '
      || 'TO opengeni_app', data_schema
    );
    GRANT EXECUTE ON FUNCTION
      opengeni_private.ensure_editable_artifact_scope_authorization_head(
        uuid, uuid, name
      ) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION
      opengeni_private.advance_editable_artifact_scope_authorization_revision(
        uuid, uuid, bigint, bigint, name
      ) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION
      opengeni_private.advance_editable_artifact_authorization_revision(
        uuid, uuid, text, bigint, bigint, name
      ) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION
      opengeni_private.editable_artifact_frontier_valid(jsonb)
      TO opengeni_app;
    GRANT EXECUTE ON FUNCTION
      opengeni_private.editable_artifact_id_array_valid(jsonb)
      TO opengeni_app;
    GRANT EXECUTE ON FUNCTION
      opengeni_private.editable_artifact_object_has_exact_keys(jsonb, text[])
      TO opengeni_app;
    GRANT EXECUTE ON FUNCTION
      opengeni_private.editable_artifact_actor_key_matches(
        text, text, text, text, text, text, integer, text
      ) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION
      opengeni_private.editable_artifact_frontier_dominates(jsonb, jsonb)
      TO opengeni_app;
    GRANT EXECUTE ON FUNCTION
      opengeni_private.editable_artifact_frontier_merge_dot_equals(
        jsonb, jsonb, jsonb, text, bigint
      ) TO opengeni_app;
    REVOKE EXECUTE ON FUNCTION
      opengeni_private.claim_editable_artifact_live_outbox(
        text, integer, integer, name
      ) FROM opengeni_app;
    REVOKE EXECUTE ON FUNCTION
      opengeni_private.mark_editable_artifact_live_outbox_published(
        text, text, integer, name
      ) FROM opengeni_app;
    REVOKE EXECUTE ON FUNCTION
      opengeni_private.renew_editable_artifact_live_outbox(
        text, text, integer, integer, name
      ) FROM opengeni_app;
    REVOKE EXECUTE ON FUNCTION
      opengeni_private.retry_editable_artifact_live_outbox(
        text, text, integer, integer, text, name
      ) FROM opengeni_app;
    REVOKE EXECUTE ON FUNCTION
      opengeni_private.dead_letter_editable_artifact_live_outbox(
        text, text, integer, text, name
      ) FROM opengeni_app;
    REVOKE EXECUTE ON FUNCTION
      opengeni_private.release_editable_artifact_live_outbox(
        text, text, integer, name
      ) FROM opengeni_app;
    REVOKE EXECUTE ON FUNCTION
      opengeni_private.claim_editable_artifact_materializations(
        text, integer, integer, name
      ) FROM opengeni_app;
    REVOKE EXECUTE ON FUNCTION
      opengeni_private.renew_editable_artifact_materialization(
        uuid, uuid, text, text, text, integer, integer, name
      ) FROM opengeni_app;
    REVOKE EXECUTE ON FUNCTION
      opengeni_private.succeed_editable_artifact_materialization(
        uuid, uuid, text, text, text, integer, text, text, text, bigint,
        text, text, timestamptz, name
      ) FROM opengeni_app;
    REVOKE EXECUTE ON FUNCTION
      opengeni_private.fail_editable_artifact_materialization(
        uuid, uuid, text, text, text, integer, text, name
      ) FROM opengeni_app;
  END IF;
END;
$runtime_grants$;

DO $artifact_outbox_dispatcher_grants$
DECLARE data_schema text := current_schema();
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'opengeni_artifact_outbox_dispatcher'
  ) THEN
    GRANT USAGE ON SCHEMA opengeni_private TO opengeni_artifact_outbox_dispatcher;
    EXECUTE format(
      'GRANT USAGE ON SCHEMA %I TO opengeni_artifact_outbox_dispatcher', data_schema
    );
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I '
      || 'FROM opengeni_artifact_outbox_dispatcher', data_schema
    );
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I '
      || 'FROM opengeni_artifact_outbox_dispatcher', data_schema
    );
    REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA opengeni_private
      FROM opengeni_artifact_outbox_dispatcher;
    GRANT EXECUTE ON FUNCTION
      opengeni_private.claim_editable_artifact_live_outbox(text, integer, integer, name)
      TO opengeni_artifact_outbox_dispatcher;
    GRANT EXECUTE ON FUNCTION
      opengeni_private.mark_editable_artifact_live_outbox_published(
        text, text, integer, name
      ) TO opengeni_artifact_outbox_dispatcher;
    GRANT EXECUTE ON FUNCTION
      opengeni_private.renew_editable_artifact_live_outbox(
        text, text, integer, integer, name
      ) TO opengeni_artifact_outbox_dispatcher;
    GRANT EXECUTE ON FUNCTION
      opengeni_private.retry_editable_artifact_live_outbox(
        text, text, integer, integer, text, name
      ) TO opengeni_artifact_outbox_dispatcher;
    GRANT EXECUTE ON FUNCTION
      opengeni_private.dead_letter_editable_artifact_live_outbox(
        text, text, integer, text, name
      ) TO opengeni_artifact_outbox_dispatcher;
    GRANT EXECUTE ON FUNCTION
      opengeni_private.release_editable_artifact_live_outbox(text, text, integer, name)
      TO opengeni_artifact_outbox_dispatcher;
  END IF;
END;
$artifact_outbox_dispatcher_grants$;

DO $artifact_materializer_grants$
DECLARE data_schema text := current_schema();
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'opengeni_artifact_materializer'
  ) THEN
    GRANT USAGE ON SCHEMA opengeni_private TO opengeni_artifact_materializer;
    EXECUTE format(
      'GRANT USAGE ON SCHEMA %I TO opengeni_artifact_materializer', data_schema
    );
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I '
      || 'FROM opengeni_artifact_materializer', data_schema
    );
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I '
      || 'FROM opengeni_artifact_materializer', data_schema
    );
    REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA opengeni_private
      FROM opengeni_artifact_materializer;
    GRANT EXECUTE ON FUNCTION
      opengeni_private.claim_editable_artifact_materializations(
        text, integer, integer, name
      ) TO opengeni_artifact_materializer;
    GRANT EXECUTE ON FUNCTION
      opengeni_private.renew_editable_artifact_materialization(
        uuid, uuid, text, text, text, integer, integer, name
      ) TO opengeni_artifact_materializer;
    GRANT EXECUTE ON FUNCTION
      opengeni_private.succeed_editable_artifact_materialization(
        uuid, uuid, text, text, text, integer, text, text, text, bigint,
        text, text, timestamptz, name
      ) TO opengeni_artifact_materializer;
    GRANT EXECUTE ON FUNCTION
      opengeni_private.fail_editable_artifact_materialization(
        uuid, uuid, text, text, text, integer, text, name
      ) TO opengeni_artifact_materializer;
  END IF;
END;
$artifact_materializer_grants$;

RESET statement_timeout;
RESET lock_timeout;
