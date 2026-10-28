-- deployment-mode: rolling
-- A workspace instruction policy can be cleared. Saving empty text stores one
-- empty revision ('') and activates it through the ordinary draft and
-- activation path, so a clear keeps the actor, reason, activation version and
-- history every other change has, and an earlier version can be restored
-- with the existing rollback. An active empty revision means no policy:
--   1. a revision is either exactly '' or text that is not blank. Whitespace
--      only is still refused; the API stores blank input as ''. The new check
--      is weaker than the old one, so it is added NOT VALID here and
--      validated in 1086 without a long lock.
--   2. accepted-turn snapshots leave out an active empty revision, so that
--      target composes nothing and runtime behaves as when it has no head.
--   3. the agent instruction tools read an active empty revision as no text:
--      an append saves only the new rule and an exact edit is refused.
-- The previous release never writes an empty revision and its workers never
-- see one: snapshots and the agent instruction routines are resolved here.
-- Only its API cannot render an empty revision written by the new release
-- (its response contract requires non-empty content) until it is replaced.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE workspace_instruction_policy_revisions
  DROP CONSTRAINT workspace_instruction_policy_revisions_content_chk;
ALTER TABLE workspace_instruction_policy_revisions
  ADD CONSTRAINT workspace_instruction_policy_revisions_content_chk
  CHECK ((content = '' OR length(btrim(content)) > 0) AND octet_length(content) <= 1048576) NOT VALID;

DO $workspace_instruction_policy_clear$
DECLARE definition text; anchor text;
BEGIN
  -- 2. Snapshots compose only non-empty active revisions.
  definition := pg_get_functiondef(format(
    '%I.workspace_instruction_policy_canonical_snapshot_entries(uuid,uuid,text,timestamptz)',
    current_schema())::regprocedure);
  anchor := $a$      AND revision.content_hash = event.new_content_hash
  ) candidate;$a$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'workspace_instruction_policy_canonical_snapshot_entries anchor drifted';
  END IF;
  definition := replace(definition, anchor, $r$      AND revision.content_hash = event.new_content_hash
      -- An active empty revision is a cleared policy: it composes nothing.
      AND revision.content <> ''
  ) candidate;$r$);
  EXECUTE definition;

  -- 3. The agent instruction tools read a cleared policy as no text.
  definition := pg_get_functiondef(format(
    '%I.agent_instruction_apply_0462_unsafe(uuid,uuid,jsonb,jsonb)', current_schema())::regprocedure);
  anchor := $a$      'content',revision.content);$a$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'agent_instruction_apply_0462_unsafe read anchor drifted';
  END IF;
  definition := replace(definition, anchor, $r$      'content',nullif(revision.content,''));$r$);
  anchor := $a$ AND r.id=head.revision_id;
    IF edit_mode='append' THEN$a$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'agent_instruction_apply_0462_unsafe save anchor drifted';
  END IF;
  definition := replace(definition, anchor, $r$ AND r.id=head.revision_id;
    -- A cleared policy has no text to append to or edit.
    current_content:=nullif(current_content,'');
    IF edit_mode='append' THEN$r$);
  EXECUTE definition;
END $workspace_instruction_policy_clear$;
