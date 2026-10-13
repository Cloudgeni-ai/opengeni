-- deployment-mode: rolling
-- Additive transport custody only. These rows confer neither native command
-- qualification nor workspace mutation authority and enroll no existing group.
CREATE TABLE native_command_broker_transports (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES managed_accounts(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  lease_id uuid NOT NULL,
  sandbox_group_id uuid NOT NULL,
  binding jsonb NOT NULL CHECK (jsonb_typeof(binding) = 'object'),
  initial_state_sha256 text NOT NULL CHECK (initial_state_sha256 ~ '^[a-f0-9]{64}$'),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740991),
  writer_id uuid,
  writer_epoch bigint NOT NULL DEFAULT 1 CHECK (writer_epoch BETWEEN 1 AND 9007199254740991),
  writer_until timestamptz,
  state_encrypted text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, account_id, workspace_id),
  FOREIGN KEY (account_id, workspace_id, lease_id) REFERENCES sandbox_leases(account_id, workspace_id, id),
  CHECK ((writer_id IS NULL) = (writer_until IS NULL))
);
CREATE UNIQUE INDEX native_command_broker_creation ON native_command_broker_transports
  (lease_id, (binding->>'createOperationId'));
CREATE UNIQUE INDEX native_command_broker_physical_instance ON native_command_broker_transports
  ((binding->>'providerBindingKey'), (binding->>'sandboxId'));

CREATE TABLE native_command_broker_entries (
  broker_id uuid NOT NULL,
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('request', 'frame', 'page', 'eof')),
  entry_key text NOT NULL CHECK (octet_length(entry_key) BETWEEN 1 AND 200),
  sequence bigint CHECK (sequence BETWEEN 1 AND 9007199254740991),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  value_encrypted text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (broker_id, kind, entry_key),
  UNIQUE (broker_id, kind, sequence),
  FOREIGN KEY (broker_id, account_id, workspace_id)
    REFERENCES native_command_broker_transports(id, account_id, workspace_id),
  CHECK ((kind IN ('request', 'frame')) = (sequence IS NOT NULL)),
  CHECK (kind <> 'request' OR sequence <= 4294967295)
);

ALTER TABLE native_command_broker_transports ENABLE ROW LEVEL SECURITY;
ALTER TABLE native_command_broker_transports FORCE ROW LEVEL SECURITY;
CREATE POLICY native_command_broker_transports_scope ON native_command_broker_transports
  USING (account_id = nullif(current_setting('opengeni.account_id', true), '')::uuid
    AND workspace_id = nullif(current_setting('opengeni.workspace_id', true), '')::uuid)
  WITH CHECK (account_id = nullif(current_setting('opengeni.account_id', true), '')::uuid
    AND workspace_id = nullif(current_setting('opengeni.workspace_id', true), '')::uuid);
ALTER TABLE native_command_broker_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE native_command_broker_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY native_command_broker_entries_scope ON native_command_broker_entries
  USING (account_id = nullif(current_setting('opengeni.account_id', true), '')::uuid
    AND workspace_id = nullif(current_setting('opengeni.workspace_id', true), '')::uuid)
  WITH CHECK (account_id = nullif(current_setting('opengeni.account_id', true), '')::uuid
    AND workspace_id = nullif(current_setting('opengeni.workspace_id', true), '')::uuid);

CREATE FUNCTION native_command_broker_transport_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['revision','writer_id','writer_epoch','writer_until','state_encrypted'])
    IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['revision','writer_id','writer_epoch','writer_until','state_encrypted'])
    OR NEW.revision <> OLD.revision + 1
    OR NEW.writer_epoch NOT BETWEEN OLD.writer_epoch AND OLD.writer_epoch + 1
    OR (NEW.writer_id IS DISTINCT FROM OLD.writer_id AND OLD.writer_id IS NOT NULL
      AND NEW.writer_epoch <> OLD.writer_epoch + 1) THEN
    RAISE EXCEPTION 'Native broker binding or revision is immutable or fenced' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER native_command_broker_transport_guard BEFORE UPDATE
  ON native_command_broker_transports FOR EACH ROW
  EXECUTE FUNCTION native_command_broker_transport_guard();

CREATE FUNCTION native_command_broker_entry_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  RAISE EXCEPTION 'Native broker transport receipts are immutable' USING ERRCODE = '55000';
END
$guard$;
CREATE TRIGGER native_command_broker_entry_guard BEFORE UPDATE OR DELETE
  ON native_command_broker_entries FOR EACH ROW
  EXECUTE FUNCTION native_command_broker_entry_guard();

REVOKE ALL ON native_command_broker_transports, native_command_broker_entries FROM PUBLIC;
