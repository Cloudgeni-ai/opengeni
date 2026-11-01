/**
 * Slack agents: reads and writes.
 *
 * An agent row is HOME-owned, exactly like `slack_channel_routes`: the
 * installation binding's `(accountId, workspaceId, connectionId)` writes it.
 * Its TARGET workspace is where its chats run and is fixed at creation. A
 * read-only organization policy lets anyone in the organization list agents and
 * lets a routed chat read its own agent from the target workspace.
 *
 * Authorization (who may create, edit or use an agent) is decided by callers
 * from live grants. Nothing here grants anything.
 */
import type { SessionAvatar } from "@opengeni/contracts";
import { and, desc, eq, isNotNull, ne, sql } from "drizzle-orm";

import { withRlsContext, withWorkspaceRls, type Database } from "./database";
import { nestedPostgresSqlState } from "./persistence-errors";
import * as schema from "./schema";

export type SlackAgentHome = { accountId: string; workspaceId: string };

export type SlackAgentRecord = {
  id: string;
  accountId: string;
  workspaceId: string;
  connectionId: string;
  slackTeamId: string;
  targetAccountId: string;
  targetWorkspaceId: string;
  name: string;
  nameKey: string;
  description: string;
  avatar: SessionAvatar;
  instructions: string;
  knowledgeCollectionId: string | null;
  open: boolean;
  createdBySubjectId: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

function mapAgent(row: typeof schema.slackAgents.$inferSelect): SlackAgentRecord {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    connectionId: row.connectionId,
    slackTeamId: row.slackTeamId,
    targetAccountId: row.targetAccountId,
    targetWorkspaceId: row.targetWorkspaceId,
    name: row.name,
    nameKey: row.nameKey,
    description: row.description,
    avatar: row.avatar,
    instructions: row.instructions,
    knowledgeCollectionId: row.knowledgeCollectionId,
    open: row.open,
    createdBySubjectId: row.createdBySubjectId,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function compareAgents(left: SlackAgentRecord, right: SlackAgentRecord): number {
  if (left.nameKey !== right.nameKey) return left.nameKey < right.nameKey ? -1 : 1;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

/** Every agent in one organization, for the directory. Ordered by name. */
export async function listOrganizationSlackAgents(
  db: Database,
  input: { accountId: string },
): Promise<SlackAgentRecord[]> {
  return await withRlsContext(db, { accountId: input.accountId }, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(schema.slackAgents)
      .where(eq(schema.slackAgents.accountId, input.accountId));
    return rows.map(mapAgent).sort(compareAgents);
  });
}

/**
 * The agents one installation answers to, ordered by name. An installation
 * with none is the common case and must stay one cheap indexed read.
 */
export async function listSlackAgentsForConnection(
  db: Database,
  home: SlackAgentHome,
  input: { connectionId: string },
): Promise<SlackAgentRecord[]> {
  return await withRlsContext(db, home, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(schema.slackAgents)
      .where(
        and(
          eq(schema.slackAgents.accountId, home.accountId),
          eq(schema.slackAgents.workspaceId, home.workspaceId),
          eq(schema.slackAgents.connectionId, input.connectionId),
        ),
      );
    return rows.map(mapAgent).sort(compareAgents);
  });
}

/** One agent by id within an organization, or null. */
export async function getSlackAgent(
  db: Database,
  input: { accountId: string; agentId: string },
): Promise<SlackAgentRecord | null> {
  return await withRlsContext(db, { accountId: input.accountId }, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.slackAgents)
      .where(
        and(
          eq(schema.slackAgents.accountId, input.accountId),
          eq(schema.slackAgents.id, input.agentId),
        ),
      )
      .limit(1);
    return row ? mapAgent(row) : null;
  });
}

export type SlackAgentWriteFields = {
  name: string;
  nameKey: string;
  description: string;
  avatar: SessionAvatar;
  instructions: string;
};

/** Create an agent. `name_taken` when the installation already has that name. */
export async function insertSlackAgent(
  db: Database,
  home: SlackAgentHome,
  input: SlackAgentWriteFields & {
    connectionId: string;
    slackTeamId: string;
    targetAccountId: string;
    targetWorkspaceId: string;
    createdBySubjectId: string;
  },
): Promise<SlackAgentRecord | "name_taken"> {
  try {
    return await withRlsContext(db, home, async (scopedDb) => {
      const [row] = await scopedDb
        .insert(schema.slackAgents)
        .values({
          accountId: home.accountId,
          workspaceId: home.workspaceId,
          connectionId: input.connectionId,
          slackTeamId: input.slackTeamId,
          targetAccountId: input.targetAccountId,
          targetWorkspaceId: input.targetWorkspaceId,
          name: input.name,
          nameKey: input.nameKey,
          description: input.description,
          avatar: input.avatar,
          instructions: input.instructions,
          createdBySubjectId: input.createdBySubjectId,
        })
        .returning();
      if (!row) throw new Error("Slack agent insert returned no row");
      return mapAgent(row);
    });
  } catch (error) {
    if (nestedPostgresSqlState(error) === "23505") return "name_taken";
    throw error;
  }
}

