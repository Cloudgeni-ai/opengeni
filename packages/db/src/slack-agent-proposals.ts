/**
 * Creating Slack agents from Slack, and the Ask form's shortcut context.
 *
 * A proposal is the server's own record of a confirmation card a chat posted
 * in its Slack thread. A click on the card is checked against this row, never
 * against the button payload. Both tables are HOME-owned, like `slack_agents`.
 *
 * Authorization (who may confirm) is decided by callers from live grants.
 * Nothing here grants anything.
 */
import type { SessionAvatar } from "@opengeni/contracts";
import { and, eq, inArray, lt, sql } from "drizzle-orm";

import { withRlsContext, type Database } from "./database";
import * as schema from "./schema";

export type SlackAgentProposalHome = { accountId: string; workspaceId: string };

export type SlackAgentProposalStatus = "pending" | "creating" | "created" | "cancelled";

export type SlackAgentProposal = {
  id: string;
  accountId: string;
  workspaceId: string;
  connectionId: string;
  slackTeamId: string;
  targetAccountId: string;
  targetWorkspaceId: string;
  proposedBySessionId: string;
  proposedBySlackUserId: string | null;
  slackChannelId: string;
  slackThreadTs: string;
  slackMessageTs: string | null;
  messageOperationId: string;
  name: string;
  nameKey: string;
  description: string;
  avatar: SessionAvatar;
  instructions: string;
  status: SlackAgentProposalStatus;
  createdSlackAgentId: string | null;
  decidedBySubjectId: string | null;
  decidedBySlackUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function mapProposal(row: typeof schema.slackAgentProposals.$inferSelect): SlackAgentProposal {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    connectionId: row.connectionId,
    slackTeamId: row.slackTeamId,
    targetAccountId: row.targetAccountId,
    targetWorkspaceId: row.targetWorkspaceId,
    proposedBySessionId: row.proposedBySessionId,
    proposedBySlackUserId: row.proposedBySlackUserId,
    slackChannelId: row.slackChannelId,
    slackThreadTs: row.slackThreadTs,
    slackMessageTs: row.slackMessageTs,
    messageOperationId: row.messageOperationId,
    name: row.name,
    nameKey: row.nameKey,
    description: row.description,
    avatar: row.avatar,
    instructions: row.instructions,
    status: row.status,
    createdSlackAgentId: row.createdSlackAgentId,
    decidedBySubjectId: row.decidedBySubjectId,
    decidedBySlackUserId: row.decidedBySlackUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function insertSlackAgentProposal(
  db: Database,
  home: SlackAgentProposalHome,
  input: {
    id: string;
    connectionId: string;
    slackTeamId: string;
    targetAccountId: string;
    targetWorkspaceId: string;
    proposedBySessionId: string;
    proposedBySlackUserId: string | null;
    slackChannelId: string;
    slackThreadTs: string;
    messageOperationId: string;
    name: string;
    nameKey: string;
    description: string;
    avatar: SessionAvatar;
    instructions: string;
  },
): Promise<SlackAgentProposal> {
  return await withRlsContext(db, home, async (scopedDb) => {
    const [row] = await scopedDb
      .insert(schema.slackAgentProposals)
      .values({ ...input, accountId: home.accountId, workspaceId: home.workspaceId })
      .returning();
    if (!row) throw new Error("Slack agent proposal insert returned no row");
    return mapProposal(row);
  });
}

export async function getSlackAgentProposal(
  db: Database,
  home: SlackAgentProposalHome,
  input: { proposalId: string },
): Promise<SlackAgentProposal | null> {
  return await withRlsContext(db, home, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.slackAgentProposals)
      .where(
        and(
          eq(schema.slackAgentProposals.id, input.proposalId),
          eq(schema.slackAgentProposals.accountId, home.accountId),
          eq(schema.slackAgentProposals.workspaceId, home.workspaceId),
        ),
      )
      .limit(1);
    return row ? mapProposal(row) : null;
  });
}

/** Remember which Slack message is the card, once it is posted. */
export async function setSlackAgentProposalMessage(
  db: Database,
  home: SlackAgentProposalHome,
  input: { proposalId: string; slackMessageTs: string },
): Promise<void> {
  await withRlsContext(db, home, async (scopedDb) => {
    await scopedDb
      .update(schema.slackAgentProposals)
      .set({ slackMessageTs: input.slackMessageTs, updatedAt: sql`now()` })
      .where(
        and(
          eq(schema.slackAgentProposals.id, input.proposalId),
          eq(schema.slackAgentProposals.workspaceId, home.workspaceId),
        ),
      );
  });
}

/**
 * Move a proposal from one status to another. Returns the updated row, or null
 * when it was not in one of `from` (someone else settled it first).
 */
