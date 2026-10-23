-- deployment-mode: rolling
-- New opt-in provider state. Existing binaries never read these tables.
-- The installation directory contains routing metadata only, never conversation
-- content or credentials. Its read policy supports authenticated provider ingress
-- and bounded pump discovery; writes remain scoped to the installing workspace.
CREATE TABLE teams_bot_installations (
 tenant_id uuid PRIMARY KEY, account_id uuid NOT NULL, workspace_id uuid NOT NULL,
 active boolean NOT NULL DEFAULT true, generation uuid NOT NULL DEFAULT gen_random_uuid(),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
 UNIQUE (tenant_id, workspace_id), UNIQUE (workspace_id)
);
CREATE TABLE teams_bot_links (
 account_id uuid NOT NULL, workspace_id uuid NOT NULL, tenant_id uuid NOT NULL,
 actor_id uuid NOT NULL, subject_id text NOT NULL CHECK(length(subject_id) BETWEEN 1 AND 512),
 PRIMARY KEY(tenant_id, actor_id), UNIQUE(workspace_id, subject_id),
 FOREIGN KEY(tenant_id, workspace_id) REFERENCES teams_bot_installations(tenant_id, workspace_id) ON DELETE CASCADE
);
CREATE TABLE teams_bot_proofs (
 account_id uuid NOT NULL, workspace_id uuid NOT NULL, nonce uuid PRIMARY KEY,
 consumed_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE
);
CREATE TABLE teams_bot_routes (
 account_id uuid NOT NULL, workspace_id uuid NOT NULL, tenant_id uuid NOT NULL,
 route_id text PRIMARY KEY, UNIQUE(route_id,workspace_id,account_id), generation uuid NOT NULL, actor_id uuid NOT NULL, subject_id text NOT NULL,
 personal boolean NOT NULL, channel_id text, conversation_id text NOT NULL, thread_id text,
 service_url text NOT NULL, bot_id text NOT NULL, session_id uuid NOT NULL DEFAULT gen_random_uuid(),
 session_bound boolean NOT NULL DEFAULT false, delivered_sequence bigint NOT NULL DEFAULT 0,
 lease_token uuid, lease_until timestamptz, last_claimed_at timestamptz,
 relevant_event_sequence bigint NOT NULL DEFAULT 0 CHECK(relevant_event_sequence>=0),
 FOREIGN KEY(tenant_id, workspace_id) REFERENCES teams_bot_installations(tenant_id, workspace_id) ON DELETE CASCADE,
 CHECK(length(route_id)<=128 AND length(conversation_id)<=512 AND length(bot_id)<=512 AND length(service_url)<=2048)
);
CREATE INDEX teams_bot_routes_due ON teams_bot_routes(tenant_id,generation,last_claimed_at,route_id);
CREATE UNIQUE INDEX teams_bot_routes_session ON teams_bot_routes(workspace_id,session_id);
CREATE INDEX teams_bot_routes_unread ON teams_bot_routes(tenant_id,generation,last_claimed_at) WHERE relevant_event_sequence>delivered_sequence;
CREATE TABLE teams_bot_inbox (
 account_id uuid NOT NULL, workspace_id uuid NOT NULL, event_id text PRIMARY KEY,
 route_id text NOT NULL,
 FOREIGN KEY(route_id,workspace_id,account_id) REFERENCES teams_bot_routes(route_id,workspace_id,account_id) ON DELETE CASCADE,
 actor_id uuid NOT NULL, subject_id text NOT NULL, payload jsonb NOT NULL, state text NOT NULL DEFAULT 'pending',
 created_at timestamptz NOT NULL DEFAULT now(), error_code text,
 CHECK(state IN ('pending','accepted','failed')), CHECK(octet_length(payload::text)<=65536)
);
CREATE INDEX teams_bot_inbox_pending ON teams_bot_inbox(route_id,created_at) WHERE state='pending';
CREATE TABLE teams_bot_outbox (
 account_id uuid NOT NULL, workspace_id uuid NOT NULL, operation_id text PRIMARY KEY,
 route_id text NOT NULL,
 FOREIGN KEY(route_id,workspace_id,account_id) REFERENCES teams_bot_routes(route_id,workspace_id,account_id) ON DELETE CASCADE,
 source_sequence bigint NOT NULL, part_index integer NOT NULL CHECK(part_index>=0),
 payload jsonb NOT NULL, state text NOT NULL DEFAULT 'pending', provider_message_id text,
 created_at timestamptz NOT NULL DEFAULT now(), retry_at timestamptz NOT NULL DEFAULT now(), error_code text,
 CHECK(state IN ('pending','sending','delivered','unknown','failed')), CHECK(octet_length(payload::text)<=65536)
);
CREATE INDEX teams_bot_outbox_pending ON teams_bot_outbox(route_id,source_sequence,part_index,retry_at) WHERE state='pending';
DO $teams$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['teams_bot_installations','teams_bot_links','teams_bot_proofs','teams_bot_routes','teams_bot_inbox','teams_bot_outbox'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY workspace_isolation ON %I USING (opengeni_private.workspace_rls_visible(account_id,workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id,workspace_id))',tab);
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='opengeni_app') THEN
   EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO opengeni_app',tab);
  END IF;
 END LOOP;
