import { and, asc, desc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import {
  BOT_TEMPLATES_PER_WORKSPACE_MAX,
  SessionBotSuggestion as SessionBotSuggestionSchema,
  type SessionAvatar,
  type SessionBotSuggestion,
} from "@opengeni/contracts";
import {
  withWorkspaceRls,
  withWorkspaceSessionActivityRls,
  withWorkspaceSubjectRls,
  type Database,
} from "./database";
import * as schema from "./schema";

/**
 * Bot templates saved in a workspace (migration 1008). Everyone in the
 * workspace reads them; the API decides who may change one.
 */

export interface BotTemplateRecord {
  id: string;
  accountId: string;
  workspaceId: string;
  name: string;
  description: string;
  /** As stored; read it back through the contract's schema. */
  avatar: unknown;
  setupInstructions: string;
  sourceSessionId: string | null;
  createdBySubjectId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Saving another template would pass the workspace's limit. */
export class BotTemplateLimitError extends Error {
  readonly name = "BotTemplateLimitError";
  constructor() {
    super(
      `A workspace keeps at most ${BOT_TEMPLATES_PER_WORKSPACE_MAX} bot templates. Delete one to save another.`,
    );
  }
}

type Row = typeof schema.botTemplates.$inferSelect;

function record(row: Row): BotTemplateRecord {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    name: row.name,
    description: row.description,
    avatar: row.avatar ?? null,
    setupInstructions: row.setupInstructions,
    sourceSessionId: row.sourceSessionId,
    createdBySubjectId: row.createdBySubjectId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The workspace's bot templates, oldest first. */
export async function listBotTemplates(
  db: Database,
  workspaceId: string,
): Promise<BotTemplateRecord[]> {
  return await withWorkspaceRls(db, workspaceId, async (scoped) => {
    const rows = await scoped
      .select()
      .from(schema.botTemplates)
      .where(eq(schema.botTemplates.workspaceId, workspaceId))
      .orderBy(asc(schema.botTemplates.createdAt), asc(schema.botTemplates.id));
    return rows.map(record);
  });
}

export async function getBotTemplate(
  db: Database,
  workspaceId: string,
  templateId: string,
): Promise<BotTemplateRecord | null> {
  return await withWorkspaceRls(db, workspaceId, async (scoped) => {
    const [row] = await scoped
      .select()
      .from(schema.botTemplates)
      .where(
        and(
          eq(schema.botTemplates.workspaceId, workspaceId),
          eq(schema.botTemplates.id, templateId),
        ),
      );
    return row ? record(row) : null;
  });
}

export async function createBotTemplate(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    name: string;
    description: string;
    avatar: SessionAvatar | null;
    setupInstructions: string;
    sourceSessionId: string | null;
    createdBySubjectId: string | null;
  },
): Promise<BotTemplateRecord> {
  return await withWorkspaceRls(db, input.workspaceId, async (scoped) => {
    // One save at a time per workspace, so the limit holds.
    await scoped.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`bot_templates:${input.workspaceId}`}, 0))`,
    );
    const [count] = await scoped
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.botTemplates)
      .where(eq(schema.botTemplates.workspaceId, input.workspaceId));
    if ((count?.count ?? 0) >= BOT_TEMPLATES_PER_WORKSPACE_MAX) {
      throw new BotTemplateLimitError();
    }
    const [row] = await scoped
      .insert(schema.botTemplates)
      .values({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        name: input.name,
        description: input.description,
        avatar: input.avatar,
        setupInstructions: input.setupInstructions,
        sourceSessionId: input.sourceSessionId,
        createdBySubjectId: input.createdBySubjectId,
      })
      .returning();
    return record(row!);
  });
}

/** Null when it no longer exists. */
export async function updateBotTemplate(
  db: Database,
  input: {
    workspaceId: string;
    templateId: string;
    name?: string | undefined;
    description?: string | undefined;
    avatar?: SessionAvatar | null | undefined;
    setupInstructions?: string | undefined;
  },
): Promise<BotTemplateRecord | null> {
  return await withWorkspaceRls(db, input.workspaceId, async (scoped) => {
    const [row] = await scoped
      .update(schema.botTemplates)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.avatar !== undefined ? { avatar: input.avatar } : {}),
        ...(input.setupInstructions !== undefined
          ? { setupInstructions: input.setupInstructions }
          : {}),
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(schema.botTemplates.workspaceId, input.workspaceId),
          eq(schema.botTemplates.id, input.templateId),
        ),
      )
      .returning();
    return row ? record(row) : null;
  });
}

/** False when it no longer exists. */
export async function deleteBotTemplate(
  db: Database,
  workspaceId: string,
  templateId: string,
): Promise<boolean> {
  return await withWorkspaceRls(db, workspaceId, async (scoped) => {
    const rows = await scoped
      .delete(schema.botTemplates)
      .where(
        and(
          eq(schema.botTemplates.workspaceId, workspaceId),
          eq(schema.botTemplates.id, templateId),
        ),
      )
      .returning({ id: schema.botTemplates.id });
    return rows.length > 0;
  });
}

// --- Bot suggestions (migration 1014) --------------------------------------

/** A stored suggestion, or null when it is absent or no longer parses. */
export function storedSessionBotSuggestion(value: unknown): SessionBotSuggestion | null {
  if (value === null || value === undefined) return null;
  const parsed = SessionBotSuggestionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Record (or clear) the newest bot suggestion in a chat. Display state: it is
 * not activity, so the chat's `updated_at` is left as it was.
 */
export async function setSessionBotSuggestion(
  db: Database,
  input: { workspaceId: string; sessionId: string; suggestion: SessionBotSuggestion | null },
): Promise<boolean> {
  return await withWorkspaceSessionActivityRls(db, input.workspaceId, async (scoped) => {
    const rows = await scoped
      .update(schema.sessions)
      .set({
        botSuggestion: input.suggestion,
        updatedAt: sql`${schema.sessions.updatedAt}`,
      })
      .where(
        and(
          eq(schema.sessions.workspaceId, input.workspaceId),
          eq(schema.sessions.id, input.sessionId),
        ),
      )
      .returning({ id: schema.sessions.id });
    return rows.length > 0;
  });
}

/** A bot chat as a suggestion or mention sees it. */
export interface WorkspaceBotSession {
  id: string;
  title: string;
  description: string | null;
  /** As stored; read it back through the contract's schema. */
  avatar: unknown;
}

/**
 * The workspace's live bot chats (a chat with a description or avatar) that
 * `subjectId` may see, most recently active first. Private chats of other
 * people never appear.
 */
export async function listWorkspaceBotSessions(
  db: Database,
  input: { workspaceId: string; subjectId: string; limit?: number },
): Promise<WorkspaceBotSession[]> {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scoped) => {
    const rows = await scoped
      .select({
        id: schema.sessions.id,
        title: schema.sessions.title,
        description: schema.sessions.description,
        avatar: schema.sessions.avatar,
      })
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.workspaceId, input.workspaceId),
          isNotNull(schema.sessions.title),
          isNull(schema.sessions.contentArchiveState),
          or(isNotNull(schema.sessions.avatar), isNotNull(schema.sessions.description)),
        ),
      )
      .orderBy(desc(schema.sessions.updatedAt), asc(schema.sessions.id))
      .limit(limit);
    return rows.map((row) => ({
      id: row.id,
      title: row.title!,
      description: row.description,
      avatar: row.avatar,
    }));
  });
}

// --- Template links and proposals (migration 1015) -------------------------

/**
 * Link a chat to the bot template it was started from. A link, not activity:
 * the chat's `updated_at` is left as it was.
 */
export async function setSessionBotTemplate(
  db: Database,
  input: { workspaceId: string; sessionId: string; templateId: string | null },
): Promise<boolean> {
  return await withWorkspaceSessionActivityRls(db, input.workspaceId, async (scoped) => {
    const rows = await scoped
      .update(schema.sessions)
      .set({ botTemplateId: input.templateId, updatedAt: sql`${schema.sessions.updatedAt}` })
      .where(
        and(
          eq(schema.sessions.workspaceId, input.workspaceId),
          eq(schema.sessions.id, input.sessionId),
        ),
      )
      .returning({ id: schema.sessions.id });
    return rows.length > 0;
  });
}

/**
 * The template a chat belongs to: the one it was started from, otherwise the
 * newest one saved from it. Null when it has neither.
 */
export async function botTemplateForSession(
  db: Database,
  input: { workspaceId: string; sessionId: string; startedFromTemplateId: string | null },
): Promise<BotTemplateRecord | null> {
  if (input.startedFromTemplateId) {
    const started = await getBotTemplate(db, input.workspaceId, input.startedFromTemplateId);
    if (started) return started;
  }
  return await withWorkspaceRls(db, input.workspaceId, async (scoped) => {
    const [row] = await scoped
      .select()
      .from(schema.botTemplates)
      .where(
        and(
          eq(schema.botTemplates.workspaceId, input.workspaceId),
          eq(schema.botTemplates.sourceSessionId, input.sessionId),
        ),
      )
      .orderBy(desc(schema.botTemplates.createdAt), asc(schema.botTemplates.id))
      .limit(1);
    return row ? record(row) : null;
  });
}

export interface BotTemplateProposalRecord {
  id: string;
  templateId: string;
  sessionId: string;
  baseUpdatedAt: Date;
  setupInstructions: string;
  reason: string;
  proposedBySubjectId: string | null;
  status: "pending" | "accepted" | "dismissed" | "superseded";
  decidedBySubjectId: string | null;
  decidedAt: Date | null;
  createdAt: Date;
}

type ProposalRow = typeof schema.botTemplateProposals.$inferSelect;

function proposalRecord(row: ProposalRow): BotTemplateProposalRecord {
  return {
    id: row.id,
    templateId: row.templateId,
    sessionId: row.sessionId,
    baseUpdatedAt: row.baseUpdatedAt,
    setupInstructions: row.setupInstructions,
    reason: row.reason,
    proposedBySubjectId: row.proposedBySubjectId,
    status: row.status,
    decidedBySubjectId: row.decidedBySubjectId,
    decidedAt: row.decidedAt,
    createdAt: row.createdAt,
  };
}

/** The proposal was already decided, so it cannot be decided again. */
export class BotTemplateProposalStateError extends Error {
  readonly name = "BotTemplateProposalStateError";
  constructor(status: string) {
    super(`This proposal was already ${status}.`);
  }
}

/** The template changed after the person reviewed the proposal against it. */
export class BotTemplateChangedError extends Error {
  readonly name = "BotTemplateChangedError";
  constructor() {
    super("The bot template changed since you reviewed this proposal. Review it again.");
  }
}

/**
 * Record a proposal against the template as it is now. The same chat's older
 * pending proposal for this template is superseded: one chat, one open
 * proposal.
 */
export async function createBotTemplateProposal(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    templateId: string;
    sessionId: string;
    baseUpdatedAt: Date;
    setupInstructions: string;
    reason: string;
    proposedBySubjectId: string | null;
  },
): Promise<BotTemplateProposalRecord> {
  return await withWorkspaceRls(db, input.workspaceId, async (scoped) => {
    await scoped
      .update(schema.botTemplateProposals)
      .set({ status: "superseded", decidedAt: sql`now()` })
      .where(
        and(
          eq(schema.botTemplateProposals.workspaceId, input.workspaceId),
          eq(schema.botTemplateProposals.templateId, input.templateId),
          eq(schema.botTemplateProposals.sessionId, input.sessionId),
          eq(schema.botTemplateProposals.status, "pending"),
        ),
      );
    const [row] = await scoped
      .insert(schema.botTemplateProposals)
      .values({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        templateId: input.templateId,
        sessionId: input.sessionId,
        baseUpdatedAt: input.baseUpdatedAt,
        setupInstructions: input.setupInstructions,
        reason: input.reason,
        proposedBySubjectId: input.proposedBySubjectId,
      })
      .returning();
    return proposalRecord(row!);
  });
}

/**
 * Proposals the subject may see (never ones from another person's private
 * chat), newest first. `status` defaults to pending.
 */
export async function listBotTemplateProposals(
  db: Database,
  input: {
    workspaceId: string;
    subjectId: string;
    templateId?: string | undefined;
    sessionId?: string | undefined;
    status?: BotTemplateProposalRecord["status"] | "all" | undefined;
  },
): Promise<BotTemplateProposalRecord[]> {
  const status = input.status ?? "pending";
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scoped) => {
    const rows = await scoped
      .select()
      .from(schema.botTemplateProposals)
      .where(
        and(
          eq(schema.botTemplateProposals.workspaceId, input.workspaceId),
          input.templateId
            ? eq(schema.botTemplateProposals.templateId, input.templateId)
            : undefined,
          input.sessionId ? eq(schema.botTemplateProposals.sessionId, input.sessionId) : undefined,
          status === "all" ? undefined : eq(schema.botTemplateProposals.status, status),
        ),
      )
      .orderBy(desc(schema.botTemplateProposals.createdAt), asc(schema.botTemplateProposals.id))
      .limit(100);
    return rows.map(proposalRecord);
  });
}

/** One proposal the subject may see, or null. */
export async function getBotTemplateProposal(
  db: Database,
  input: { workspaceId: string; subjectId: string; proposalId: string },
): Promise<BotTemplateProposalRecord | null> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scoped) => {
    const [row] = await scoped
      .select()
      .from(schema.botTemplateProposals)
      .where(
        and(
          eq(schema.botTemplateProposals.workspaceId, input.workspaceId),
          eq(schema.botTemplateProposals.id, input.proposalId),
        ),
      )
      .limit(1);
    return row ? proposalRecord(row) : null;
  });
}

/**
 * Accept a pending proposal: replace the template's setup instructions, but
 * only while the template is still the version the person reviewed. Null
 * when the proposal or template no longer exists. The caller has already
 * checked that the person may change the template.
 */
export async function acceptBotTemplateProposal(
  db: Database,
  input: {
    workspaceId: string;
    subjectId: string;
    proposalId: string;
    expectedUpdatedAt: string;
    decidedBySubjectId: string | null;
  },
): Promise<{ template: BotTemplateRecord; proposal: BotTemplateProposalRecord } | null> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scoped) => {
    const [proposal] = await scoped
      .select()
      .from(schema.botTemplateProposals)
      .where(
        and(
          eq(schema.botTemplateProposals.workspaceId, input.workspaceId),
          eq(schema.botTemplateProposals.id, input.proposalId),
        ),
      )
      .for("update")
      .limit(1);
    if (!proposal) return null;
    if (proposal.status !== "pending") throw new BotTemplateProposalStateError(proposal.status);
    const [current] = await scoped
      .select()
      .from(schema.botTemplates)
      .where(
        and(
          eq(schema.botTemplates.workspaceId, input.workspaceId),
          eq(schema.botTemplates.id, proposal.templateId),
        ),
      )
      .for("update")
      .limit(1);
    if (!current) return null;
    if (current.updatedAt.getTime() !== Date.parse(input.expectedUpdatedAt)) {
      throw new BotTemplateChangedError();
    }
    const [template] = await scoped
      .update(schema.botTemplates)
      .set({ setupInstructions: proposal.setupInstructions, updatedAt: sql`now()` })
      .where(eq(schema.botTemplates.id, current.id))
      .returning();
    const [decided] = await scoped
      .update(schema.botTemplateProposals)
      .set({
        status: "accepted",
        decidedBySubjectId: input.decidedBySubjectId,
        decidedAt: sql`now()`,
      })
      .where(eq(schema.botTemplateProposals.id, proposal.id))
      .returning();
    return { template: record(template!), proposal: proposalRecord(decided!) };
  });
}

/** Dismiss a pending proposal. Null when it does not exist; throws when already decided. */
export async function dismissBotTemplateProposal(
  db: Database,
  input: {
    workspaceId: string;
    subjectId: string;
    proposalId: string;
    decidedBySubjectId: string | null;
  },
): Promise<BotTemplateProposalRecord | null> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scoped) => {
    const [proposal] = await scoped
      .select()
      .from(schema.botTemplateProposals)
      .where(
        and(
          eq(schema.botTemplateProposals.workspaceId, input.workspaceId),
          eq(schema.botTemplateProposals.id, input.proposalId),
        ),
      )
      .for("update")
      .limit(1);
    if (!proposal) return null;
    if (proposal.status !== "pending") throw new BotTemplateProposalStateError(proposal.status);
    const [decided] = await scoped
      .update(schema.botTemplateProposals)
      .set({
        status: "dismissed",
        decidedBySubjectId: input.decidedBySubjectId,
        decidedAt: sql`now()`,
      })
      .where(eq(schema.botTemplateProposals.id, proposal.id))
      .returning();
    return proposalRecord(decided!);
  });
}