export async function transitionSlackAgentProposal(
  db: Database,
  home: SlackAgentProposalHome,
  input: {
    proposalId: string;
    from: readonly SlackAgentProposalStatus[];
    to: SlackAgentProposalStatus;
    createdSlackAgentId?: string;
    decidedBySubjectId?: string | null;
    decidedBySlackUserId?: string | null;
  },
): Promise<SlackAgentProposal | null> {
  return await withRlsContext(db, home, async (scopedDb) => {
    const [row] = await scopedDb
      .update(schema.slackAgentProposals)
      .set({
        status: input.to,
        ...(input.createdSlackAgentId ? { createdSlackAgentId: input.createdSlackAgentId } : {}),
        ...(input.decidedBySubjectId !== undefined
          ? { decidedBySubjectId: input.decidedBySubjectId }
          : {}),
        ...(input.decidedBySlackUserId !== undefined
          ? { decidedBySlackUserId: input.decidedBySlackUserId }
          : {}),
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(schema.slackAgentProposals.id, input.proposalId),
          eq(schema.slackAgentProposals.workspaceId, home.workspaceId),
          inArray(schema.slackAgentProposals.status, [...input.from]),
        ),
      )
      .returning();
    return row ? mapProposal(row) : null;
  });
}

export type SlackAskForm = {
  id: string;
  connectionId: string;
  slackTeamId: string;
  slackUserId: string;
  slackChannelId: string;
  slackMessageTs: string;
  slackThreadTs: string | null;
  providerEventId: string;
  messageText: string;
  expiresAt: Date;
};

/** Forms not submitted within a day are dropped. */
const SLACK_ASK_FORM_TTL_MS = 24 * 60 * 60 * 1_000;

/**
 * Keep the message a shortcut opened the Ask form on. Expired forms of the same
 * installation are removed on the way, so unsubmitted forms do not pile up.
 */
export async function insertSlackAskForm(
  db: Database,
  home: SlackAgentProposalHome,
  input: Omit<SlackAskForm, "id" | "expiresAt"> & { now?: Date },
): Promise<SlackAskForm> {
  const now = input.now ?? new Date();
  return await withRlsContext(db, home, async (scopedDb) => {
    await scopedDb
      .delete(schema.slackAskForms)
      .where(
        and(
          eq(schema.slackAskForms.workspaceId, home.workspaceId),
          eq(schema.slackAskForms.connectionId, input.connectionId),
          lt(schema.slackAskForms.expiresAt, now),
        ),
      );
    const [row] = await scopedDb
      .insert(schema.slackAskForms)
      .values({
        accountId: home.accountId,
        workspaceId: home.workspaceId,
        connectionId: input.connectionId,
        slackTeamId: input.slackTeamId,
        slackUserId: input.slackUserId,
        slackChannelId: input.slackChannelId,
        slackMessageTs: input.slackMessageTs,
        slackThreadTs: input.slackThreadTs,
        providerEventId: input.providerEventId,
        messageText: input.messageText,
        expiresAt: new Date(now.getTime() + SLACK_ASK_FORM_TTL_MS),
      })
      .returning();
    if (!row) throw new Error("Slack Ask form insert returned no row");
    return mapAskForm(row);
  });
}

/** An unexpired Ask form, or null. */
export async function getSlackAskForm(
  db: Database,
  home: SlackAgentProposalHome,
  input: { formId: string; now?: Date },
): Promise<SlackAskForm | null> {
  return await withRlsContext(db, home, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.slackAskForms)
      .where(
        and(
          eq(schema.slackAskForms.id, input.formId),
          eq(schema.slackAskForms.workspaceId, home.workspaceId),
        ),
      )
      .limit(1);
    if (!row || row.expiresAt.getTime() <= (input.now ?? new Date()).getTime()) return null;
    return mapAskForm(row);
  });
}

/** Drop a submitted form. Its request is in the inbox by then. */
export async function deleteSlackAskForm(
  db: Database,
  home: SlackAgentProposalHome,
  input: { formId: string },
): Promise<void> {
  await withRlsContext(db, home, async (scopedDb) => {
    await scopedDb
      .delete(schema.slackAskForms)
      .where(
        and(
          eq(schema.slackAskForms.id, input.formId),
          eq(schema.slackAskForms.workspaceId, home.workspaceId),
        ),
      );
  });
}

function mapAskForm(row: typeof schema.slackAskForms.$inferSelect): SlackAskForm {
  return {
    id: row.id,
    connectionId: row.connectionId,
    slackTeamId: row.slackTeamId,
    slackUserId: row.slackUserId,
    slackChannelId: row.slackChannelId,
    slackMessageTs: row.slackMessageTs,
    slackThreadTs: row.slackThreadTs,
    providerEventId: row.providerEventId,
    messageText: row.messageText,
    expiresAt: row.expiresAt,
  };
}
