import {
  NewSessionDraftOptions,
  type NewSessionDraftOptions as NewSessionDraftOptionsValue,
  type NewSessionSelectionHistory,
  type LatencyMode,
  type ReasoningEffort,
  type RepositoryResourceRef,
  type ResourceRef,
  type ToolRef,
} from "@opengeni/contracts";
import { stableJson } from "@opengeni/contracts";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "./database";
import * as schema from "./schema";
import {
  accountIdInRlsScope,
  subjectHasLiveWorkspaceAuthorityInScope,
} from "./workspace-authority";

export type NewSessionDraftRow = typeof schema.newSessionDrafts.$inferSelect;

async function lockNewSessionDraftIdentity(
  db: Database,
  workspaceId: string,
  subjectId: string,
): Promise<void> {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`new-session-draft:${workspaceId}:${subjectId}`}, 0))`,
  );
}

export type NewSessionDraftSnapshot = {
  text: string;
  resources: ResourceRef[];
  tools: ToolRef[];
  toolsProvided: boolean;
  model: string;
  reasoningEffort: ReasoningEffort;
  latencyMode: LatencyMode;
  options: NewSessionDraftOptionsValue;
  // Project provenance is hydration metadata rather than a create option. Its
  // save still advances the revision fence, while omitting it here keeps old
  // clients compatible with a new server's exact create comparison.
};

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

type StoredNewSessionDraftOptions = NewSessionDraftOptionsValue & {
  /** JSONB-only compatibility marker; deliberately not part of public options. */
  toolsProvided?: boolean;
  /** Successful-create preference state, separate from transient draft edits. */
  selectionHistory?: NewSessionSelectionHistory;
  /** Absent is legacy/unknown; null is explicit provenance for the Default project. */
  selectedProjectChannelId?: string | null;
};

const REMEMBERED_WORKING_DIR_MAX_LENGTH = 4096;
const PROJECT_CHANNEL_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function storedOptions(
  options: NewSessionDraftOptionsValue,
  toolsProvided: boolean,
  selectionHistory: NewSessionSelectionHistory = { projects: [] },
  selectedProjectChannelId?: string | null,
): StoredNewSessionDraftOptions {
  return {
    ...options,
    toolsProvided,
    selectionHistory,
    ...(selectedProjectChannelId !== undefined ? { selectedProjectChannelId } : {}),
  };
}

export function newSessionSelectionHistory(row: NewSessionDraftRow): NewSessionSelectionHistory {
  const raw = (row.sessionOptions as StoredNewSessionDraftOptions).selectionHistory;
  if (!raw || !Array.isArray(raw.projects)) return { projects: [] };
  return {
    projects: raw.projects.slice(0, 50).flatMap((project) => {
      if (!project || (project.channelId !== null && typeof project.channelId !== "string")) {
        return [];
      }
      return [
        {
          channelId: project.channelId,
          targetSandboxId:
            typeof project.targetSandboxId === "string" ? project.targetSandboxId : null,
          machines: Array.isArray(project.machines)
            ? project.machines.slice(0, 20).flatMap((machine) =>
                machine && typeof machine.sandboxId === "string"
                  ? [
                      {
                        sandboxId: machine.sandboxId,
                        workingDir:
                          typeof machine.workingDir === "string" &&
                          machine.workingDir.length > 0 &&
                          machine.workingDir.length <= REMEMBERED_WORKING_DIR_MAX_LENGTH
                            ? machine.workingDir
                            : null,
                      },
                    ]
                  : [],
              )
            : [],
        },
      ];
    }),
  };
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

export function newSessionDraftSelectedProjectChannelId(
  row: NewSessionDraftRow,
): string | null | undefined {
  const options = row.sessionOptions as StoredNewSessionDraftOptions;
  if (!Object.hasOwn(options, "selectedProjectChannelId")) return undefined;
  if (options.selectedProjectChannelId === null) return null;
  return typeof options.selectedProjectChannelId === "string" &&
    PROJECT_CHANNEL_ID_PATTERN.test(options.selectedProjectChannelId)
    ? options.selectedProjectChannelId
    : undefined;
}

export function publicNewSessionDraftOptions(row: NewSessionDraftRow): NewSessionDraftOptionsValue {
  const options = { ...(row.sessionOptions as StoredNewSessionDraftOptions) };
  delete options.toolsProvided;
  delete options.selectionHistory;
  delete options.selectedProjectChannelId;
  return options;
}

function projectComputeMatches(
  current: NewSessionDraftOptionsValue,
  incoming: NewSessionDraftOptionsValue,
): boolean {
  // An old client cannot name project provenance. Preserve a newer client's
  // marker only while the compute placement that marker described is exact.
  return (
    current.sandboxBackend === incoming.sandboxBackend &&
    current.targetSandboxId === incoming.targetSandboxId &&
    current.workingDir === incoming.workingDir
  );
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
    latencyMode: LatencyMode;
    selectedProjectChannelId?: string | null;
    options: NewSessionDraftOptionsValue;
    /** API-key and delegated service subjects have no workspace-membership row. */
    requireWorkspaceMembership?: boolean;
    /**
     * May this caller use the owner-only managed personal-workspace exception?
     * See `PersonalWorkspaceOwnerException` in `@opengeni/db`. Absent means the
     * historical bare-membership fence, unchanged.
     */
    personalWorkspaceOwnerException?: boolean;
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
    // The owner of a managed personal workspace never has a membership row there
    // (migration 0219 raises on one), so the bare probe above would 403 the
    // composer inside the one workspace they always belong to. Ask the canonical
    // resolver instead of re-deriving that rule — it runs on this same
    // transaction handle, and there is no membership row for removeWorkspaceMember()
    // to delete in a personal workspace, so nothing is lost by taking no
    // `FOR KEY SHARE` on this path.
    if (
      !membership &&
      !(
        input.personalWorkspaceOwnerException === true &&
        (await subjectHasLiveWorkspaceAuthorityInScope(db, {
          // Scope-derived, NOT `input.accountId`: the applied RLS GUC is the
          // tenant this transaction actually runs under, so an authority
          // decision never reads a caller-supplied account. Matches
          // listSessionsForSubject and setSessionPin.
          accountId: await accountIdInRlsScope(db),
          workspaceId: input.workspaceId,
          subjectId: input.subjectId,
        }))
      )
    ) {
      throw new NewSessionDraftAccessError();
    }
  }
  await lockNewSessionDraftIdentity(db, input.workspaceId, input.subjectId);
  const current = await getNewSessionDraftInTransaction(db, {
    ...input,
    lock: true,
  });
  const currentRevision = current?.revision ?? 0;
  if (currentRevision !== input.expectedRevision) {
    throw new NewSessionDraftConflictError(currentRevision);
  }

  const revision = currentRevision + 1;
  const selectedProjectChannelId = Object.hasOwn(input, "selectedProjectChannelId")
    ? input.selectedProjectChannelId
    : current && projectComputeMatches(publicNewSessionDraftOptions(current), input.options)
      ? newSessionDraftSelectedProjectChannelId(current)
      : undefined;
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
    latencyMode: input.latencyMode,
    // Keep the explicit/omitted policy in the existing JSONB extension point;
    // adding a column here would turn a client preference into a migration.
    sessionOptions: storedOptions(
      input.options,
      input.toolsProvided,
      current ? newSessionSelectionHistory(current) : { projects: [] },
      selectedProjectChannelId,
    ),
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
  const raced = await getNewSessionDraftInTransaction(db, {
    ...input,
    lock: true,
  });
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

export type AcceptedNewSessionSelection = {
  channelId: string | null;
  targetSandboxId: string | null;
  workingDir: string | null;
};

export function rememberNewSessionSelection(
  history: NewSessionSelectionHistory,
  selection: AcceptedNewSessionSelection,
): NewSessionSelectionHistory {
  const existingProject = history.projects.find(
    (project) => project.channelId === selection.channelId,
  );
  let machines = existingProject?.machines ?? [];
  if (selection.targetSandboxId) {
    machines = [
      {
        sandboxId: selection.targetSandboxId,
        workingDir:
          selection.workingDir && selection.workingDir.length <= REMEMBERED_WORKING_DIR_MAX_LENGTH
            ? selection.workingDir
            : null,
      },
      ...machines.filter((machine) => machine.sandboxId !== selection.targetSandboxId),
    ].slice(0, 20);
  }
  return {
    projects: [
      {
        channelId: selection.channelId,
        targetSandboxId: selection.targetSandboxId,
        machines,
      },
      ...history.projects.filter((project) => project.channelId !== selection.channelId),
    ].slice(0, 50),
  };
}

/**
 * Record a successful create without consuming the editable draft. Realtime
 * session creation uses this path because it must preserve the actor's pending
 * text/files for a later ordinary session. The hidden preference update shares
 * the draft identity lock with saves, and deliberately leaves its OCC revision
 * unchanged because no browser-editable field changed.
 */
export async function rememberNewSessionSelectionInTransaction(
  db: Database,
  input: {
    workspaceId: string;
    subjectId: string;
    acceptedSelection: AcceptedNewSessionSelection;
  },
): Promise<boolean> {
  await lockNewSessionDraftIdentity(db, input.workspaceId, input.subjectId);
  const current = await getNewSessionDraftInTransaction(db, { ...input, lock: true });
  if (!current) return false;
  const [updated] = await db
    .update(schema.newSessionDrafts)
    .set({
      sessionOptions: storedOptions(
        publicNewSessionDraftOptions(current),
        newSessionDraftToolsProvided(current),
        rememberNewSessionSelection(newSessionSelectionHistory(current), input.acceptedSelection),
        newSessionDraftSelectedProjectChannelId(current),
      ),
    })
    .where(eq(schema.newSessionDrafts.id, current.id))
    .returning({ id: schema.newSessionDrafts.id });
  return Boolean(updated);
}

async function lockCurrentNewSessionDraft(
  db: Database,
  input: { workspaceId: string; subjectId: string },
): Promise<NewSessionDraftRow | undefined> {
  await lockNewSessionDraftIdentity(db, input.workspaceId, input.subjectId);
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
  return current;
}

async function lockExactNewSessionDraft(
  db: Database,
  input: {
    workspaceId: string;
    subjectId: string;
    expectedRevision: number;
    expectedSnapshot: NewSessionDraftSnapshot;
  },
): Promise<NewSessionDraftRow> {
  const current = await lockCurrentNewSessionDraft(db, input);
  if (!current || current.revision !== input.expectedRevision) {
    throw new NewSessionDraftConflictError(current?.revision ?? 0);
  }
  if (
    stableJson({
      text: current.text,
      resources: current.resources,
      tools: newSessionDraftToolsProvided(current) ? current.tools : [],
      toolsProvided: newSessionDraftToolsProvided(current),
      model: current.model,
      reasoningEffort: current.reasoningEffort,
      latencyMode: current.latencyMode,
      options: publicNewSessionDraftOptions(current),
    }) !== stableJson(input.expectedSnapshot)
  ) {
    throw new NewSessionDraftConflictError(current.revision);
  }
  return current;
}

/**
 * Fence a fresh session shell on the exact actor-private draft it represents.
 * The caller keeps this row lock through its create transaction, so a draft
 * that was already stale cannot leave a committed, uninitialized session.
 * The later atomic initializer still performs the authoritative consume.
 */
export async function assertExactNewSessionDraftInTransaction(
  db: Database,
  input: {
    workspaceId: string;
    subjectId: string;
    expectedRevision: number;
    expectedSnapshot: NewSessionDraftSnapshot;
  },
): Promise<void> {
  await lockExactNewSessionDraft(db, input);
}

/**
 * Replace one exact accepted draft with the next-create safe seed. The row is
 * identity-serialized before the revision check so even the absent-row
 * revision-zero case cannot race a first save. Exact create callers receive a
 * typed conflict; legacy revision-only callers retain the old false/no-op
 * result. A missing row is an idempotent no-op.
 */
export async function seedNewSessionDraftInTransaction(
  db: Database,
  input: {
    workspaceId: string;
    subjectId: string;
    expectedRevision: number;
    expectedSnapshot?: NewSessionDraftSnapshot;
    acceptedSelection?: AcceptedNewSessionSelection;
  },
): Promise<boolean> {
  const current = input.expectedSnapshot
    ? await lockExactNewSessionDraft(db, {
        workspaceId: input.workspaceId,
        subjectId: input.subjectId,
        expectedRevision: input.expectedRevision,
        expectedSnapshot: input.expectedSnapshot,
      })
    : await lockCurrentNewSessionDraft(db, input);
  if (!current || current.revision !== input.expectedRevision) {
    return false;
  }

  const parsedOptions = NewSessionDraftOptions.safeParse(publicNewSessionDraftOptions(current));
  const options = parsedOptions.success ? parsedOptions.data : {};
  const targetSandboxId =
    typeof options.targetSandboxId === "string" ? options.targetSandboxId : undefined;
  const selectedProjectChannelId = input.acceptedSelection
    ? input.acceptedSelection.channelId
    : newSessionDraftSelectedProjectChannelId(current);
  const safeOptions: NewSessionDraftOptionsValue = {
    ...(options.sandboxBackend ? { sandboxBackend: options.sandboxBackend } : {}),
    ...(targetSandboxId ? { targetSandboxId } : {}),
    ...(targetSandboxId && typeof options.workingDir === "string"
      ? { workingDir: options.workingDir }
      : {}),
    ...(options.variableSetIds && options.variableSetIds.length > 0
      ? {
          variableSetIds: options.variableSetIds,
          variableSetId: options.variableSetIds[options.variableSetIds.length - 1],
        }
      : {}),
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
      latencyMode: current.latencyMode,
      sessionOptions: storedOptions(
        safeOptions,
        newSessionDraftToolsProvided(current),
        input.acceptedSelection
          ? rememberNewSessionSelection(
              newSessionSelectionHistory(current),
              input.acceptedSelection,
            )
          : newSessionSelectionHistory(current),
        selectedProjectChannelId,
      ),
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
