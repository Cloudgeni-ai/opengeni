-- deployment-mode: maintenance
-- Add default-off machine storage beside the legacy sandbox path. The exact
-- runtime table/grant posture changes, so old binaries must be drained for this
-- schema install. This does not enable v2, migrate old groups or delete legacy
-- state; one new binary continues to run both sandbox engines.

-- A unique index, rather than a snapshot-sensitive cross-table EXISTS, fences
-- both engines under every supported transaction isolation level. The claim
-- survives lease cleanup and is removed only with its tenant.
CREATE TABLE sandbox_group_engines (
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  sandbox_group_id uuid NOT NULL,
  engine text NOT NULL CHECK (engine IN ('legacy','machine-v2')),
  PRIMARY KEY (workspace_id,sandbox_group_id),
  FOREIGN KEY (workspace_id,account_id) REFERENCES workspaces(id,account_id) ON DELETE CASCADE
);
ALTER TABLE sessions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE sandbox_leases NO FORCE ROW LEVEL SECURITY;
INSERT INTO sandbox_group_engines(account_id,workspace_id,sandbox_group_id,engine)
  SELECT account_id,workspace_id,sandbox_group_id,'legacy' FROM sessions
  UNION
  SELECT account_id,workspace_id,sandbox_group_id,'legacy' FROM sandbox_leases;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE sandbox_leases FORCE ROW LEVEL SECURITY;
ALTER TABLE sandbox_group_engines ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox_group_engines FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE sandbox_group_engines FROM PUBLIC;
CREATE POLICY workspace_isolation ON sandbox_group_engines
  USING (opengeni_private.workspace_rls_visible(account_id,workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id,workspace_id));

CREATE FUNCTION guard_sandbox_group_engine()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    -- Direct app INSERT uses the same advisory-before-unique-key order as the
    -- session helper and both engine table triggers.
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'sandbox-lease-admission:' || NEW.workspace_id::text || ':' || NEW.sandbox_group_id::text, 0));
    RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' THEN
    RAISE EXCEPTION 'Sandbox group engine is immutable' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM workspaces WHERE id=OLD.workspace_id AND account_id=OLD.account_id)
    AND EXISTS (SELECT 1 FROM managed_accounts WHERE id=OLD.account_id) THEN
    RAISE EXCEPTION 'Sandbox group engine must be retained' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
END $$;

REVOKE ALL ON FUNCTION guard_sandbox_group_engine() FROM PUBLIC;
CREATE TRIGGER sandbox_group_engine_guard BEFORE INSERT OR UPDATE OR DELETE ON sandbox_group_engines
  FOR EACH ROW EXECUTE FUNCTION guard_sandbox_group_engine();

CREATE TABLE sandbox_v2_machines (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  sandbox_group_id uuid NOT NULL,
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 128),
  version bigint NOT NULL DEFAULT 0 CHECK (version BETWEEN 0 AND 9007199254740991),
  projection jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CHECK (jsonb_typeof(projection) = 'object'),
  CHECK (projection->>'id' IS NOT DISTINCT FROM id::text),
  CHECK (projection->>'workspaceId' IS NOT DISTINCT FROM workspace_id::text),
  CHECK (projection->>'sandboxGroupId' IS NOT DISTINCT FROM sandbox_group_id::text),
  CHECK (projection->>'provider' IS NOT DISTINCT FROM provider),
  CHECK (jsonb_typeof(projection->'version') IS NOT DISTINCT FROM 'number'),
  CHECK ((projection->>'version')::numeric IS NOT DISTINCT FROM version::numeric),
  CHECK (coalesce(projection->>'state' IN ('absent','running','suspended','destroying','destroyed'),false)),
  CHECK (projection->>'state'<>'destroying' OR coalesce(
    projection->>'target'='destroyed' AND projection->'instance'='null'::jsonb
    AND projection->'disk'<>'null'::jsonb AND projection->'demands'='[]'::jsonb,false)),
  CHECK (coalesce(projection->>'target' IN ('running','suspended','destroyed'),false)),
  CHECK (jsonb_typeof(projection->'demands') = 'array'),
  CHECK (projection ?& ARRAY['id','workspaceId','sandboxGroupId','provider','version',
    'state','target','instance','disk','demands','idleSince','transition'])
);
CREATE UNIQUE INDEX sandbox_v2_machines_group_uq ON sandbox_v2_machines(workspace_id,sandbox_group_id);
CREATE UNIQUE INDEX sandbox_v2_machines_scope_uq ON sandbox_v2_machines(account_id,workspace_id,id);
CREATE INDEX sandbox_v2_machines_inventory_idx ON sandbox_v2_machines(account_id,workspace_id,updated_at,id);

ALTER TABLE sandbox_v2_machines ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox_v2_machines FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE sandbox_v2_machines FROM PUBLIC;
CREATE POLICY workspace_isolation ON sandbox_v2_machines
  USING (opengeni_private.workspace_rls_visible(account_id,workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id,workspace_id));

CREATE FUNCTION guard_sandbox_v2_machine()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE recorded_engine text;
BEGIN
  IF TG_OP='DELETE' THEN
    -- Keep the recorded engine and dispatch tombstones while their tenant lives.
    -- Parent deletion may cascade; ordinary group cleanup retains this row.
    IF EXISTS (SELECT 1 FROM workspaces WHERE id=OLD.workspace_id AND account_id=OLD.account_id)
      AND EXISTS (SELECT 1 FROM managed_accounts WHERE id=OLD.account_id) THEN
      RAISE EXCEPTION 'Sandbox machine authority must be retained' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  ELSIF TG_OP='INSERT' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'sandbox-lease-admission:' || NEW.workspace_id::text || ':' || NEW.sandbox_group_id::text, 0));
    INSERT INTO sandbox_group_engines(account_id,workspace_id,sandbox_group_id,engine)
      VALUES (NEW.account_id,NEW.workspace_id,NEW.sandbox_group_id,'machine-v2')
      ON CONFLICT (workspace_id,sandbox_group_id) DO NOTHING;
    SELECT engine INTO recorded_engine FROM sandbox_group_engines
      WHERE account_id=NEW.account_id AND workspace_id=NEW.workspace_id
        AND sandbox_group_id=NEW.sandbox_group_id;
    IF recorded_engine IS DISTINCT FROM 'machine-v2' THEN
      RAISE EXCEPTION 'Sandbox group already belongs to the legacy engine' USING ERRCODE='23514';
    END IF;
    IF NEW.version<>0 OR NEW.projection->>'state' IS DISTINCT FROM 'absent'
      OR NEW.projection->>'target' IS DISTINCT FROM 'suspended'
      OR NEW.projection->'instance' IS DISTINCT FROM 'null'::jsonb
      OR NEW.projection->'disk' IS DISTINCT FROM 'null'::jsonb
      OR NEW.projection->'demands' IS DISTINCT FROM '[]'::jsonb
      OR NEW.projection->'idleSince' IS DISTINCT FROM 'null'::jsonb
      OR NEW.projection->'transition' IS DISTINCT FROM 'null'::jsonb THEN
      RAISE EXCEPTION 'Sandbox machine admission requires a fresh projection' USING ERRCODE='23514';
    END IF;
  ELSE
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.account_id IS DISTINCT FROM OLD.account_id
      OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.sandbox_group_id IS DISTINCT FROM OLD.sandbox_group_id
      OR NEW.provider IS DISTINCT FROM OLD.provider OR NEW.created_at IS DISTINCT FROM OLD.created_at
      OR NEW.version<>OLD.version+1 THEN
      RAISE EXCEPTION 'Sandbox machine identity is immutable and version is sequential' USING ERRCODE='23514';
    END IF;
    IF OLD.projection->>'target'='destroyed' AND NEW.projection->>'target' IS DISTINCT FROM 'destroyed' THEN
      RAISE EXCEPTION 'Sandbox machine destruction is monotonic' USING ERRCODE='23514';
    END IF;
    IF jsonb_typeof(OLD.projection->'transition')='object'
      AND jsonb_typeof(NEW.projection->'transition')='object' THEN
      IF ((OLD.projection->'transition')-'phase') IS DISTINCT FROM ((NEW.projection->'transition')-'phase')
        OR (OLD.projection->'transition'->>'phase'='dispatched'
          AND NOT coalesce(NEW.projection->'transition'->>'phase' IN ('dispatched','unknown'),false))
        OR (OLD.projection->'transition'->>'phase'='unknown'
          AND NEW.projection->'transition'->>'phase' IS DISTINCT FROM 'unknown') THEN
        RAISE EXCEPTION 'Sandbox machine transition admission is immutable' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_sandbox_v2_machine() FROM PUBLIC;
CREATE TRIGGER sandbox_v2_machine_guard BEFORE INSERT OR UPDATE OR DELETE ON sandbox_v2_machines
  FOR EACH ROW EXECUTE FUNCTION guard_sandbox_v2_machine();

-- The SQL boundary also rejects stale or older callers attempting to create a
-- legacy lease for an admitted v2 group. Both inserts serialize the absent-row
-- window; flag changes cannot license two engines to own the same workspace.
CREATE FUNCTION guard_legacy_sandbox_engine()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE recorded_engine text;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.account_id IS DISTINCT FROM OLD.account_id
      OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
      OR NEW.sandbox_group_id IS DISTINCT FROM OLD.sandbox_group_id THEN
      RAISE EXCEPTION 'Sandbox lease identity is immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'sandbox-lease-admission:' || NEW.workspace_id::text || ':' || NEW.sandbox_group_id::text, 0));
  INSERT INTO sandbox_group_engines(account_id,workspace_id,sandbox_group_id,engine)
    VALUES (NEW.account_id,NEW.workspace_id,NEW.sandbox_group_id,'legacy')
    ON CONFLICT (workspace_id,sandbox_group_id) DO NOTHING;
  SELECT engine INTO recorded_engine FROM sandbox_group_engines
    WHERE account_id=NEW.account_id AND workspace_id=NEW.workspace_id
      AND sandbox_group_id=NEW.sandbox_group_id;
  IF recorded_engine IS DISTINCT FROM 'legacy' THEN
    RAISE EXCEPTION 'Sandbox group already belongs to the machine engine' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_legacy_sandbox_engine() FROM PUBLIC;
CREATE TRIGGER sandbox_legacy_engine_guard BEFORE INSERT OR UPDATE ON sandbox_leases
  FOR EACH ROW EXECUTE FUNCTION guard_legacy_sandbox_engine();

-- Pin each target-schema function independently. No shared private function or
-- caller-controlled search_path can rebind a guard to another installation.
DO $$ DECLARE target_schema text := current_schema(); routine text; BEGIN
  FOREACH routine IN ARRAY ARRAY['guard_sandbox_group_engine',
    'guard_sandbox_v2_machine','guard_legacy_sandbox_engine'] LOOP
    EXECUTE format('ALTER FUNCTION %I.%I() SET search_path TO pg_catalog, %I, pg_temp',
      target_schema,routine,target_schema);
  END LOOP;
END $$;

-- Command locators stay in protected control-plane storage, independent of
-- filesystem rollback. These tables contain no executable launch body or input
-- bytes. Captured output is retained only after the exact owner fence commits.
CREATE TABLE sandbox_v2_commands (
  operation_id uuid PRIMARY KEY,
  handle integer GENERATED ALWAYS AS IDENTITY UNIQUE CHECK (handle>0),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL,
  turn_id uuid NOT NULL REFERENCES session_turns(id) ON DELETE CASCADE,
  attempt_id uuid NOT NULL REFERENCES session_turn_attempts(id) ON DELETE CASCADE,
  execution_generation integer NOT NULL CHECK (execution_generation>=0),
  machine_id uuid NOT NULL,
  instance_id text NOT NULL CHECK (length(instance_id) BETWEEN 1 AND 256),
  accepted_action_id text NOT NULL CHECK (length(accepted_action_id) BETWEEN 1 AND 512),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  binding jsonb,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740991),
  stdout jsonb NOT NULL DEFAULT '{"offset":0,"remainder":""}',
  stderr jsonb NOT NULL DEFAULT '{"offset":0,"remainder":""}',
  proof jsonb,
  abandoned boolean NOT NULL DEFAULT false,
  next_input_sequence bigint NOT NULL DEFAULT 1 CHECK (next_input_sequence BETWEEN 1 AND 9007199254740991),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id,account_id) REFERENCES workspaces(id,account_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id,session_id) REFERENCES sessions(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY (session_id,account_id) REFERENCES sessions(id,account_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id,workspace_id,machine_id) REFERENCES sandbox_v2_machines(account_id,workspace_id,id) ON DELETE RESTRICT,
  UNIQUE (account_id,workspace_id,session_id,operation_id),
  UNIQUE (workspace_id,session_id,turn_id,accepted_action_id),
  CHECK (binding IS NULL OR (binding->>'operationId' IS NOT DISTINCT FROM operation_id::text
    AND binding->>'machineId' IS NOT DISTINCT FROM machine_id::text)),
  CHECK (proof IS NULL OR (binding IS NOT NULL AND proof->>'operationId' IS NOT DISTINCT FROM operation_id::text
    AND coalesce(proof->>'state' IN ('exited','cancelled'),false)))
);
CREATE INDEX sandbox_v2_commands_pending_idx ON sandbox_v2_commands(workspace_id,attempt_id,operation_id) WHERE proof IS NULL AND NOT abandoned;
CREATE INDEX sandbox_v2_commands_inventory_idx ON sandbox_v2_commands(workspace_id,machine_id,operation_id) WHERE proof IS NULL AND NOT abandoned;

