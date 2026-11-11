/**
 * Agent suggestions (`agent_suggest`, migration 1361): the card a chat shows
 * when its agent offers to make an agent of it, or points to an agent that
 * already does its work. Display state on the `sessions` row; it never makes
 * or changes an agent and never reaches the model. See docs/agents.md.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  SessionAgentSuggestion as SessionAgentSuggestionSchema,
  type SessionAgentSuggestion,
} from "@opengeni/contracts";
import {
  rawRows,
  withRlsContext,
  withWorkspaceSessionActivityRls,
  withWorkspaceSubjectRls,
  type Database,
} from "./database";
import * as schema from "./schema";

/** A stored suggestion, or null when it is absent or no longer parses. */
export function storedSessionAgentSuggestion(value: unknown): SessionAgentSuggestion | null {
  if (value === null || value === undefined) return null;
  const parsed = SessionAgentSuggestionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Record a chat's agent suggestion, once: only the write that finds none
 * stored succeeds, so concurrent calls can't replace a card someone already
 * saw or dismissed. False when the chat has one already, or does not exist.
 * Display state, not activity, so the chat's `updated_at` is left as it was.
 */
export async function claimSessionAgentSuggestion(
  db: Database,
  input: { workspaceId: string; sessionId: string; suggestion: SessionAgentSuggestion },
): Promise<boolean> {
  return await withWorkspaceSessionActivityRls(db, input.workspaceId, async (scoped) => {
    const rows = await scoped
      .update(schema.sessions)
      .set({
        agentSuggestion: input.suggestion,
        updatedAt: sql`${schema.sessions.updatedAt}`,
      })
      .where(
        and(
          eq(schema.sessions.workspaceId, input.workspaceId),
          eq(schema.sessions.id, input.sessionId),
          isNull(schema.sessions.agentSuggestion),
        ),
      )
      .returning({ id: schema.sessions.id });
    return rows.length > 0;
  });
}

/**
 * Whether an agent of the home workspace was already made from this chat
 * (`agents.source_session_id`), whoever can see it. Only a yes or no, so an
 * Only me agent's name never leaves its owner.
 */
export async function agentMadeFromSession(
  db: Database,
  home: { accountId: string; workspaceId: string },
  sessionId: string,
): Promise<boolean> {
  return await withRlsContext(db, home, async (tx) => {
    const rows = await rawRows<{ found: boolean }>(
      tx,
      sql`select true as found
        from agents a
        where a.account_id = ${home.accountId}::uuid
          and a.workspace_id = ${home.workspaceId}::uuid
          and a.source_session_id = ${sessionId}::uuid
        limit 1`,
    );
    return rows.length > 0;
  });
}

/**
 * How many requests people sent this chat: human and API prompts, never agent
 * messages, schedules or goal continuations. The floor under `agent_suggest`.
 */
export async function countSessionHumanRequests(
  db: Database,
  input: { workspaceId: string; subjectId: string; sessionId: string },
): Promise<number> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scoped) => {
    const [row] = await scoped
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.sessionTurns)
      .where(
        and(
          eq(schema.sessionTurns.workspaceId, input.workspaceId),
          eq(schema.sessionTurns.sessionId, input.sessionId),
          sql`${schema.sessionTurns.initiatorKind} = 'subject' and ${schema.sessionTurns.source} in ('user', 'api') and ${schema.sessionTurns.surface} is distinct from 'agent'`,
        ),
      );
    return row?.count ?? 0;
  });
}
