-- deployment-mode: rolling
-- Usage by agent (docs/agents.md, "Cost"; docs/insights.md).
--
-- insights_scoped_usage_rows adds two fields to each visible usage row
-- (kind 'item'):
--
-- * agentId: the agent its chat was started for. Usage belongs to the chat's
--   ROOT session, so a child worker's calls count toward the agent of the
--   chat that started it (child workers never set sessions.agent_id).
-- * agentName: the agent's name, only when the viewer may see that agent: a
--   shared agent, or an Only me agent the viewer (or the person a turn acts
--   for) owns. The agents table's own policies apply on top. Otherwise it is
--   null and readers say "Unavailable agent".
--
-- Hidden rows (private, personal, restricted, deleted) gain nothing: they
-- stay aggregates per kind, person, payer and workspace, so which agent a
-- hidden chat used is never revealed.
--
-- Only the root chats of visible rows are looked up, so other groupings pay
-- little for it.
--
-- The function is patched in place at two exact anchors (as 1030 does), so
-- its signature, owner, grants, SECURITY DEFINER and SET options are
-- unchanged and no new routine needs EXECUTE. sessions.agent_id (1244) and
-- the agents table (1243) exist in every supported release.
--
-- Rolling: the previous release ignores payload keys it doesn't read (its
-- reader projects named keys; the facet de-duplication still collapses rows
-- by the values it reads), so it answers exactly as before. A newer reader
-- against the previous function sees no agentId and shows every chat as
-- "No agent" until this migration runs.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $usage_agents$
DECLARE
  routine regprocedure := 'opengeni_private.insights_scoped_usage_rows(uuid,uuid,timestamptz,timestamptz,text,uuid[],boolean)'::regprocedure;
  definition text := pg_catalog.pg_get_functiondef(routine);
  data_schema text := current_schema();
  field_anchor text := $old$'scheduleName',CASE WHEN f.kind='item' THEN task.name END,$old$;
  field_replacement text := $new$'scheduleName',CASE WHEN f.kind='item' THEN task.name END,
                'agentId',CASE WHEN f.kind='item' THEN agent_root.agent_id END,
                'agentName',CASE WHEN f.kind='item' AND(agent.visibility='workspace'
                  OR agent.owner_subject_id=subject_value OR agent.owner_subject_id=human_value) THEN agent.name END,$new$;
  join_anchor text := $old$task.account_id=a AND task.workspace_id=w.id$old$;
  join_replacement text;
BEGIN
  join_replacement := pg_catalog.format($new$task.account_id=a AND task.workspace_id=w.id
              LEFT JOIN(SELECT sa.id,sa.agent_id FROM %1$I.sessions sa
                WHERE sa.account_id=a AND sa.workspace_id=w.id AND sa.agent_id IS NOT NULL
                  AND sa.id IN(SELECT c.root_session_id FROM classified c WHERE c.kind='item')) agent_root
                ON f.kind='item' AND agent_root.id=f.root_session_id
              LEFT JOIN %1$I.agents agent ON agent.id=agent_root.agent_id AND agent.account_id=a$new$, data_schema);
  IF (pg_catalog.length(definition) - pg_catalog.length(pg_catalog.replace(definition, field_anchor, '')))
    <> pg_catalog.length(field_anchor) THEN
    RAISE EXCEPTION 'insights usage agents: % changed near: %', routine, field_anchor;
  END IF;
  IF (pg_catalog.length(definition) - pg_catalog.length(pg_catalog.replace(definition, join_anchor, '')))
    <> pg_catalog.length(join_anchor) THEN
    RAISE EXCEPTION 'insights usage agents: % changed near: %', routine, join_anchor;
  END IF;
  EXECUTE pg_catalog.replace(pg_catalog.replace(definition, field_anchor, field_replacement),
    join_anchor, join_replacement);
END
$usage_agents$;