CREATE TABLE sandbox_v2_command_inputs (
  account_id uuid NOT NULL, workspace_id uuid NOT NULL, session_id uuid NOT NULL, operation_id uuid NOT NULL,
  accepted_action_id text NOT NULL CHECK (length(accepted_action_id) BETWEEN 1 AND 512),
  part_index integer NOT NULL CHECK (part_index>=0), part_count integer NOT NULL CHECK (part_count BETWEEN 1 AND 4096 AND part_index<part_count),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  action_digest text NOT NULL CHECK (action_digest ~ '^[a-f0-9]{64}$'),
  sequence bigint NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (operation_id,accepted_action_id,part_index), UNIQUE(operation_id,sequence),
  FOREIGN KEY(account_id,workspace_id,session_id,operation_id)
    REFERENCES sandbox_v2_commands(account_id,workspace_id,session_id,operation_id) ON DELETE CASCADE
);
CREATE TABLE sandbox_v2_command_output (
  account_id uuid NOT NULL, workspace_id uuid NOT NULL, session_id uuid NOT NULL, operation_id uuid NOT NULL,
  accepted_action_id text NOT NULL CHECK (length(accepted_action_id) BETWEEN 1 AND 512),
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  observation jsonb NOT NULL, stdout text NOT NULL, stderr text NOT NULL,
  PRIMARY KEY(operation_id,revision),
  FOREIGN KEY(account_id,workspace_id,session_id,operation_id)
    REFERENCES sandbox_v2_commands(account_id,workspace_id,session_id,operation_id) ON DELETE CASCADE
);

DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['sandbox_v2_commands','sandbox_v2_command_inputs','sandbox_v2_command_output'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC',relation);
    EXECUTE format('CREATE POLICY workspace_isolation ON %I USING (opengeni_private.workspace_rls_visible(account_id,workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id,workspace_id))',relation);
    EXECUTE format('CREATE POLICY session_visibility_isolation ON %I AS RESTRICTIVE USING (session_reference_visible(account_id,workspace_id,session_id)) WITH CHECK (session_reference_visible(account_id,workspace_id,session_id))',relation);
  END LOOP;
END $$;

CREATE FUNCTION guard_sandbox_v2_command()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE stream jsonb; receipt jsonb; current_instance jsonb;
  suffix bytea; suffix_length integer; suffix_width integer; suffix_lead integer; byte_index integer;
  terminal_stream jsonb:='{"offset":0,"nextOffset":0,"data":"","eof":true}';
  uuid_pattern text:='^([a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$';
BEGIN
  IF TG_OP='DELETE' THEN
    IF EXISTS (SELECT 1 FROM sessions WHERE id=OLD.session_id AND workspace_id=OLD.workspace_id)
      AND EXISTS (SELECT 1 FROM workspaces WHERE id=OLD.workspace_id AND account_id=OLD.account_id) THEN
      RAISE EXCEPTION 'Sandbox command dispatch authority must be retained' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.revision<>0 OR NEW.binding IS NOT NULL OR NEW.proof IS NOT NULL OR NEW.abandoned OR NEW.next_input_sequence<>1
      OR NEW.stdout IS DISTINCT FROM '{"offset":0,"remainder":""}'::jsonb
      OR NEW.stderr IS DISTINCT FROM '{"offset":0,"remainder":""}'::jsonb THEN
      RAISE EXCEPTION 'Sandbox command allocation requires fresh authority' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM session_turn_attempts attempt JOIN session_turns turn_row ON turn_row.id=attempt.turn_id
      JOIN sessions session_row ON session_row.id=attempt.session_id
      JOIN sandbox_v2_machines machine ON machine.id=NEW.machine_id
      WHERE attempt.id=NEW.attempt_id AND attempt.account_id=NEW.account_id AND attempt.workspace_id=NEW.workspace_id
        AND attempt.session_id=NEW.session_id AND attempt.turn_id=NEW.turn_id AND attempt.execution_generation=NEW.execution_generation
        AND turn_row.account_id=NEW.account_id AND turn_row.session_id=NEW.session_id
        AND machine.account_id=NEW.account_id AND machine.workspace_id=NEW.workspace_id
        AND machine.sandbox_group_id=session_row.sandbox_group_id) THEN
      RAISE EXCEPTION 'Sandbox command owner or machine scope mismatch' USING ERRCODE='23514';
    END IF;
  ELSE
    IF (NEW.operation_id,NEW.handle,NEW.account_id,NEW.workspace_id,NEW.session_id,NEW.turn_id,NEW.attempt_id,
      NEW.execution_generation,NEW.machine_id,NEW.instance_id,NEW.accepted_action_id,NEW.request_digest,NEW.created_at)
      IS DISTINCT FROM (OLD.operation_id,OLD.handle,OLD.account_id,OLD.workspace_id,OLD.session_id,OLD.turn_id,OLD.attempt_id,
      OLD.execution_generation,OLD.machine_id,OLD.instance_id,OLD.accepted_action_id,OLD.request_digest,OLD.created_at)
      OR NEW.revision<>OLD.revision+1 OR NEW.next_input_sequence<OLD.next_input_sequence
      OR (OLD.binding IS NOT NULL AND NEW.binding IS DISTINCT FROM OLD.binding)
      OR (OLD.abandoned AND NOT NEW.abandoned)
      OR (OLD.proof IS NOT NULL AND NEW.proof IS DISTINCT FROM OLD.proof) THEN
      RAISE EXCEPTION 'Sandbox command identity and terminal evidence are immutable' USING ERRCODE='23514';
    END IF;
    IF ((OLD.binding IS NULL AND NEW.binding IS NOT NULL)
      OR NEW.next_input_sequence>OLD.next_input_sequence)
      AND EXISTS (SELECT 1 FROM session_background_commands job
        WHERE job.native_operation_id=NEW.operation_id AND job.state<>'running') THEN
      RAISE EXCEPTION 'Native background command is stopping or settled' USING ERRCODE='23514';
    END IF;
    IF ((OLD.binding IS NULL AND NEW.binding IS NOT NULL)
      OR NEW.next_input_sequence>OLD.next_input_sequence)
      AND EXISTS (SELECT 1 FROM sandbox_v2_background_credentials custody
        WHERE custody.job_id=NEW.operation_id AND custody.expires_at<=clock_timestamp()) THEN
      RAISE EXCEPTION 'Native background original credentials expired' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.abandoned AND (NEW.binding IS NOT NULL OR NEW.proof IS NOT NULL OR NEW.next_input_sequence<>1) THEN
    RAISE EXCEPTION 'Abandoned allocation cannot acquire dispatch authority' USING ERRCODE='23514';
  END IF;
  -- The runtime owns provider evidence, but the SQL boundary must never turn
  -- arbitrary JSON into physical quiescence. Pin the same locator, cursor and
  -- canonical terminal shapes the shared protocol accepts.
  IF NEW.binding IS NOT NULL THEN
    IF jsonb_typeof(NEW.binding) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Invalid sandbox command binding' USING ERRCODE='23514';
    END IF;
    IF NOT coalesce(NEW.binding ?& ARRAY['kind','machineId','operationId','diskLineage',
      'bootId','specificationDigest','stdin','pty']
      AND (SELECT count(*) FROM jsonb_object_keys(NEW.binding))=8
      AND jsonb_typeof(NEW.binding->'kind')='string'
      AND jsonb_typeof(NEW.binding->'machineId')='string'
      AND jsonb_typeof(NEW.binding->'operationId')='string'
      AND jsonb_typeof(NEW.binding->'diskLineage')='string'
      AND jsonb_typeof(NEW.binding->'bootId')='string'
      AND jsonb_typeof(NEW.binding->'specificationDigest')='string'
      AND NEW.binding->>'kind'='machine-journal-v1'
      AND NEW.binding->>'operationId'=NEW.operation_id::text
      AND NEW.binding->>'machineId'=NEW.machine_id::text
      AND NEW.binding->>'diskLineage' ~ uuid_pattern
      AND NEW.binding->>'bootId' ~ '^[a-f0-9]{64}$'
      AND NEW.binding->>'specificationDigest' ~ '^[a-f0-9]{64}$'
      AND jsonb_typeof(NEW.binding->'stdin')='boolean'
      AND jsonb_typeof(NEW.binding->'pty')='boolean'
      AND (NEW.binding->'pty'='false' OR NEW.binding->'stdin'='true'),false) THEN
      RAISE EXCEPTION 'Invalid sandbox command binding' USING ERRCODE='23514';
    END IF;
  END IF;
  FOREACH stream IN ARRAY ARRAY[NEW.stdout,NEW.stderr] LOOP
    IF jsonb_typeof(stream) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Invalid sandbox command byte cursor' USING ERRCODE='23514';
    END IF;
    IF NOT coalesce(stream ?& ARRAY['offset','remainder']
      AND (SELECT count(*) FROM jsonb_object_keys(stream))=2
      AND jsonb_typeof(stream->'offset')='number'
      AND (stream->>'offset')::numeric BETWEEN 0 AND 9007199254740991
      AND trunc((stream->>'offset')::numeric)=(stream->>'offset')::numeric
      AND jsonb_typeof(stream->'remainder')='string'
      AND length(stream->>'remainder')<=4
      AND encode(decode(stream->>'remainder','base64'),'base64')=stream->>'remainder',false) THEN
      RAISE EXCEPTION 'Invalid sandbox command byte cursor' USING ERRCODE='23514';
    END IF;
    IF NEW.binding IS NULL AND stream IS DISTINCT FROM '{"offset":0,"remainder":""}'::jsonb THEN
      RAISE EXCEPTION 'Unbound sandbox command cannot consume bytes' USING ERRCODE='23514';
    END IF;
    suffix:=decode(stream->>'remainder','base64'); suffix_length:=length(suffix);
    IF suffix_length>3 OR suffix_length>(stream->>'offset')::numeric THEN
      RAISE EXCEPTION 'Sandbox command remainder exceeds observed bytes' USING ERRCODE='23514';
    END IF;
    IF suffix_length>0 THEN
      suffix_lead:=get_byte(suffix,0);
      suffix_width:=CASE WHEN suffix_lead BETWEEN 194 AND 223 THEN 2
        WHEN suffix_lead BETWEEN 224 AND 239 THEN 3 WHEN suffix_lead BETWEEN 240 AND 244 THEN 4 ELSE 0 END;
      IF suffix_length>=suffix_width THEN
        RAISE EXCEPTION 'Sandbox command remainder is not unfinished UTF-8' USING ERRCODE='23514';
      END IF;
      IF suffix_length>1 THEN
        FOR byte_index IN 1..suffix_length-1 LOOP
          IF get_byte(suffix,byte_index) NOT BETWEEN 128 AND 191 THEN
            RAISE EXCEPTION 'Invalid sandbox command UTF-8 continuation' USING ERRCODE='23514';
          END IF;
        END LOOP;
        IF (suffix_lead=224 AND get_byte(suffix,1)<160) OR (suffix_lead=237 AND get_byte(suffix,1)>159)
          OR (suffix_lead=240 AND get_byte(suffix,1)<144) OR (suffix_lead=244 AND get_byte(suffix,1)>143) THEN
          RAISE EXCEPTION 'Invalid sandbox command UTF-8 scalar prefix' USING ERRCODE='23514';
        END IF;
      END IF;
    END IF;
  END LOOP;
  IF TG_OP='UPDATE' AND ((NEW.stdout->>'offset')::numeric<(OLD.stdout->>'offset')::numeric
    OR (NEW.stderr->>'offset')::numeric<(OLD.stderr->>'offset')::numeric
    OR (OLD.proof IS NOT NULL AND NEW.next_input_sequence<>OLD.next_input_sequence)) THEN
    RAISE EXCEPTION 'Sandbox command cursors and input history are monotonic' USING ERRCODE='23514';
  END IF;
  IF NEW.proof IS NOT NULL THEN
    IF jsonb_typeof(NEW.proof) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Invalid sandbox command terminal evidence' USING ERRCODE='23514';
    END IF;
    IF NOT coalesce(NEW.binding IS NOT NULL
      AND NEW.proof ?& ARRAY['operationId','state','specificationDigest','receipt','stdout','stderr']
      AND (SELECT count(*) FROM jsonb_object_keys(NEW.proof))=6
      AND jsonb_typeof(NEW.proof->'operationId')='string'
      AND jsonb_typeof(NEW.proof->'state')='string'
      AND NEW.proof->>'operationId'=NEW.operation_id::text
      AND NEW.proof->>'state' IN ('exited','cancelled')
      AND NEW.proof->'stdout'=terminal_stream AND NEW.proof->'stderr'=terminal_stream,false) THEN
      RAISE EXCEPTION 'Invalid sandbox command terminal evidence' USING ERRCODE='23514';
    END IF;
    IF NEW.proof->>'state'='cancelled' THEN
      IF NEW.proof->'specificationDigest' IS DISTINCT FROM 'null'::jsonb
        OR NEW.proof->'receipt' IS DISTINCT FROM 'null'::jsonb THEN
        RAISE EXCEPTION 'Never-started cancellation has no receipt' USING ERRCODE='23514';
      END IF;
      IF TG_OP='INSERT' OR NEW.proof IS DISTINCT FROM OLD.proof THEN
        SELECT projection->'instance' INTO current_instance FROM sandbox_v2_machines
          WHERE account_id=NEW.account_id AND workspace_id=NEW.workspace_id AND id=NEW.machine_id;
        IF NOT coalesce(current_instance->>'id'=NEW.instance_id
          AND current_instance->>'bootId'=NEW.binding->>'bootId'
          AND current_instance->>'diskLineage'=NEW.binding->>'diskLineage',false) THEN
          RAISE EXCEPTION 'Replacement machine cannot prove never-started cancellation' USING ERRCODE='23514';
        END IF;
      END IF;
    ELSE
      receipt:=NEW.proof->'receipt';
      IF jsonb_typeof(receipt) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'Exited sandbox command requires its native receipt' USING ERRCODE='23514';
      END IF;
      IF NOT coalesce(jsonb_typeof(NEW.proof->'specificationDigest')='string'
        AND NEW.proof->>'specificationDigest'=NEW.binding->>'specificationDigest'
        AND receipt ?& ARRAY['protocol','invocationId','receiptId','leaderExitCode']
        AND (SELECT count(*) FROM jsonb_object_keys(receipt))=
          4+CASE WHEN NEW.binding->'stdin'='true' THEN 1 ELSE 0 END+
          CASE WHEN receipt ? 'incompleteInputSequence' THEN 1 ELSE 0 END
        AND receipt->>'protocol'='native-subreaper-v1'
        AND jsonb_typeof(receipt->'protocol')='string'
        AND jsonb_typeof(receipt->'invocationId')='string'
        AND jsonb_typeof(receipt->'receiptId')='string'
        AND receipt->>'invocationId'=NEW.operation_id::text
        AND receipt->>'receiptId' ~ uuid_pattern
        AND jsonb_typeof(receipt->'leaderExitCode')='number'
        AND (receipt->>'leaderExitCode')::numeric BETWEEN -2147483648 AND 2147483647
        AND trunc((receipt->>'leaderExitCode')::numeric)=(receipt->>'leaderExitCode')::numeric
        AND (receipt ? 'acceptedInputSequence')=(NEW.binding->'stdin'='true'),false) THEN
        RAISE EXCEPTION 'Invalid exact sandbox command native receipt' USING ERRCODE='23514';
      END IF;
      IF NEW.binding->'stdin'='true' AND NOT coalesce(jsonb_typeof(receipt->'acceptedInputSequence')='number'
        AND (receipt->>'acceptedInputSequence')::numeric BETWEEN 0 AND NEW.next_input_sequence-1
        AND trunc((receipt->>'acceptedInputSequence')::numeric)=(receipt->>'acceptedInputSequence')::numeric,false) THEN
        RAISE EXCEPTION 'Native input receipt exceeds admitted history' USING ERRCODE='23514';
      END IF;
      IF receipt ? 'incompleteInputSequence' AND NOT coalesce(NEW.binding->'pty'='true'
        AND jsonb_typeof(receipt->'incompleteInputSequence')='number'
        AND (receipt->>'incompleteInputSequence')::numeric=(receipt->>'acceptedInputSequence')::numeric+1
        AND (receipt->>'incompleteInputSequence')::numeric<NEW.next_input_sequence,false) THEN
        RAISE EXCEPTION 'Invalid native incomplete input receipt' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RAISE EXCEPTION 'Invalid sandbox command protocol value' USING ERRCODE='23514';
