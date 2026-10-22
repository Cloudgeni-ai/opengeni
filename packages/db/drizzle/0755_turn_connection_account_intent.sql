-- deployment-mode: rolling
-- Autonomous turns resolve the person's connector accounts again instead of
-- copying an earlier turn's accounts.
--
-- A goal continuation, wait wake-up, command result or child result used to
-- copy the exact connector accounts of the turn it continues, which copied
-- them from the turn before it, and so on back to the person's message. A
-- long chain kept the accounts of that first message for days: a reconnected
-- or newly connected account never appeared, and a revoked one stayed bound
-- until it failed at use.
--
-- Each turn now records its account intent: whose personal accounts it may
-- use and which accounts a person explicitly picked. A turn that continues it
-- carries the same intent and resolves it again for the same person, exactly
-- as a new message from that person with the same picks would. The resolved
-- accounts are still frozen on the turn and admitted by the existing fences:
-- shared workspace accounts are checked live, and personal accounts must
-- belong to the turn's initiating person and are captured afresh.
--
-- Fence changes, all limited to a turn that carries its context's intent:
-- * fence_inbox_execution_context: a turn delivered into a receiving context
--   may hold freshly resolved accounts when it carries exactly the context's
--   intent. Every other check is unchanged, and delivered inputs are still
--   compared with the context's own accounts.
-- * fence_mcp_account_bindings: such a turn's workspace accounts are checked
--   live instead of being trusted as a copy of the context.
-- * capture_accepted_turn_connection_authorities: such a turn's personal
--   accounts are captured afresh for its initiating person instead of copying
--   the context's receipts.
--
-- Rolling: previous releases never write an intent, always copy the context's
-- accounts, and so see exactly the previous fence behaviour. Turns accepted
-- before this release have no intent, and their continuations keep copying
-- the exact accounts.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE FUNCTION opengeni_private.connection_account_intent_is_valid(intent jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $body$
  SELECT intent IS NULL OR (
    jsonb_typeof(intent) = 'object'
    AND intent - ARRAY['version','principal','selections'] = '{}'::jsonb
    AND intent -> 'version' = '1'::jsonb
    AND jsonb_typeof(intent -> 'principal') = 'object'
    AND (
      (intent #>> '{principal,kind}' = 'none' AND intent -> 'principal' = '{"kind":"none"}'::jsonb)
      OR (intent #>> '{principal,kind}' = 'subject'
        AND (intent -> 'principal') - ARRAY['kind','subjectId'] = '{}'::jsonb
        AND jsonb_typeof(intent #> '{principal,subjectId}') = 'string'
        AND length(intent #>> '{principal,subjectId}') BETWEEN 1 AND 512)
    )
    AND jsonb_typeof(intent -> 'selections') = 'array'
    AND jsonb_array_length(intent -> 'selections') <= 128
  )
$body$;

ALTER TABLE sessions ADD COLUMN initial_connection_account_intent jsonb DEFAULT NULL
  CONSTRAINT sessions_initial_connection_account_intent_shape
  CHECK (opengeni_private.connection_account_intent_is_valid(initial_connection_account_intent));
ALTER TABLE session_turns ADD COLUMN connection_account_intent jsonb DEFAULT NULL
  CONSTRAINT session_turns_connection_account_intent_shape
  CHECK (opengeni_private.connection_account_intent_is_valid(connection_account_intent));
ALTER TABLE session_realtime_modes ADD COLUMN connection_account_intent jsonb DEFAULT NULL
  CONSTRAINT session_realtime_modes_connection_account_intent_shape
  CHECK (opengeni_private.connection_account_intent_is_valid(connection_account_intent));

-- A turn's intent is part of its accepted authority.
CREATE FUNCTION opengeni_private.prevent_connection_account_intent_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $body$
BEGIN
  IF NEW.connection_account_intent IS DISTINCT FROM OLD.connection_account_intent THEN
    RAISE EXCEPTION 'accepted connection account intent is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $body$;
CREATE TRIGGER session_turns_connection_account_intent_immutable
BEFORE UPDATE OF connection_account_intent ON session_turns
FOR EACH ROW EXECUTE FUNCTION opengeni_private.prevent_connection_account_intent_mutation();

-- Each function is patched in place by earlier migrations, so this edits the
-- live definition and fails if an anchor drifted.
DO $fresh_accounts$
DECLARE
  target regprocedure;
  definition text;
  anchor text;
  replacement text;
  count_of integer;
BEGIN
  -- 1. Receiving-context fence.
  target := pg_catalog.to_regprocedure('opengeni_private.fence_inbox_execution_context()');
  IF target IS NULL THEN
    RAISE EXCEPTION '0755 receiving-context fence is missing' USING ERRCODE = '55000';
  END IF;
  definition := pg_catalog.pg_get_functiondef(target);
  anchor :=
    E'    OR NEW.personal_connection_delegations IS DISTINCT FROM context.personal_connection_delegations\n'
    || E'    OR NEW.mcp_account_bindings IS DISTINCT FROM context.mcp_account_bindings\n';
  replacement :=
    E'    OR (NEW.connection_account_intent IS NOT NULL\n'
    || E'      AND NEW.connection_account_intent IS DISTINCT FROM context.connection_account_intent)\n'
    || E'    OR ((NEW.personal_connection_delegations IS DISTINCT FROM context.personal_connection_delegations\n'
    || E'      OR NEW.mcp_account_bindings IS DISTINCT FROM context.mcp_account_bindings)\n'
    || E'      -- 0755: carrying the context''s intent, the turn resolved it afresh.\n'
    || E'      AND NEW.connection_account_intent IS NULL)\n';
  count_of := (pg_catalog.length(definition) - pg_catalog.length(pg_catalog.replace(definition, anchor, '')))
    / pg_catalog.length(anchor);
  IF count_of <> 1 THEN
    RAISE EXCEPTION '0755 receiving-context fence drift (context accounts)' USING ERRCODE = '55000';
  END IF;
  definition := pg_catalog.replace(definition, anchor, replacement);
  anchor :=
    E'      IF u.mcp_account_bindings IS DISTINCT FROM NEW.mcp_account_bindings\n'
    || E'        OR u.personal_connection_delegations IS DISTINCT FROM NEW.personal_connection_delegations\n';
  replacement :=
    E'      IF u.mcp_account_bindings IS DISTINCT FROM context.mcp_account_bindings\n'
    || E'        OR u.personal_connection_delegations IS DISTINCT FROM context.personal_connection_delegations\n';
  count_of := (pg_catalog.length(definition) - pg_catalog.length(pg_catalog.replace(definition, anchor, '')))
    / pg_catalog.length(anchor);
  IF count_of <> 1 THEN
    RAISE EXCEPTION '0755 receiving-context fence drift (delivered accounts)' USING ERRCODE = '55000';
  END IF;
  EXECUTE pg_catalog.replace(definition, anchor, replacement);

  -- 2. Account binding fence: only an exact copy of the context is trusted.
  target := pg_catalog.to_regprocedure('opengeni_private.fence_mcp_account_bindings()');
  IF target IS NULL THEN
    RAISE EXCEPTION '0755 account binding fence is missing' USING ERRCODE = '55000';
  END IF;
  definition := pg_catalog.pg_get_functiondef(target);
  anchor :=
    E'    IF TG_TABLE_NAME = ''session_turns'' AND document ->> ''execution_context_turn_id'' IS NOT NULL THEN\n'
    || E'      inherited_bindings := true; -- validated by inbox_execution_context_fence\n'
    || E'    END IF;\n';
  replacement :=
    E'    IF TG_TABLE_NAME = ''session_turns'' AND document ->> ''execution_context_turn_id'' IS NOT NULL\n'
    || E'      -- 0755: freshly resolved accounts are admitted live below.\n'
    || E'      AND EXISTS (SELECT 1 FROM public.session_turns context_turn\n'
    || E'        WHERE context_turn.id = (document ->> ''execution_context_turn_id'')::uuid\n'
    || E'          AND context_turn.account_id = NEW.account_id\n'
    || E'          AND context_turn.workspace_id = NEW.workspace_id\n'
    || E'          AND nullif(context_turn.mcp_account_bindings, ''null''::jsonb) IS NOT DISTINCT FROM bindings)\n'
    || E'    THEN\n'
    || E'      inherited_bindings := true; -- validated by inbox_execution_context_fence\n'
    || E'    END IF;\n';
  count_of := (pg_catalog.length(definition) - pg_catalog.length(pg_catalog.replace(definition, anchor, '')))
    / pg_catalog.length(anchor);
  IF count_of <> 1 THEN
    RAISE EXCEPTION '0755 account binding fence drift' USING ERRCODE = '55000';
  END IF;
  EXECUTE pg_catalog.replace(definition, anchor, replacement);

  -- 3. Personal capture: copy the context's receipts only for its exact accounts.
  target := pg_catalog.to_regprocedure('opengeni_private.capture_accepted_turn_connection_authorities()');
  IF target IS NULL THEN
    RAISE EXCEPTION '0755 connection capture function is missing' USING ERRCODE = '55000';
  END IF;
  definition := pg_catalog.pg_get_functiondef(target);
  anchor := E'  IF NEW.execution_context_turn_id IS NOT NULL THEN\n';
  replacement :=
    E'  IF NEW.execution_context_turn_id IS NOT NULL\n'
    || E'    -- 0755: freshly resolved accounts are captured below like any other turn.\n'
    || E'    AND NEW.personal_connection_delegations IS NOT DISTINCT FROM (\n'
    || E'      SELECT context_turn.personal_connection_delegations FROM public.session_turns context_turn\n'
    || E'      WHERE context_turn.id = NEW.execution_context_turn_id\n'
    || E'        AND context_turn.account_id = NEW.account_id\n'
    || E'        AND context_turn.workspace_id = NEW.workspace_id\n'
    || E'        AND context_turn.session_id = NEW.session_id)\n'
    || E'  THEN\n';
  count_of := (pg_catalog.length(definition) - pg_catalog.length(pg_catalog.replace(definition, anchor, '')))
    / pg_catalog.length(anchor);
  IF count_of <> 1 THEN
    RAISE EXCEPTION '0755 connection capture drift' USING ERRCODE = '55000';
  END IF;
  EXECUTE pg_catalog.replace(definition, anchor, replacement);
END
$fresh_accounts$;
