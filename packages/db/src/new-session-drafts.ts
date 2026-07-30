import type {
  NewSessionDraftOptions,
  ReasoningEffort,
  RepositoryResourceRef,
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

export class NewSessionDraftAccessError extends Error {
  readonly name = "NewSessionDraftAccessError";

  constructor() {
    super("New-session draft access changed");
  }
}

type StoredNewSessionDraftOptions = NewSessionDraftOptions & {
  /** JSONB-only compatibility marker; deliberately not part of public options. */
  toolsProvided?: boolean;
};

function storedOptions(
  options: NewSessionDraftOptions,
  toolsProvided: boolean,
): StoredNewSessionDraftOptions {
  return { ...options, toolsProvided };
}

export function newSessionDraftToolsProvided(row: NewSessionDraftRow): boolean {
  const options = row.sessionOptions as StoredNewSessionDraftOptions;
  // Rows written before the explicitness marker was introduced always carried
  // a `tools` array. Treat a markerless row as explicit rather than widening a
  // narrowed (including empty) legacy selection to today's workspace defaults.
  // New rows always write the marker, so an explicit false remains omitted /
  // workspace-default policy.
  return options.toolsProvided === true || !Object.hasOwn(options, "toolsProvided");
}

export function publicNewSessionDraftOptions(row: NewSessionDraftRow): NewSessionDraftOptions {
  const options = { ...(row.sessionOptions as StoredNewSessionDraftOptions) };
  delete options.toolsProvided;
  return options;
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
    toolsProvided: boolean;
    model: string;
    reasoningEffort: ReasoningEffort;
    options: NewSessionDraftOptions;
    /** API-key and delegated service subjects have no workspace-membership row. */
    requireWorkspaceMembership?: boolean;
  },
): Promise<NewSessionDraftRow> {
  if (input.requireWorkspaceMembership !== false) {
    // Serialize with removeWorkspaceMember(), which takes FOR UPDATE before it
    // deletes private rows and the membership. A save that wins first commits
    // before removal's cleanup; a removal that wins first leaves no membership
    // for a stale, already-authorized request to recreate after re-invitation.
    const [membership] = await db
      .select({ id: schema.workspaceMemberships.id })
      .from(schema.workspaceMemberships)
      .where(
        and(
          eq(schema.workspaceMemberships.workspaceId, input.workspaceId),
          eq(schema.workspaceMemberships.subjectId, input.subjectId),
        ),
      )
      .for("key share")
      .limit(1);
    if (!membership) throw new NewSessionDraftAccessError();
  }
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
    // Keep the explicit/omitted policy in the existing JSONB extension point;
    // adding a column here would turn a client preference into a migration.
    sessionOptions: storedOptions(input.options, input.toolsProvided),
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

function safeRepositoryResource(resource: RepositoryResourceRef): RepositoryResourceRef {
  // A repository's URI/ref/mount and GitHub identity are ordinary selection
  // state. Credential bindings, connection refs, access intent, and generic
  // provider ids are per-session authorization/runtime state and must not seed
  // the next create.
  return {
    kind: "repository",
    uri: resource.uri,
    ref: resource.ref,
    ...(resource.mountPath ? { mountPath: resource.mountPath } : {}),
    ...(resource.subpath ? { subpath: resource.subpath } : {}),
    ...(resource.githubInstallationId
      ? { githubInstallationId: resource.githubInstallationId }
      : {}),
    ...(resource.githubRepositoryId ? { githubRepositoryId: resource.githubRepositoryId } : {}),
  };
}

function safeWorkingDir(value: unknown, targetSandboxId: string | undefined): string | undefined {
  if (!targetSandboxId || typeof value !== "string") return undefined;
  const trimmed = value.trim();
  // Only a workspace-root-relative path is safe to remember. Absolute host
  // paths and traversal would leak or unexpectedly target a different machine
  // location after the user changes machines.
  if (
    !trimmed ||
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.includes("\u0000") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(trimmed) ||
    trimmed.split(/[\\/]+/).some((part) => part === "..")
  ) {
    return undefined;
  }
  return trimmed;
}

/**
 * Replace one exact accepted draft with the next-create safe seed. The row is
 * locked before the revision check so a concurrent save either commits first
 * and wins (this returns false), or observes the incremented seed revision and
 * reports a typed OCC conflict. A missing row is an idempotent no-op.
 */
export async function seedNewSessionDraftInTransaction(
  db: Database,
  input: { workspaceId: string; subjectId: string; expectedRevision: number },
): Promise<boolean> {
  if (input.expectedRevision === 0) return false;
  const [current] = await db
    .select()
    .from(schema.newSessionDrafts)
    .where(
      and(
        eq(schema.newSessionDrafts.workspaceId, input.workspaceId),
        eq(schema.newSessionDrafts.subjectId, input.subjectId),
      ),
    )
    .for("update")
    .limit(1);
  if (!current || current.revision !== input.expectedRevision) return false;

  const options = current.sessionOptions as StoredNewSessionDraftOptions;
  const targetSandboxId =
    typeof options.targetSandboxId === "string" ? options.targetSandboxId : undefined;
  const safeOptions: NewSessionDraftOptions = {
    ...(options.sandboxBackend ? { sandboxBackend: options.sandboxBackend } : {}),
    ...(targetSandboxId ? { targetSandboxId } : {}),
    ...(safeWorkingDir(options.workingDir, targetSandboxId)
      ? { workingDir: safeWorkingDir(options.workingDir, targetSandboxId) }
      : {}),
    ...(options.variableSetId ? { variableSetId: options.variableSetId } : {}),
    ...(options.rigId ? { rigId: options.rigId } : {}),
  };
  const resources = (Array.isArray(current.resources) ? current.resources : []).flatMap((raw) => {
    if (!raw || typeof raw !== "object" || (raw as { kind?: unknown }).kind !== "repository") {
      return [];
    }
    return [safeRepositoryResource(raw as RepositoryResourceRef)];
  });
  const [seeded] = await db
    .update(schema.newSessionDrafts)
    .set({
      revision: current.revision + 1,
      text: "",
      resources,
      // The explicit array is retained only when the caller explicitly pinned
      // tools. Omitted workspace-default policy is represented by [] + false.
      tools: newSessionDraftToolsProvided(current) ? current.tools : [],
      model: current.model,
      reasoningEffort: current.reasoningEffort,
      sessionOptions: storedOptions(safeOptions, newSessionDraftToolsProvided(current)),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.newSessionDrafts.id, current.id),
        eq(schema.newSessionDrafts.revision, input.expectedRevision),
      ),
    )
    .returning({ id: schema.newSessionDrafts.id });
  return Boolean(seeded);
}

/** @deprecated Kept as a compatibility name for low-level callers. */
export const consumeNewSessionDraftInTransaction = seedNewSessionDraftInTransaction;