END $$;
REVOKE ALL ON FUNCTION guard_sandbox_v2_command() FROM PUBLIC;
CREATE TRIGGER sandbox_v2_command_guard BEFORE INSERT OR UPDATE OR DELETE ON sandbox_v2_commands
  FOR EACH ROW EXECUTE FUNCTION guard_sandbox_v2_command();
DO $$ DECLARE target_schema text:=current_schema(); BEGIN
  EXECUTE format('ALTER FUNCTION %I.guard_sandbox_v2_command() SET search_path TO pg_catalog, %I, pg_temp',target_schema,target_schema);
END $$;

CREATE FUNCTION guard_sandbox_v2_command_output()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE command sandbox_v2_commands; stream jsonb; bytes bytea;
BEGIN
  SELECT * INTO command FROM sandbox_v2_commands WHERE operation_id=coalesce(NEW.operation_id,OLD.operation_id);
  IF TG_OP='DELETE' THEN
    IF FOUND THEN RAISE EXCEPTION 'Retained command output cannot be erased' USING ERRCODE='23514'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' THEN
    RAISE EXCEPTION 'Retained command output is immutable' USING ERRCODE='23514';
  END IF;
  IF command.binding IS NULL OR NEW.revision<>command.revision+1
    OR NOT coalesce(NEW.account_id=command.account_id AND NEW.workspace_id=command.workspace_id
      AND NEW.session_id=command.session_id,false) THEN
    RAISE EXCEPTION 'Command output must extend the exact retained cursor' USING ERRCODE='23514';
  END IF;
  IF jsonb_typeof(NEW.observation) IS DISTINCT FROM 'object' OR NOT coalesce(
    NEW.observation ?& ARRAY['operationId','state','specificationDigest','receipt','stdout','stderr']
    AND (SELECT count(*) FROM jsonb_object_keys(NEW.observation))=6
    AND jsonb_typeof(NEW.observation->'operationId')='string'
    AND NEW.observation->>'operationId'=NEW.operation_id::text
    AND jsonb_typeof(NEW.observation->'state')='string'
    AND NEW.observation->>'state' IN ('not_found','unknown','prepared','running','exited','lost','cancelled')
    AND (NEW.observation->'specificationDigest'='null'::jsonb OR
      NEW.observation->'specificationDigest'=command.binding->'specificationDigest'),false) THEN
    RAISE EXCEPTION 'Invalid command output observation' USING ERRCODE='23514';
  END IF;
  FOREACH stream IN ARRAY ARRAY[NEW.observation->'stdout',NEW.observation->'stderr'] LOOP
    IF jsonb_typeof(stream) IS DISTINCT FROM 'object' OR NOT coalesce(
      stream ?& ARRAY['offset','nextOffset','data','eof'] AND (SELECT count(*) FROM jsonb_object_keys(stream))=4
      AND jsonb_typeof(stream->'offset')='number' AND jsonb_typeof(stream->'nextOffset')='number'
      AND (stream->>'offset')::numeric BETWEEN 0 AND 9007199254740991
      AND (stream->>'nextOffset')::numeric BETWEEN (stream->>'offset')::numeric AND 9007199254740991
      AND trunc((stream->>'offset')::numeric)=(stream->>'offset')::numeric
      AND trunc((stream->>'nextOffset')::numeric)=(stream->>'nextOffset')::numeric
      AND jsonb_typeof(stream->'data')='string' AND jsonb_typeof(stream->'eof')='boolean',false) THEN
      RAISE EXCEPTION 'Invalid command output byte page' USING ERRCODE='23514';
    END IF;
    bytes:=decode(stream->>'data','base64');
    IF length(bytes)>1048576 OR replace(encode(bytes,'base64'),E'\n','')<>stream->>'data'
      OR length(bytes)<>(stream->>'nextOffset')::numeric-(stream->>'offset')::numeric THEN
      RAISE EXCEPTION 'Command output bytes do not match their exact range' USING ERRCODE='23514';
    END IF;
  END LOOP;
  IF NEW.observation->'stdout'->'offset' IS DISTINCT FROM command.stdout->'offset'
    OR NEW.observation->'stderr'->'offset' IS DISTINCT FROM command.stderr->'offset'
    OR replace(encode(decode(NEW.stdout,'base64'),'base64'),E'\n','')<>NEW.stdout
    OR replace(encode(decode(NEW.stderr,'base64'),'base64'),E'\n','')<>NEW.stderr THEN
    RAISE EXCEPTION 'Command output does not extend its current byte cursor' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RAISE EXCEPTION 'Invalid command output protocol value' USING ERRCODE='23514';
END $$;
REVOKE ALL ON FUNCTION guard_sandbox_v2_command_output() FROM PUBLIC;
CREATE TRIGGER sandbox_v2_command_output_guard BEFORE INSERT OR UPDATE OR DELETE ON sandbox_v2_command_output
  FOR EACH ROW EXECUTE FUNCTION guard_sandbox_v2_command_output();

-- Capture inserts its page before advancing the command within one transaction.
-- A cached terminal observation is usable only after the same proof commits.
CREATE FUNCTION check_sandbox_v2_command_output_commit()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE command sandbox_v2_commands;
  parent_account text:=current_setting('opengeni.account_id',true);
  parent_workspace text:=current_setting('opengeni.workspace_id',true);
  parent_subject text:=current_setting('opengeni.subject_id',true);
  terminal_stream jsonb:='{"offset":0,"nextOffset":0,"data":"","eof":true}'::jsonb;
BEGIN
  -- Deferred triggers run after nested tenant helpers restore their parent GUCs.
  -- The inserted row already passed RLS; read its parent under that exact scope
  -- so tenant invisibility cannot masquerade as an actual cascading deletion.
  PERFORM set_config('opengeni.account_id',NEW.account_id::text,true);
  PERFORM set_config('opengeni.workspace_id',NEW.workspace_id::text,true);
  -- This trigger only validates a row already admitted by RLS. Its internal
  -- parent read must not disappear when a later private-session actor changes.
  PERFORM set_config('opengeni.subject_id','',true);
  SELECT * INTO command FROM sandbox_v2_commands WHERE operation_id=NEW.operation_id;
  PERFORM set_config('opengeni.account_id',coalesce(parent_account,''),true);
  PERFORM set_config('opengeni.workspace_id',coalesce(parent_workspace,''),true);
  PERFORM set_config('opengeni.subject_id',coalesce(parent_subject,''),true);
  IF command.operation_id IS NULL THEN RETURN NEW; END IF;
  IF command.revision<NEW.revision
    OR (command.stdout->>'offset')::numeric<(NEW.observation->'stdout'->>'nextOffset')::numeric
    OR (command.stderr->>'offset')::numeric<(NEW.observation->'stderr'->>'nextOffset')::numeric
    OR (NEW.observation->>'state' IN ('exited','cancelled') AND
      (NEW.observation || jsonb_build_object('stdout',terminal_stream,'stderr',terminal_stream)) IS DISTINCT FROM command.proof) THEN
    RAISE EXCEPTION 'Command output lacks its committed cursor or terminal proof' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION check_sandbox_v2_command_output_commit() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER sandbox_v2_command_output_commit AFTER INSERT ON sandbox_v2_command_output
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_sandbox_v2_command_output_commit();
DO $$ DECLARE target_schema text:=current_schema(); BEGIN
  EXECUTE format('ALTER FUNCTION %I.guard_sandbox_v2_command_output() SET search_path TO pg_catalog, %I, pg_temp',target_schema,target_schema);
  EXECUTE format('ALTER FUNCTION %I.check_sandbox_v2_command_output_commit() SET search_path TO pg_catalog, %I, pg_temp',target_schema,target_schema);
END $$;

-- Session-only deletion must not discard dispatch authority just because its
-- logical turn ended. Explicit tenant teardown may still cascade its own rows.
CREATE FUNCTION guard_session_sandbox_v2_cleanup()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM workspaces WHERE id=OLD.workspace_id AND account_id=OLD.account_id)
    AND EXISTS (SELECT 1 FROM managed_accounts WHERE id=OLD.account_id) THEN
    IF EXISTS (SELECT 1 FROM sandbox_v2_commands WHERE account_id=OLD.account_id
      AND workspace_id=OLD.workspace_id AND session_id=OLD.id AND proof IS NULL AND NOT abandoned)
      OR EXISTS (SELECT 1 FROM sandbox_v2_credential_cleanup WHERE account_id=OLD.account_id
        AND workspace_id=OLD.workspace_id AND session_id=OLD.id AND proof IS NULL)
      OR EXISTS (SELECT 1 FROM sandbox_v2_background_credentials WHERE account_id=OLD.account_id
        AND workspace_id=OLD.workspace_id AND session_id=OLD.id AND cleanup_proof IS NULL)
      OR EXISTS (SELECT 1 FROM sandbox_v2_machines WHERE account_id=OLD.account_id
        AND workspace_id=OLD.workspace_id AND sandbox_group_id=OLD.sandbox_group_id
        AND (NOT coalesce(projection->>'state' IN ('absent','destroyed'),false)
          OR projection->'instance' IS DISTINCT FROM 'null'::jsonb
          OR projection->'disk' IS DISTINCT FROM 'null'::jsonb
          OR projection->'transition' IS DISTINCT FROM 'null'::jsonb
          OR projection->'demands' IS DISTINCT FROM '[]'::jsonb)) THEN
      RAISE EXCEPTION 'Sandbox machine cleanup requires physical quiescence' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION guard_session_sandbox_v2_cleanup() FROM PUBLIC;
CREATE TRIGGER session_sandbox_v2_cleanup_guard BEFORE DELETE ON sessions
  FOR EACH ROW EXECUTE FUNCTION guard_session_sandbox_v2_cleanup();