END $teams$;
DO $teams_scope$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['teams_bot_links','teams_bot_routes','teams_bot_inbox','teams_bot_outbox'] LOOP
  EXECUTE format('ALTER TABLE %I ADD FOREIGN KEY (workspace_id,account_id) REFERENCES workspaces(id,account_id) ON DELETE CASCADE',tab);
 END LOOP;
END $teams_scope$;
CREATE POLICY teams_installation_directory ON teams_bot_installations FOR SELECT USING (true);

-- Existing custom event-writer roles must keep appending during the rolling
-- migration/provisioning gap. Give only the new trigger's metadata access;
-- provisioning the current application role remains the sole broader grant.
DO $teams_existing_event_writers$
DECLARE writer_role text; data_schema text:=current_schema(); event_table oid;
BEGIN
 event_table:=format('%I.session_events',data_schema)::regclass;
 FOR writer_role IN
  SELECT role.rolname FROM pg_roles role
  WHERE NOT role.rolsuper
   AND role.oid<>(SELECT relowner FROM pg_class WHERE oid=event_table)
   AND has_table_privilege(role.oid,event_table,'INSERT')
 LOOP
  EXECUTE format('GRANT SELECT, UPDATE(relevant_event_sequence) ON %I.teams_bot_routes TO %I',data_schema,writer_role);
 END LOOP;
END
$teams_existing_event_writers$;

-- A content-free wake only. Dispatch still reauthorizes the linked human and
-- native session before reading any event payload or contacting Microsoft.
-- Route reservation precedes native session creation, so even an immediate
-- first reply commits its wake in the same transaction as its event.
CREATE FUNCTION opengeni_private.wake_teams_route_for_session_event()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT AS $wake$
DECLARE
 prior_account text:=coalesce(current_setting('opengeni.account_id',true),'');
 prior_workspace text:=coalesce(current_setting('opengeni.workspace_id',true),'');
BEGIN
 -- The already-authorized native event supplies the exact scope. This uses
 -- the inserting role's ordinary Teams-table privileges, never an owner role.
 -- Some native lifecycle writers establish their own event audience rather
 -- than caller workspace GUCs; no actor identity is borrowed or changed here.
 PERFORM set_config('opengeni.account_id',NEW.account_id::text,true);
 PERFORM set_config('opengeni.workspace_id',NEW.workspace_id::text,true);
 UPDATE teams_bot_routes SET relevant_event_sequence=greatest(relevant_event_sequence,NEW.sequence)
 WHERE account_id=NEW.account_id AND workspace_id=NEW.workspace_id AND session_id=NEW.session_id;
 PERFORM set_config('opengeni.account_id',prior_account,true);
 PERFORM set_config('opengeni.workspace_id',prior_workspace,true);
 RETURN NULL;
EXCEPTION WHEN OTHERS THEN
 PERFORM set_config('opengeni.account_id',prior_account,true);
 PERFORM set_config('opengeni.workspace_id',prior_workspace,true);
 RAISE;
END
$wake$;
DO $teams_wake_security$
DECLARE target_schema text:=current_schema();
BEGIN
 EXECUTE format('ALTER FUNCTION opengeni_private.wake_teams_route_for_session_event() SET search_path=pg_catalog,%I,pg_temp',target_schema);
END
$teams_wake_security$;
REVOKE ALL ON FUNCTION opengeni_private.wake_teams_route_for_session_event() FROM PUBLIC;
CREATE TRIGGER session_events_teams_wake AFTER INSERT ON session_events FOR EACH ROW
WHEN(NEW.duplicate_of_event_id IS NULL AND NEW.type IN('turn.completed','turn.failed','session.requiresAction','session.humanInput.requested'))
EXECUTE FUNCTION opengeni_private.wake_teams_route_for_session_event();
-- Migration owners may have default EXECUTE grants for existing runtime roles.
-- Strip every non-owner grant, not just PUBLIC or a guessed application role.
DO $teams_wake_acl$
DECLARE grantee_name text;
BEGIN
 FOR grantee_name IN
  SELECT DISTINCT role.rolname FROM pg_proc routine
  CROSS JOIN LATERAL aclexplode(coalesce(routine.proacl,acldefault('f',routine.proowner))) acl
  JOIN pg_roles role ON role.oid=acl.grantee
  WHERE routine.oid='opengeni_private.wake_teams_route_for_session_event()'::regprocedure
   AND acl.grantee<>routine.proowner
 LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION opengeni_private.wake_teams_route_for_session_event() FROM %I',grantee_name);
 END LOOP;
END
$teams_wake_acl$;
