-- deployment-mode: rolling
-- Additive account-scoped receipts. No new callable SECURITY DEFINER capability.
-- The invoker trigger inherits the existing membership writer's authority and
-- projects only active billing recipients. Runtime cannot write that projection.
CREATE TABLE billing_credit_alert_settings (
  account_id uuid PRIMARY KEY REFERENCES managed_accounts(id) ON DELETE CASCADE,
  low_balance_threshold_micros bigint NOT NULL DEFAULT 10000000
    CHECK (low_balance_threshold_micros BETWEEN 0 AND 9007199254740991),
  low_active boolean NOT NULL DEFAULT false,
  exhausted_active boolean NOT NULL DEFAULT false,
  unusual_active boolean NOT NULL DEFAULT false,
  last_unusual_at timestamptz,
  checked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE billing_credit_notification_recipients (
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  subject_id text NOT NULL,
  membership_id uuid NOT NULL REFERENCES organization_memberships(id) ON DELETE CASCADE,
  personal_workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  PRIMARY KEY (account_id, subject_id)
);

CREATE TABLE billing_credit_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  operation_key text NOT NULL CHECK (octet_length(operation_key) BETWEEN 1 AND 512),
  kind text NOT NULL CHECK (kind IN ('low_balance','exhausted','unusual_spend','topup_success','topup_failed','cap_reached')),
  details jsonb NOT NULL CHECK (jsonb_typeof(details) = 'object' AND octet_length(details::text) <= 4096),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (account_id, operation_key),
  UNIQUE (id, account_id)
);

CREATE TABLE billing_credit_notification_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  notification_id uuid NOT NULL,
  subject_id text NOT NULL,
  email text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed','outcome_unknown','suppressed')),
  claim_id uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  first_attempt_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  retry_before timestamptz,
  provider_scope text,
  message jsonb,
  provider_message_id text,
  error_class text,
  read_at timestamptz,
  UNIQUE (notification_id, subject_id),
  FOREIGN KEY (notification_id, account_id) REFERENCES billing_credit_notifications(id, account_id) ON DELETE CASCADE
);
CREATE INDEX billing_credit_notification_deliveries_due ON billing_credit_notification_deliveries(account_id,next_attempt_at)
  WHERE status IN ('pending','failed','sending','outcome_unknown');
CREATE INDEX billing_credit_notifications_created ON billing_credit_notifications(account_id,created_at DESC,id);

DO $policies$
DECLARE relation text; data_schema text := current_schema(); owner_name text := current_user;
BEGIN
  FOREACH relation IN ARRAY ARRAY['billing_credit_alert_settings','billing_credit_notifications','billing_credit_notification_deliveries','billing_credit_notification_recipients'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', relation);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', relation);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', relation);
    EXECUTE format('CREATE POLICY account_isolation ON %I USING (account_id = opengeni_private.current_account_id()) WITH CHECK (account_id = opengeni_private.current_account_id())', relation);
  END LOOP;
  EXECUTE format('CREATE POLICY recipient_owner ON billing_credit_notification_recipients TO %I USING (true) WITH CHECK (true)', owner_name);
  EXECUTE format($definition$
    CREATE FUNCTION opengeni_private.project_billing_credit_recipients() RETURNS trigger
    LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, %I, pg_temp AS $body$
    BEGIN
      IF TG_OP <> 'INSERT' THEN
        DELETE FROM billing_credit_notification_recipients WHERE account_id = OLD.account_id AND subject_id = OLD.subject_id;
      END IF;
      IF TG_OP <> 'DELETE' AND NEW.status = 'active' AND NEW.revoked_at IS NULL
        AND NEW.role IN ('owner','admin') AND NEW.subject_id LIKE 'user:%%' THEN
        INSERT INTO billing_credit_notification_recipients(account_id,subject_id,membership_id,personal_workspace_id)
          VALUES (NEW.account_id,NEW.subject_id,NEW.id,NEW.personal_workspace_id)
          ON CONFLICT (account_id,subject_id) DO UPDATE SET membership_id = excluded.membership_id,personal_workspace_id=excluded.personal_workspace_id;
      END IF;
      RETURN NULL;
    END $body$
  $definition$, data_schema);
END $policies$;
REVOKE ALL ON FUNCTION opengeni_private.project_billing_credit_recipients() FROM PUBLIC;
CREATE TRIGGER billing_credit_recipients_project AFTER INSERT OR UPDATE OR DELETE ON organization_memberships
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.project_billing_credit_recipients();

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='opengeni_app') THEN
    -- An already-provisioned owner grants runtime DML through default privileges.
    -- Reset those inherited grants before installing this read-only projection.
    REVOKE ALL ON billing_credit_notification_recipients FROM opengeni_app;
    GRANT SELECT ON billing_credit_notification_recipients TO opengeni_app;
    GRANT SELECT,INSERT,UPDATE,DELETE ON billing_credit_alert_settings,billing_credit_notifications,billing_credit_notification_deliveries TO opengeni_app;
    REVOKE ALL ON FUNCTION opengeni_private.project_billing_credit_recipients() FROM opengeni_app;
  END IF;
END $grants$;