DO $$ DECLARE target_schema text:=current_schema(); BEGIN
  EXECUTE format('ALTER FUNCTION %I.guard_session_sandbox_v2_cleanup() SET search_path TO pg_catalog, %I, pg_temp',target_schema,target_schema);
END $$;

-- One bounded, read-only control inventory. The capability is backend/transaction
-- scoped and this policy applies only to the migration owner inside the definer.
-- Opening an inventory never grants the application a cross-tenant table read.
DO $machine_inventory_install$
DECLARE target_schema text:=current_schema();
  target_schema_oid oid:=current_schema()::regnamespace;
  migration_owner text:=current_user;
BEGIN
  EXECUTE format('CREATE POLICY sandbox_v2_machine_inventory_read ON %I.sandbox_v2_machines '
    || 'FOR SELECT USING (%I.session_tenancy_fence_owner_policy_active('
    || 'current_user::text,%L::text,%s::oid,workspace_id,true))',
    target_schema,target_schema,migration_owner,target_schema_oid);
  EXECUTE format($definition$
    CREATE FUNCTION %1$I.list_sandbox_v2_machine_inventory(p_limit integer,p_after uuid)
    RETURNS TABLE(account_id uuid,workspace_id uuid,sandbox_group_id uuid,machine_id uuid,provider text)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,%1$I,pg_temp AS $body$
    DECLARE inventory_id uuid;
    BEGIN
      IF p_limit IS NULL OR p_limit<1 OR p_limit>1000 THEN
        RAISE EXCEPTION 'Invalid bounded machine inventory limit' USING ERRCODE='22023';
      END IF;
      inventory_id:=opengeni_private.open_session_tenancy_fence_inventory(%2$s::oid);
      RETURN QUERY SELECT machine.account_id,machine.workspace_id,machine.sandbox_group_id,
        machine.id,machine.provider FROM %1$I.sandbox_v2_machines machine
        WHERE (p_after IS NULL OR machine.id>p_after)
          AND machine.projection->>'state'<>'destroyed'
        ORDER BY machine.id LIMIT p_limit;
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
    EXCEPTION WHEN OTHERS THEN
      IF inventory_id IS NOT NULL THEN
        PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
      END IF;
      RAISE;
    END $body$;
  $definition$,target_schema,target_schema_oid);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.list_sandbox_v2_machine_inventory(integer,uuid) FROM PUBLIC',
    target_schema);
END $machine_inventory_install$;

-- Host preparation is immutable before its first side effect. Only stable
-- credential-generation/file references and nonsecret setup commands belong
-- here; credential envelopes, download URLs and stdin payloads are excluded.
CREATE TABLE sandbox_v2_preparation_plans (
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL, session_id uuid NOT NULL,
  turn_id uuid NOT NULL REFERENCES session_turns(id) ON DELETE CASCADE,
  attempt_id uuid NOT NULL REFERENCES session_turn_attempts(id) ON DELETE CASCADE,
  execution_generation integer NOT NULL CHECK (execution_generation>=0),
  machine_id uuid NOT NULL, instance jsonb NOT NULL CHECK (jsonb_typeof(instance)='object'),
  setup_id text NOT NULL CHECK (length(setup_id) BETWEEN 1 AND 512),
  definition_digest text NOT NULL CHECK (definition_digest ~ '^[a-f0-9]{64}$'),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition)='object'
    AND definition->>'setupId' IS NOT DISTINCT FROM setup_id
    AND definition ?& ARRAY['setupId','steps','files']
    AND jsonb_typeof(definition->'steps')='array'
    AND jsonb_typeof(definition->'files')='array'
    AND octet_length(definition::text)<=2097152),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,session_id,turn_id,setup_id),
  FOREIGN KEY(workspace_id,account_id) REFERENCES workspaces(id,account_id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,session_id) REFERENCES sessions(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(session_id,account_id) REFERENCES sessions(id,account_id) ON DELETE CASCADE,
  FOREIGN KEY(account_id,workspace_id,machine_id)
    REFERENCES sandbox_v2_machines(account_id,workspace_id,id) ON DELETE RESTRICT
);
ALTER TABLE sandbox_v2_preparation_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox_v2_preparation_plans FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE sandbox_v2_preparation_plans FROM PUBLIC;
CREATE POLICY workspace_isolation ON sandbox_v2_preparation_plans
  USING (opengeni_private.workspace_rls_visible(account_id,workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id,workspace_id));
CREATE POLICY session_visibility_isolation ON sandbox_v2_preparation_plans AS RESTRICTIVE
  USING (session_reference_visible(account_id,workspace_id,session_id))
  WITH CHECK (session_reference_visible(account_id,workspace_id,session_id));

CREATE FUNCTION guard_sandbox_v2_preparation_plan()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    RAISE EXCEPTION 'Retained preparation plan is immutable' USING ERRCODE='23514';
  ELSIF TG_OP='DELETE' THEN
    IF EXISTS (SELECT 1 FROM sessions WHERE id=OLD.session_id AND workspace_id=OLD.workspace_id)
      AND EXISTS (SELECT 1 FROM workspaces WHERE id=OLD.workspace_id AND account_id=OLD.account_id) THEN
      RAISE EXCEPTION 'Retained preparation plan cannot be erased' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM session_turn_attempts attempt
    JOIN session_turns turn_row ON turn_row.id=attempt.turn_id
    JOIN sessions session_row ON session_row.id=attempt.session_id
    JOIN sandbox_v2_machines machine ON machine.id=NEW.machine_id
    WHERE attempt.id=NEW.attempt_id AND attempt.account_id=NEW.account_id
      AND attempt.workspace_id=NEW.workspace_id AND attempt.session_id=NEW.session_id
      AND attempt.turn_id=NEW.turn_id AND attempt.execution_generation=NEW.execution_generation
      AND turn_row.account_id=NEW.account_id AND turn_row.session_id=NEW.session_id
      AND machine.account_id=NEW.account_id AND machine.workspace_id=NEW.workspace_id
      AND machine.sandbox_group_id=session_row.sandbox_group_id
      AND machine.projection->'instance' IS NOT DISTINCT FROM NEW.instance) THEN
    RAISE EXCEPTION 'Preparation plan owner or machine scope mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_sandbox_v2_preparation_plan() FROM PUBLIC;
CREATE TRIGGER sandbox_v2_preparation_plan_guard BEFORE INSERT OR UPDATE OR DELETE
  ON sandbox_v2_preparation_plans FOR EACH ROW EXECUTE FUNCTION guard_sandbox_v2_preparation_plan();
DO $$ DECLARE target_schema text:=current_schema(); BEGIN
  EXECUTE format('ALTER FUNCTION %I.guard_sandbox_v2_preparation_plan() SET search_path TO pg_catalog, %I, pg_temp',
    target_schema,target_schema);
END $$;

-- Immutable encrypted originals for host run-credential recovery. The key is
-- held outside Postgres; plaintext never belongs in setup plans or this table.
-- Erasure keeps an identity tombstone and requires exact physical quiescence.
CREATE TABLE sandbox_v2_credential_generations (
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL, session_id uuid NOT NULL,
  turn_id uuid NOT NULL REFERENCES session_turns(id) ON DELETE CASCADE,
  attempt_id uuid NOT NULL REFERENCES session_turn_attempts(id) ON DELETE CASCADE,
  execution_generation integer NOT NULL CHECK (execution_generation>=0),
  machine_id uuid NOT NULL, instance jsonb NOT NULL CHECK (jsonb_typeof(instance)='object'),
  generation_id text NOT NULL CHECK (length(generation_id) BETWEEN 1 AND 512),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition)='object'
    AND definition ?& ARRAY['generationId','purpose','forceRefresh']
    AND (definition-'generationId'-'purpose'-'forceRefresh')='{}'::jsonb
    AND jsonb_typeof(definition->'generationId')='string'
    AND definition->>'generationId' IS NOT DISTINCT FROM generation_id
    AND definition->>'purpose' IN ('provision','renewal')
    AND jsonb_typeof(definition->'forceRefresh')='boolean'
    AND octet_length(definition::text)<=4096),
  ciphertext text, expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), cleared_at timestamptz,
  CHECK ((ciphertext IS NULL) = (cleared_at IS NOT NULL)),
  CHECK (ciphertext IS NULL OR (octet_length(ciphertext)<=67108864
    AND ciphertext ~ '^v2:[A-Za-z0-9+/]{16}:[A-Za-z0-9+/]+={0,2}$')),
  PRIMARY KEY(workspace_id,session_id,attempt_id,generation_id),
  FOREIGN KEY(workspace_id,account_id) REFERENCES workspaces(id,account_id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,session_id) REFERENCES sessions(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(session_id,account_id) REFERENCES sessions(id,account_id) ON DELETE CASCADE,
  FOREIGN KEY(account_id,workspace_id,machine_id)
    REFERENCES sandbox_v2_machines(account_id,workspace_id,id) ON DELETE RESTRICT
);
ALTER TABLE sandbox_v2_credential_generations ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox_v2_credential_generations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE sandbox_v2_credential_generations FROM PUBLIC;
CREATE POLICY workspace_isolation ON sandbox_v2_credential_generations
  USING (opengeni_private.workspace_rls_visible(account_id,workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id,workspace_id));
CREATE POLICY session_visibility_isolation ON sandbox_v2_credential_generations AS RESTRICTIVE
  USING (session_reference_visible(account_id,workspace_id,session_id))
  WITH CHECK (session_reference_visible(account_id,workspace_id,session_id));

CREATE FUNCTION guard_sandbox_v2_credential_generation()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF EXISTS (SELECT 1 FROM sessions WHERE id=OLD.session_id AND workspace_id=OLD.workspace_id)
      AND EXISTS (SELECT 1 FROM workspaces WHERE id=OLD.workspace_id AND account_id=OLD.account_id) THEN
      RAISE EXCEPTION 'Retained credential identity cannot be erased' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  ELSIF TG_OP='UPDATE' THEN
    IF OLD.ciphertext IS NULL OR OLD.cleared_at IS NOT NULL
      OR NEW.ciphertext IS NOT NULL OR NEW.cleared_at IS NULL
      OR (NEW.account_id,NEW.workspace_id,NEW.session_id,NEW.turn_id,NEW.attempt_id,
          NEW.execution_generation,NEW.machine_id,NEW.instance,NEW.generation_id,
          NEW.definition,NEW.expires_at,NEW.created_at) IS DISTINCT FROM
         (OLD.account_id,OLD.workspace_id,OLD.session_id,OLD.turn_id,OLD.attempt_id,
          OLD.execution_generation,OLD.machine_id,OLD.instance,OLD.generation_id,
          OLD.definition,OLD.expires_at,OLD.created_at)
      OR NOT EXISTS (SELECT 1 FROM session_turn_attempts attempt
        WHERE attempt.id=OLD.attempt_id AND attempt.account_id=OLD.account_id
          AND attempt.workspace_id=OLD.workspace_id AND attempt.session_id=OLD.session_id
          AND attempt.turn_id=OLD.turn_id AND attempt.execution_generation=OLD.execution_generation
          AND attempt.closed_at IS NOT NULL AND attempt.quiesced_at IS NOT NULL)
      OR sandbox_v2_attempt_writers_pending(OLD.account_id,OLD.workspace_id,OLD.session_id,OLD.attempt_id,NULL) THEN
      RAISE EXCEPTION 'Credential erasure requires exact attempt quiescence' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.ciphertext IS NULL OR NEW.cleared_at IS NOT NULL
    OR NOT EXISTS (SELECT 1 FROM session_turn_attempts attempt
      JOIN session_turns turn_row ON turn_row.id=attempt.turn_id
      JOIN sessions session_row ON session_row.id=attempt.session_id
      JOIN sandbox_v2_machines machine ON machine.id=NEW.machine_id
      WHERE attempt.id=NEW.attempt_id AND attempt.account_id=NEW.account_id
        AND attempt.workspace_id=NEW.workspace_id AND attempt.session_id=NEW.session_id
        AND attempt.turn_id=NEW.turn_id AND attempt.execution_generation=NEW.execution_generation
        AND attempt.state IN ('claimed','running') AND attempt.closed_at IS NULL
        AND turn_row.account_id=NEW.account_id AND turn_row.session_id=NEW.session_id
        AND turn_row.active_attempt_id=NEW.attempt_id AND session_row.active_turn_id=NEW.turn_id
        AND machine.account_id=NEW.account_id AND machine.workspace_id=NEW.workspace_id
        AND machine.sandbox_group_id=session_row.sandbox_group_id
        AND machine.projection->'instance' IS NOT DISTINCT FROM NEW.instance) THEN
    RAISE EXCEPTION 'Credential generation owner or machine scope mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

