-- deployment-mode: rolling
-- online-safety-exception: unbatched-data: joins the older First message into the Instructions of the agent revisions that still keep one (made before agents had one text, or too long to join then), once; few rows.
-- First-message cleanup (docs/agents.md, "First message"): agents have one
-- text, their Instructions. Every agent_revisions row whose first_message is
-- not empty gets it joined to its Instructions exactly as readers have seen
-- them since the agents contract (agentInstructionsSql in the previous
-- release, agentInstructionsWithFirstMessage in @opengeni/contracts): as its
-- own paragraph led by "When a chat starts:", unless the Instructions already
-- contain it; then first_message is emptied. This release reads only the
-- Instructions.
--
-- Rolling: the previous release shows a revision's Instructions with its
-- First message joined, so it shows the same text before and after. It
-- still keeps a First message apart when joining would pass 20,000
-- characters; such a row written during the rollout keeps its First message
-- in the column, unread here, until the later step that joins and drops it.
-- agent_revisions is FORCE ROW LEVEL SECURITY, so the window is lifted for
-- the backfill and restored before commit
-- (docs/force-rls-migration-backfills.md). A NOTICE reports the count.
SET LOCAL lock_timeout = '5s';

ALTER TABLE agent_revisions NO FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  changed bigint;
BEGIN
  UPDATE agent_revisions r SET
    instructions = CASE
      WHEN btrim(r.first_message, E' \t\n\r\f\v') = '' THEN r.instructions
      WHEN strpos(r.instructions, btrim(r.first_message, E' \t\n\r\f\v')) > 0 THEN r.instructions
      WHEN btrim(r.instructions, E' \t\n\r\f\v') = ''
        THEN 'When a chat starts:' || E'\n' || btrim(r.first_message, E' \t\n\r\f\v')
      ELSE btrim(r.instructions, E' \t\n\r\f\v') || E'\n\n' || 'When a chat starts:' || E'\n'
        || btrim(r.first_message, E' \t\n\r\f\v')
    END,
    first_message = ''
  WHERE r.first_message <> '';
  GET DIAGNOSTICS changed = ROW_COUNT;
  RAISE NOTICE 'agent revisions first message backfill: revisions changed %', changed;
END $$;

ALTER TABLE agent_revisions FORCE ROW LEVEL SECURITY;
