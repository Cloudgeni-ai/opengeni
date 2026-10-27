import { and, asc, eq, sql } from "drizzle-orm";
import { BOT_TEMPLATES_PER_WORKSPACE_MAX, type SessionAvatar } from "@opengeni/contracts";
import { withWorkspaceRls, type Database } from "./database";
import * as schema from "./schema";

/**
 * Bot templates saved in a workspace (migration 1004). Everyone in the
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