-- Retain cleanup before material is delivered. Its native proof closes a
-- separate maintenance writer; revocation never reopens agent commands.
CREATE TABLE sandbox_v2_credential_cleanup (
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL, session_id uuid NOT NULL,
  turn_id uuid NOT NULL REFERENCES session_turns(id) ON DELETE CASCADE,
  attempt_id uuid NOT NULL REFERENCES session_turn_attempts(id) ON DELETE CASCADE,
  execution_generation integer NOT NULL CHECK (execution_generation>=0),
  machine_id uuid NOT NULL, instance jsonb NOT NULL CHECK (jsonb_typeof(instance)='object'),
  operation_id uuid NOT NULL UNIQUE,
  specification_digest text NOT NULL CHECK (specification_digest ~ '^[a-f0-9]{64}$'),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision>=0 AND revision<9007199254740991),
  binding jsonb, proof jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,session_id,attempt_id),
  FOREIGN KEY(workspace_id,account_id) REFERENCES workspaces(id,account_id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,session_id) REFERENCES sessions(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(session_id,account_id) REFERENCES sessions(id,account_id) ON DELETE CASCADE,
  FOREIGN KEY(account_id,workspace_id,machine_id)
    REFERENCES sandbox_v2_machines(account_id,workspace_id,id) ON DELETE RESTRICT
);
CREATE INDEX sandbox_v2_credential_cleanup_pending_idx
  ON sandbox_v2_credential_cleanup(workspace_id,machine_id) WHERE proof IS NULL;
ALTER TABLE sandbox_v2_credential_cleanup ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox_v2_credential_cleanup FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE sandbox_v2_credential_cleanup FROM PUBLIC;
CREATE POLICY workspace_isolation ON sandbox_v2_credential_cleanup
  USING (opengeni_private.workspace_rls_visible(account_id,workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id,workspace_id));
CREATE POLICY session_visibility_isolation ON sandbox_v2_credential_cleanup AS RESTRICTIVE
  USING (session_reference_visible(account_id,workspace_id,session_id))
  WITH CHECK (session_reference_visible(account_id,workspace_id,session_id));

CREATE FUNCTION guard_sandbox_v2_credential_cleanup()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE closed boolean; live boolean; current_instance jsonb; current_state text;
  terminal_stdout jsonb:='{"offset":0,"nextOffset":7,"data":"Y2xlYW5lZA==","eof":true}';
  terminal_stderr jsonb:='{"offset":0,"nextOffset":0,"data":"","eof":true}';
  receipt jsonb;
  uuid_pattern text:='^([a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$';
BEGIN
  IF TG_OP='DELETE' THEN
    IF EXISTS (SELECT 1 FROM sessions WHERE id=OLD.session_id AND workspace_id=OLD.workspace_id)
      AND EXISTS (SELECT 1 FROM workspaces WHERE id=OLD.workspace_id AND account_id=OLD.account_id) THEN
      RAISE EXCEPTION 'Credential cleanup authority must be retained' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  SELECT attempt.closed_at IS NOT NULL,
      attempt.closed_at IS NULL AND attempt.state IN ('claimed','running')
        AND turn_row.active_attempt_id=NEW.attempt_id
        AND turn_row.execution_generation=NEW.execution_generation AND session_row.active_turn_id=NEW.turn_id,
      machine.projection->'instance',machine.projection->>'state'
    INTO closed,live,current_instance,current_state
    FROM session_turn_attempts attempt
    JOIN session_turns turn_row ON turn_row.id=attempt.turn_id
    JOIN sessions session_row ON session_row.id=attempt.session_id
    JOIN sandbox_v2_machines machine ON machine.id=NEW.machine_id
    WHERE attempt.id=NEW.attempt_id AND attempt.account_id=NEW.account_id
      AND attempt.workspace_id=NEW.workspace_id AND attempt.session_id=NEW.session_id
      AND attempt.turn_id=NEW.turn_id AND attempt.execution_generation=NEW.execution_generation
      AND session_row.account_id=NEW.account_id AND turn_row.account_id=NEW.account_id
      AND machine.account_id=NEW.account_id AND machine.workspace_id=NEW.workspace_id
      AND machine.sandbox_group_id=session_row.sandbox_group_id;
  IF closed IS NULL OR current_instance IS DISTINCT FROM NEW.instance THEN
    RAISE EXCEPTION 'Credential cleanup owner or incarnation changed' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF live IS DISTINCT FROM true OR NEW.binding IS NOT NULL OR NEW.proof IS NOT NULL OR NEW.revision<>0 OR current_state IS DISTINCT FROM 'running' THEN
      RAISE EXCEPTION 'Credential cleanup intent requires live original authority' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.revision<>OLD.revision+1 OR
    (NEW.account_id,NEW.workspace_id,NEW.session_id,NEW.turn_id,NEW.attempt_id,NEW.execution_generation,
      NEW.machine_id,NEW.instance,NEW.operation_id,NEW.specification_digest,NEW.created_at) IS DISTINCT FROM
    (OLD.account_id,OLD.workspace_id,OLD.session_id,OLD.turn_id,OLD.attempt_id,OLD.execution_generation,
      OLD.machine_id,OLD.instance,OLD.operation_id,OLD.specification_digest,OLD.created_at)
    OR OLD.binding IS NOT NULL AND NEW.binding IS DISTINCT FROM OLD.binding
    OR OLD.proof IS NOT NULL AND NEW.proof IS DISTINCT FROM OLD.proof THEN
    RAISE EXCEPTION 'Credential cleanup identity and evidence are immutable' USING ERRCODE='23514';
  END IF;
  IF closed IS DISTINCT FROM true OR sandbox_v2_attempt_writers_pending(NEW.account_id,NEW.workspace_id,NEW.session_id,NEW.attempt_id,NEW.operation_id) THEN
    RAISE EXCEPTION 'Credential cleanup requires a closed drained original attempt' USING ERRCODE='23514';
  END IF;
  IF NEW.binding IS NULL OR NEW.binding IS DISTINCT FROM jsonb_build_object(
    'kind','machine-journal-v1','machineId',NEW.machine_id::text,'operationId',NEW.operation_id::text,
    'diskLineage',NEW.instance->>'diskLineage','bootId',NEW.instance->>'bootId',
    'specificationDigest',NEW.specification_digest,'stdin',false,'pty',false) THEN
    RAISE EXCEPTION 'Credential cleanup dispatch binding changed' USING ERRCODE='23514';
  END IF;
  IF NEW.proof IS NOT NULL THEN
    receipt:=NEW.proof->'receipt';
    IF jsonb_typeof(NEW.proof) IS DISTINCT FROM 'object' OR jsonb_typeof(receipt) IS DISTINCT FROM 'object'
      OR NOT coalesce(NEW.proof ?& ARRAY['operationId','state','specificationDigest','receipt','stdout','stderr']
        AND (SELECT count(*) FROM jsonb_object_keys(NEW.proof))=6
        AND NEW.proof->>'operationId'=NEW.operation_id::text AND NEW.proof->>'state'='exited'
        AND NEW.proof->>'specificationDigest'=NEW.specification_digest
        AND NEW.proof->'stdout'=terminal_stdout AND NEW.proof->'stderr'=terminal_stderr
        AND receipt ?& ARRAY['protocol','invocationId','receiptId','leaderExitCode']
        AND (SELECT count(*) FROM jsonb_object_keys(receipt))=4
        AND receipt->>'protocol'='native-subreaper-v1' AND receipt->>'invocationId'=NEW.operation_id::text
        AND jsonb_typeof(receipt->'receiptId')='string' AND receipt->>'receiptId' ~ uuid_pattern
        AND receipt->'leaderExitCode'='0'::jsonb,false) THEN
      RAISE EXCEPTION 'Credential cleanup requires its complete exact acknowledgement and native exit' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_sandbox_v2_credential_cleanup() FROM PUBLIC;
CREATE TRIGGER sandbox_v2_credential_cleanup_guard BEFORE INSERT OR UPDATE OR DELETE
  ON sandbox_v2_credential_cleanup FOR EACH ROW EXECUTE FUNCTION guard_sandbox_v2_credential_cleanup();
DO $$ DECLARE target_schema text:=current_schema(); BEGIN
  EXECUTE format('ALTER FUNCTION %I.guard_sandbox_v2_credential_cleanup() SET search_path TO pg_catalog, %I, pg_temp',target_schema,target_schema);
END $$;
REVOKE ALL ON FUNCTION guard_sandbox_v2_credential_generation() FROM PUBLIC;
CREATE TRIGGER sandbox_v2_credential_generation_guard BEFORE INSERT OR UPDATE OR DELETE
  ON sandbox_v2_credential_generations FOR EACH ROW EXECUTE FUNCTION guard_sandbox_v2_credential_generation();
DO $$ DECLARE target_schema text:=current_schema(); BEGIN
  EXECUTE format('ALTER FUNCTION %I.guard_sandbox_v2_credential_generation() SET search_path TO pg_catalog, %I, pg_temp',
    target_schema,target_schema);
END $$;

-- This head retains only ordered, nonsecret generation references. Reservation
-- happens before broker I/O; activation requires the exact writer capture.
-- It remains an attempt-owned credential seam, not a fleet/lifetime scheduler.
CREATE TABLE sandbox_v2_credential_owners (
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL, session_id uuid NOT NULL,
  turn_id uuid NOT NULL REFERENCES session_turns(id) ON DELETE CASCADE,
  attempt_id uuid NOT NULL REFERENCES session_turn_attempts(id) ON DELETE CASCADE,
  execution_generation integer NOT NULL CHECK (execution_generation>=0),
  machine_id uuid NOT NULL, instance jsonb NOT NULL CHECK (jsonb_typeof(instance)='object'),
  setup_id text NOT NULL CHECK (length(setup_id) BETWEEN 1 AND 512),
  initial_generation_id text NOT NULL CHECK (length(initial_generation_id) BETWEEN 1 AND 512),
  version bigint NOT NULL DEFAULT 0 CHECK (version>=0 AND version<9007199254740991),
  active jsonb, pending jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,session_id,attempt_id),
  FOREIGN KEY(workspace_id,account_id) REFERENCES workspaces(id,account_id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,session_id) REFERENCES sessions(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(session_id,account_id) REFERENCES sessions(id,account_id) ON DELETE CASCADE,
  FOREIGN KEY(account_id,workspace_id,machine_id)
    REFERENCES sandbox_v2_machines(account_id,workspace_id,id) ON DELETE RESTRICT
);
ALTER TABLE sandbox_v2_credential_owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox_v2_credential_owners FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE sandbox_v2_credential_owners FROM PUBLIC;
CREATE POLICY workspace_isolation ON sandbox_v2_credential_owners
  USING (opengeni_private.workspace_rls_visible(account_id,workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id,workspace_id));
CREATE POLICY session_visibility_isolation ON sandbox_v2_credential_owners AS RESTRICTIVE
  USING (session_reference_visible(account_id,workspace_id,session_id))
  WITH CHECK (session_reference_visible(account_id,workspace_id,session_id));

