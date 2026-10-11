-- deployment-mode: rolling
-- M4 PR 0b, part 1: accepted authority across a provider's cutover (design
-- docs/design/subscription-core-2026-10-07.md, 5.3 "Accepted authority across
-- the cutover" and "PR 0b: authority compatibility and fences").
--
-- 1. `authority_inserted_at`: a server-owned insertion marker on every carrier
--    table. Supplied values are replaced, never rejected; it never changes.
-- 2. `opengeni_private.subscription_authority_compat`: one immutable record per
--    carrier and provider. Runtime roles hold no privilege on it.
-- 3. One source resolver per carrier path, the copy rule, the copy routine
--    and the reader.
-- 4. A commit-time (deferred) compatibility constraint trigger on every
--    carrier table.
-- 5. The record branch of both personal-authority helpers (0667, 0668).
--
-- Inert until a provider's own drained cutover inserts a receipt with a real
-- commit time: nothing here acts for Codex (receipt at '-infinity', no
-- records) or for a provider without a receipt, and nothing in the runtime
-- calls the copy routine yet (the provider writers, X2b and C2b, will).
SET LOCAL lock_timeout = '5s';

DO $prerequisite$
BEGIN
  IF to_regprocedure('opengeni_private.subscription_provider_cutover_committed(text)') IS NULL
    OR to_regclass('opengeni_private.subscription_provider_cutover_receipts') IS NULL
  THEN
    RAISE EXCEPTION '0715 requires the 0712 provider cutover receipts' USING ERRCODE = '55000';
  END IF;
END
$prerequisite$;

-- 1. The server-owned insertion marker. A constant default is a metadata-only
-- change: every existing row reads this migration's time, before any receipt
-- a later cutover writes. Older binaries never name the column.
ALTER TABLE session_turns
  ADD COLUMN authority_inserted_at timestamptz NOT NULL DEFAULT transaction_timestamp();
ALTER TABLE sessions
  ADD COLUMN authority_inserted_at timestamptz NOT NULL DEFAULT transaction_timestamp();
ALTER TABLE scheduled_tasks
  ADD COLUMN authority_inserted_at timestamptz NOT NULL DEFAULT transaction_timestamp();
ALTER TABLE scheduled_task_revision_authorities
  ADD COLUMN authority_inserted_at timestamptz NOT NULL DEFAULT transaction_timestamp();
ALTER TABLE session_system_updates
  ADD COLUMN authority_inserted_at timestamptz NOT NULL DEFAULT transaction_timestamp();
ALTER TABLE session_system_update_outbox
  ADD COLUMN authority_inserted_at timestamptz NOT NULL DEFAULT transaction_timestamp();

CREATE FUNCTION opengeni_subscription_internal.stamp_subscription_authority_inserted_at()
RETURNS trigger
LANGUAGE plpgsql
AS $body$
BEGIN
  -- Whatever the writer supplied (older binaries supply nothing, a backdated
  -- import supplies created_at only), the marker is this transaction's start.
  NEW.authority_inserted_at := pg_catalog.transaction_timestamp();
  RETURN NEW;
END
$body$;

CREATE FUNCTION opengeni_subscription_internal.keep_subscription_authority_inserted_at()
RETURNS trigger
LANGUAGE plpgsql
AS $body$
BEGIN
  RAISE EXCEPTION 'authority_inserted_at is server-owned and immutable' USING ERRCODE = '42501';
END
$body$;

DO $marker_triggers$
DECLARE carrier text;
BEGIN
  FOREACH carrier IN ARRAY ARRAY[
    'session_turns', 'sessions', 'scheduled_tasks', 'scheduled_task_revision_authorities',
    'session_system_updates', 'session_system_update_outbox'
  ] LOOP
    -- `zzz_` orders these after every other BEFORE trigger on the table, so
    -- no later trigger can replace the stamped value.
    EXECUTE format(
      'CREATE TRIGGER zzz_authority_inserted_at_stamp BEFORE INSERT ON %I '
      'FOR EACH ROW EXECUTE FUNCTION '
      'opengeni_subscription_internal.stamp_subscription_authority_inserted_at()',
      carrier);
    EXECUTE format(
      'CREATE TRIGGER zzz_authority_inserted_at_immutable BEFORE UPDATE ON %I '
      'FOR EACH ROW WHEN (NEW.authority_inserted_at IS DISTINCT FROM OLD.authority_inserted_at) '
      'EXECUTE FUNCTION opengeni_subscription_internal.keep_subscription_authority_inserted_at()',
      carrier);
  END LOOP;
END
$marker_triggers$;

-- The marker is not execution state: the scheduled-task execution digest
-- excludes it (as 0688 excluded `subscription_authority`), so a task's digest,
-- and every run receipt holding it, is the same before and after this
-- migration. Each anchor must occur exactly once in the live definition.
DO $authority_marker_digest$
DECLARE signature text; definition text; row_name text; anchor text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'scheduled_task_execution_digest(scheduled_tasks)',
    'set_scheduled_task_execution_digest()'
  ] LOOP
    definition := pg_get_functiondef(signature::regprocedure);
    row_name := CASE WHEN signature = 'set_scheduled_task_execution_digest()'
      THEN 'NEW' ELSE 'p_task' END;
    anchor := '(pg_catalog.to_jsonb(' || row_name || ') - ''subscription_authority'')';
    IF (length(definition) - length(replace(definition, anchor, ''))) <> length(anchor) THEN
      RAISE EXCEPTION 'scheduled task digest definition changed: %', signature;
    END IF;
    EXECUTE replace(definition, anchor,
      '((pg_catalog.to_jsonb(' || row_name || ') - ''subscription_authority'') - ''authority_inserted_at'')');
  END LOOP;
END
$authority_marker_digest$;

