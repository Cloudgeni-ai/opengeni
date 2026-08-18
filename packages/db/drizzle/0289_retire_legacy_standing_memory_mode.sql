-- deployment-mode: rolling
SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- Retire Memory V1's standing prompt block.
--
-- `legacy_standing` was the explicit rollback opt-out after 0271 made
-- retrieval-only the default. It is now gone: the mode can no longer be
-- selected, and nothing is injected into a prompt unbidden. An agent reads a
-- workspace's records through `memory_search` when it needs them.
--
-- Nothing is rewritten. Stored settings are a passthrough bag, so a workspace
-- that opted in keeps its stored value and simply stops acting on it; already
-- accepted turns keep the mode they recorded, because those snapshots are
-- immutable facts about what was composed, not settings.
--
-- This migration deliberately does not assume the opt-out was unused: it
-- reports what it finds. The code path is removed either way - a stored value
-- has had no effect since the application change shipped - but a deployment
-- that was relying on it deserves to see that in its migration output rather
-- than discover the prompt changed.
DO $retire_legacy_standing$
DECLARE
  opted_in bigint;
  composed bigint;
BEGIN
  SELECT count(*) INTO opted_in
  FROM workspaces
  WHERE settings->>'memoryPromptMode' = 'legacy_standing';

  SELECT count(*) INTO composed
  FROM company_brain_turn_context_snapshots
  WHERE memory_prompt_mode = 'legacy_standing'
    AND created_at > now() - interval '90 days';

  IF opted_in > 0 OR composed > 0 THEN
    RAISE WARNING
      'Memory V1 standing block retired: % workspace(s) still store memoryPromptMode=legacy_standing, and % turn(s) composed under it in the last 90 days. Their prompts no longer include the standing block. Stored values and historical snapshots are unchanged.',
      opted_in, composed;
  ELSE
    RAISE NOTICE
      'Memory V1 standing block retired: no workspace stores memoryPromptMode=legacy_standing and no turn composed under it in the last 90 days.';
  END IF;
END
$retire_legacy_standing$;

RESET statement_timeout;
RESET lock_timeout;