CREATE FUNCTION sandbox_v2_credential_writer_action(setup_id text,generation_id text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT 'sandbox-v2:' || encode(sha256(convert_to(
    '["sandbox-v2-operation-v1",' || to_json('platform-setup-v1:' ||
      encode(sha256(convert_to('["platform-setup-v1",' || to_json(setup_id)::text || ']','UTF8')),'hex'))::text ||
    ',' || to_json('credentials:' || encode(sha256(convert_to(generation_id,'UTF8')),'hex'))::text || ']','UTF8')),'hex')
$$;
REVOKE ALL ON FUNCTION sandbox_v2_credential_writer_action(text,text) FROM PUBLIC;

CREATE FUNCTION guard_sandbox_v2_credential_owner()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE ticket jsonb; generation_id text; ordinal_value numeric; acknowledgement text; page_count integer;
BEGIN
  IF TG_OP='DELETE' THEN
    IF EXISTS (SELECT 1 FROM sessions WHERE id=OLD.session_id AND workspace_id=OLD.workspace_id)
      AND EXISTS (SELECT 1 FROM workspaces WHERE id=OLD.workspace_id AND account_id=OLD.account_id) THEN
      RAISE EXCEPTION 'Retained credential owner cannot be erased' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM session_turn_attempts attempt
    JOIN session_turns turn_row ON turn_row.id=attempt.turn_id
    JOIN sessions session_row ON session_row.id=attempt.session_id
    JOIN sandbox_v2_machines machine ON machine.id=NEW.machine_id
    JOIN sandbox_v2_preparation_plans plan ON plan.workspace_id=NEW.workspace_id
      AND plan.session_id=NEW.session_id AND plan.turn_id=NEW.turn_id AND plan.setup_id=NEW.setup_id
    WHERE attempt.id=NEW.attempt_id AND attempt.account_id=NEW.account_id
      AND attempt.workspace_id=NEW.workspace_id AND attempt.session_id=NEW.session_id
      AND attempt.turn_id=NEW.turn_id AND attempt.execution_generation=NEW.execution_generation
      AND attempt.state IN ('claimed','running') AND attempt.closed_at IS NULL
      AND turn_row.active_attempt_id=NEW.attempt_id AND turn_row.execution_generation=NEW.execution_generation
      AND session_row.active_turn_id=NEW.turn_id AND machine.account_id=NEW.account_id
      AND machine.workspace_id=NEW.workspace_id AND machine.sandbox_group_id=session_row.sandbox_group_id
      AND machine.projection->'instance' IS NOT DISTINCT FROM NEW.instance
      AND plan.attempt_id=NEW.attempt_id AND plan.machine_id=NEW.machine_id
      AND plan.execution_generation=NEW.execution_generation AND plan.instance IS NOT DISTINCT FROM NEW.instance
      AND plan.definition->>'credentialGenerationId' IS NOT DISTINCT FROM NEW.initial_generation_id) THEN
    RAISE EXCEPTION 'Credential owner or preparation scope mismatch' USING ERRCODE='23514';
  END IF;
  FOREACH ticket IN ARRAY ARRAY[NEW.active,NEW.pending] LOOP
    IF ticket IS NULL THEN CONTINUE; END IF;
    IF jsonb_typeof(ticket) IS DISTINCT FROM 'object'
      OR NOT ticket ?& ARRAY['ordinal','definition','writerActionId']
      OR (ticket-'ordinal'-'definition'-'writerActionId') <> '{}'::jsonb
      OR jsonb_typeof(ticket->'ordinal') IS DISTINCT FROM 'number'
      OR (ticket->>'ordinal') !~ '^[0-9]+$'
      OR jsonb_typeof(ticket->'definition') IS DISTINCT FROM 'object'
      OR NOT (ticket->'definition') ?& ARRAY['generationId','purpose','forceRefresh']
      OR ((ticket->'definition')-'generationId'-'purpose'-'forceRefresh') <> '{}'::jsonb
      OR jsonb_typeof(ticket->'definition'->'generationId') IS DISTINCT FROM 'string'
      OR length(ticket->'definition'->>'generationId') NOT BETWEEN 1 AND 512
      OR jsonb_typeof(ticket->'definition'->'forceRefresh') IS DISTINCT FROM 'boolean'
      OR jsonb_typeof(ticket->'writerActionId') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'Invalid credential activation ticket' USING ERRCODE='23514';
    END IF;
    ordinal_value := (ticket->>'ordinal')::numeric;
    generation_id := ticket->'definition'->>'generationId';
    IF ordinal_value>=9007199254740991
      OR ticket->>'writerActionId' IS DISTINCT FROM sandbox_v2_credential_writer_action(NEW.setup_id,generation_id)
      OR (ordinal_value=0 AND (generation_id IS DISTINCT FROM NEW.initial_generation_id
        OR ticket->'definition'->>'purpose' IS DISTINCT FROM 'provision'
        OR ticket->'definition'->'forceRefresh' IS DISTINCT FROM 'false'::jsonb))
      OR (ordinal_value>0 AND (generation_id=NEW.initial_generation_id
        OR ticket->'definition'->>'purpose' IS DISTINCT FROM 'renewal'
        OR ticket->'definition'->'forceRefresh' IS DISTINCT FROM 'true'::jsonb)) THEN
      RAISE EXCEPTION 'Credential activation ticket identity changed' USING ERRCODE='23514';
    END IF;
  END LOOP;
  IF NEW.active IS NULL AND (NEW.pending IS NULL OR NEW.pending->>'ordinal' IS DISTINCT FROM '0')
    OR NEW.pending IS NOT NULL AND (NEW.pending->>'ordinal')::numeric <> COALESCE((NEW.active->>'ordinal')::numeric,-1)+1 THEN
    RAISE EXCEPTION 'Credential activation sequence is invalid' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.version<>0 OR NEW.active IS NOT NULL OR NEW.pending IS NULL THEN
      RAISE EXCEPTION 'Credential owner must begin pending' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.version<>OLD.version+1
    OR (NEW.account_id,NEW.workspace_id,NEW.session_id,NEW.turn_id,NEW.attempt_id,
        NEW.execution_generation,NEW.machine_id,NEW.instance,NEW.setup_id,NEW.initial_generation_id,NEW.created_at)
      IS DISTINCT FROM (OLD.account_id,OLD.workspace_id,OLD.session_id,OLD.turn_id,OLD.attempt_id,
        OLD.execution_generation,OLD.machine_id,OLD.instance,OLD.setup_id,OLD.initial_generation_id,OLD.created_at) THEN
    RAISE EXCEPTION 'Credential owner identity or version changed' USING ERRCODE='23514';
  END IF;
  IF OLD.pending IS NULL AND OLD.active IS NOT NULL AND NEW.active IS NOT DISTINCT FROM OLD.active
    AND NEW.pending IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM sandbox_v2_credential_generations generation
      WHERE generation.workspace_id=NEW.workspace_id AND generation.session_id=NEW.session_id
        AND generation.attempt_id=NEW.attempt_id
        AND generation.generation_id=NEW.pending->'definition'->>'generationId') THEN
      RAISE EXCEPTION 'Credential generation identity cannot be reused' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.pending IS NULL OR NEW.pending IS NOT NULL OR NEW.active IS DISTINCT FROM OLD.pending THEN
    RAISE EXCEPTION 'Pending credential generation cannot be replaced' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM sandbox_v2_credential_generations generation
    WHERE generation.account_id=NEW.account_id AND generation.workspace_id=NEW.workspace_id
      AND generation.session_id=NEW.session_id AND generation.attempt_id=NEW.attempt_id
      AND generation.turn_id=NEW.turn_id AND generation.execution_generation=NEW.execution_generation
      AND generation.machine_id=NEW.machine_id AND generation.instance IS NOT DISTINCT FROM NEW.instance
      AND generation.generation_id=NEW.active->'definition'->>'generationId'
      AND generation.definition IS NOT DISTINCT FROM NEW.active->'definition'
      AND generation.ciphertext IS NOT NULL AND generation.cleared_at IS NULL
      AND (generation.expires_at IS NULL OR generation.expires_at>clock_timestamp())) THEN
    RAISE EXCEPTION 'Credential activation has no usable retained original' USING ERRCODE='23514';
  END IF;
  SELECT string_agg(convert_from(decode(page.stdout,'base64'),'UTF8'),'' ORDER BY page.revision),count(*)::integer
    INTO acknowledgement,page_count FROM sandbox_v2_commands command
    JOIN sandbox_v2_command_output page ON page.operation_id=command.operation_id
    WHERE command.account_id=NEW.account_id AND command.workspace_id=NEW.workspace_id
      AND command.session_id=NEW.session_id AND command.turn_id=NEW.turn_id AND command.attempt_id=NEW.attempt_id
      AND command.execution_generation=NEW.execution_generation AND command.machine_id=NEW.machine_id
      AND command.instance_id=NEW.instance->>'id' AND command.binding->>'bootId'=NEW.instance->>'bootId'
      AND command.binding->>'diskLineage'=NEW.instance->>'diskLineage'
      AND command.accepted_action_id=NEW.active->>'writerActionId'
      AND command.proof->>'state'='exited' AND command.proof->'receipt'->'leaderExitCode'='0'::jsonb
      AND (command.proof->'receipt'->>'acceptedInputSequence')::bigint>=2
      AND command.proof->'stdout'->'eof'='true'::jsonb AND command.proof->'stderr'->'eof'='true'::jsonb
      AND command.proof->'stderr'->'nextOffset'='0'::jsonb AND command.stderr->'offset'='0'::jsonb
      AND command.stdout->>'remainder'='' AND command.stderr->>'remainder'=''
      AND command.stdout->'offset' IN ('9'::jsonb,'14'::jsonb) AND page.stderr='' AND page.stdout<>'';
  IF acknowledgement IS NULL OR acknowledgement NOT IN ('installed','not_applicable') OR page_count>=32 THEN
    RAISE EXCEPTION 'Credential activation requires exact writer completion' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_sandbox_v2_credential_owner() FROM PUBLIC;
CREATE TRIGGER sandbox_v2_credential_owner_guard BEFORE INSERT OR UPDATE OR DELETE
  ON sandbox_v2_credential_owners FOR EACH ROW EXECUTE FUNCTION guard_sandbox_v2_credential_owner();
DO $$ DECLARE target_schema text:=current_schema(); BEGIN
  EXECUTE format('ALTER FUNCTION %I.guard_sandbox_v2_credential_owner() SET search_path TO pg_catalog, %I, pg_temp',target_schema,target_schema);
END $$;

-- A native background intent reuses the managed command API. Its exact native
-- operation replaces only the legacy retained-process locator. Registration
-- precedes binding/Start; this does not change attempt writer or credential
-- gates, install an adapter or grant post-turn launch authority.
ALTER TABLE session_background_commands ADD COLUMN native_operation_id uuid;
ALTER TABLE session_background_commands
  ADD CONSTRAINT session_background_commands_native_operation_fk
  FOREIGN KEY(account_id,workspace_id,session_id,native_operation_id)
  REFERENCES sandbox_v2_commands(account_id,workspace_id,session_id,operation_id) ON DELETE CASCADE;
CREATE UNIQUE INDEX session_background_commands_native_operation_uq
  ON session_background_commands(native_operation_id) WHERE native_operation_id IS NOT NULL;
ALTER TABLE session_background_commands DROP CONSTRAINT session_background_commands_provider_identity_check;
ALTER TABLE session_background_commands ADD CONSTRAINT session_background_commands_provider_identity_check CHECK (
  (provider='managed'
    AND ((retained_process_id IS NOT NULL AND native_operation_id IS NULL)
      OR (retained_process_id IS NULL AND native_operation_id IS NOT NULL))
    AND control_workspace_id IS NULL AND enrollment_id IS NULL
    AND connection_instance_id IS NULL AND op_id IS NULL)
  OR (provider='connected_machine' AND retained_process_id IS NULL AND native_operation_id IS NULL
    AND control_workspace_id IS NOT NULL AND enrollment_id IS NOT NULL
    AND connection_instance_id IS NOT NULL AND octet_length(connection_instance_id) BETWEEN 1 AND 128
    AND op_id IS NOT NULL AND octet_length(op_id) BETWEEN 1 AND 256)
);

CREATE FUNCTION guard_sandbox_v2_background_intent()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.native_operation_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM sessions WHERE id=OLD.session_id AND workspace_id=OLD.workspace_id)
      AND EXISTS (SELECT 1 FROM workspaces WHERE id=OLD.workspace_id AND account_id=OLD.account_id) THEN
      RAISE EXCEPTION 'Native background launch intent must be retained' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.native_operation_id IS DISTINCT FROM OLD.native_operation_id
      OR (OLD.native_operation_id IS NOT NULL AND
        (NEW.id,NEW.account_id,NEW.workspace_id,NEW.session_id,NEW.provider,NEW.retained_process_id,
          NEW.launch_turn_id,NEW.launch_attempt_id,NEW.launch_execution_generation,NEW.command_text,NEW.command_preview)
        IS DISTINCT FROM
        (OLD.id,OLD.account_id,OLD.workspace_id,OLD.session_id,OLD.provider,OLD.retained_process_id,
          OLD.launch_turn_id,OLD.launch_attempt_id,OLD.launch_execution_generation,OLD.command_text,OLD.command_preview)) THEN
      RAISE EXCEPTION 'Native background launch identity is immutable' USING ERRCODE='23514';
    END IF;
    IF OLD.native_operation_id IS NOT NULL AND NEW.state IN ('exited','lost')
      AND NOT EXISTS (SELECT 1 FROM sandbox_v2_commands command
        WHERE command.operation_id=OLD.native_operation_id
          AND ((NEW.state='lost' AND command.abandoned AND command.binding IS NULL AND NEW.exit_code IS NULL)
            OR (NEW.state='exited' AND command.proof IS NOT NULL
              AND EXISTS (SELECT 1 FROM sandbox_v2_command_output output
                WHERE output.operation_id=command.operation_id
                  AND output.revision=(SELECT max(revision) FROM sandbox_v2_command_output WHERE operation_id=command.operation_id)
                  AND output.observation->>'state' IN ('exited','cancelled')
                  AND output.observation->'stdout'->'eof'='true'::jsonb
                  AND output.observation->'stderr'->'eof'='true'::jsonb)
              AND ((command.proof->>'state'='cancelled' AND NEW.exit_code IS NULL)
                OR (command.proof->>'state'='exited' AND NEW.exit_code IS NOT DISTINCT FROM
                  (command.proof->'receipt'->>'leaderExitCode')::integer))))) THEN
      RAISE EXCEPTION 'Native background terminal state requires its exact command evidence' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.native_operation_id IS NOT NULL THEN
    IF NEW.id<>NEW.native_operation_id OR NEW.command_text IS NULL
      OR octet_length(NEW.command_text)>262144 OR NEW.provider<>'managed'
      OR NEW.retained_process_id IS NOT NULL OR NEW.state<>'running'
      OR NOT EXISTS (
        SELECT 1 FROM sandbox_v2_commands command
        JOIN session_turn_attempts attempt ON attempt.id=command.attempt_id
        JOIN session_turns turn_row ON turn_row.id=command.turn_id
        JOIN sessions session_row ON session_row.id=command.session_id
        WHERE command.operation_id=NEW.native_operation_id AND command.account_id=NEW.account_id
          AND command.workspace_id=NEW.workspace_id AND command.session_id=NEW.session_id
          AND command.turn_id=NEW.launch_turn_id AND command.attempt_id=NEW.launch_attempt_id
          AND command.execution_generation=NEW.launch_execution_generation
          AND command.binding IS NULL AND command.proof IS NULL AND NOT command.abandoned
          AND attempt.closed_at IS NULL AND attempt.state IN ('claimed','running')
          AND turn_row.active_attempt_id=command.attempt_id
          AND turn_row.execution_generation=command.execution_generation
          AND session_row.active_turn_id=command.turn_id
      ) THEN
      RAISE EXCEPTION 'Native background intent requires its original unbound live command' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_sandbox_v2_background_intent() FROM PUBLIC;
