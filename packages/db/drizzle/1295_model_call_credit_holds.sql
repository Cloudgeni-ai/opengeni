-- deployment-mode: rolling
-- Credit holds for stateless model calls (the chat completions endpoint).
--
-- Admission for an Opengeni-credit call used to check only that the balance
-- was positive, so calls running at the same time could together spend more
-- than the balance. Admission now reserves the call's maximum priced cost in
-- model_call_credit_holds, under the account advisory lock that settlement
-- takes, and admits only when the spendable balance minus the account's
-- other live holds covers it. The call deletes its hold once it settles,
-- fails or is aborted. A hold whose process stopped mid-call stops counting
-- at expires_at.
--
-- Rolling: a new FORCE-RLS table the previous release never reads or writes.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE model_call_credit_holds (
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  amount_micros bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, request_id),
  CONSTRAINT model_call_credit_holds_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT model_call_credit_holds_amount_chk CHECK (amount_micros > 0),
  CONSTRAINT model_call_credit_holds_expiry_chk CHECK (expires_at > created_at)
);

ALTER TABLE model_call_credit_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_call_credit_holds FORCE ROW LEVEL SECURITY;
REVOKE ALL ON model_call_credit_holds FROM PUBLIC;
-- Holds are summed across the whole account, whose balance they draw on.
CREATE POLICY account_isolation ON model_call_credit_holds
  USING (opengeni_private.account_rls_visible(account_id))
  WITH CHECK (opengeni_private.account_rls_visible(account_id));

DO $model_call_credit_holds_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    REVOKE ALL ON model_call_credit_holds FROM opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON model_call_credit_holds TO opengeni_app;
  END IF;
END
$model_call_credit_holds_grants$;
