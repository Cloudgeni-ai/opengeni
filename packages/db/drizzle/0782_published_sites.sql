-- deployment-mode: rolling
-- Published Sites (OPE-802): a workspace Site served on its own hostname
-- under the configured Sites domain, to members, invited people or the
-- public, through the Site gateway and the narrow site-runtime API.
--
-- Every table is workspace-owned, FORCE RLS, with the workspace_isolation
-- policy. The one cross-tenant read is a hostname lookup: the gateway (and
-- the availability check) knows a label, not a workspace, so site_hostnames
-- has an api_keys-style lane that shows exactly the row whose label the
-- transaction set in `opengeni.site_hostname_label`, and lets that lane
-- delete a released row whose 30-day hold has ended (so another workspace
-- can take the label). RLS is never disabled.
-- The same lane shows site_hostname_holds read-only: labels a platform
-- moderator took down, which no workspace may claim until the platform lifts
-- the hold, and labels whose Site or workspace was deleted, held for 30 days
-- (a definer trigger on site_hostnames writes those, so deleting a Site or
-- workspace never frees its label at once). Holds have no workspace foreign
-- keys on purpose: they outlive the Site and its workspace. Only the schema
-- owner (the migrations credential the operator scripts use) writes holds.
--
-- The operator moderation queue reads open abuse reports and flagged
-- publications across workspaces as the schema owner, through owner-only
-- read policies (as 0639 and 0751 do): the application role never matches
-- them, and nobody needs BYPASSRLS.
--
-- Host-map generations come from one sequence, so they only grow per
-- hostname whichever Site holds it: a label that moves to another Site, or a
-- tombstone for a released one, always carries a newer generation than any
-- record the edge already holds for that hostname.
--
-- Site Data gains a per-collection guest rule (`none` by default), so
-- anonymous guests of public Sites reach only what the owner allows.
-- New tables, plus one defaulted column and a validated check on
-- site_data_collections (added in 0776, small): no long lock.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE SEQUENCE site_host_generation_seq AS bigint;
REVOKE ALL ON SEQUENCE site_host_generation_seq FROM PUBLIC;

ALTER TABLE site_data_collections
  ADD COLUMN guest_access text NOT NULL DEFAULT 'none';
ALTER TABLE site_data_collections
  ADD CONSTRAINT site_data_collections_guest_access_check
  CHECK (guest_access IN ('none', 'read', 'append', 'own')) NOT VALID;
ALTER TABLE site_data_collections
  VALIDATE CONSTRAINT site_data_collections_guest_access_check;