-- 2. The compatibility relation.
CREATE FUNCTION opengeni_subscription_internal.subscription_authority_compat_entry_valid(entry jsonb)
RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT
AS $body$
  SELECT CASE WHEN jsonb_typeof(entry) <> 'object' THEN false
    WHEN NOT (entry ?& ARRAY['ownerMembershipId', 'authorityGeneration', 'connectionIds']) THEN false
    WHEN entry - ARRAY['ownerMembershipId', 'authorityGeneration', 'connectionIds'] <> '{}'::jsonb THEN false
    WHEN jsonb_typeof(entry->'ownerMembershipId') <> 'string'
      OR (entry->>'ownerMembershipId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      THEN false
    WHEN jsonb_typeof(entry->'authorityGeneration') <> 'number'
      OR (entry->>'authorityGeneration') !~ '^[1-9][0-9]{0,15}$' THEN false
    WHEN (entry->>'authorityGeneration')::numeric > 9007199254740991 THEN false
    WHEN jsonb_typeof(entry->'connectionIds') <> 'array' THEN false
    WHEN jsonb_array_length(entry->'connectionIds') NOT BETWEEN 1 AND 64 THEN false
    ELSE NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(entry->'connectionIds') connection(id)
        WHERE jsonb_typeof(connection.id) <> 'string'
          OR (connection.id #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      )
      AND (SELECT count(DISTINCT connection.id) = count(*)
        FROM jsonb_array_elements_text(entry->'connectionIds') connection(id))
  END
$body$;

CREATE TABLE opengeni_private.subscription_authority_compat (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
  carrier_kind text NOT NULL,
  -- One typed reference per carrier kind, each with its own foreign key.
  session_id uuid,
  turn_id uuid,
  scheduled_task_id uuid,
  task_authority_revision bigint,
  system_update_id uuid,
  outbox_id uuid,
  -- [] or one {ownerMembershipId, authorityGeneration, connectionIds} entry.
  personal jsonb NOT NULL,
  shared_pool text NOT NULL,
  legacy_scope text NOT NULL,
  -- The human whose personal authority this record carries (a `user` record,
  -- or a record with a personal entry); NULL for shared and `missing`
  -- records. A copy keeps the personal entry only for this exact human.
  owner_subject_id text,
  recorded_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT subscription_authority_compat_carrier CHECK (CASE carrier_kind
    WHEN 'session_initial' THEN session_id IS NOT NULL AND turn_id IS NULL
      AND scheduled_task_id IS NULL AND task_authority_revision IS NULL
      AND system_update_id IS NULL AND outbox_id IS NULL
    WHEN 'session_turn' THEN turn_id IS NOT NULL AND session_id IS NULL
      AND scheduled_task_id IS NULL AND task_authority_revision IS NULL
      AND system_update_id IS NULL AND outbox_id IS NULL
    WHEN 'scheduled_task' THEN scheduled_task_id IS NOT NULL AND task_authority_revision IS NULL
      AND session_id IS NULL AND turn_id IS NULL AND system_update_id IS NULL AND outbox_id IS NULL
    WHEN 'scheduled_task_revision' THEN scheduled_task_id IS NOT NULL
      AND task_authority_revision IS NOT NULL AND session_id IS NULL AND turn_id IS NULL
      AND system_update_id IS NULL AND outbox_id IS NULL
    WHEN 'session_system_update' THEN system_update_id IS NOT NULL AND session_id IS NULL
      AND turn_id IS NULL AND scheduled_task_id IS NULL AND task_authority_revision IS NULL
      AND outbox_id IS NULL
    WHEN 'session_system_update_outbox' THEN outbox_id IS NOT NULL AND session_id IS NULL
      AND turn_id IS NULL AND scheduled_task_id IS NULL AND task_authority_revision IS NULL
      AND system_update_id IS NULL
    ELSE false
  END),
  CONSTRAINT subscription_authority_compat_content CHECK (
    shared_pool IN ('workspace', 'organization', 'none')
    AND legacy_scope IN ('organization', 'workspace', 'user', 'missing')
    AND jsonb_typeof(personal) = 'array'
    AND CASE WHEN jsonb_typeof(personal) = 'array' THEN jsonb_array_length(personal) <= 1 ELSE false END
    AND CASE legacy_scope
      WHEN 'organization' THEN shared_pool = 'organization' AND personal = '[]'::jsonb
      WHEN 'workspace' THEN shared_pool = 'workspace'
      WHEN 'user' THEN shared_pool = 'none'
      WHEN 'missing' THEN shared_pool = 'none' AND personal = '[]'::jsonb
      ELSE false
    END
    AND (personal = '[]'::jsonb
      OR opengeni_subscription_internal.subscription_authority_compat_entry_valid(personal->0))
    AND (owner_subject_id IS NOT NULL) = (legacy_scope = 'user' OR personal <> '[]'::jsonb)
    AND (owner_subject_id IS NULL OR octet_length(btrim(owner_subject_id)) BETWEEN 1 AND 512)
  ),
  CONSTRAINT subscription_authority_compat_session_fk FOREIGN KEY (workspace_id, session_id)
    REFERENCES sessions (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT subscription_authority_compat_turn_fk FOREIGN KEY (workspace_id, turn_id)
    REFERENCES session_turns (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT subscription_authority_compat_task_fk FOREIGN KEY (scheduled_task_id)
    REFERENCES scheduled_tasks (id) ON DELETE CASCADE,
  CONSTRAINT subscription_authority_compat_revision_fk
    FOREIGN KEY (scheduled_task_id, task_authority_revision)
    REFERENCES scheduled_task_revision_authorities (task_id, task_authority_revision) ON DELETE CASCADE,
  CONSTRAINT subscription_authority_compat_update_fk FOREIGN KEY (workspace_id, system_update_id)
    REFERENCES session_system_updates (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT subscription_authority_compat_outbox_fk FOREIGN KEY (outbox_id)
    REFERENCES session_system_update_outbox (id) ON DELETE CASCADE
);
-- One record per carrier and provider. Each index also serves its foreign
-- key's cascade lookup (the kind's column leads; other kinds leave it NULL).
CREATE UNIQUE INDEX subscription_authority_compat_session_uq
  ON opengeni_private.subscription_authority_compat (session_id, workspace_id, provider);
CREATE UNIQUE INDEX subscription_authority_compat_turn_uq
  ON opengeni_private.subscription_authority_compat (turn_id, workspace_id, provider);
CREATE UNIQUE INDEX subscription_authority_compat_task_uq
  ON opengeni_private.subscription_authority_compat (scheduled_task_id, provider)
  WHERE carrier_kind = 'scheduled_task';
CREATE UNIQUE INDEX subscription_authority_compat_revision_uq
  ON opengeni_private.subscription_authority_compat (scheduled_task_id, task_authority_revision, provider);
CREATE UNIQUE INDEX subscription_authority_compat_update_uq
  ON opengeni_private.subscription_authority_compat (system_update_id, workspace_id, provider);
CREATE UNIQUE INDEX subscription_authority_compat_outbox_uq
  ON opengeni_private.subscription_authority_compat (outbox_id, provider);

REVOKE ALL ON TABLE opengeni_private.subscription_authority_compat FROM PUBLIC;
ALTER TABLE opengeni_private.subscription_authority_compat ENABLE ROW LEVEL SECURITY;
ALTER TABLE opengeni_private.subscription_authority_compat FORCE ROW LEVEL SECURITY;
-- Visibility follows the carrier: a record is visible exactly when its carrier
-- row is, under the reader's own row security (workspace, session visibility).
-- Runtime roles hold no privilege, so only owner-run routines evaluate this.
CREATE POLICY subscription_authority_compat_carrier_read
  ON opengeni_private.subscription_authority_compat FOR SELECT
  USING (CASE subscription_authority_compat.carrier_kind
    WHEN 'session_initial' THEN EXISTS (SELECT 1 FROM sessions carrier
      WHERE carrier.workspace_id = subscription_authority_compat.workspace_id
        AND carrier.id = subscription_authority_compat.session_id
        AND carrier.account_id = subscription_authority_compat.account_id)
    WHEN 'session_turn' THEN EXISTS (SELECT 1 FROM session_turns carrier
      WHERE carrier.workspace_id = subscription_authority_compat.workspace_id
        AND carrier.id = subscription_authority_compat.turn_id
        AND carrier.account_id = subscription_authority_compat.account_id)
    WHEN 'scheduled_task' THEN EXISTS (SELECT 1 FROM scheduled_tasks carrier
      WHERE carrier.workspace_id = subscription_authority_compat.workspace_id
        AND carrier.id = subscription_authority_compat.scheduled_task_id
        AND carrier.account_id = subscription_authority_compat.account_id)
    WHEN 'scheduled_task_revision' THEN EXISTS (SELECT 1 FROM scheduled_task_revision_authorities carrier
      WHERE carrier.workspace_id = subscription_authority_compat.workspace_id
        AND carrier.task_id = subscription_authority_compat.scheduled_task_id
        AND carrier.task_authority_revision = subscription_authority_compat.task_authority_revision
        AND carrier.account_id = subscription_authority_compat.account_id)
    WHEN 'session_system_update' THEN EXISTS (SELECT 1 FROM session_system_updates carrier
      WHERE carrier.workspace_id = subscription_authority_compat.workspace_id
        AND carrier.id = subscription_authority_compat.system_update_id
        AND carrier.account_id = subscription_authority_compat.account_id)
    WHEN 'session_system_update_outbox' THEN EXISTS (SELECT 1 FROM session_system_update_outbox carrier
      WHERE carrier.workspace_id = subscription_authority_compat.workspace_id
        AND carrier.id = subscription_authority_compat.outbox_id
        AND carrier.account_id = subscription_authority_compat.account_id)
    ELSE false
  END);
CREATE POLICY subscription_authority_compat_carrier_insert
  ON opengeni_private.subscription_authority_compat FOR INSERT
  WITH CHECK (CASE subscription_authority_compat.carrier_kind
    WHEN 'session_initial' THEN EXISTS (SELECT 1 FROM sessions carrier
      WHERE carrier.workspace_id = subscription_authority_compat.workspace_id
        AND carrier.id = subscription_authority_compat.session_id
        AND carrier.account_id = subscription_authority_compat.account_id)
    WHEN 'session_turn' THEN EXISTS (SELECT 1 FROM session_turns carrier
      WHERE carrier.workspace_id = subscription_authority_compat.workspace_id
        AND carrier.id = subscription_authority_compat.turn_id
        AND carrier.account_id = subscription_authority_compat.account_id)
    WHEN 'scheduled_task' THEN EXISTS (SELECT 1 FROM scheduled_tasks carrier
      WHERE carrier.workspace_id = subscription_authority_compat.workspace_id
        AND carrier.id = subscription_authority_compat.scheduled_task_id
        AND carrier.account_id = subscription_authority_compat.account_id)
    WHEN 'scheduled_task_revision' THEN EXISTS (SELECT 1 FROM scheduled_task_revision_authorities carrier
      WHERE carrier.workspace_id = subscription_authority_compat.workspace_id
        AND carrier.task_id = subscription_authority_compat.scheduled_task_id
        AND carrier.task_authority_revision = subscription_authority_compat.task_authority_revision
        AND carrier.account_id = subscription_authority_compat.account_id)
    WHEN 'session_system_update' THEN EXISTS (SELECT 1 FROM session_system_updates carrier
      WHERE carrier.workspace_id = subscription_authority_compat.workspace_id
        AND carrier.id = subscription_authority_compat.system_update_id
        AND carrier.account_id = subscription_authority_compat.account_id)
    WHEN 'session_system_update_outbox' THEN EXISTS (SELECT 1 FROM session_system_update_outbox carrier
      WHERE carrier.workspace_id = subscription_authority_compat.workspace_id
        AND carrier.id = subscription_authority_compat.outbox_id
        AND carrier.account_id = subscription_authority_compat.account_id)
    ELSE false
  END);
-- No UPDATE or DELETE policy: under FORCE row security even the owner
-- updates or deletes nothing. The triggers below make that explicit for a
-- role that bypasses row security.

CREATE FUNCTION opengeni_subscription_internal.guard_subscription_authority_compat()
RETURNS trigger
LANGUAGE plpgsql
AS $body$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Records exist only for a provider whose own drained cutover committed
    -- after receipts existed: never for Codex ('-infinity') or a provider
    -- without a receipt.
    IF NOT EXISTS (
      SELECT 1 FROM opengeni_private.subscription_provider_cutover_receipts receipt
      WHERE receipt.provider = NEW.provider AND receipt.committed_at > '-infinity'::timestamptz
    ) THEN
      RAISE EXCEPTION 'subscription authority compatibility records require the provider''s cutover receipt'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    -- Only a referential cascade from the carrier deletes a record: the
    -- cascade's DELETE runs inside the carrier's referential trigger.
    IF pg_catalog.pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'subscription authority compatibility records are deleted only with their carrier'
      USING ERRCODE = '42501';
  END IF;
  RAISE EXCEPTION 'subscription authority compatibility records are immutable' USING ERRCODE = '42501';
END
$body$;
CREATE TRIGGER subscription_authority_compat_guard
  BEFORE INSERT OR UPDATE OR DELETE ON opengeni_private.subscription_authority_compat
  FOR EACH ROW EXECUTE FUNCTION opengeni_subscription_internal.guard_subscription_authority_compat();
CREATE TRIGGER subscription_authority_compat_no_truncate
  BEFORE TRUNCATE ON opengeni_private.subscription_authority_compat
  FOR EACH STATEMENT EXECUTE FUNCTION opengeni_subscription_internal.guard_subscription_authority_compat();

-- 3. Resolvers. Every function below is owner-only and runs inside an
-- owner-run caller (copy routine, deferred trigger, fence, personal helper).
-- "Inserted by this transaction" is the server-owned marker equal to
-- transaction_timestamp(): the source of a derived carrier is resolved as the
-- writer saw it, before the carrier and its siblings were inserted.

-- The human whose authority a turn carries (as accepted-subscription-authority.ts).
CREATE FUNCTION opengeni_subscription_internal.subscription_compat_turn_human(
  p_workspace_id uuid, p_turn_id uuid)
RETURNS text
LANGUAGE sql STABLE
AS $body$
  SELECT coalesce(turn.initiating_human_subject_id,
    CASE WHEN turn.initiator_kind = 'subject' THEN turn.initiator_subject_id END)
  FROM session_turns turn
  WHERE turn.workspace_id = p_workspace_id AND turn.id = p_turn_id
$body$;

-- Whether a v2 value holds a personal entry for the provider.
CREATE FUNCTION opengeni_subscription_internal.subscription_compat_v2_has_entry(
  p_v2 jsonb, p_provider text)
RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $body$
  SELECT coalesce(CASE WHEN jsonb_typeof(p_v2->'personal') = 'array' THEN EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_v2->'personal') entry(value)
      WHERE entry.value->>'provider' = p_provider)
    END, false)
$body$;

-- Path: Agent Message, Agent Steer, agent-submitted prompts. The receiving
-- session's execution-context turn, else its latest accepted turn, else its
-- spawning parent turn, else its session_initial carrier
-- (receiverAuthoritySourceInTransaction). Turns inserted by this transaction
-- are not candidates: the writer resolved its source before inserting.
CREATE FUNCTION opengeni_subscription_internal.subscription_compat_receiver_source(
  p_workspace_id uuid, p_session_id uuid, OUT source_kind text, OUT source_id uuid)
LANGUAGE plpgsql STABLE
AS $body$
DECLARE target sessions%ROWTYPE;
BEGIN
  SELECT * INTO target FROM sessions session_row
  WHERE session_row.workspace_id = p_workspace_id AND session_row.id = p_session_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF target.execution_context_turn_id IS NOT NULL THEN
    SELECT 'session_turn', turn.id INTO source_kind, source_id FROM session_turns turn
    WHERE turn.workspace_id = p_workspace_id AND turn.session_id = p_session_id
      AND turn.id = target.execution_context_turn_id
      AND turn.authority_inserted_at <> pg_catalog.transaction_timestamp();
    IF FOUND THEN RETURN; END IF;
  END IF;
  SELECT 'session_turn', turn.id INTO source_kind, source_id FROM session_turns turn
  WHERE turn.workspace_id = p_workspace_id AND turn.session_id = p_session_id
    AND turn.authority_inserted_at <> pg_catalog.transaction_timestamp()
  ORDER BY turn.created_at DESC, turn.position DESC, turn.id DESC
  LIMIT 1;
  IF FOUND THEN RETURN; END IF;
  IF target.parent_session_id IS NOT NULL AND target.parent_turn_id IS NOT NULL THEN
    SELECT 'session_turn', turn.id INTO source_kind, source_id FROM session_turns turn
    WHERE turn.workspace_id = p_workspace_id AND turn.session_id = target.parent_session_id
      AND turn.id = target.parent_turn_id;
    IF FOUND THEN RETURN; END IF;
  END IF;
  source_kind := 'session_initial';
  source_id := p_session_id;
END
$body$;

-- Path: delivery of internal updates into one turn (index.ts, internal turn
-- acceptance). A pure goal continuation (every delivered update is one) reads
-- the goal's causal turn of the first continuation in delivery order
-- (created_at, then id), as the writer does, when that turn has the
-- delivering turn's human, not the context turn or the update; otherwise it
-- has no source. Delivery into
-- a receiving context reads the context turn, and every causal update
-- delivered with it (not Agent messages or child results, which 0608 checks
-- by human only) must yield the same copy. Any other delivery reads every
-- delivered update. A batch shares a turn only when its sources all yield
-- the same copy.
CREATE FUNCTION opengeni_subscription_internal.subscription_compat_delivery_sources(
  p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_execution_context_turn_id uuid,
  p_initiating_human_subject_id text)
RETURNS TABLE (path text, source_kind text, source_id uuid)
LANGUAGE sql STABLE
AS $body$
  WITH delivered AS (
    SELECT update_row.id, update_row.kind, update_row.lineage, update_row.created_at
    FROM session_system_updates update_row
    WHERE update_row.workspace_id = p_workspace_id AND update_row.session_id = p_session_id
      AND update_row.delivered_turn_id = p_turn_id AND update_row.state = 'delivered'
  ), shape AS (
    SELECT count(*) > 0 AND bool_and(delivered.kind = 'goal_continuation') AS pure_goal
    FROM delivered
  ), first_delivered AS (
    -- The writer takes the first continuation in delivery order.
    SELECT delivered.lineage FROM delivered
    ORDER BY delivered.created_at, delivered.id
    LIMIT 1
  )
  SELECT 'pure_goal_continuation', 'session_turn', causal.id
  FROM first_delivered
  CROSS JOIN shape
  JOIN session_turns causal ON causal.workspace_id = p_workspace_id
    AND causal.session_id = p_session_id
    AND causal.id::text = lower(first_delivered.lineage->>'causalTurnId')
  WHERE shape.pure_goal AND p_initiating_human_subject_id IS NOT NULL
    AND causal.initiating_human_subject_id = p_initiating_human_subject_id
  UNION ALL
  SELECT 'informational_delivery', 'session_turn', p_execution_context_turn_id
  FROM shape
  WHERE NOT shape.pure_goal AND p_execution_context_turn_id IS NOT NULL
  UNION ALL
  SELECT 'causal_delivery', 'session_system_update', delivered.id
  FROM delivered
  CROSS JOIN shape
  WHERE NOT shape.pure_goal
    AND (p_execution_context_turn_id IS NULL
      OR NOT (delivered.kind = 'agent_message' OR delivered.kind LIKE 'child\_%'))
$body$;

-- Path: compaction. The latest started turn the compaction continues
-- (latestStartedSessionTurnRow: the turn of the session's latest
-- `turn.started` event), not counting turns inserted by this transaction (the
-- compaction turn itself).
CREATE FUNCTION opengeni_subscription_internal.subscription_compat_compaction_source(
  p_workspace_id uuid, p_session_id uuid)
RETURNS uuid
LANGUAGE sql STABLE
AS $body$
  SELECT turn.id
  FROM session_events started
  JOIN session_turns turn ON turn.workspace_id = started.workspace_id
    AND turn.session_id = started.session_id AND turn.id = started.turn_id
  WHERE started.workspace_id = p_workspace_id AND started.session_id = p_session_id
    AND started.type = 'turn.started'
    AND turn.authority_inserted_at <> pg_catalog.transaction_timestamp()
  ORDER BY started.sequence DESC
  LIMIT 1
$body$;

-- Path: scheduled firing. The occurrence's task revision; the copy keeps a
-- personal entry only when the revision's authorizer is the task owner
-- (getScheduledTaskSubscriptionAuthority). Without the revision row the task
-- itself is the source and nothing personal is kept.
CREATE FUNCTION opengeni_subscription_internal.subscription_compat_scheduled_source(
  p_workspace_id uuid, p_run_id uuid,
  OUT source_kind text, OUT source_id uuid, OUT source_revision bigint, OUT causal_human text)
LANGUAGE plpgsql STABLE
AS $body$
DECLARE run_task uuid; run_revision bigint; task_owner text; authorizer text;
BEGIN
  SELECT run.task_id, run.task_authority_revision, task.owner_subject_id
  INTO run_task, run_revision, task_owner
  FROM scheduled_task_runs run
  JOIN scheduled_tasks task ON task.id = run.task_id AND task.workspace_id = run.workspace_id
  WHERE run.workspace_id = p_workspace_id AND run.id = p_run_id;
  IF run_task IS NULL THEN RETURN; END IF;
  SELECT revision.subject_id INTO authorizer
  FROM scheduled_task_revision_authorities revision
  WHERE revision.workspace_id = p_workspace_id AND revision.task_id = run_task
    AND revision.task_authority_revision = run_revision;
  IF FOUND THEN
    source_kind := 'scheduled_task_revision';
    source_id := run_task;
    source_revision := run_revision;
    causal_human := CASE WHEN authorizer = task_owner THEN authorizer END;
  ELSE
    source_kind := 'scheduled_task';
    source_id := run_task;
  END IF;
END
$body$;

-- The source of each carrier, by path. No row: the carrier is a new
-- acceptance (human, service or API work, archive imports) and carries no
-- record. Several rows: every source must yield the same copy.
CREATE FUNCTION opengeni_subscription_internal.subscription_compat_carrier_sources(
  p_carrier_kind text, p_workspace_id uuid, p_carrier_id uuid, p_task_authority_revision bigint)
RETURNS TABLE (path text, source_kind text, source_id uuid, source_revision bigint, causal_human text)
LANGUAGE plpgsql STABLE
AS $body$
DECLARE
  turn_row session_turns%ROWTYPE;
  session_row sessions%ROWTYPE;
  task_row scheduled_tasks%ROWTYPE;
  revision_row scheduled_task_revision_authorities%ROWTYPE;
  update_row session_system_updates%ROWTYPE;
  outbox_row session_system_update_outbox%ROWTYPE;
  human text;
  scheduled record;
  receiver record;
  hop jsonb;
  outbox_id uuid;
  parent_turn uuid;
  run_id text;
BEGIN
  IF p_carrier_kind = 'session_turn' THEN
    SELECT * INTO turn_row FROM session_turns turn
    WHERE turn.workspace_id = p_workspace_id AND turn.id = p_carrier_id;
    IF NOT FOUND THEN RETURN; END IF;
    SELECT * INTO session_row FROM sessions session_ref
    WHERE session_ref.workspace_id = p_workspace_id AND session_ref.id = turn_row.session_id;
    IF session_row.imported_archive_import_id IS NOT NULL THEN RETURN; END IF;
    human := coalesce(turn_row.initiating_human_subject_id,
      CASE WHEN turn_row.initiator_kind = 'subject' THEN turn_row.initiator_subject_id END);
    IF turn_row.scheduled_task_run_id IS NOT NULL THEN
      SELECT * INTO scheduled FROM opengeni_subscription_internal.subscription_compat_scheduled_source(
        p_workspace_id, turn_row.scheduled_task_run_id);
      IF scheduled.source_kind IS NOT NULL THEN
        RETURN QUERY SELECT 'scheduled_firing'::text, scheduled.source_kind, scheduled.source_id,
          scheduled.source_revision, scheduled.causal_human;
      END IF;
      RETURN;
    END IF;
    IF turn_row.source IN ('system', 'goal') THEN
      RETURN QUERY SELECT delivery.path, delivery.source_kind, delivery.source_id, NULL::bigint, human
      FROM opengeni_subscription_internal.subscription_compat_delivery_sources(
        p_workspace_id, turn_row.session_id, turn_row.id, turn_row.execution_context_turn_id,
        turn_row.initiating_human_subject_id) delivery;
      RETURN;
    END IF;
    IF turn_row.source = 'compaction' THEN
      parent_turn := opengeni_subscription_internal.subscription_compat_compaction_source(
        p_workspace_id, turn_row.session_id);
      IF parent_turn IS NOT NULL THEN
        RETURN QUERY SELECT 'compaction'::text, 'session_turn'::text, parent_turn, NULL::bigint, human;
      END IF;
      RETURN;
    END IF;
    IF turn_row.source IN ('user', 'api') THEN
      -- An edit resubmits the exact prompt its subject withdrew and copies
      -- that turn's accepted authority and human verbatim
      -- (session-queue-commands.ts), so the withdrawn turn is its source and
      -- its human the causal one. A link to anything else is refused.
      IF turn_row.lineage ? 'editedFromTurnId' THEN
        SELECT edited.id INTO parent_turn FROM session_turns edited
        WHERE edited.workspace_id = p_workspace_id AND edited.account_id = turn_row.account_id
          AND edited.session_id = turn_row.session_id AND edited.id <> turn_row.id
          AND edited.id::text = lower(turn_row.lineage->>'editedFromTurnId')
          AND edited.source IN ('user', 'api')
          AND edited.status = 'withdrawn_for_edit' AND edited.cancel_reason = 'withdrawn_for_edit'
          AND coalesce(edited.initiating_human_subject_id,
            CASE WHEN edited.initiator_kind = 'subject' THEN edited.initiator_subject_id END)
            IS NOT DISTINCT FROM turn_row.initiating_human_subject_id;
        IF parent_turn IS NULL THEN
          RAISE EXCEPTION 'an edited prompt copies only the exact turn withdrawn for its edit'
            USING ERRCODE = '23514';
        END IF;
        RETURN QUERY SELECT 'edited_prompt'::text, 'session_turn'::text, parent_turn, NULL::bigint,
          turn_row.initiating_human_subject_id;
        RETURN;
      END IF;
      IF turn_row.lineage->>'actor' = 'agent_attempt' THEN
        SELECT * INTO receiver FROM opengeni_subscription_internal.subscription_compat_receiver_source(
          p_workspace_id, turn_row.session_id);
        IF receiver.source_kind IS NOT NULL THEN
          RETURN QUERY SELECT 'agent_prompt'::text, receiver.source_kind, receiver.source_id,
            NULL::bigint, human;
        END IF;
        RETURN;
      END IF;
      -- A child's or a scheduled session's first turn copies its creation
      -- source (the spawning parent turn, or the occurrence's revision).
      -- Every other prompt is a new acceptance.
      IF EXISTS (
        SELECT 1 FROM session_turns earlier
        WHERE earlier.workspace_id = p_workspace_id AND earlier.session_id = turn_row.session_id
          AND earlier.id <> turn_row.id
          AND (earlier.created_at, earlier.position, earlier.id)
            < (turn_row.created_at, turn_row.position, turn_row.id)
      ) THEN RETURN; END IF;
      IF session_row.parent_session_id IS NOT NULL AND session_row.parent_turn_id IS NOT NULL THEN
        RETURN QUERY SELECT 'child_initial_turn'::text, 'session_turn'::text,
          session_row.parent_turn_id, NULL::bigint, human;
        RETURN;
      END IF;
      run_id := session_row.created_by_context->>'scheduledTaskRunId';
      IF session_row.created_by_kind = 'service' AND session_row.created_by_subject_id = 'scheduler'
        AND coalesce(run_id, '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN
        SELECT * INTO scheduled FROM opengeni_subscription_internal.subscription_compat_scheduled_source(
          p_workspace_id, run_id::uuid);
        IF scheduled.source_kind IS NOT NULL THEN
          RETURN QUERY SELECT 'scheduled_initial_turn'::text, scheduled.source_kind,
            scheduled.source_id, scheduled.source_revision, scheduled.causal_human;
        END IF;
      END IF;
      RETURN;
    END IF;
    RETURN;
  END IF;

  IF p_carrier_kind = 'session_initial' THEN
    SELECT * INTO session_row FROM sessions session_ref
    WHERE session_ref.workspace_id = p_workspace_id AND session_ref.id = p_carrier_id;
    IF NOT FOUND OR session_row.imported_archive_import_id IS NOT NULL THEN RETURN; END IF;
    IF session_row.parent_session_id IS NOT NULL AND session_row.parent_turn_id IS NOT NULL THEN
      RETURN QUERY SELECT 'child_creation'::text, 'session_turn'::text, session_row.parent_turn_id,
        NULL::bigint,
        opengeni_subscription_internal.subscription_compat_turn_human(
          p_workspace_id, session_row.parent_turn_id);
      RETURN;
    END IF;
    run_id := session_row.created_by_context->>'scheduledTaskRunId';
    IF session_row.created_by_kind = 'service' AND session_row.created_by_subject_id = 'scheduler'
      AND coalesce(run_id, '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN
      SELECT * INTO scheduled FROM opengeni_subscription_internal.subscription_compat_scheduled_source(
        p_workspace_id, run_id::uuid);
      IF scheduled.source_kind IS NOT NULL THEN
        RETURN QUERY SELECT 'scheduled_session'::text, scheduled.source_kind, scheduled.source_id,
          scheduled.source_revision, scheduled.causal_human;
      END IF;
    END IF;
    RETURN;
  END IF;

  IF p_carrier_kind = 'scheduled_task' THEN
    SELECT * INTO task_row FROM scheduled_tasks task
    WHERE task.workspace_id = p_workspace_id AND task.id = p_carrier_id;
    IF NOT FOUND THEN RETURN; END IF;
    -- An agent-created task copies its creating turn (the last agent hop of
    -- its frozen creator context); personal authority only for an owner
    -- destination, as the task writer's eligibility check.
    hop := CASE WHEN jsonb_typeof(task_row.created_by_context->'via') = 'array'
      THEN task_row.created_by_context->'via'->-1 END;
    IF hop IS NULL OR hop->>'kind' IS DISTINCT FROM 'agent'
      OR coalesce(hop->>'turnId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR coalesce(hop->>'sessionId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR NOT EXISTS (SELECT 1 FROM session_turns creator
        WHERE creator.workspace_id = p_workspace_id
          AND creator.session_id = (hop->>'sessionId')::uuid AND creator.id = (hop->>'turnId')::uuid)
    THEN RETURN; END IF;
    RETURN QUERY SELECT 'agent_created_task'::text, 'session_turn'::text, (hop->>'turnId')::uuid,
      NULL::bigint,
      CASE WHEN task_row.owner_subject_id IS NOT NULL AND CASE
        WHEN task_row.reusable_session_id IS NULL
          THEN get_workspace_kind(task_row.account_id, task_row.workspace_id) = 'personal'
        ELSE EXISTS (SELECT 1 FROM sessions destination
          WHERE destination.account_id = task_row.account_id
            AND destination.workspace_id = task_row.workspace_id
            AND destination.id = task_row.reusable_session_id
            AND destination.owner_subject_id = task_row.owner_subject_id
            AND (destination.visibility = 'user_private'
              OR get_workspace_kind(task_row.account_id, task_row.workspace_id) = 'personal'))
      END THEN task_row.owner_subject_id END;
    RETURN;
  END IF;

  IF p_carrier_kind = 'scheduled_task_revision' THEN
    SELECT * INTO revision_row FROM scheduled_task_revision_authorities revision
    WHERE revision.workspace_id = p_workspace_id AND revision.task_id = p_carrier_id
      AND revision.task_authority_revision = p_task_authority_revision;
    IF NOT FOUND THEN RETURN; END IF;
    -- Every revision (a new authorization or a clone on rename or pause)
    -- copies the task, keeping personal authority only for the task owner as
    -- authorizer: the rule the revision's v2 derivation already applies.
    RETURN QUERY SELECT 'task_revision'::text, 'scheduled_task'::text, revision_row.task_id,
      NULL::bigint, revision_row.subject_id;
    RETURN;
  END IF;

  IF p_carrier_kind = 'session_system_update' THEN
    SELECT * INTO update_row FROM session_system_updates update_ref
    WHERE update_ref.workspace_id = p_workspace_id AND update_ref.id = p_carrier_id;
    IF NOT FOUND THEN RETURN; END IF;
    IF update_row.scheduled_task_run_id IS NOT NULL THEN
      SELECT * INTO scheduled FROM opengeni_subscription_internal.subscription_compat_scheduled_source(
        p_workspace_id, update_row.scheduled_task_run_id);
      IF scheduled.source_kind IS NOT NULL THEN
        RETURN QUERY SELECT 'scheduled_occurrence'::text, scheduled.source_kind, scheduled.source_id,
          scheduled.source_revision, scheduled.causal_human;
      END IF;
      RETURN;
    END IF;
    IF update_row.kind IN ('agent_message', 'agent_steer_instruction') THEN
      -- The receiving session's source, kept personal only for the sender's
      -- exact causal human; never the sender's own authority.
      SELECT * INTO receiver FROM opengeni_subscription_internal.subscription_compat_receiver_source(
        p_workspace_id, update_row.session_id);
      IF receiver.source_kind IS NULL THEN RETURN; END IF;
      SELECT coalesce(caller.initiating_human_subject_id,
        CASE WHEN caller.initiator_kind = 'subject' THEN caller.initiator_subject_id END)
      INTO human FROM session_turns caller
      WHERE caller.workspace_id = p_workspace_id
        AND caller.id::text = lower(update_row.lineage->>'callerTurnId')
        AND caller.session_id::text = lower(update_row.lineage->>'callerSessionId');
      RETURN QUERY SELECT 'agent_message'::text, receiver.source_kind, receiver.source_id,
        NULL::bigint, human;
      RETURN;
    END IF;
    IF update_row.kind LIKE 'child\_%' THEN
      -- A child result copies its outbox row (parent wake keeps workspace,
      -- target session and dedupe key).
      SELECT outbox.id INTO outbox_id FROM session_system_update_outbox outbox
      WHERE outbox.workspace_id = p_workspace_id AND outbox.dedupe_key = update_row.dedupe_key
        AND outbox.target_session_id = update_row.session_id;
      IF outbox_id IS NOT NULL THEN
        SELECT source_ref.causal_human INTO human
        FROM opengeni_subscription_internal.subscription_compat_carrier_sources(
          'session_system_update_outbox', p_workspace_id, outbox_id, NULL) source_ref
        LIMIT 1;
        RETURN QUERY SELECT 'child_result'::text, 'session_system_update_outbox'::text, outbox_id,
          NULL::bigint, human;
        RETURN;
      END IF;
    END IF;
    -- Background results, wait timeouts, goal continuations and child
    -- results without an outbox row copy their causal turn.
    parent_turn := CASE
      WHEN update_row.kind LIKE 'child\_%'
        AND coalesce(update_row.lineage->>'parentTurnId', '')
          ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN (update_row.lineage->>'parentTurnId')::uuid
      WHEN update_row.kind NOT LIKE 'child\_%'
        AND coalesce(update_row.lineage->>'causalTurnId', '')
          ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN (update_row.lineage->>'causalTurnId')::uuid
    END;
    IF parent_turn IS NULL OR NOT EXISTS (SELECT 1 FROM session_turns causal
      WHERE causal.workspace_id = p_workspace_id AND causal.session_id = update_row.session_id
        AND causal.id = parent_turn)
    THEN RETURN; END IF;
    RETURN QUERY SELECT 'causal_update'::text, 'session_turn'::text, parent_turn, NULL::bigint,
      opengeni_subscription_internal.subscription_compat_turn_human(p_workspace_id, parent_turn);
    RETURN;
  END IF;

  IF p_carrier_kind = 'session_system_update_outbox' THEN
    SELECT * INTO outbox_row FROM session_system_update_outbox outbox
    WHERE outbox.workspace_id = p_workspace_id AND outbox.id = p_carrier_id;
    IF NOT FOUND THEN RETURN; END IF;
    -- A child result's causal turn is the child's exact spawning parent turn.
    SELECT child.parent_turn_id INTO parent_turn FROM sessions child
    WHERE child.workspace_id = p_workspace_id AND child.id = outbox_row.source_session_id
      AND child.parent_session_id = outbox_row.target_session_id;
    IF parent_turn IS NULL AND coalesce(outbox_row.lineage->>'parentTurnId', '')
      ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN
      parent_turn := (outbox_row.lineage->>'parentTurnId')::uuid;
    END IF;
    IF parent_turn IS NULL OR NOT EXISTS (SELECT 1 FROM session_turns causal
      WHERE causal.workspace_id = p_workspace_id AND causal.session_id = outbox_row.target_session_id
        AND causal.id = parent_turn)
    THEN RETURN; END IF;
    RETURN QUERY SELECT 'child_outbox'::text, 'session_turn'::text, parent_turn, NULL::bigint,
      opengeni_subscription_internal.subscription_compat_turn_human(p_workspace_id, parent_turn);
    RETURN;
  END IF;
  RAISE EXCEPTION 'unknown subscription authority carrier kind %', p_carrier_kind
    USING ERRCODE = '22023';
END
$body$;

-- A carrier's v2 value and server-owned marker.
CREATE FUNCTION opengeni_subscription_internal.subscription_compat_carrier_state(
  p_carrier_kind text, p_workspace_id uuid, p_carrier_id uuid, p_task_authority_revision bigint,
  OUT account_id uuid, OUT v2 jsonb, OUT inserted_at timestamptz)
LANGUAGE plpgsql STABLE
AS $body$
BEGIN
  IF p_carrier_kind = 'session_initial' THEN
    SELECT carrier.account_id, NULL::jsonb, carrier.authority_inserted_at INTO account_id, v2, inserted_at
    FROM sessions carrier WHERE carrier.workspace_id = p_workspace_id AND carrier.id = p_carrier_id;
  ELSIF p_carrier_kind = 'session_turn' THEN
    SELECT carrier.account_id, carrier.subscription_authority, carrier.authority_inserted_at
    INTO account_id, v2, inserted_at
    FROM session_turns carrier WHERE carrier.workspace_id = p_workspace_id AND carrier.id = p_carrier_id;
  ELSIF p_carrier_kind = 'scheduled_task' THEN
    SELECT carrier.account_id, carrier.subscription_authority, carrier.authority_inserted_at
    INTO account_id, v2, inserted_at
    FROM scheduled_tasks carrier WHERE carrier.workspace_id = p_workspace_id AND carrier.id = p_carrier_id;
  ELSIF p_carrier_kind = 'scheduled_task_revision' THEN
    SELECT carrier.account_id, carrier.subscription_authority, carrier.authority_inserted_at
    INTO account_id, v2, inserted_at
    FROM scheduled_task_revision_authorities carrier
    WHERE carrier.workspace_id = p_workspace_id AND carrier.task_id = p_carrier_id
      AND carrier.task_authority_revision = p_task_authority_revision;
  ELSIF p_carrier_kind = 'session_system_update' THEN
    SELECT carrier.account_id, carrier.subscription_authority, carrier.authority_inserted_at
    INTO account_id, v2, inserted_at
    FROM session_system_updates carrier WHERE carrier.workspace_id = p_workspace_id AND carrier.id = p_carrier_id;
  ELSIF p_carrier_kind = 'session_system_update_outbox' THEN
    SELECT carrier.account_id, carrier.subscription_authority, carrier.authority_inserted_at
    INTO account_id, v2, inserted_at
    FROM session_system_update_outbox carrier
    WHERE carrier.workspace_id = p_workspace_id AND carrier.id = p_carrier_id;
  ELSE
    RAISE EXCEPTION 'unknown subscription authority carrier kind %', p_carrier_kind
      USING ERRCODE = '22023';
  END IF;
END
$body$;

-- A carrier's record for one provider (index-backed per kind).
CREATE FUNCTION opengeni_subscription_internal.subscription_compat_record(
  p_provider text, p_carrier_kind text, p_workspace_id uuid, p_carrier_id uuid,
  p_task_authority_revision bigint)
RETURNS SETOF opengeni_private.subscription_authority_compat
LANGUAGE plpgsql STABLE
AS $body$
BEGIN
  IF p_carrier_kind = 'session_initial' THEN
    RETURN QUERY SELECT * FROM opengeni_private.subscription_authority_compat record
    WHERE record.session_id = p_carrier_id AND record.workspace_id = p_workspace_id
      AND record.provider = p_provider AND record.carrier_kind = p_carrier_kind;
  ELSIF p_carrier_kind = 'session_turn' THEN
    RETURN QUERY SELECT * FROM opengeni_private.subscription_authority_compat record
    WHERE record.turn_id = p_carrier_id AND record.workspace_id = p_workspace_id
      AND record.provider = p_provider AND record.carrier_kind = p_carrier_kind;
  ELSIF p_carrier_kind = 'scheduled_task' THEN
    RETURN QUERY SELECT * FROM opengeni_private.subscription_authority_compat record
    WHERE record.scheduled_task_id = p_carrier_id AND record.workspace_id = p_workspace_id
      AND record.provider = p_provider AND record.carrier_kind = p_carrier_kind;
  ELSIF p_carrier_kind = 'scheduled_task_revision' THEN
    RETURN QUERY SELECT * FROM opengeni_private.subscription_authority_compat record
    WHERE record.scheduled_task_id = p_carrier_id
      AND record.task_authority_revision = p_task_authority_revision
      AND record.workspace_id = p_workspace_id AND record.provider = p_provider
      AND record.carrier_kind = p_carrier_kind;
  ELSIF p_carrier_kind = 'session_system_update' THEN
    RETURN QUERY SELECT * FROM opengeni_private.subscription_authority_compat record
    WHERE record.system_update_id = p_carrier_id AND record.workspace_id = p_workspace_id
      AND record.provider = p_provider AND record.carrier_kind = p_carrier_kind;
  ELSIF p_carrier_kind = 'session_system_update_outbox' THEN
    RETURN QUERY SELECT * FROM opengeni_private.subscription_authority_compat record
    WHERE record.outbox_id = p_carrier_id AND record.workspace_id = p_workspace_id
      AND record.provider = p_provider AND record.carrier_kind = p_carrier_kind;
  ELSE
    RAISE EXCEPTION 'unknown subscription authority carrier kind %', p_carrier_kind
      USING ERRCODE = '22023';
  END IF;
END
$body$;

-- The copy rule for one source (design 5.3 "Writing", narrowing):
-- * the source holds a v2 entry: no record (the writer copies v2);
-- * the source holds a record: a `missing` or ownerless record is copied
--   verbatim; otherwise verbatim only for its owner, else the personal entry
--   is dropped and a remaining workspace or organization narrowing is
--   written, and a `user` record yields no record;
-- * the source holds neither and predates the receipt: the waiting `missing`
--   copy; otherwise no record.
-- `fires` is false when neither the record nor the receipt time applies.
CREATE FUNCTION opengeni_subscription_internal.subscription_compat_expected(
  p_provider text, p_committed_at timestamptz, p_workspace_id uuid, p_source_kind text,
  p_source_id uuid, p_source_revision bigint, p_causal_human text,
  OUT fires boolean, OUT has_record boolean, OUT personal jsonb, OUT shared_pool text,
  OUT legacy_scope text, OUT owner_subject_id text)
LANGUAGE plpgsql STABLE
AS $body$
DECLARE
  source_state record;
  source_record opengeni_private.subscription_authority_compat%ROWTYPE;
BEGIN
  fires := false;
  has_record := false;
  IF p_source_kind IS NULL OR p_source_id IS NULL THEN RETURN; END IF;
  SELECT * INTO source_state FROM opengeni_subscription_internal.subscription_compat_carrier_state(
    p_source_kind, p_workspace_id, p_source_id, p_source_revision);
  IF source_state.inserted_at IS NULL THEN RETURN; END IF;
  SELECT * INTO source_record FROM opengeni_subscription_internal.subscription_compat_record(
    p_provider, p_source_kind, p_workspace_id, p_source_id, p_source_revision);
  IF FOUND THEN
    fires := true;
    IF source_record.legacy_scope = 'missing' OR source_record.owner_subject_id IS NULL
      OR (p_causal_human IS NOT NULL AND p_causal_human = source_record.owner_subject_id)
    THEN
      has_record := true;
      personal := source_record.personal;
      shared_pool := source_record.shared_pool;
      legacy_scope := source_record.legacy_scope;
      owner_subject_id := source_record.owner_subject_id;
    ELSIF source_record.shared_pool IN ('workspace', 'organization') THEN
      has_record := true;
      personal := '[]'::jsonb;
      shared_pool := source_record.shared_pool;
      legacy_scope := source_record.legacy_scope;
      owner_subject_id := NULL;
    END IF;
    RETURN;
  END IF;
  IF source_state.inserted_at < p_committed_at
    AND NOT opengeni_subscription_internal.subscription_compat_v2_has_entry(source_state.v2, p_provider)
  THEN
    fires := true;
    has_record := true;
    personal := '[]'::jsonb;
    shared_pool := 'none';
    legacy_scope := 'missing';
    owner_subject_id := NULL;
  END IF;
END
$body$;

-- The copy a carrier must hold for one provider, from all of its sources.
-- Raises when sources disagree (a narrowed and an unnarrowed update never
-- share one delivering turn).
CREATE FUNCTION opengeni_subscription_internal.subscription_compat_carrier_expected(
  p_provider text, p_committed_at timestamptz, p_carrier_kind text, p_workspace_id uuid,
  p_carrier_id uuid, p_task_authority_revision bigint,
  OUT fires boolean, OUT has_record boolean, OUT personal jsonb, OUT shared_pool text,
  OUT legacy_scope text, OUT owner_subject_id text)
LANGUAGE plpgsql STABLE
AS $body$
DECLARE source record; copy record; first boolean := true;
BEGIN
  fires := false;
  has_record := false;
  FOR source IN SELECT * FROM opengeni_subscription_internal.subscription_compat_carrier_sources(
    p_carrier_kind, p_workspace_id, p_carrier_id, p_task_authority_revision)
  LOOP
    SELECT * INTO copy FROM opengeni_subscription_internal.subscription_compat_expected(
      p_provider, p_committed_at, p_workspace_id, source.source_kind, source.source_id,
      source.source_revision, source.causal_human);
    IF first THEN
      fires := copy.fires;
      has_record := copy.has_record;
      personal := copy.personal;
      shared_pool := copy.shared_pool;
      legacy_scope := copy.legacy_scope;
      owner_subject_id := copy.owner_subject_id;
      first := false;
    ELSIF copy.has_record IS DISTINCT FROM has_record OR copy.personal IS DISTINCT FROM personal
      OR copy.shared_pool IS DISTINCT FROM shared_pool OR copy.legacy_scope IS DISTINCT FROM legacy_scope
      OR copy.owner_subject_id IS DISTINCT FROM owner_subject_id
    THEN
      RAISE EXCEPTION 'subscription authority sources of one % carrier disagree', p_carrier_kind
        USING ERRCODE = '23514';
    ELSE
      fires := fires OR copy.fires;
    END IF;
  END LOOP;
END
$body$;

-- Resolve with the carrier's own tenancy and every session in it visible, so
-- the copy routine and the commit-time check see the same sources whatever
-- the caller's later settings. Returns the settings to restore.
CREATE FUNCTION opengeni_subscription_internal.subscription_compat_enter_scope(
  p_account_id uuid, p_workspace_id uuid)
RETURNS text[]
LANGUAGE plpgsql
AS $body$
DECLARE prior text[] := ARRAY[
  coalesce(current_setting('opengeni.account_id', true), ''),
  coalesce(current_setting('opengeni.workspace_id', true), ''),
  coalesce(current_setting('opengeni.subject_id', true), '')
];
BEGIN
  PERFORM pg_catalog.set_config('opengeni.account_id', p_account_id::text, true);
  PERFORM pg_catalog.set_config('opengeni.workspace_id', p_workspace_id::text, true);
  PERFORM pg_catalog.set_config('opengeni.subject_id', '', true);
  RETURN prior;
END
$body$;

CREATE FUNCTION opengeni_subscription_internal.subscription_compat_leave_scope(p_prior text[])
RETURNS void
LANGUAGE plpgsql
AS $body$
BEGIN
  PERFORM pg_catalog.set_config('opengeni.account_id', p_prior[1], true);
  PERFORM pg_catalog.set_config('opengeni.workspace_id', p_prior[2], true);
  PERFORM pg_catalog.set_config('opengeni.subject_id', p_prior[3], true);
END
$body$;

-- 4. The commit-time compatibility check, on every carrier table. For each
-- provider whose receipt has a real commit time, when the carrier's source
-- has a record or predates the receipt, the carrier must hold exactly the
-- copy and no v2 entry for that provider. Otherwise it holds no record.
CREATE FUNCTION opengeni_subscription_internal.enforce_subscription_authority_compat()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $body$
DECLARE
  carrier_kind text;
  carrier_id uuid;
  carrier_revision bigint;
  carrier_state record;
  receipt record;
  expected record;
  actual opengeni_private.subscription_authority_compat%ROWTYPE;
  actual_found boolean;
  prior text[];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM opengeni_private.subscription_provider_cutover_receipts receipt_row
    WHERE receipt_row.committed_at > '-infinity'::timestamptz
  ) THEN
    RETURN NULL;
  END IF;
  carrier_kind := CASE TG_TABLE_NAME
    WHEN 'session_turns' THEN 'session_turn'
    WHEN 'sessions' THEN 'session_initial'
    WHEN 'scheduled_tasks' THEN 'scheduled_task'
    WHEN 'scheduled_task_revision_authorities' THEN 'scheduled_task_revision'
    WHEN 'session_system_updates' THEN 'session_system_update'
    WHEN 'session_system_update_outbox' THEN 'session_system_update_outbox'
  END;
  IF carrier_kind = 'scheduled_task_revision' THEN
    carrier_id := NEW.task_id;
    carrier_revision := NEW.task_authority_revision;
  ELSE
    carrier_id := NEW.id;
  END IF;
  prior := opengeni_subscription_internal.subscription_compat_enter_scope(NEW.account_id, NEW.workspace_id);
  SELECT * INTO carrier_state FROM opengeni_subscription_internal.subscription_compat_carrier_state(
    carrier_kind, NEW.workspace_id, carrier_id, carrier_revision);
  -- A carrier deleted later in the same transaction needs no record.
  IF carrier_state.inserted_at IS NOT NULL THEN
    FOR receipt IN
      SELECT receipt_row.provider, receipt_row.committed_at
      FROM opengeni_private.subscription_provider_cutover_receipts receipt_row
      WHERE receipt_row.committed_at > '-infinity'::timestamptz
      ORDER BY receipt_row.provider
    LOOP
      SELECT * INTO expected FROM opengeni_subscription_internal.subscription_compat_carrier_expected(
        receipt.provider, receipt.committed_at, carrier_kind, NEW.workspace_id, carrier_id,
        carrier_revision);
      SELECT * INTO actual FROM opengeni_subscription_internal.subscription_compat_record(
        receipt.provider, carrier_kind, NEW.workspace_id, carrier_id, carrier_revision);
      actual_found := FOUND;
      IF expected.has_record IS DISTINCT FROM actual_found
        OR (actual_found AND (actual.personal IS DISTINCT FROM expected.personal
          OR actual.shared_pool IS DISTINCT FROM expected.shared_pool
          OR actual.legacy_scope IS DISTINCT FROM expected.legacy_scope
          OR actual.owner_subject_id IS DISTINCT FROM expected.owner_subject_id))
        OR (expected.fires AND opengeni_subscription_internal.subscription_compat_v2_has_entry(
          carrier_state.v2, receipt.provider))
      THEN
        RAISE EXCEPTION 'subscription authority compatibility record mismatch for % % (%)',
          carrier_kind, carrier_id, receipt.provider
          USING ERRCODE = '23514';
      END IF;
    END LOOP;
  END IF;
  PERFORM opengeni_subscription_internal.subscription_compat_leave_scope(prior);
  RETURN NULL;
END
$body$;

DO $compat_constraint_triggers$
DECLARE carrier text;
BEGIN
  FOREACH carrier IN ARRAY ARRAY[
    'session_turns', 'sessions', 'scheduled_tasks', 'scheduled_task_revision_authorities',
    'session_system_updates', 'session_system_update_outbox'
  ] LOOP
    EXECUTE format(
      'CREATE CONSTRAINT TRIGGER zzz_subscription_authority_compat_check AFTER INSERT ON %I '
      'DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION '
      'opengeni_subscription_internal.enforce_subscription_authority_compat()',
      carrier);
  END LOOP;
END
$compat_constraint_triggers$;

-- The copy routine. The caller names only the carrier (inserted by its own
-- transaction and visible to it); the content is computed from the carrier's
-- verified source. Returns whether the carrier now holds a record.
CREATE FUNCTION opengeni_private.copy_subscription_authority_compat(
  p_provider text, p_carrier_kind text, p_workspace_id uuid, p_carrier_id uuid,
  p_task_authority_revision bigint)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $body$
DECLARE
  committed timestamptz;
  carrier_state record;
  expected record;
  stored opengeni_private.subscription_authority_compat%ROWTYPE;
  prior text[];
BEGIN
  SELECT receipt.committed_at INTO committed
  FROM opengeni_private.subscription_provider_cutover_receipts receipt
  WHERE receipt.provider = p_provider AND receipt.committed_at > '-infinity'::timestamptz;
  IF committed IS NULL THEN RETURN false; END IF;
  IF p_workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid THEN
    RAISE EXCEPTION 'subscription authority carrier is outside the current workspace'
      USING ERRCODE = '42501';
  END IF;
  -- Visible to the caller under its own row security, and inserted by this
  -- transaction: a record is copied once, when its carrier is accepted.
  SELECT * INTO carrier_state FROM opengeni_subscription_internal.subscription_compat_carrier_state(
    p_carrier_kind, p_workspace_id, p_carrier_id, p_task_authority_revision);
  IF carrier_state.inserted_at IS NULL
    OR carrier_state.account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'subscription authority carrier is not visible' USING ERRCODE = '42501';
  END IF;
  IF carrier_state.inserted_at <> pg_catalog.transaction_timestamp() THEN
    RAISE EXCEPTION 'subscription authority is copied only into a carrier this transaction inserted'
      USING ERRCODE = '55000';
  END IF;
  prior := opengeni_subscription_internal.subscription_compat_enter_scope(
    carrier_state.account_id, p_workspace_id);
  SELECT * INTO expected FROM opengeni_subscription_internal.subscription_compat_carrier_expected(
    p_provider, committed, p_carrier_kind, p_workspace_id, p_carrier_id, p_task_authority_revision);
  IF expected.has_record THEN
    INSERT INTO opengeni_private.subscription_authority_compat (
      account_id, workspace_id, provider, carrier_kind, session_id, turn_id, scheduled_task_id,
      task_authority_revision, system_update_id, outbox_id, personal, shared_pool, legacy_scope,
      owner_subject_id
    ) VALUES (
      carrier_state.account_id, p_workspace_id, p_provider, p_carrier_kind,
      CASE WHEN p_carrier_kind = 'session_initial' THEN p_carrier_id END,
      CASE WHEN p_carrier_kind = 'session_turn' THEN p_carrier_id END,
      CASE WHEN p_carrier_kind IN ('scheduled_task', 'scheduled_task_revision') THEN p_carrier_id END,
      CASE WHEN p_carrier_kind = 'scheduled_task_revision' THEN p_task_authority_revision END,
      CASE WHEN p_carrier_kind = 'session_system_update' THEN p_carrier_id END,
      CASE WHEN p_carrier_kind = 'session_system_update_outbox' THEN p_carrier_id END,
      expected.personal, expected.shared_pool, expected.legacy_scope, expected.owner_subject_id
    ) ON CONFLICT DO NOTHING;
    SELECT * INTO stored FROM opengeni_subscription_internal.subscription_compat_record(
      p_provider, p_carrier_kind, p_workspace_id, p_carrier_id, p_task_authority_revision);
    IF stored.personal IS DISTINCT FROM expected.personal
      OR stored.shared_pool IS DISTINCT FROM expected.shared_pool
      OR stored.legacy_scope IS DISTINCT FROM expected.legacy_scope
      OR stored.owner_subject_id IS DISTINCT FROM expected.owner_subject_id
    THEN
      RAISE EXCEPTION 'subscription authority compatibility record mismatch for % % (%)',
        p_carrier_kind, p_carrier_id, p_provider USING ERRCODE = '23514';
    END IF;
  END IF;
  PERFORM opengeni_subscription_internal.subscription_compat_leave_scope(prior);
  RETURN expected.has_record;
END
$body$;

-- A provider's effective accepted authority on one carrier: `v1` before the
-- provider's receipt (v1 stays authoritative), `v2` when the carrier holds the
-- provider's v2 entry, `record` with its content, `missing` for a carrier
-- created before the receipt that holds neither (no personal authority,
-- shared_pool none: the work waits), else `none` (no personal authority and
-- no narrowing). NULL when the carrier does not exist. The reader below and
-- the inbox fence (0716) both answer with it.
CREATE FUNCTION opengeni_subscription_internal.subscription_compat_effective(
  p_provider text, p_carrier_kind text, p_workspace_id uuid, p_carrier_id uuid,
  p_task_authority_revision bigint)
RETURNS jsonb
LANGUAGE plpgsql STABLE
AS $body$
DECLARE
  committed timestamptz;
  carrier_state record;
  stored opengeni_private.subscription_authority_compat%ROWTYPE;
BEGIN
  IF NOT opengeni_private.subscription_provider_cutover_committed(p_provider) THEN
    RETURN jsonb_build_object('authority', 'v1');
  END IF;
  SELECT receipt.committed_at INTO committed
  FROM opengeni_private.subscription_provider_cutover_receipts receipt
  WHERE receipt.provider = p_provider;
  SELECT * INTO carrier_state FROM opengeni_subscription_internal.subscription_compat_carrier_state(
    p_carrier_kind, p_workspace_id, p_carrier_id, p_task_authority_revision);
  IF carrier_state.inserted_at IS NULL THEN RETURN NULL; END IF;
  IF opengeni_subscription_internal.subscription_compat_v2_has_entry(carrier_state.v2, p_provider) THEN
    RETURN jsonb_build_object('authority', 'v2');
  END IF;
  SELECT * INTO stored FROM opengeni_subscription_internal.subscription_compat_record(
    p_provider, p_carrier_kind, p_workspace_id, p_carrier_id, p_task_authority_revision);
  IF FOUND THEN
    RETURN jsonb_build_object('authority', 'record', 'personal', stored.personal,
      'sharedPool', stored.shared_pool, 'legacyScope', stored.legacy_scope);
  END IF;
  IF carrier_state.inserted_at < committed THEN
    RETURN jsonb_build_object('authority', 'missing', 'personal', '[]'::jsonb, 'sharedPool', 'none');
  END IF;
  RETURN jsonb_build_object('authority', 'none');
END
$body$;

-- The reader: the effective accepted authority under the caller's own row
-- security. `v1` before the provider's receipt; NULL when the carrier is not
-- visible to the caller's account.
CREATE FUNCTION opengeni_private.read_subscription_authority_compat(
  p_provider text, p_carrier_kind text, p_workspace_id uuid, p_carrier_id uuid,
  p_task_authority_revision bigint)
RETURNS jsonb
LANGUAGE plpgsql STABLE
SECURITY DEFINER
AS $body$
DECLARE carrier_state record;
BEGIN
  IF NOT opengeni_private.subscription_provider_cutover_committed(p_provider) THEN
    RETURN jsonb_build_object('authority', 'v1');
  END IF;
  SELECT * INTO carrier_state FROM opengeni_subscription_internal.subscription_compat_carrier_state(
    p_carrier_kind, p_workspace_id, p_carrier_id, p_task_authority_revision);
  IF carrier_state.inserted_at IS NULL
    OR carrier_state.account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
  THEN
    RETURN NULL;
  END IF;
  RETURN opengeni_subscription_internal.subscription_compat_effective(
    p_provider, p_carrier_kind, p_workspace_id, p_carrier_id, p_task_authority_revision);
END
$body$;

-- Providers whose own drained cutover committed after receipts existed (the
-- providers that can hold records). Empty while only Codex is cut over.
CREATE FUNCTION opengeni_private.subscription_authority_compat_providers()
RETURNS text[]
LANGUAGE sql STABLE
SECURITY DEFINER
AS $body$
  SELECT coalesce(array_agg(receipt.provider ORDER BY receipt.provider), ARRAY[]::text[])
  FROM opengeni_private.subscription_provider_cutover_receipts receipt
  WHERE receipt.committed_at > '-infinity'::timestamptz
$body$;

-- 5. The record branch of both personal-authority helpers. After the
-- provider's receipt and with an enabled cutover row (0712), a turn without a
-- v2 entry for the provider reads its compatibility record: the exact owner
-- membership, the connection's current generation, the connection among the
-- record's exact connections, and personalConnectionsAllowed. The placement
-- helper never mints personal access by membership and generation alone for
-- a record. Without records (Codex, providers without a receipt) both helpers
-- decide exactly as before. Each anchor must occur exactly once in the live
-- definition.
DO $personal_access_record$
DECLARE definition text; anchor text; replacement text; patch text[];
BEGIN
  definition := pg_get_functiondef(
    'opengeni_private.authorize_subscription_personal_access(uuid,uuid,uuid,uuid,uuid,text,text,text)'::regprocedure);
  FOREACH patch SLICE 1 IN ARRAY ARRAY[
    ARRAY[$old$      provider_core boolean := false;
$old$, $new$      provider_core boolean := false;
      record_entry jsonb;
$new$],
    ARRAY[$old$      IF NOT provider_core THEN
        authorized := false;
      ELSE
$old$, $new$      IF NOT provider_core THEN
        authorized := false;
      ELSIF NOT opengeni_subscription_internal.subscription_compat_v2_has_entry(
        v2_snapshot, p_provider)
      THEN
        -- No v2 entry for the provider: the turn's compatibility record, for
        -- the exact owner membership and current generation, and only for
        -- the exact connections it lists.
        SELECT record.personal->0 INTO record_entry
        FROM opengeni_private.subscription_authority_compat record
        WHERE record.account_id = p_account_id AND record.workspace_id = p_workspace_id
          AND record.turn_id = p_turn_id AND record.carrier_kind = 'session_turn'
          AND record.provider = p_provider
          AND record.owner_subject_id = p_session_owner_subject_id;
        authorized := coalesce(owner_membership IS NOT NULL
          AND record_entry IS NOT NULL
          AND record_entry->>'ownerMembershipId' = owner_membership::text
          AND record_entry->>'authorityGeneration' = connection_generation::text
          AND record_entry->'connectionIds' ? p_connection_id::text
          AND coalesce((subscription_effective_settings(p_account_id, p_workspace_id)
            #>> '{values,personalConnectionsAllowed}')::boolean, false), false);
      ELSE
$new$]
  ] LOOP
    anchor := patch[1];
    replacement := patch[2];
    IF (length(definition) - length(replace(definition, anchor, ''))) <> length(anchor) THEN
      RAISE EXCEPTION 'subscription personal access source changed';
    END IF;
    definition := replace(definition, anchor, replacement);
  END LOOP;
  EXECUTE definition;
END
$personal_access_record$;

DO $personal_placement_record$
DECLARE definition text; anchor text; replacement text; patch text[];
BEGIN
  definition := pg_get_functiondef(
    'opengeni_private.authorize_subscription_personal_placement_access(uuid,uuid,uuid,uuid,text,uuid,bigint,text,text)'::regprocedure);
  FOREACH patch SLICE 1 IN ARRAY ARRAY[
    ARRAY[$old$      minted_connections uuid[] := '{}'::uuid[];
$old$, $new$      minted_connections uuid[] := '{}'::uuid[];
      record_connections uuid[];
      turn_found boolean;
$new$],
    ARRAY[$old$      SELECT turn.subscription_authority INTO authority_snapshot
$old$, $new$      SELECT turn.subscription_authority, true INTO authority_snapshot, turn_found
$new$],
    ARRAY[$old$      IF authority_snapshot IS NOT NULL
        AND authority_snapshot->>'version' = '2'
$old$, $new$      IF turn_found IS TRUE
        AND NOT opengeni_subscription_internal.subscription_compat_v2_has_entry(
          authority_snapshot, p_provider)
      THEN
        -- No v2 entry for the provider: the turn's compatibility record. Its
        -- exact connections bound everything minted below; membership and
        -- generation alone never grant a record's personal access.
        SELECT coalesce(array_agg(connection_id.value::uuid), '{}'::uuid[])
        INTO record_connections
        FROM opengeni_private.subscription_authority_compat record
        CROSS JOIN LATERAL jsonb_array_elements_text(record.personal->0->'connectionIds')
          connection_id(value)
        WHERE record.account_id = p_account_id AND record.workspace_id = p_workspace_id
          AND record.turn_id = p_turn_id AND record.carrier_kind = 'session_turn'
          AND record.provider = p_provider
          AND record.owner_subject_id = p_session_owner_subject_id
          AND record.personal->0->>'ownerMembershipId' = p_owner_membership_id::text
          AND record.personal->0->>'authorityGeneration' = p_authority_generation::text;
        allowed := cardinality(record_connections) > 0;
      ELSIF authority_snapshot IS NOT NULL
        AND authority_snapshot->>'version' = '2'
$new$],
    ARRAY[$old$          AND authority.status = 'active' AND authority.revoked_at IS NULL
        ON CONFLICT (backend_pid, transaction_id, capability_kind, account_id, connection_id)
$old$, $new$          AND authority.status = 'active' AND authority.revoked_at IS NULL
          AND (record_connections IS NULL OR authority.resource_id = ANY (record_connections))
        ON CONFLICT (backend_pid, transaction_id, capability_kind, account_id, connection_id)
$new$],
    ARRAY[$old$          AND connection.authority_generation = p_authority_generation
          AND opengeni_private.subscription_personal_connection_visible(
$old$, $new$          AND connection.authority_generation = p_authority_generation
          AND (record_connections IS NULL OR connection.id = ANY (record_connections))
          AND opengeni_private.subscription_personal_connection_visible(
$new$]
  ] LOOP
    anchor := patch[1];
    replacement := patch[2];
    IF (length(definition) - length(replace(definition, anchor, ''))) <> length(anchor) THEN
      RAISE EXCEPTION 'subscription personal placement access source changed';
    END IF;
    definition := replace(definition, anchor, replacement);
  END LOOP;
  EXECUTE definition;
END
$personal_placement_record$;

-- Search paths: the data schema of this deployment, opengeni_private, and
-- pg_temp last. Owner-only routines lose PUBLIC execute; the three runtime
-- routines are granted to every configured application role (not only the
-- default name), so the previous release's readiness, which rejects an
-- opengeni_private routine the runtime role cannot execute and does not
-- list, passes before provision-roles runs (0706's and 0712's pattern).
DO $compat_search_paths$
DECLARE data_schema text := current_schema(); routine regprocedure; application_role text;
BEGIN
  FOREACH routine IN ARRAY ARRAY[
    'opengeni_subscription_internal.stamp_subscription_authority_inserted_at()',
    'opengeni_subscription_internal.keep_subscription_authority_inserted_at()',
    'opengeni_subscription_internal.subscription_authority_compat_entry_valid(jsonb)',
    'opengeni_subscription_internal.guard_subscription_authority_compat()',
    'opengeni_subscription_internal.subscription_compat_turn_human(uuid,uuid)',
    'opengeni_subscription_internal.subscription_compat_v2_has_entry(jsonb,text)',
    'opengeni_subscription_internal.subscription_compat_receiver_source(uuid,uuid)',
    'opengeni_subscription_internal.subscription_compat_delivery_sources(uuid,uuid,uuid,uuid,text)',
    'opengeni_subscription_internal.subscription_compat_compaction_source(uuid,uuid)',
    'opengeni_subscription_internal.subscription_compat_scheduled_source(uuid,uuid)',
    'opengeni_subscription_internal.subscription_compat_carrier_sources(text,uuid,uuid,bigint)',
    'opengeni_subscription_internal.subscription_compat_carrier_state(text,uuid,uuid,bigint)',
    'opengeni_subscription_internal.subscription_compat_record(text,text,uuid,uuid,bigint)',
    'opengeni_subscription_internal.subscription_compat_expected(text,timestamptz,uuid,text,uuid,bigint,text)',
    'opengeni_subscription_internal.subscription_compat_carrier_expected(text,timestamptz,text,uuid,uuid,bigint)',
    'opengeni_subscription_internal.subscription_compat_enter_scope(uuid,uuid)',
    'opengeni_subscription_internal.subscription_compat_leave_scope(text[])',
    'opengeni_subscription_internal.subscription_compat_effective(text,text,uuid,uuid,bigint)',
    'opengeni_subscription_internal.enforce_subscription_authority_compat()',
    'opengeni_private.copy_subscription_authority_compat(text,text,uuid,uuid,bigint)',
    'opengeni_private.read_subscription_authority_compat(text,text,uuid,uuid,bigint)',
    'opengeni_private.subscription_authority_compat_providers()'
  ]::regprocedure[] LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, %I, opengeni_private, pg_temp',
      routine, data_schema);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', routine);
  END LOOP;
  FOR application_role IN
    SELECT role_value.rolname
    FROM pg_catalog.jsonb_array_elements_text(
      coalesce(nullif(current_setting('opengeni.migration_application_roles', true), ''), '[]')::jsonb
    ) configured(value)
    JOIN pg_catalog.pg_roles role_value ON role_value.rolname = configured.value
    UNION SELECT 'opengeni_app'
      WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'opengeni_app')
  LOOP
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION '
      'opengeni_private.copy_subscription_authority_compat(text,text,uuid,uuid,bigint), '
      'opengeni_private.read_subscription_authority_compat(text,text,uuid,uuid,bigint), '
      'opengeni_private.subscription_authority_compat_providers() TO %I',
      application_role
    );
  END LOOP;
END
$compat_search_paths$;
