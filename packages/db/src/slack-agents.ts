/**
 * Slack agents: reads and writes, now backed by agents (see `./agents`).
 *
 * The functions keep the shapes the Slack code was written against: `home`
 * is the Slack installation's own workspace (where its binding and channel
 * routes live) and `targetWorkspaceId` is the agent's home workspace, where
 * its chats run. Agent rows, revisions and Slack availability are written in
 * the agent's home. An agent may be in several installations; a record is the
 * agent as one installation sees it.
 *
 * Authorization (who may create, edit or use an agent) is decided by callers
 * from live grants. Nothing here grants anything.
 */
import { AGENTS_PER_WORKSPACE_MAX, type SessionAvatar } from "@opengeni/contracts";
import { and, eq, sql } from "drizzle-orm";

import {
  agentSlackAvatar,
  createAgent,
  deleteAgentFromSlackInstall,
  getSessionAgent,
  getSlackAgentProjection,
  listAgentChats,
  listOrganizationSlackAgentProjections,
  listSlackAgentProjectionsForConnection,
  lockAgent,
  putAgentSlackInstall,
  setAgentMemoryCollection,
  updateAgent,
  type SlackAgentProjection,
} from "./agents";
import { withRlsContext, type Database } from "./database";
import * as schema from "./schema";

export type SlackAgentHome = { accountId: string; workspaceId: string };

/**
 * An agent as one Slack installation sees it. Read from the agents tables
 * (see `./agents`); the shape is the one the Slack code was written against.
 */
export type SlackAgentRecord = SlackAgentProjection;

/**
 * Every Slack-available agent in one organization, for the directory, once
 * per installation it is in. Ordered by name.
 */
export async function listOrganizationSlackAgents(
  db: Database,
  input: { accountId: string },
): Promise<SlackAgentRecord[]> {
  return await listOrganizationSlackAgentProjections(db, input);
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
  return await listSlackAgentProjectionsForConnection(db, home, input.connectionId);
}

/**
 * One Slack-available agent by id within an organization, or null: as
 * `connectionId`'s installation sees it, or else the installation it joined
 * first.
 */
export async function getSlackAgent(
  db: Database,
  input: { accountId: string; agentId: string; connectionId?: string | null },
): Promise<SlackAgentRecord | null> {
  return await getSlackAgentProjection(db, input);
}

export type SlackAgentWriteFields = {
  name: string;
  nameKey: string;
  description: string;
  avatar: SessionAvatar;
  instructions: string;
};

/** The agent write aborted; its transaction rolls back. */
class SlackAgentWriteAbort extends Error {
  constructor(readonly outcome: "name_taken" | "version_conflict" | "not_found") {
    super(`Slack agent write aborted: ${outcome}`);
  }
}

/**
 * Create an agent available in one installation (`home` is the
 * installation's own workspace), with Memory on. `name_taken` when the
 * installation already has that name; nothing is created then.
 */
export async function insertSlackAgent(
  db: Database,
  home: SlackAgentHome,
  input: SlackAgentWriteFields & {
    /** A fixed id makes a retried create find the agent it already made. */
    id?: string;
    connectionId: string;
    slackTeamId: string;
    targetAccountId: string;
    targetWorkspaceId: string;
    createdBySubjectId: string;
    /** `slack` for the card a chat posted in Slack; `app` otherwise. */
    origin?: "slack" | "app";
    maxPerWorkspace?: number;
  },
): Promise<SlackAgentRecord | "name_taken"> {
  const target = { accountId: input.targetAccountId, workspaceId: input.targetWorkspaceId };
  try {
    return await withRlsContext(db, target, async (tx) => {
      const { agent } = await createAgent(tx, target, {
        ...(input.id ? { id: input.id } : {}),
        visibility: "workspace",
        ownerSubjectId: null,
        name: input.name,
        description: input.description,
        avatar: input.avatar,
        instructions: input.instructions,
        firstMessage: "",
        memoryEnabled: true,
        origin: input.origin ?? "app",
        sourceSessionId: null,
        createdBySubjectId: input.createdBySubjectId,
        maxPerWorkspace: input.maxPerWorkspace ?? AGENTS_PER_WORKSPACE_MAX,
      });
      const saved = await putAgentSlackInstall(tx, target, {
        agentId: agent.id,
        connectionId: input.connectionId,
        slackTeamId: input.slackTeamId,
        installWorkspaceId: home.workspaceId,
        actorSubjectId: input.createdBySubjectId,
      });
      if (saved.kind !== "saved") throw new SlackAgentWriteAbort("name_taken");
      const projection = await getSlackAgentProjection(tx, {
        accountId: target.accountId,
        agentId: agent.id,
        connectionId: input.connectionId,
      });
      if (!projection) throw new Error("Slack agent insert returned no row");
      return projection;
    });
  } catch (error) {
    if (error instanceof SlackAgentWriteAbort) return "name_taken";
    throw error;
  }
}

