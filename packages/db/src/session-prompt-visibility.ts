import { sql, type SQL } from "drizzle-orm";
import * as schema from "./schema";

/** Agent conversation readers hide accepted prompts until they enter history.
 * Normally started_at proves consumption. A coalesced Steer has no attempt,
 * so its retained server-written supersession receipt supplies that proof.
 * Both compaction and content archival preserve the receipt. Do not trust caller
 * metadata or terminal status alone: withdrawn/rejected prompts stay hidden.
 * Keep the literal workspace bound and started_at predicate so the existing
 * session_turns_unclaimed_prompt_trigger_idx remains usable. The receipt lookup
 * uses session_events_workspace_turn_type_idx and is scoped to this session.
 */
export function excludeUnclaimedHumanPromptEventFilter(workspaceId: string): SQL {
  return sql`(
    ${schema.sessionEvents.type} <> 'user.message'
    or not exists (
      select 1 from ${schema.sessionTurns} unclaimed_prompt_turn
      where unclaimed_prompt_turn.workspace_id = ${workspaceId}
        and unclaimed_prompt_turn.workspace_id = ${schema.sessionEvents.workspaceId}
        and unclaimed_prompt_turn.session_id = ${schema.sessionEvents.sessionId}
        and unclaimed_prompt_turn.trigger_event_id = ${schema.sessionEvents.id}
        and unclaimed_prompt_turn.source in ('user', 'api')
        and unclaimed_prompt_turn.started_at is null
        and not (
          unclaimed_prompt_turn.status = 'superseded'
          and exists (
            select 1 from ${schema.sessionEvents} consumed_prompt
            where consumed_prompt.workspace_id = ${workspaceId}
              and consumed_prompt.session_id = unclaimed_prompt_turn.session_id
              and consumed_prompt.turn_id = unclaimed_prompt_turn.id
              and consumed_prompt.type = 'turn.superseded'
              and consumed_prompt.payload @> '{"reason":"steer","beforeAttempt":true}'::jsonb
          )
        )
    )
  )`;
}