CREATE TRIGGER sandbox_v2_background_intent_guard BEFORE INSERT OR UPDATE OR DELETE
  ON session_background_commands FOR EACH ROW EXECUTE FUNCTION guard_sandbox_v2_background_intent();
DO $$ DECLARE target_schema text:=current_schema(); BEGIN
  EXECUTE format('ALTER FUNCTION %I.guard_sandbox_v2_background_intent() SET search_path TO pg_catalog, %I, pg_temp',target_schema,target_schema);
END $$;

-- Separate original job material from attempt-owned receipt/erasure. Initial
-- sealing requires the original live attempt and a still-unbound job command.
-- Cleanup custody is fixed before delivery. It grants no job renewal or new
-- agent command authority after the original turn ends.
CREATE TABLE sandbox_v2_background_credentials (
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL, session_id uuid NOT NULL, job_id uuid NOT NULL,
  turn_id uuid NOT NULL REFERENCES session_turns(id) ON DELETE CASCADE,
  attempt_id uuid NOT NULL REFERENCES session_turn_attempts(id) ON DELETE CASCADE,
  execution_generation integer NOT NULL CHECK (execution_generation>=0),
  machine_id uuid NOT NULL, instance jsonb NOT NULL CHECK (jsonb_typeof(instance)='object'),
  generation_id text NOT NULL CHECK (length(generation_id) BETWEEN 1 AND 512),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition)='object'
    AND definition->>'generationId' IS NOT DISTINCT FROM generation_id
    AND definition->>'purpose' IS NOT DISTINCT FROM 'provision'
    AND definition->'forceRefresh' IS NOT DISTINCT FROM 'false'::jsonb
    AND (definition-'generationId'-'purpose'-'forceRefresh')='{}'::jsonb),
  ciphertext text CHECK (ciphertext IS NULL OR (octet_length(ciphertext)<=67108864
    AND ciphertext ~ '^v2:[A-Za-z0-9+/]{16}:[A-Za-z0-9+/]+={0,2}$')),
  expires_at timestamptz,
  writer_action_id text NOT NULL CHECK (writer_action_id ~ '^sandbox-v2:[a-f0-9]{64}$'),
  cleanup_operation_id uuid NOT NULL UNIQUE CHECK (cleanup_operation_id<>job_id),
  cleanup_specification_digest text NOT NULL CHECK (cleanup_specification_digest ~ '^[a-f0-9]{64}$'),
  cleanup_revision bigint NOT NULL DEFAULT 0 CHECK (cleanup_revision>=0 AND cleanup_revision<9007199254740991),
  cleanup_binding jsonb, cleanup_proof jsonb, cleared_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((ciphertext IS NULL)=(cleared_at IS NOT NULL)
    AND (cleared_at IS NOT NULL)=(cleanup_proof IS NOT NULL)),
  PRIMARY KEY(workspace_id,session_id,job_id),
  FOREIGN KEY(workspace_id,account_id) REFERENCES workspaces(id,account_id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,session_id) REFERENCES sessions(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(session_id,account_id) REFERENCES sessions(id,account_id) ON DELETE CASCADE,
  FOREIGN KEY(job_id) REFERENCES session_background_commands(id) ON DELETE CASCADE,
  FOREIGN KEY(account_id,workspace_id,machine_id)
    REFERENCES sandbox_v2_machines(account_id,workspace_id,id) ON DELETE RESTRICT
);
ALTER TABLE sandbox_v2_background_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox_v2_background_credentials FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE sandbox_v2_background_credentials FROM PUBLIC;
CREATE POLICY workspace_isolation ON sandbox_v2_background_credentials
  USING (opengeni_private.workspace_rls_visible(account_id,workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id,workspace_id));
CREATE POLICY session_visibility_isolation ON sandbox_v2_background_credentials AS RESTRICTIVE
  USING (session_reference_visible(account_id,workspace_id,session_id))
  WITH CHECK (session_reference_visible(account_id,workspace_id,session_id));
CREATE FUNCTION guard_sandbox_v2_background_credentials()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE receipt jsonb;
  terminal_stdout constant jsonb:='{"offset":0,"nextOffset":7,"data":"Y2xlYW5lZA==","eof":true}'::jsonb;
  terminal_stderr constant jsonb:='{"offset":0,"nextOffset":0,"data":"","eof":true}'::jsonb;
  uuid_pattern constant text:='^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$';
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.cleanup_revision<>OLD.cleanup_revision+1 OR OLD.cleared_at IS NOT NULL
      OR (NEW.account_id,NEW.workspace_id,NEW.session_id,NEW.job_id,NEW.turn_id,NEW.attempt_id,
        NEW.execution_generation,NEW.machine_id,NEW.instance,NEW.generation_id,NEW.definition,
        NEW.expires_at,NEW.writer_action_id,NEW.cleanup_operation_id,NEW.cleanup_specification_digest,NEW.created_at)
      IS DISTINCT FROM
      (OLD.account_id,OLD.workspace_id,OLD.session_id,OLD.job_id,OLD.turn_id,OLD.attempt_id,
        OLD.execution_generation,OLD.machine_id,OLD.instance,OLD.generation_id,OLD.definition,
        OLD.expires_at,OLD.writer_action_id,OLD.cleanup_operation_id,OLD.cleanup_specification_digest,OLD.created_at)
      OR OLD.cleanup_binding IS NOT NULL AND NEW.cleanup_binding IS DISTINCT FROM OLD.cleanup_binding
      OR OLD.cleanup_proof IS NOT NULL AND NEW.cleanup_proof IS DISTINCT FROM OLD.cleanup_proof THEN
      RAISE EXCEPTION 'Original background material and cleanup identity are immutable' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM sandbox_v2_commands command
      JOIN sandbox_v2_machines machine ON machine.id=command.machine_id
      WHERE command.operation_id=NEW.job_id AND command.account_id=NEW.account_id
        AND command.workspace_id=NEW.workspace_id AND command.session_id=NEW.session_id
        AND command.turn_id=NEW.turn_id AND command.attempt_id=NEW.attempt_id
        AND command.execution_generation=NEW.execution_generation AND command.machine_id=NEW.machine_id
        AND (command.abandoned AND command.binding IS NULL OR command.proof IS NOT NULL
          AND EXISTS (SELECT 1 FROM sandbox_v2_command_output output
            WHERE output.operation_id=command.operation_id
              AND output.revision=(SELECT max(revision) FROM sandbox_v2_command_output WHERE operation_id=command.operation_id)
              AND output.observation->>'state' IN ('exited','cancelled')
              AND output.observation->'stdout'->'eof'='true'::jsonb
              AND output.observation->'stderr'->'eof'='true'::jsonb))
        AND machine.projection->'instance' IS NOT DISTINCT FROM NEW.instance
        AND machine.projection->>'state'='running' AND machine.projection->'transition'='null'::jsonb
        AND machine.projection->'demands' @> jsonb_build_array(jsonb_build_object(
          'id',NEW.cleanup_operation_id::text,'kind','command','owner',NEW.session_id::text,'authority',NEW.job_id::text)))
      OR EXISTS (SELECT 1 FROM sandbox_v2_commands writer
        WHERE writer.account_id=NEW.account_id AND writer.workspace_id=NEW.workspace_id
          AND writer.session_id=NEW.session_id AND writer.attempt_id=NEW.attempt_id
          AND writer.accepted_action_id=NEW.writer_action_id AND NOT writer.abandoned AND writer.proof IS NULL) THEN
      RAISE EXCEPTION 'Job cleanup requires physical settlement of its original writers' USING ERRCODE='23514';
    END IF;
    IF NEW.cleanup_binding IS NULL OR NEW.cleanup_binding IS DISTINCT FROM jsonb_build_object(
      'kind','machine-journal-v1','machineId',NEW.machine_id::text,'operationId',NEW.cleanup_operation_id::text,
      'diskLineage',NEW.instance->>'diskLineage','bootId',NEW.instance->>'bootId',
      'specificationDigest',NEW.cleanup_specification_digest,'stdin',false,'pty',false) THEN
      RAISE EXCEPTION 'Job cleanup dispatch binding changed' USING ERRCODE='23514';
    END IF;
    IF NEW.cleanup_proof IS NULL THEN
      IF NEW.ciphertext IS DISTINCT FROM OLD.ciphertext OR NEW.cleared_at IS NOT NULL THEN
        RAISE EXCEPTION 'Job ciphertext requires its original cleanup acknowledgement' USING ERRCODE='23514';
      END IF;
    ELSE
      receipt:=NEW.cleanup_proof->'receipt';
      IF OLD.cleanup_binding IS NULL OR OLD.ciphertext IS NULL OR NEW.ciphertext IS NOT NULL OR NEW.cleared_at IS NULL
        OR jsonb_typeof(NEW.cleanup_proof) IS DISTINCT FROM 'object' OR jsonb_typeof(receipt) IS DISTINCT FROM 'object'
        OR NOT coalesce(NEW.cleanup_proof ?& ARRAY['operationId','state','specificationDigest','receipt','stdout','stderr']
          AND (SELECT count(*) FROM jsonb_object_keys(NEW.cleanup_proof))=6
          AND NEW.cleanup_proof->>'operationId'=NEW.cleanup_operation_id::text AND NEW.cleanup_proof->>'state'='exited'
          AND NEW.cleanup_proof->>'specificationDigest'=NEW.cleanup_specification_digest
          AND NEW.cleanup_proof->'stdout'=terminal_stdout AND NEW.cleanup_proof->'stderr'=terminal_stderr
          AND receipt ?& ARRAY['protocol','invocationId','receiptId','leaderExitCode']
          AND (SELECT count(*) FROM jsonb_object_keys(receipt))=4
          AND receipt->>'protocol'='native-subreaper-v1' AND receipt->>'invocationId'=NEW.cleanup_operation_id::text
          AND jsonb_typeof(receipt->'receiptId')='string' AND receipt->>'receiptId' ~ uuid_pattern
          AND receipt->'leaderExitCode'='0'::jsonb,false) THEN
        RAISE EXCEPTION 'Job erasure requires complete original cleanup and native exit' USING ERRCODE='23514';
      END IF;
    END IF;
    RETURN NEW;
  ELSIF TG_OP='DELETE' THEN
    IF EXISTS (SELECT 1 FROM sessions WHERE id=OLD.session_id AND workspace_id=OLD.workspace_id)
      AND EXISTS (SELECT 1 FROM workspaces WHERE id=OLD.workspace_id AND account_id=OLD.account_id) THEN
      RAISE EXCEPTION 'Original background credential generation must be retained' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.ciphertext IS NULL OR NEW.cleared_at IS NOT NULL OR NEW.cleanup_binding IS NOT NULL
    OR NEW.cleanup_proof IS NOT NULL OR NEW.cleanup_revision<>0 THEN
    RAISE EXCEPTION 'Job custody must begin with its original sealed material and unbound cleanup' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM session_background_commands job
    JOIN sandbox_v2_commands command ON command.operation_id=job.native_operation_id
    JOIN session_turn_attempts attempt ON attempt.id=command.attempt_id
    JOIN session_turns turn_row ON turn_row.id=command.turn_id
    JOIN sessions session_row ON session_row.id=command.session_id
    JOIN sandbox_v2_machines machine ON machine.id=command.machine_id
    WHERE job.id=NEW.job_id AND job.native_operation_id=NEW.job_id AND job.provider='managed'
      AND job.account_id=NEW.account_id AND job.workspace_id=NEW.workspace_id AND job.session_id=NEW.session_id
      AND job.state='running' AND command.binding IS NULL AND command.proof IS NULL AND NOT command.abandoned
      AND command.turn_id=NEW.turn_id AND command.attempt_id=NEW.attempt_id
      AND command.execution_generation=NEW.execution_generation AND command.machine_id=NEW.machine_id
      AND machine.projection->'instance' IS NOT DISTINCT FROM NEW.instance
      AND machine.projection->>'target'<>'destroyed'
      AND machine.projection->>'state'='running' AND machine.projection->'transition'='null'::jsonb
      AND attempt.closed_at IS NULL AND attempt.state IN ('claimed','running')
      AND turn_row.active_attempt_id=NEW.attempt_id AND turn_row.execution_generation=NEW.execution_generation
      AND session_row.active_turn_id=NEW.turn_id
  ) THEN
    RAISE EXCEPTION 'Background credentials require their original unbound live job' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_sandbox_v2_background_credentials() FROM PUBLIC;
CREATE TRIGGER sandbox_v2_background_credentials_guard BEFORE INSERT OR UPDATE OR DELETE
  ON sandbox_v2_background_credentials FOR EACH ROW EXECUTE FUNCTION guard_sandbox_v2_background_credentials();
DO $$ DECLARE target_schema text:=current_schema(); BEGIN
  EXECUTE format('ALTER FUNCTION %I.guard_sandbox_v2_background_credentials() SET search_path TO pg_catalog, %I, pg_temp',target_schema,target_schema);
END $$;