/**
 * Change an agent's own fields at an expected version (the agent's). The
 * home workspace and installation never change. `home` is the installation's
 * own workspace; `connectionId` picks the installation whose `open` setting
 * a patch changes (else the agent's first installation in `home`).
 */
export async function updateSlackAgent(
  db: Database,
  home: SlackAgentHome,
  input: {
    agentId: string;
    connectionId?: string | null;
    expectedVersion: number;
    patch: Partial<SlackAgentWriteFields> & {
      knowledgeCollectionId?: string | null;
      open?: boolean;
    };
    /** Who made the change, recorded on a new revision. */
    actorSubjectId?: string | null;
  },
): Promise<SlackAgentRecord | "version_conflict" | "name_taken" | null> {
  const current = await getSlackAgentProjection(db, {
    accountId: home.accountId,
    agentId: input.agentId,
    connectionId: input.connectionId ?? null,
    installWorkspaceId: home.workspaceId,
  });
  if (!current || current.workspaceId !== home.workspaceId) return null;
  const target = { accountId: current.targetAccountId, workspaceId: current.targetWorkspaceId };
  const { patch } = input;
  try {
    return await withRlsContext(db, target, async (tx) => {
      const locked = await lockAgent(tx, target, current.id);
      if (!locked) throw new SlackAgentWriteAbort("not_found");
      if (input.expectedVersion !== locked.version) {
        throw new SlackAgentWriteAbort("version_conflict");
      }
      const fields = {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.avatar !== undefined ? { avatar: patch.avatar } : {}),
        ...(patch.instructions !== undefined ? { instructions: patch.instructions } : {}),
      };
      if (Object.keys(fields).length > 0) {
        const updated = await updateAgent(tx, target, {
          agentId: current.id,
          expectedVersion: null,
          actorSubjectId: input.actorSubjectId ?? null,
          patch: fields,
        });
        if (updated.kind === "slack_name_taken") throw new SlackAgentWriteAbort("name_taken");
        if (updated.kind !== "updated") throw new SlackAgentWriteAbort("not_found");
      }
      if (patch.open !== undefined) {
        const saved = await putAgentSlackInstall(tx, target, {
          agentId: current.id,
          connectionId: current.connectionId,
          slackTeamId: current.slackTeamId,
          installWorkspaceId: home.workspaceId,
          open: patch.open,
          actorSubjectId: input.actorSubjectId ?? current.createdBySubjectId,
        });
        if (saved.kind !== "saved") throw new SlackAgentWriteAbort("not_found");
      }
      if (patch.knowledgeCollectionId) {
        await setAgentMemoryCollection(tx, target, {
          agentId: current.id,
          collectionId: patch.knowledgeCollectionId,
        });
      }
      return await getSlackAgentProjection(tx, {
        accountId: target.accountId,
        agentId: current.id,
        connectionId: current.connectionId,
      });
    });
  } catch (error) {
    if (error instanceof SlackAgentWriteAbort) {
      return error.outcome === "not_found" ? null : error.outcome;
    }
    throw error;
  }
}

/** Remember the agent's Memory collection once it exists. Version-free and idempotent. */
export async function setSlackAgentKnowledgeCollection(
  db: Database,
  home: SlackAgentHome,
  input: { agentId: string; knowledgeCollectionId: string; connectionId?: string | null },
): Promise<SlackAgentRecord | null> {
  const current = await getSlackAgentProjection(db, {
    accountId: home.accountId,
    agentId: input.agentId,
    connectionId: input.connectionId ?? null,
    installWorkspaceId: home.workspaceId,
  });
  if (!current || current.workspaceId !== home.workspaceId) return null;
  const target = { accountId: current.targetAccountId, workspaceId: current.targetWorkspaceId };
  const updated = await setAgentMemoryCollection(db, target, {
    agentId: current.id,
    collectionId: input.knowledgeCollectionId,
  });
  if (!updated) return null;
  return await getSlackAgentProjection(db, {
    accountId: home.accountId,
    agentId: current.id,
    connectionId: current.connectionId,
  });
}

/**
 * Delete a Slack agent through the Slack agents API: the agent leaves that
 * installation, and is deleted with its last one, as a Slack agent delete
 * always deleted the agent. Its channel settings there go with it; its chats
 * stay.
 */