-- One publication per Site. `label` mirrors the Site's live row in
-- site_hostnames (written in the same transaction). `generation` grows on
-- every change the host map carries, so edge copies never go backwards.
CREATE TABLE site_publications (
  site_id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  label text NOT NULL CHECK (label ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'),
  access text NOT NULL DEFAULT 'members' CHECK (access IN ('members', 'invited', 'public')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'unpublished', 'suspended')),
  noindex boolean NOT NULL DEFAULT true,
  agent_enabled boolean NOT NULL DEFAULT true,
  agent_model text CHECK (agent_model IS NULL OR char_length(agent_model) BETWEEN 1 AND 200),
  agent_instructions text
    CHECK (agent_instructions IS NULL OR char_length(agent_instructions) <= 8000),
  agent_tools jsonb CHECK (agent_tools IS NULL OR (jsonb_typeof(agent_tools) = 'array'
    AND jsonb_array_length(agent_tools) <= 100)),
  -- Anonymous guests get the agent's tools only when an admin opts in.
  agent_guest_tools boolean NOT NULL DEFAULT false,
  -- NULL inherits the workspace default profile (site_limit_profiles).
  limit_profile_kind text
    CHECK (limit_profile_kind IS NULL OR limit_profile_kind IN ('free', 'credits', 'unlimited', 'custom')),
  limit_overrides jsonb CHECK (limit_overrides IS NULL OR jsonb_typeof(limit_overrides) = 'object'),
  invited_emails jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(invited_emails) = 'array' AND jsonb_array_length(invited_emails) <= 500),
  suspended_at timestamptz,
  suspended_by text CHECK (suspended_by IS NULL OR suspended_by IN ('owner', 'admin', 'platform')),
  suspended_reason text CHECK (suspended_reason IS NULL OR char_length(suspended_reason) <= 2000),
  suspended_by_subject text,
  generation bigint NOT NULL DEFAULT nextval('site_host_generation_seq') CHECK (generation > 0),
  edge_synced_generation bigint NOT NULL DEFAULT 0 CHECK (edge_synced_generation >= 0),
  scan_status text NOT NULL DEFAULT 'none'
    CHECK (scan_status IN ('none', 'clean', 'flagged', 'error')),
  scan_findings jsonb CHECK (scan_findings IS NULL OR jsonb_typeof(scan_findings) = 'array'),
  scanned_version_id uuid,
  scanned_at timestamptz,
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT site_publications_suspension_check
    CHECK ((status = 'suspended') = (suspended_at IS NOT NULL AND suspended_by IS NOT NULL)),
  CONSTRAINT site_publications_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT site_publications_site_fk FOREIGN KEY (workspace_id, site_id)
    REFERENCES workspace_artifacts(workspace_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX site_publications_workspace_site_uq ON site_publications (workspace_id, site_id);
CREATE UNIQUE INDEX site_publications_label_uq ON site_publications (label);
CREATE INDEX site_publications_flagged_idx ON site_publications (scanned_at DESC)
  WHERE scan_status = 'flagged';

-- The global hostname registry. The label is the primary key, so it is
-- unique across every workspace whatever RLS shows. A released row keeps the
-- label for its workspace for the hold (at least 30 days).
CREATE TABLE site_hostnames (
  label text PRIMARY KEY CHECK (label ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  site_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  CONSTRAINT site_hostnames_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT site_hostnames_site_fk FOREIGN KEY (workspace_id, site_id)
    REFERENCES workspace_artifacts(workspace_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX site_hostnames_live_site_uq ON site_hostnames (site_id) WHERE released_at IS NULL;
CREATE INDEX site_hostnames_workspace_site_idx ON site_hostnames (workspace_id, site_id);

-- Platform holds on taken-down labels. No foreign keys: a hold survives the
-- Site and its workspace, so deleting either never frees the label.
-- A `release` hold keeps a deleted Site's (or workspace's) label for its
-- workspace until expires_at; a `platform` hold never expires.
CREATE TABLE site_hostname_holds (
  label text PRIMARY KEY CHECK (label ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'),
  site_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 2000),
  held_by text NOT NULL CHECK (char_length(held_by) BETWEEN 1 AND 300),
  kind text NOT NULL DEFAULT 'platform' CHECK (kind IN ('platform', 'release')),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT site_hostname_holds_expiry_check CHECK ((kind = 'release') = (expires_at IS NOT NULL))
);

-- One-time viewer sign-in codes: hash only, 60 s, single use, bound to the
-- host, PKCE challenge, redirect and subject.
CREATE TABLE site_auth_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  site_id uuid NOT NULL,
  code_hash text NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  hostname text NOT NULL CHECK (char_length(hostname) BETWEEN 1 AND 253),
  code_challenge text NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  redirect_uri text NOT NULL CHECK (char_length(redirect_uri) BETWEEN 1 AND 2048),
  subject_id text NOT NULL CHECK (char_length(subject_id) BETWEEN 1 AND 300),
  viewer_kind text NOT NULL CHECK (viewer_kind IN ('member', 'invited', 'user')),
  email text CHECK (email IS NULL OR char_length(email) <= 320),
  display_name text CHECK (display_name IS NULL OR char_length(display_name) <= 300),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT site_auth_codes_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT site_auth_codes_site_fk FOREIGN KEY (workspace_id, site_id)
    REFERENCES workspace_artifacts(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX site_auth_codes_site_expiry_idx ON site_auth_codes (workspace_id, site_id, expires_at);

-- Site-session tokens (hash only), valid on site-runtime for one Site.
CREATE TABLE site_viewer_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  site_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  subject_id text NOT NULL CHECK (char_length(subject_id) BETWEEN 1 AND 300),
  viewer_kind text NOT NULL CHECK (viewer_kind IN ('member', 'invited', 'user')),
  email text CHECK (email IS NULL OR char_length(email) <= 320),
  display_name text CHECK (display_name IS NULL OR char_length(display_name) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT site_viewer_sessions_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT site_viewer_sessions_site_fk FOREIGN KEY (workspace_id, site_id)
    REFERENCES workspace_artifacts(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX site_viewer_sessions_site_subject_idx
  ON site_viewer_sessions (workspace_id, site_id, subject_id);
CREATE INDEX site_viewer_sessions_site_expiry_idx
  ON site_viewer_sessions (workspace_id, site_id, expires_at);

-- The workspace default limit profile; a Site's own lives on its publication.
CREATE TABLE site_limit_profiles (
  workspace_id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('free', 'credits', 'unlimited', 'custom')),
  overrides jsonb CHECK (overrides IS NULL OR jsonb_typeof(overrides) = 'object'),
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT site_limit_profiles_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE
);

-- Embedded agent conversations started through site-runtime: who owns each
-- (the Site and the viewer principal), how many messages it took, how much
-- of its spend has been counted into the usage windows, and how much of its
-- remaining per-conversation budget is reserved in them (reserved_day and
-- reserved_month name the periods the reservation was counted in).
CREATE TABLE site_runtime_conversations (
  session_id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  site_id uuid NOT NULL,
  viewer_principal text NOT NULL CHECK (char_length(viewer_principal) BETWEEN 1 AND 300),
  version_id uuid,
  turns integer NOT NULL DEFAULT 0 CHECK (turns >= 0),
  metered_micros bigint NOT NULL DEFAULT 0 CHECK (metered_micros >= 0),
  -- The conversation's own spend cap (its session usage limit), fixed at start.
  limit_micros bigint CHECK (limit_micros IS NULL OR limit_micros >= 0),
  reserved_micros bigint NOT NULL DEFAULT 0 CHECK (reserved_micros >= 0),
  reserved_day date,
  reserved_month date,
  -- Work admitted so far (the start, messages, steering, resumes). Releasing
  -- an idle conversation's reservation applies only if it has not moved since
  -- the session's status was read.
  admissions bigint NOT NULL DEFAULT 0 CHECK (admissions >= 0),
  -- When a reservation sweep last visited the conversation (null: never).
  swept_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Last admitted work or counted spend.
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT site_runtime_conversations_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  -- No session foreign key: the row (and its budget reservation) is written
  -- before the session is created, so the session gets its usage limit in its
  -- own create transaction. A start whose session never appears is released.
  CONSTRAINT site_runtime_conversations_site_fk FOREIGN KEY (workspace_id, site_id)
    REFERENCES workspace_artifacts(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX site_runtime_conversations_viewer_idx
  ON site_runtime_conversations (workspace_id, site_id, viewer_principal, created_at DESC);
CREATE INDEX site_runtime_conversations_site_recent_idx
  ON site_runtime_conversations (workspace_id, site_id, updated_at DESC);
CREATE INDEX site_runtime_conversations_reserved_idx
  ON site_runtime_conversations (workspace_id, site_id, swept_at NULLS FIRST, updated_at)
  WHERE reserved_micros > 0;

-- Current-period spend and conversation counters per Site and viewer
-- principal ('*' is the whole Site): one row per (principal, period kind),
-- reset when its period changes, so reads never aggregate. agent_micros is
-- settled spend; reserved_micros is what running conversations may still
-- spend. A new conversation or message is admitted only when settled plus
-- reserved plus its own reservation stays within each budget.
CREATE TABLE site_runtime_usage (
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  site_id uuid NOT NULL,
  principal_key text NOT NULL CHECK (char_length(principal_key) BETWEEN 1 AND 300),
  period text NOT NULL CHECK (period IN ('day', 'month')),
  period_start date NOT NULL,
  conversations integer NOT NULL DEFAULT 0 CHECK (conversations >= 0),
  agent_micros bigint NOT NULL DEFAULT 0 CHECK (agent_micros >= 0),
  reserved_micros bigint NOT NULL DEFAULT 0 CHECK (reserved_micros >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, site_id, principal_key, period),
  CONSTRAINT site_runtime_usage_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT site_runtime_usage_site_fk FOREIGN KEY (workspace_id, site_id)
    REFERENCES workspace_artifacts(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX site_runtime_usage_site_period_idx
  ON site_runtime_usage (workspace_id, site_id, period_start);

-- Fixed one-minute request windows per Site, principal and bucket.
CREATE TABLE site_runtime_rate_windows (
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  site_id uuid NOT NULL,
  principal_key text NOT NULL CHECK (char_length(principal_key) BETWEEN 1 AND 300),
  bucket text NOT NULL CHECK (bucket IN ('requests', 'guest_writes', 'reports', 'sign_in')),
  window_started_at timestamptz NOT NULL,
  operations integer NOT NULL CHECK (operations >= 0),
  PRIMARY KEY (workspace_id, site_id, principal_key, bucket),
  CONSTRAINT site_runtime_rate_windows_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT site_runtime_rate_windows_site_fk FOREIGN KEY (workspace_id, site_id)
    REFERENCES workspace_artifacts(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX site_runtime_rate_windows_site_window_idx
  ON site_runtime_rate_windows (workspace_id, site_id, window_started_at);

CREATE TABLE site_abuse_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  site_id uuid NOT NULL,
  hostname text NOT NULL CHECK (char_length(hostname) BETWEEN 1 AND 253),
  category text NOT NULL
    CHECK (category IN ('phishing', 'malware', 'spam', 'illegal', 'harassment', 'copyright', 'other')),
  message text NOT NULL DEFAULT '' CHECK (char_length(message) <= 4000),
  contact_email text CHECK (contact_email IS NULL OR char_length(contact_email) <= 320),
  reporter_principal text NOT NULL CHECK (char_length(reporter_principal) BETWEEN 1 AND 300),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed', 'actioned')),
  resolved_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT site_abuse_reports_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT site_abuse_reports_site_fk FOREIGN KEY (workspace_id, site_id)
    REFERENCES workspace_artifacts(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX site_abuse_reports_site_idx
  ON site_abuse_reports (workspace_id, site_id, status, created_at DESC);
-- The platform's moderation queue reads open reports across workspaces.
CREATE INDEX site_abuse_reports_open_idx ON site_abuse_reports (created_at DESC)
  WHERE status = 'open';

DO $rls$
DECLARE
  site_table text;
BEGIN
  FOREACH site_table IN ARRAY ARRAY[
    'site_publications', 'site_hostnames', 'site_auth_codes', 'site_viewer_sessions',
    'site_limit_profiles', 'site_runtime_conversations', 'site_runtime_usage',
    'site_runtime_rate_windows', 'site_abuse_reports'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', site_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', site_table);
    EXECUTE format(
      'CREATE POLICY workspace_isolation ON %I '
      'USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) '
      'WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id))',
      site_table
    );
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', site_table);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO opengeni_app', site_table);
    END IF;
  END LOOP;
  ALTER TABLE site_hostname_holds ENABLE ROW LEVEL SECURITY;
  ALTER TABLE site_hostname_holds FORCE ROW LEVEL SECURITY;
  REVOKE ALL ON TABLE site_hostname_holds FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    -- Read-only: the application never places or lifts a hold.
    GRANT SELECT ON TABLE site_hostname_holds TO opengeni_app;
    GRANT USAGE ON SEQUENCE site_host_generation_seq TO opengeni_app;
  END IF;
END
$rls$;

-- The hostname lane: exactly the row whose label this transaction named.
CREATE POLICY site_hostnames_label_lookup ON site_hostnames
  FOR SELECT
  USING (label = nullif(pg_catalog.current_setting('opengeni.site_hostname_label', true), ''));
-- A released label whose hold has ended may be taken by another workspace:
-- the lane may remove exactly that row. The API applies the configured hold
-- (never under 30 days); this policy is the floor.
CREATE POLICY site_hostnames_label_takeover ON site_hostnames
  FOR DELETE
  USING (
    label = nullif(pg_catalog.current_setting('opengeni.site_hostname_label', true), '')
    AND released_at IS NOT NULL
    AND released_at < now() - interval '30 days'
  );
-- Holds are read through the same lane, one label at a time.
CREATE POLICY site_hostname_holds_label_lane ON site_hostname_holds
  FOR SELECT
  USING (label = nullif(pg_catalog.current_setting('opengeni.site_hostname_label', true), ''));

-- Owner-only lanes: the schema owner (operator scripts with the migrations
-- credential, and the release-hold trigger below) writes holds and reads the
-- moderation queue across workspaces. The application role is never the
-- owner, so these never match for it.
DO $owner_lanes$
DECLARE
  owner_table text;
BEGIN
  FOREACH owner_table IN ARRAY ARRAY['site_hostname_holds', 'site_publications', 'site_abuse_reports']
  LOOP
    EXECUTE format(
      'CREATE POLICY %I ON %I %s USING (CURRENT_USER = pg_catalog.pg_get_userbyid(('
      'SELECT relation.relowner FROM pg_catalog.pg_class relation '
      'WHERE relation.oid = %L::regclass)))%s',
      owner_table || '_owner',
      owner_table,
      CASE WHEN owner_table = 'site_hostname_holds' THEN '' ELSE 'FOR SELECT' END,
      format('%I.%I', current_schema(), owner_table),
      CASE WHEN owner_table = 'site_hostname_holds' THEN format(
        ' WITH CHECK (CURRENT_USER = pg_catalog.pg_get_userbyid(('
        'SELECT relation.relowner FROM pg_catalog.pg_class relation '
        'WHERE relation.oid = %L::regclass)))',
        format('%I.%I', current_schema(), owner_table)) ELSE '' END
    );
  END LOOP;
END
$owner_lanes$;

-- Deleting a hostname row (its Site or workspace was deleted) leaves a
-- 30-day release hold, so the label is not free to another workspace at
-- once. A row released more than 30 days ago (the takeover path) leaves
-- nothing. A platform hold is never replaced. Runs as the owner: the
-- application role holds no write privilege on site_hostname_holds.
CREATE FUNCTION opengeni_private.hold_deleted_site_hostname()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $hold$
BEGIN
  IF OLD.released_at IS NOT NULL AND OLD.released_at <= now() - interval '30 days' THEN
    RETURN OLD;
  END IF;
  INSERT INTO site_hostname_holds (label, site_id, workspace_id, reason, held_by, kind, expires_at)
  VALUES (
    OLD.label, OLD.site_id, OLD.workspace_id, 'Released when its Site or workspace was deleted',
    'system', 'release', coalesce(OLD.released_at, now()) + interval '30 days'
  )
  ON CONFLICT (label) DO UPDATE SET site_id = excluded.site_id,
    workspace_id = excluded.workspace_id, reason = excluded.reason, held_by = excluded.held_by,
    expires_at = excluded.expires_at, created_at = now()
  WHERE site_hostname_holds.kind = 'release';
  RETURN OLD;
END
$hold$;
DO $hold_search_path$
BEGIN
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.hold_deleted_site_hostname() SET search_path = pg_catalog, %I, pg_temp',
    current_schema()
  );
END
$hold_search_path$;
REVOKE ALL ON FUNCTION opengeni_private.hold_deleted_site_hostname() FROM PUBLIC;
CREATE TRIGGER site_hostnames_hold_deleted
  AFTER DELETE ON site_hostnames
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.hold_deleted_site_hostname();
