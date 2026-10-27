import { and, asc, desc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import {
  BOT_TEMPLATES_PER_WORKSPACE_MAX,
  SessionBotSuggestion as SessionBotSuggestionSchema,
  type BotTemplateVisibility,
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
 * Bot templates saved in a workspace (migrations 1008 and 1064). A shared
 * template is read by everyone in the workspace and an Only me one only by
 * whoever saved it; the API decides who may change one.
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
  visibility: BotTemplateVisibility;
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
    visibility: row.visibility === "private" ? "private" : "workspace",
    sourceSessionId: row.sourceSessionId,
    createdBySubjectId: row.createdBySubjectId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The workspace's bot templates a reader sees, oldest first: the shared ones
 * and, for a person, their own Only me ones.
 */
export async function listBotTemplates(
  db: Database,
  workspaceId: string,
  readerSubjectId: string | null,
): Promise<BotTemplateRecord[]> {
  return await withWorkspaceRls(db, workspaceId, async (scoped) => {
    const rows = await scoped
      .select()
      .from(schema.botTemplates)
      .where(
        and(
          eq(schema.botTemplates.workspaceId, workspaceId),
          readerSubjectId === null
            ? eq(schema.botTemplates.visibility, "workspace")
            : or(
                eq(schema.botTemplates.visibility, "workspace"),
                eq(schema.botTemplates.createdBySubjectId, readerSubjectId),
              ),
        ),
      )
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
    visibility: BotTemplateVisibility;
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
        visibility: input.visibility,
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
    visibility?: BotTemplateVisibility | undefined;
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
        ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
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

// --- Bot suggestions (migration 1219) --------------------------------------

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

/**
 * How many requests people sent this chat: human and API prompts, never agent
 * messages, schedules or goal continuations. The floor under `bot_suggest`.
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