export async function deleteSlackAgent(
  db: Database,
  home: SlackAgentHome,
  input: { agentId: string; connectionId?: string | null },
): Promise<boolean> {
  const current = await getSlackAgentProjection(db, {
    accountId: home.accountId,
    agentId: input.agentId,
    connectionId: input.connectionId ?? null,
    installWorkspaceId: home.workspaceId,
  });
  if (!current || current.workspaceId !== home.workspaceId) return false;
  return await deleteAgentFromSlackInstall(
    db,
    { accountId: current.targetAccountId, workspaceId: current.targetWorkspaceId },
    { agentId: current.id, connectionId: current.connectionId },
  );
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
        target: [
          schema.slackAgentUserStates.connectionId,
          schema.slackAgentUserStates.slackAgentId,
          schema.slackAgentUserStates.slackUserId,
        ],
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

/**
 * Claim the one-time open-agent notice for a person and agent: true only for
 * the chat that claims it (and repairs of that chat), never again after.
 * Records first use too, like `touchSlackAgentUserState`.
 */
export async function claimSlackAgentOpenNotice(
  db: Database,
  home: SlackAgentHome,
  input: {
    connectionId: string;
    slackAgentId: string;
    slackUserId: string;
    interactionId: string;
  },
): Promise<boolean> {
  return await withRlsContext(db, home, async (scopedDb) => {
    const [row] = await scopedDb
      .insert(schema.slackAgentUserStates)
      .values({
        accountId: home.accountId,
        workspaceId: home.workspaceId,
        connectionId: input.connectionId,
        slackAgentId: input.slackAgentId,
        slackUserId: input.slackUserId,
        openNoticeInteractionId: input.interactionId,
      })
      .onConflictDoUpdate({
        target: [
          schema.slackAgentUserStates.connectionId,
          schema.slackAgentUserStates.slackAgentId,
          schema.slackAgentUserStates.slackUserId,
        ],
        set: {
          openNoticeInteractionId: sql`coalesce(${schema.slackAgentUserStates.openNoticeInteractionId}, excluded.open_notice_interaction_id)`,
          updatedAt: sql`now()`,
        },
      })
      .returning({
        openNoticeInteractionId: schema.slackAgentUserStates.openNoticeInteractionId,
      });
    return row?.openNoticeInteractionId === input.interactionId;
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
 * Which agent, if any, a chat was started with (`sessions.agent_id`, or an
 * older Slack chat's metadata), read from the workspace that owns the chat.
 *
 * `agentChat` stays true when the agent was deleted since, so the caller can
 * keep posting as plain Opengeni rather than falling back to the chat's own
 * title and avatar.
 */
export async function getSlackAgentForSession(
  db: Database,
  input: { workspaceId: string; sessionId: string },
): Promise<{
  agentChat: boolean;
  agent: { id: string; name: string; avatar: SessionAvatar; targetWorkspaceId: string } | null;
}> {
  const { agentChat, agent } = await getSessionAgent(db, input);
  return {
    agentChat,
    agent: agent
      ? {
          id: agent.id,
          name: agent.name,
          avatar: agentSlackAvatar(agent),
          targetWorkspaceId: agent.workspaceId,
        }
      : null,
  };
}

export type SlackAgentChatSummary = {
  sessionId: string;
  title: string | null;
  /** Null for a chat started in the app. */
  slackChannelId: string | null;
  slackThreadTs: string | null;
  initiatingSlackUserId: string | null;
  createdAt: Date;
};

/**
 * Recent shared chats of one agent in its own workspace, newest first. Only
 * chats everyone in the workspace can open: an Only me chat (a Slack DM
 * included) belongs to the person who started it.
 */
export async function listSlackAgentChats(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    slackAgentId: string;
    excludeSessionId?: string | null;
    limit: number;
  },
): Promise<SlackAgentChatSummary[]> {
  const chats = await listAgentChats(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    {
      agentId: input.slackAgentId,
      viewerSubjectId: null,
      filter: "everyone",
      sharedOnly: true,
      excludeSessionId: input.excludeSessionId ?? null,
      limit: Math.max(1, Math.min(50, Math.trunc(input.limit))),
    },
  );
  return chats.map((chat) => ({
    sessionId: chat.sessionId,
    title: chat.title,
    slackChannelId: chat.slack?.channelId ?? null,
    slackThreadTs: chat.slack?.threadTs ?? null,
    initiatingSlackUserId: chat.slack?.initiatingSlackUserId ?? null,
    createdAt: chat.createdAt,
  }));
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

/** Record that an agent's intro was posted in a channel. Idempotent. */
export async function recordSlackAgentIntroPost(
  db: Database,
  home: SlackAgentHome,
  input: {
    connectionId: string;
    slackAgentId: string;
    slackChannelId: string;
    postedBySubjectId: string;
  },
): Promise<void> {
  await withRlsContext(db, home, async (scopedDb) => {
    await scopedDb
      .insert(schema.slackAgentIntroPosts)
      .values({
        accountId: home.accountId,
        workspaceId: home.workspaceId,
        connectionId: input.connectionId,
        slackAgentId: input.slackAgentId,
        slackChannelId: input.slackChannelId,
        postedBySubjectId: input.postedBySubjectId,
      })
      .onConflictDoUpdate({
        target: [
          schema.slackAgentIntroPosts.connectionId,
          schema.slackAgentIntroPosts.slackAgentId,
          schema.slackAgentIntroPosts.slackChannelId,
        ],
        set: { postedBySubjectId: input.postedBySubjectId, updatedAt: sql`now()` },
      });
  });
}

/** The channels an agent's intro was posted in (in one installation, given `connectionId`). */
export async function listSlackAgentIntroChannelIds(
  db: Database,
  home: SlackAgentHome,
  input: { slackAgentId: string; connectionId?: string | null },
): Promise<string[]> {
  return await withRlsContext(db, home, async (scopedDb) => {
    const rows = await scopedDb
      .select({ slackChannelId: schema.slackAgentIntroPosts.slackChannelId })
      .from(schema.slackAgentIntroPosts)
      .where(
        and(
          eq(schema.slackAgentIntroPosts.workspaceId, home.workspaceId),
          eq(schema.slackAgentIntroPosts.slackAgentId, input.slackAgentId),
          input.connectionId
            ? eq(schema.slackAgentIntroPosts.connectionId, input.connectionId)
            : undefined,
        ),
      );
    return rows.map((row) => row.slackChannelId);
  });
}

export type SlackAgentSuggestionRecord = {
  id: string;
  connectionId: string;
  slackAgentId: string;
  interactionId: string;
  turnId: string;
  providerEventId: string;
  slackTeamId: string;
  slackUserId: string;
  slackChannelId: string;
  slackThreadTs: string;
  createdAt: Date;
};

function mapSuggestion(
  row: typeof schema.slackAgentSuggestions.$inferSelect,
): SlackAgentSuggestionRecord {
  return {
    id: row.id,
    connectionId: row.connectionId,
    slackAgentId: row.slackAgentId,
    interactionId: row.interactionId,
    turnId: row.turnId,
    providerEventId: row.providerEventId,
    slackTeamId: row.slackTeamId,
    slackUserId: row.slackUserId,
    slackChannelId: row.slackChannelId,
    slackThreadTs: row.slackThreadTs,
    createdAt: row.createdAt,
  };
}

/**
 * Record a chat's suggestion to ask an agent, once per turn: the first
 * suggestion of a turn wins and a retried call returns it.
 */
export async function recordSlackAgentSuggestion(
  db: Database,
  home: SlackAgentHome,
  input: Omit<SlackAgentSuggestionRecord, "id" | "createdAt">,
): Promise<SlackAgentSuggestionRecord> {
  return await withRlsContext(db, home, async (scopedDb) => {
    const [inserted] = await scopedDb
      .insert(schema.slackAgentSuggestions)
      .values({ accountId: home.accountId, workspaceId: home.workspaceId, ...input })
      .onConflictDoNothing({
        target: [schema.slackAgentSuggestions.interactionId, schema.slackAgentSuggestions.turnId],
      })
      .returning();
    if (inserted) return mapSuggestion(inserted);
    const [existing] = await scopedDb
      .select()
      .from(schema.slackAgentSuggestions)
      .where(
        and(
          eq(schema.slackAgentSuggestions.workspaceId, home.workspaceId),
          eq(schema.slackAgentSuggestions.interactionId, input.interactionId),
          eq(schema.slackAgentSuggestions.turnId, input.turnId),
        ),
      )
      .limit(1);
    if (!existing) throw new Error("Slack agent suggestion write returned no row");
    return mapSuggestion(existing);
  });
}

/** A turn's suggestion, if its chat made one. */
export async function getSlackAgentSuggestionForTurn(
  db: Database,
  home: SlackAgentHome,
  input: { interactionId: string; turnId: string },
): Promise<SlackAgentSuggestionRecord | null> {
  return await withRlsContext(db, home, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.slackAgentSuggestions)
      .where(
        and(
          eq(schema.slackAgentSuggestions.workspaceId, home.workspaceId),
          eq(schema.slackAgentSuggestions.interactionId, input.interactionId),
          eq(schema.slackAgentSuggestions.turnId, input.turnId),
        ),
      )
      .limit(1);
    return row ? mapSuggestion(row) : null;
  });
}

/** One suggestion by id, for its button. */
export async function getSlackAgentSuggestion(
  db: Database,
  home: SlackAgentHome,
  input: { suggestionId: string },
): Promise<SlackAgentSuggestionRecord | null> {
  return await withRlsContext(db, home, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.slackAgentSuggestions)
      .where(
        and(
          eq(schema.slackAgentSuggestions.workspaceId, home.workspaceId),
          eq(schema.slackAgentSuggestions.id, input.suggestionId),
        ),
      )
      .limit(1);
    return row ? mapSuggestion(row) : null;
  });
}
