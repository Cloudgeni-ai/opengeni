-- deployment-mode: rolling
-- Agent calls for products embedding Opengeni (docs/design/agent-calls.md).
-- A product that rings its own app with its own push credentials, from the
-- session.agentCall.ringing webhook, states here how many of a person's phones
-- it can ring for agents, and whether agents working for the person's
-- teammates may ring them too. Agents count these phones alongside the
-- person's Opengeni app phones, so a person reachable only through the
-- product can be called. The person's own request (through the product's
-- backend acting as them) writes their row; agents in the account read it.
-- New code owns the table; old binaries never read it.
SET LOCAL lock_timeout = '5s';

CREATE TABLE agent_call_host_phones (
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  subject_id text NOT NULL CHECK (char_length(subject_id) BETWEEN 1 AND 300),
  phones integer NOT NULL CHECK (phones BETWEEN 1 AND 20),
  teammates boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, subject_id)
);
ALTER TABLE agent_call_host_phones ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_call_host_phones FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON agent_call_host_phones
  USING (opengeni_private.account_rls_visible(account_id))
  WITH CHECK (opengeni_private.account_rls_visible(account_id));

DO $agent_call_host_phones_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON agent_call_host_phones TO opengeni_app;
  END IF;
END
$agent_call_host_phones_grants$;
