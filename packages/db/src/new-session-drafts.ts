import type {
  NewSessionDraftOptions,
  ReasoningEffort,
  ResourceRef,
  ToolRef,
} from "@opengeni/contracts";
import { and, eq } from "drizzle-orm";
import type { Database } from "./index";
import * as schema from "./schema";

export type NewSessionDraftRow = typeof schema.newSessionDrafts.$inferSelect;

export class NewSessionDraftConflictError extends Error {
  readonly name = "NewSessionDraftConflictError";

  constructor(readonly currentRevision: number) {
    super("New-session draft changed in another client");
  }
}

export async function getNewSessionDraftInTransaction(
  db: Database,
  input: { workspaceId: string; subjectId: string; lock?: boolean },
): Promise<NewSessionDraftRow | null> {
  const query = db
    .select()
    .from(schema.newSessionDrafts)
    .where(
      and(
        eq(schema.newSessionDrafts.workspaceId, input.workspaceId),
        eq(schema.newSessionDrafts.subjectId, input.subjectId),
      ),
    )
    .limit(1);
  const rows = input.lock ? await query.for("update") : await query;
  return rows[0] ?? null;
}

export async function saveNewSessionDraftInTransaction(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    expectedRevision: number;
    text: string;
    resources: ResourceRef[];
    tools: ToolRef[];
    model: string;
    reasoningEffort: ReasoningEffort;
    options: NewSessionDraftOptions;
  },
): Promise<NewSessionDraftRow> {
  const current = await getNewSessionDraftInTransaction(db, { ...input, lock: true });
  const currentRevision = current?.revision ?? 0;
  if (currentRevision !== input.expectedRevision) {
    throw new NewSessionDraftConflictError(currentRevision);
  }

  const revision = currentRevision + 1;
  const values = {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
    revision,
    text: input.text,
    resources: input.resources,
    tools: input.tools,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    sessionOptions: input.options,
    updatedAt: new Date(),
  };
  if (current) {
    const [saved] = await db
      .update(schema.newSessionDrafts)
      .set(values)
      .where(eq(schema.newSessionDrafts.id, current.id))
      .returning();
    if (!saved) throw new Error("New-session draft did not save");
    return saved;
  }

  // SELECT FOR UPDATE cannot lock an absent key. Two first saves may therefore
  // race; ON CONFLICT keeps the loser transaction usable so it can report the
  // winner's authoritative revision instead of leaking a unique violation.
  const [inserted] = await db
    .insert(schema.newSessionDrafts)
    .values(values)
    .onConflictDoNothing({
      target: [schema.newSessionDrafts.workspaceId, schema.newSessionDrafts.subjectId],
    })
    .returning();
  if (inserted) return inserted;
  const raced = await getNewSessionDraftInTransaction(db, { ...input, lock: true });
  throw new NewSessionDraftConflictError(raced?.revision ?? 0);
}

/** Delete only the submitted revision; a newer sibling-tab revision survives. */
export async function consumeNewSessionDraftInTransaction(
  db: Database,
  input: { workspaceId: string; subjectId: string; expectedRevision: number },
): Promise<boolean> {
  if (input.expectedRevision === 0) return false;
  const deleted = await db
    .delete(schema.newSessionDrafts)
    .where(
      and(
        eq(schema.newSessionDrafts.workspaceId, input.workspaceId),
        eq(schema.newSessionDrafts.subjectId, input.subjectId),
        eq(schema.newSessionDrafts.revision, input.expectedRevision),
      ),
    )
    .returning({ id: schema.newSessionDrafts.id });
  return deleted.length > 0;
}