-- Explicit custody before binding/Start, after actual separate credential ACK.
-- This registration alone does not exclude writers or install a job grant.
CREATE TABLE sandbox_v2_background_owners (
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL, session_id uuid NOT NULL, job_id uuid PRIMARY KEY,
  turn_id uuid NOT NULL REFERENCES session_turns(id) ON DELETE CASCADE,
  attempt_id uuid NOT NULL REFERENCES session_turn_attempts(id) ON DELETE CASCADE,
  execution_generation integer NOT NULL CHECK (execution_generation>=0),
  machine_id uuid NOT NULL, instance jsonb NOT NULL CHECK (jsonb_typeof(instance)='object'),
  generation_id text NOT NULL CHECK (length(generation_id) BETWEEN 1 AND 512),
  writer_action_id text NOT NULL CHECK (writer_action_id ~ '^sandbox-v2:[a-f0-9]{64}$'),
  cleanup_operation_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(workspace_id,account_id) REFERENCES workspaces(id,account_id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,session_id,job_id)
    REFERENCES sandbox_v2_background_credentials(workspace_id,session_id,job_id) ON DELETE CASCADE,
  FOREIGN KEY(account_id,workspace_id,machine_id)
    REFERENCES sandbox_v2_machines(account_id,workspace_id,id) ON DELETE RESTRICT
);
ALTER TABLE sandbox_v2_background_owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox_v2_background_owners FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE sandbox_v2_background_owners FROM PUBLIC;
CREATE POLICY workspace_isolation ON sandbox_v2_background_owners
  USING (opengeni_private.workspace_rls_visible(account_id,workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id,workspace_id));
CREATE POLICY session_visibility_isolation ON sandbox_v2_background_owners AS RESTRICTIVE
  USING (session_reference_visible(account_id,workspace_id,session_id))
  WITH CHECK (session_reference_visible(account_id,workspace_id,session_id));
CREATE FUNCTION guard_sandbox_v2_background_owner()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE acknowledgement text; page_count integer;
BEGIN
  IF TG_OP='UPDATE' THEN
    RAISE EXCEPTION 'Original background owner is immutable' USING ERRCODE='23514';
  ELSIF TG_OP='DELETE' THEN
    IF EXISTS (SELECT 1 FROM sessions WHERE id=OLD.session_id AND workspace_id=OLD.workspace_id)
      AND EXISTS (SELECT 1 FROM workspaces WHERE id=OLD.workspace_id AND account_id=OLD.account_id) THEN
      RAISE EXCEPTION 'Original background owner must be retained' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM sandbox_v2_background_credentials custody
    JOIN sandbox_v2_commands command ON command.operation_id=custody.job_id
    JOIN session_background_commands job ON job.id=custody.job_id
    JOIN session_turn_attempts attempt ON attempt.id=custody.attempt_id
    JOIN session_turns turn_row ON turn_row.id=custody.turn_id
    JOIN sessions session_row ON session_row.id=custody.session_id
    JOIN sandbox_v2_machines machine ON machine.id=custody.machine_id
    WHERE (custody.account_id,custody.workspace_id,custody.session_id,custody.job_id,
      custody.turn_id,custody.attempt_id,custody.execution_generation,custody.machine_id,
      custody.instance,custody.generation_id,custody.writer_action_id,custody.cleanup_operation_id)
      IS NOT DISTINCT FROM (NEW.account_id,NEW.workspace_id,NEW.session_id,NEW.job_id,
        NEW.turn_id,NEW.attempt_id,NEW.execution_generation,NEW.machine_id,
        NEW.instance,NEW.generation_id,NEW.writer_action_id,NEW.cleanup_operation_id)
      AND custody.ciphertext IS NOT NULL AND custody.cleared_at IS NULL
      AND (custody.expires_at IS NULL OR custody.expires_at>clock_timestamp())
      AND job.native_operation_id=NEW.job_id AND job.provider='managed' AND job.state='running'
      AND command.binding IS NULL AND command.proof IS NULL AND NOT command.abandoned
      AND attempt.closed_at IS NULL AND attempt.state IN ('claimed','running')
      AND turn_row.active_attempt_id=NEW.attempt_id AND turn_row.execution_generation=NEW.execution_generation
      AND session_row.active_turn_id=NEW.turn_id
      AND machine.projection->'instance' IS NOT DISTINCT FROM NEW.instance
      AND machine.projection->>'state'='running' AND machine.projection->'transition'='null'::jsonb
      AND machine.projection->'demands' @> jsonb_build_array(jsonb_build_object(
        'id',NEW.cleanup_operation_id::text,'kind','command','owner',NEW.session_id::text,'authority',NEW.job_id::text))
  ) THEN
    RAISE EXCEPTION 'Background owner requires original unbound live custody' USING ERRCODE='23514';
  END IF;
  SELECT string_agg(convert_from(decode(output.stdout,'base64'),'UTF8'),'' ORDER BY output.revision),count(*)::integer
    INTO acknowledgement,page_count
    FROM sandbox_v2_commands writer JOIN sandbox_v2_command_output output ON output.operation_id=writer.operation_id
    WHERE writer.account_id=NEW.account_id AND writer.workspace_id=NEW.workspace_id AND writer.session_id=NEW.session_id
      AND writer.turn_id=NEW.turn_id AND writer.attempt_id=NEW.attempt_id AND writer.execution_generation=NEW.execution_generation
      AND writer.machine_id=NEW.machine_id AND writer.instance_id=NEW.instance->>'id'
      AND writer.binding->>'bootId'=NEW.instance->>'bootId' AND writer.binding->>'diskLineage'=NEW.instance->>'diskLineage'
      AND writer.accepted_action_id=NEW.writer_action_id
      AND writer.proof->>'state'='exited' AND writer.proof->'receipt'->'leaderExitCode'='0'::jsonb
      AND (writer.proof->'receipt'->>'acceptedInputSequence')::bigint>=2
      AND writer.stdout->'offset' IN ('9'::jsonb,'14'::jsonb) AND writer.stderr->'offset'='0'::jsonb
      AND writer.stdout->>'remainder'='' AND writer.stderr->>'remainder'='' AND output.stderr=''
      AND EXISTS (SELECT 1 FROM sandbox_v2_command_output last
        WHERE last.operation_id=writer.operation_id
          AND last.revision=(SELECT max(revision) FROM sandbox_v2_command_output WHERE operation_id=writer.operation_id)
          AND last.observation->>'state'='exited'
          AND last.observation->'stdout'->'eof'='true'::jsonb AND last.observation->'stderr'->'eof'='true'::jsonb);
  IF acknowledgement IS NULL OR acknowledgement NOT IN ('installed','not_applicable') OR page_count>=32 THEN
    RAISE EXCEPTION 'Background owner requires exact credential writer ACK' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_sandbox_v2_background_owner() FROM PUBLIC;
CREATE TRIGGER sandbox_v2_background_owner_guard BEFORE INSERT OR UPDATE OR DELETE
  ON sandbox_v2_background_owners FOR EACH ROW EXECUTE FUNCTION guard_sandbox_v2_background_owner();
DO $$ DECLARE target_schema text:=current_schema(); BEGIN
  EXECUTE format('ALTER FUNCTION %I.guard_sandbox_v2_background_owner() SET search_path TO pg_catalog, %I, pg_temp',target_schema,target_schema);
END $$;

-- Original custody was registered before binding, after its real credential
-- writer ACK. Its bound command is routed only to the independently authorized
-- job controller. This immutable identity survives expiry and terminal cleanup;
-- neither event restores generic turn-control authority.
CREATE FUNCTION sandbox_v2_command_has_background_owner(p_operation uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path FROM CURRENT AS $$
  SELECT EXISTS (
    SELECT 1 FROM sandbox_v2_commands command
    JOIN sandbox_v2_background_owners owner ON owner.job_id=command.operation_id
    JOIN sandbox_v2_background_credentials custody ON custody.job_id=owner.job_id
    JOIN session_background_commands job ON job.id=owner.job_id
    WHERE command.operation_id=p_operation AND command.binding IS NOT NULL
      AND (command.account_id,command.workspace_id,command.session_id,command.turn_id,
        command.attempt_id,command.execution_generation,command.machine_id,command.instance_id,
        command.binding->>'bootId',command.binding->>'diskLineage')
        IS NOT DISTINCT FROM (owner.account_id,owner.workspace_id,owner.session_id,owner.turn_id,
          owner.attempt_id,owner.execution_generation,owner.machine_id,owner.instance->>'id',
          owner.instance->>'bootId',owner.instance->>'diskLineage')
      AND (custody.account_id,custody.workspace_id,custody.session_id,custody.turn_id,
        custody.attempt_id,custody.execution_generation,custody.machine_id,custody.instance,
        custody.generation_id,custody.writer_action_id,custody.cleanup_operation_id)
        IS NOT DISTINCT FROM (owner.account_id,owner.workspace_id,owner.session_id,owner.turn_id,
          owner.attempt_id,owner.execution_generation,owner.machine_id,owner.instance,
          owner.generation_id,owner.writer_action_id,owner.cleanup_operation_id)
      AND (job.account_id,job.workspace_id,job.session_id,job.native_operation_id,
        job.launch_turn_id,job.launch_attempt_id,job.launch_execution_generation,job.provider)
        IS NOT DISTINCT FROM (owner.account_id,owner.workspace_id,owner.session_id,owner.job_id,
          owner.turn_id,owner.attempt_id,owner.execution_generation,'managed'::text)
  )
$$;
REVOKE ALL ON FUNCTION sandbox_v2_command_has_background_owner(uuid) FROM PUBLIC;

-- Shared by receipts, normal credential cleanup and ciphertext erasure. Only
-- exact preowned bound jobs with retained custody and cleanup demand leave the
-- originating attempt's writer gate. They remain physical machine writers.
-- A broken custody/demand invariant holds the attempt; it does not send the job
-- back through generic control. Maintenance excludes only its OWN cleanup.
CREATE FUNCTION sandbox_v2_attempt_writers_pending(
  p_account uuid,p_workspace uuid,p_session uuid,p_attempt uuid,p_exclude_cleanup uuid DEFAULT NULL
) RETURNS boolean LANGUAGE sql STABLE SET search_path FROM CURRENT AS $$
  SELECT EXISTS (SELECT 1 FROM sandbox_v2_commands command
    WHERE command.account_id=p_account AND command.workspace_id=p_workspace
      AND command.session_id=p_session AND command.attempt_id=p_attempt
      AND command.proof IS NULL AND NOT command.abandoned
      AND NOT (sandbox_v2_command_has_background_owner(command.operation_id)
        AND EXISTS (SELECT 1 FROM sandbox_v2_background_credentials custody
          JOIN sandbox_v2_machines machine ON machine.id=custody.machine_id
          WHERE custody.job_id=command.operation_id AND custody.ciphertext IS NOT NULL
            AND custody.cleared_at IS NULL
            AND machine.account_id=custody.account_id AND machine.workspace_id=custody.workspace_id
            AND machine.projection->'instance' IS NOT DISTINCT FROM custody.instance
            AND machine.projection->'demands' @> jsonb_build_array(jsonb_build_object(
              'id',custody.cleanup_operation_id::text,'kind','command',
              'owner',custody.session_id::text,'authority',custody.job_id::text)))))
  OR EXISTS (SELECT 1 FROM sandbox_v2_credential_cleanup cleanup
    WHERE cleanup.account_id=p_account AND cleanup.workspace_id=p_workspace
      AND cleanup.session_id=p_session AND cleanup.attempt_id=p_attempt
      AND cleanup.proof IS NULL
      AND (p_exclude_cleanup IS NULL OR cleanup.operation_id<>p_exclude_cleanup))
  OR EXISTS (SELECT 1 FROM sandbox_workspace_mutation_admissions admission
    WHERE admission.account_id=p_account AND admission.workspace_id=p_workspace
      AND admission.session_id=p_session AND admission.settled_at IS NULL
      AND (admission.attempt_id=p_attempt OR (admission.actor_kind='process' AND EXISTS (
        SELECT 1 FROM sandbox_retained_processes process WHERE process.account_id=p_account
          AND process.workspace_id=p_workspace AND process.session_id=p_session
          AND process.id=admission.actor_id AND process.owner_attempt_id=p_attempt)))
      AND NOT EXISTS (SELECT 1 FROM sandbox_retained_processes process
        JOIN session_background_commands command ON command.retained_process_id=process.id
        WHERE process.account_id=p_account AND process.workspace_id=p_workspace
          AND process.session_id=p_session
          AND (process.parent_admission_id=admission.id
            OR (admission.actor_kind='process' AND process.id=admission.actor_id))
          AND command.state IN ('running','stopping')))
  OR EXISTS (SELECT 1 FROM sandbox_retained_processes process
    WHERE process.account_id=p_account AND process.workspace_id=p_workspace
      AND process.session_id=p_session AND process.owner_attempt_id=p_attempt AND process.state='active'
      AND NOT EXISTS (SELECT 1 FROM session_background_commands command
        WHERE command.retained_process_id=process.id AND command.state IN ('running','stopping')))
$$;
REVOKE ALL ON FUNCTION sandbox_v2_attempt_writers_pending(uuid,uuid,uuid,uuid,uuid) FROM PUBLIC;
DO $$ DECLARE target_schema text:=current_schema(); BEGIN
  EXECUTE format('ALTER FUNCTION %I.sandbox_v2_command_has_background_owner(uuid) SET search_path TO pg_catalog, %I, pg_temp',target_schema,target_schema);
  EXECUTE format('ALTER FUNCTION %I.sandbox_v2_attempt_writers_pending(uuid,uuid,uuid,uuid,uuid) SET search_path TO pg_catalog, %I, pg_temp',target_schema,target_schema);
END $$;
