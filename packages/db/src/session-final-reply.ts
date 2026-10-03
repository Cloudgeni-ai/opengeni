import { and, eq, sql } from "drizzle-orm";
import { type Database, withWorkspaceRls, withWorkspaceSessionActivityRls } from "./database";
import * as schema from "./schema";

/** Accepted goal authority plus causal turn facts, never the mutable goal head. */
export async function sessionTurnFinalReplyFacts(
  db: Database,
  workspaceId: string,
  sessionId: string,
  turnId: string,
): Promise<{ toolsExecuted: boolean; completedGoal: boolean }> {
  return withWorkspaceSessionActivityRls(db, workspaceId, async (scoped) => {
    const eventExists = (eventType: string) => sql<boolean>`exists (
      select 1 from ${schema.sessionEvents}
      where ${schema.sessionEvents.workspaceId} = ${workspaceId}
        and ${schema.sessionEvents.sessionId} = ${sessionId}
        and ${schema.sessionEvents.turnId} = ${turnId}
        and ${schema.sessionEvents.type} = ${eventType}
        and ${schema.sessionEvents.turnAssociation} = 'current'
        and ${schema.sessionEvents.duplicateOfEventId} is null
    )`;
    const rows = await scoped
      .select({
        toolsExecuted: sql<boolean>`exists (
          select 1 from ${schema.sessionHistoryItems}
          where ${schema.sessionHistoryItems.workspaceId} = ${workspaceId}
            and ${schema.sessionHistoryItems.sessionId} = ${sessionId}
            and ${schema.sessionHistoryItems.turnId} = ${turnId}
            and (
              ${schema.sessionHistoryItems.item}->>'type' in
                ('function_call_result', 'shell_call_output', 'computer_call_result')
              or (
                ${schema.sessionHistoryItems.item}->>'type' in
                  ('hosted_tool_call', 'web_search_call', 'file_search_call',
                   'code_interpreter_call', 'image_generation_call')
                and ${schema.sessionHistoryItems.item}->>'status' = 'completed'
              )
            )
        )`,
        completedGoal: sql<boolean>`coalesce(${schema.sessionTurns.goalSnapshot}->>'state' = 'completed', false) or ${eventExists("goal.completed")}`,
      })
      .from(schema.sessionTurns)
      .where(
        and(
          eq(schema.sessionTurns.workspaceId, workspaceId),
          eq(schema.sessionTurns.sessionId, sessionId),
          eq(schema.sessionTurns.id, turnId),
        ),
      )
      .limit(1);
    return rows[0] ?? { toolsExecuted: false, completedGoal: false };
  });
}

/** A bounded same-turn probe, including inactive rows after compaction. */
export async function sessionTurnHasFinalReplyNudge(
  db: Database,
  workspaceId: string,
  sessionId: string,
  turnId: string,
  markerText: string,
): Promise<boolean> {
  return withWorkspaceRls(db, workspaceId, async (scoped) => {
    const rows = await scoped
      .select({ id: schema.sessionHistoryItems.id })
      .from(schema.sessionHistoryItems)
      .where(
        and(
          eq(schema.sessionHistoryItems.workspaceId, workspaceId),
          eq(schema.sessionHistoryItems.sessionId, sessionId),
          eq(schema.sessionHistoryItems.turnId, turnId),
          sql`${schema.sessionHistoryItems.item}->>'role' = 'developer'`,
          sql`${schema.sessionHistoryItems.item}->'content'->0->>'text' = ${markerText}`,
        ),
      )
      .limit(1);
    return rows.length > 0;
  });
}
