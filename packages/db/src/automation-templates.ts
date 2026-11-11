import { and, asc, eq, sql } from "drizzle-orm";
import { AUTOMATION_TEMPLATES_PER_WORKSPACE_MAX } from "@opengeni/contracts";
import { withWorkspaceRls, type Database } from "./database";
import * as schema from "./schema";

/**
 * Automation templates saved in a workspace (migration 0959). Everyone in the
 * workspace reads them; the API decides who may change one. `definition` is
 * stored as the API validated it and read back through the same schema.
 */

export interface AutomationTemplateRecord {
  id: string;
  accountId: string;
  workspaceId: string;
  name: string;
  description: string;
  definition: unknown;
  createdBySubjectId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Saving another template would pass the workspace's limit. */
export class AutomationTemplateLimitError extends Error {
  readonly name = "AutomationTemplateLimitError";
  constructor() {
    super(
      `A workspace keeps at most ${AUTOMATION_TEMPLATES_PER_WORKSPACE_MAX} templates. Delete one to save another.`,
    );
  }
}

type Row = typeof schema.automationTemplates.$inferSelect;

function record(row: Row): AutomationTemplateRecord {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    name: row.name,
    description: row.description,
    definition: row.definition,
    createdBySubjectId: row.createdBySubjectId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The workspace's templates, oldest first. */
export async function listAutomationTemplates(
  db: Database,
  workspaceId: string,
): Promise<AutomationTemplateRecord[]> {
  return await withWorkspaceRls(db, workspaceId, async (scoped) => {
    const rows = await scoped
      .select()
      .from(schema.automationTemplates)
      .where(eq(schema.automationTemplates.workspaceId, workspaceId))
      .orderBy(asc(schema.automationTemplates.createdAt), asc(schema.automationTemplates.id));
    return rows.map(record);
  });
}

export async function getAutomationTemplate(
  db: Database,
  workspaceId: string,
  templateId: string,
): Promise<AutomationTemplateRecord | null> {
  return await withWorkspaceRls(db, workspaceId, async (scoped) => {
    const [row] = await scoped
      .select()
      .from(schema.automationTemplates)
      .where(
        and(
          eq(schema.automationTemplates.workspaceId, workspaceId),
          eq(schema.automationTemplates.id, templateId),
        ),
      );
    return row ? record(row) : null;
  });
}

export async function createAutomationTemplate(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    name: string;
    description: string;
    definition: Record<string, unknown>;
    createdBySubjectId: string | null;
  },
): Promise<AutomationTemplateRecord> {
  return await withWorkspaceRls(db, input.workspaceId, async (scoped) => {
    // One save at a time per workspace, so the limit holds.
    await scoped.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`automation_templates:${input.workspaceId}`}, 0))`,
    );
    const [count] = await scoped
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.automationTemplates)
      .where(eq(schema.automationTemplates.workspaceId, input.workspaceId));
    if ((count?.count ?? 0) >= AUTOMATION_TEMPLATES_PER_WORKSPACE_MAX) {
      throw new AutomationTemplateLimitError();
    }
    const [row] = await scoped
      .insert(schema.automationTemplates)
      .values({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        name: input.name,
        description: input.description,
        definition: input.definition,
        createdBySubjectId: input.createdBySubjectId,
      })
      .returning();
    return record(row!);
  });
}

/** Null when it no longer exists. */
export async function updateAutomationTemplate(
  db: Database,
  input: {
    workspaceId: string;
    templateId: string;
    name?: string | undefined;
    description?: string | undefined;
    definition?: Record<string, unknown> | undefined;
  },
): Promise<AutomationTemplateRecord | null> {
  return await withWorkspaceRls(db, input.workspaceId, async (scoped) => {
    const [row] = await scoped
      .update(schema.automationTemplates)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.definition !== undefined ? { definition: input.definition } : {}),
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(schema.automationTemplates.workspaceId, input.workspaceId),
          eq(schema.automationTemplates.id, input.templateId),
        ),
      )
      .returning();
    return row ? record(row) : null;
  });
}

/** False when it no longer exists. */
export async function deleteAutomationTemplate(
  db: Database,
  workspaceId: string,
  templateId: string,
): Promise<boolean> {
  return await withWorkspaceRls(db, workspaceId, async (scoped) => {
    const rows = await scoped
      .delete(schema.automationTemplates)
      .where(
        and(
          eq(schema.automationTemplates.workspaceId, workspaceId),
          eq(schema.automationTemplates.id, templateId),
        ),
      )
      .returning({ id: schema.automationTemplates.id });
    return rows.length > 0;
  });
}