/**
 * Change an agent's own fields at an expected version. The target workspace
 * and installation never change.
 */
export async function updateSlackAgent(
  db: Database,
  home: SlackAgentHome,
  input: {
    agentId: string;
    expectedVersion: number;
    patch: Partial<SlackAgentWriteFields> & {
      knowledgeCollectionId?: string | null;
      open?: boolean;
    };
  },
): Promise<SlackAgentRecord | "version_conflict" | "name_taken" | null> {
  try {
    return await withRlsContext(db, home, async (scopedDb) => {
      const [row] = await scopedDb
        .update(schema.slackAgents)
        .set({
          ...input.patch,
          version: sql`${schema.slackAgents.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(schema.slackAgents.id, input.agentId),
            eq(schema.slackAgents.accountId, home.accountId),
            eq(schema.slackAgents.workspaceId, home.workspaceId),
            eq(schema.slackAgents.version, input.expectedVersion),
          ),
        )
        .returning();
      if (row) return mapAgent(row);
      const [current] = await scopedDb
        .select({ id: schema.slackAgents.id })
        .from(schema.slackAgents)
        .where(
          and(
            eq(schema.slackAgents.id, input.agentId),
            eq(schema.slackAgents.workspaceId, home.workspaceId),
          ),
        )
        .limit(1);
      return current ? ("version_conflict" as const) : null;
    });
  } catch (error) {
    if (nestedPostgresSqlState(error) === "23505") return "name_taken";
    throw error;
  }
}

/** Remember the agent's Memory collection once it exists. Version-free and idempotent. */
export async function setSlackAgentKnowledgeCollection(
  db: Database,
  home: SlackAgentHome,
  input: { agentId: string; knowledgeCollectionId: string },
): Promise<SlackAgentRecord | null> {
  return await withRlsContext(db, home, async (scopedDb) => {
    const [row] = await scopedDb
      .update(schema.slackAgents)
      .set({ knowledgeCollectionId: input.knowledgeCollectionId, updatedAt: sql`now()` })
      .where(
        and(
          eq(schema.slackAgents.id, input.agentId),
          eq(schema.slackAgents.workspaceId, home.workspaceId),
        ),
      )
      .returning();
    return row ? mapAgent(row) : null;
  });
}

/** Delete an agent. Its channel settings go with it; its chats stay. */
export async function deleteSlackAgent(
  db: Database,
  home: SlackAgentHome,
  input: { agentId: string },
): Promise<boolean> {
  return await withRlsContext(db, home, async (scopedDb) => {
    const removed = await scopedDb
      .delete(schema.slackAgents)
      .where(
        and(
          eq(schema.slackAgents.id, input.agentId),
          eq(schema.slackAgents.accountId, home.accountId),
          eq(schema.slackAgents.workspaceId, home.workspaceId),
        ),
      )
      .returning({ id: schema.slackAgents.id });
    return removed.length > 0;
  });
}

/**
 * Record that a person used an agent, and claim the one-time "next time" hint
 * for `hintInteractionId` when one is offered.
 *
 * Replay-stable: the stored claim is the source of truth, so a retried call for
 * the same interaction returns the same answer, and two interactions racing for
 * the hint elect exactly one.
 */
export async function touchSlackAgentUserState(
  db: Database,
  home: SlackAgentHome,
  input: {
    connectionId: string;
    slackAgentId: string;
    slackUserId: string;
    hintInteractionId: string | null;
  },
): Promise<{ showHint: boolean }> {
  return await withRlsContext(db, home, async (scopedDb) => {
    const [row] = await scopedDb
      .insert(schema.slackAgentUserStates)
      .values({
        accountId: home.accountId,
        workspaceId: home.workspaceId,
        connectionId: input.connectionId,
        slackAgentId: input.slackAgentId,
        slackUserId: input.slackUserId,
        hintInteractionId: input.hintInteractionId,
      })
      .onConflictDoUpdate({
        target: [schema.slackAgentUserStates.slackAgentId, schema.slackAgentUserStates.slackUserId],
        set: {
          hintInteractionId: sql`coalesce(${schema.slackAgentUserStates.hintInteractionId}, excluded.hint_interaction_id)`,
          updatedAt: sql`now()`,
        },
      })
      .returning({ hintInteractionId: schema.slackAgentUserStates.hintInteractionId });
    return {
      showHint:
        input.hintInteractionId !== null && row?.hintInteractionId === input.hintInteractionId,
    };
  });
}

/** The agents one Slack person has already used through this installation. */
export async function listSlackAgentIdsUsedBy(
  db: Database,
  home: SlackAgentHome,
  input: { connectionId: string; slackUserId: string },
): Promise<string[]> {
  return await withRlsContext(db, home, async (scopedDb) => {
    const rows = await scopedDb
      .select({ slackAgentId: schema.slackAgentUserStates.slackAgentId })
      .from(schema.slackAgentUserStates)
      .where(
        and(
          eq(schema.slackAgentUserStates.connectionId, input.connectionId),
          eq(schema.slackAgentUserStates.slackUserId, input.slackUserId),
        ),
      );
    return rows.map((row) => row.slackAgentId);
  });
}

/**
 * Which Slack agent, if any, a chat was started for, read from the TARGET
 * workspace that owns the chat.
 *
 * `agentChat` stays true when the agent was deleted since, so the caller can
 * keep posting as plain Opengeni rather than falling back to the chat's own
 * title and avatar.
 */
export async function getSlackAgentForSession(
  db: Database,
  input: { workspaceId: string; sessionId: string },
): Promise<{ agentChat: boolean; agent: SlackAgentRecord | null }> {
  return await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
    const [session] = await scopedDb
      .select({
        agentId: sql<string | null>`${schema.sessions.metadata} -> 'slackAgent' ->> 'id'`,
      })
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.workspaceId, input.workspaceId),
          eq(schema.sessions.id, input.sessionId),
        ),
      )
      .limit(1);
    if (!session?.agentId) return { agentChat: false, agent: null };
    const [interaction] = await scopedDb
      .select({ slackAgentId: schema.slackInteractions.slackAgentId })
      .from(schema.slackInteractions)
      .where(
        and(
          eq(schema.slackInteractions.workspaceId, input.workspaceId),
          eq(schema.slackInteractions.sessionId, input.sessionId),
        ),
      )
      .limit(1);
    if (!interaction?.slackAgentId) return { agentChat: true, agent: null };
    const [agent] = await scopedDb
      .select()
      .from(schema.slackAgents)
      .where(eq(schema.slackAgents.id, interaction.slackAgentId))
      .limit(1);
    return { agentChat: true, agent: agent ? mapAgent(agent) : null };
  });
}

export type SlackAgentChatSummary = {
  sessionId: string;
  title: string | null;
  slackChannelId: string;
  slackThreadTs: string;
  initiatingSlackUserId: string | null;
  createdAt: Date;
};

/**
 * Recent chats of one agent in its own workspace, newest first. Filtered by
 * agent id, so chats of other agents and plain Opengeni chats in the same
 * workspace never appear.
 */
export async function listSlackAgentChats(
  db: Database,
  input: {
    workspaceId: string;
    slackAgentId: string;
    excludeSessionId?: string | null;
    limit: number;
  },
): Promise<SlackAgentChatSummary[]> {
  const limit = Math.max(1, Math.min(50, Math.trunc(input.limit)));
  return await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .select({
        sessionId: schema.slackInteractions.sessionId,
        title: schema.sessions.title,
        slackChannelId: schema.slackInteractions.slackChannelId,
        slackThreadTs: schema.slackInteractions.slackThreadTs,
        initiatingSlackUserId: schema.slackInteractions.initiatingSlackUserId,
        createdAt: schema.slackInteractions.createdAt,
      })
      .from(schema.slackInteractions)
      .innerJoin(schema.sessions, eq(schema.sessions.id, schema.slackInteractions.sessionId))
      .where(
        and(
          eq(schema.slackInteractions.workspaceId, input.workspaceId),
          eq(schema.slackInteractions.slackAgentId, input.slackAgentId),
          isNotNull(schema.slackInteractions.sessionId),
          // Only chats everyone in the workspace can open; a private DM chat
          // belongs to the person who started it.
          eq(schema.slackInteractions.visibility, "workspace"),
          ...(input.excludeSessionId
            ? [ne(schema.slackInteractions.sessionId, input.excludeSessionId)]
            : []),
        ),
      )
      .orderBy(desc(schema.slackInteractions.createdAt))
      .limit(limit);
    return rows.flatMap((row) =>
      row.sessionId
        ? [
            {
              sessionId: row.sessionId,
              title: row.title,
              slackChannelId: row.slackChannelId,
              slackThreadTs: row.slackThreadTs,
              initiatingSlackUserId: row.initiatingSlackUserId,
              createdAt: row.createdAt,
            },
          ]
        : [],
    );
  });
}

/** Mute or unmute occasional update messages for one Slack person. */
export async function setSlackBotUserUpdatesMuted(
  db: Database,
  home: SlackAgentHome,
  input: { connectionId: string; slackUserId: string; muted: boolean },
): Promise<boolean> {
  return await withRlsContext(db, home, async (scopedDb) => {
    const updated = await scopedDb
      .update(schema.slackBotUserLinks)
      .set({ updatesMutedAt: input.muted ? sql`now()` : null, updatedAt: sql`now()` })
      .where(
        and(
          eq(schema.slackBotUserLinks.workspaceId, home.workspaceId),
          eq(schema.slackBotUserLinks.connectionId, input.connectionId),
          eq(schema.slackBotUserLinks.slackUserId, input.slackUserId),
        ),
      )
      .returning({ id: schema.slackBotUserLinks.id });
    return updated.length > 0;
  });
}
