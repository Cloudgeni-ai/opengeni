import {
  type CreateSessionRequest,
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
import { membershipOutsidePersonalWorkspace } from "./personal-workspace-membership";
import { notifyActorDraftChanged } from "./session-list-notifications";
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
  /**
   * JSONB-only model-policy marker. True means the person chose the model,
   * reasoning, and latency; false means they follow the resolved new-chat
   * default. Absent on rows written before the marker existed.
   */
  modelProvided?: boolean;
  /** Successful-create preference state, separate from transient draft edits. */
  selectionHistory?: NewSessionSelectionHistory;
  /** Legacy rolling-upgrade input; migration 0404 strips this on every write. */
  selectedProjectChannelId?: string | null;
};

const REMEMBERED_WORKING_DIR_MAX_LENGTH = 4096;
const PROJECT_CHANNEL_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function storedOptions(
  options: NewSessionDraftOptionsValue,
  toolsProvided: boolean,
  selectionHistory: NewSessionSelectionHistory = { projects: [] },
  modelProvided?: boolean,
): StoredNewSessionDraftOptions {
  const stored: StoredNewSessionDraftOptions = {
    ...options,
    toolsProvided,
    ...(modelProvided === undefined ? {} : { modelProvided }),
    selectionHistory,
  };
  // A caller may have read a row written by the short-lived JSONB provenance
  // implementation. Never carry that metadata back into public create options.
  delete (stored as StoredNewSessionDraftOptions).selectedProjectChannelId;
  return stored;
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

/**
 * The stored model-policy marker, or undefined for a row written before the
 * marker existed (or by an older client that did not send it). Callers that
 * know the deployment default decide what an unmarked row means.
 */
export function newSessionDraftModelProvided(row: NewSessionDraftRow): boolean | undefined {
  const marker = (row.sessionOptions as StoredNewSessionDraftOptions).modelProvided;
  return typeof marker === "boolean" ? marker : undefined;
}

export function newSessionDraftSelectedProjectChannelId(
  row: NewSessionDraftRow,
): string | null | undefined {
  if (row.selectedProjectComputeSnapshot === null) return undefined;
  if (
    stableJson(row.selectedProjectComputeSnapshot) !==
    stableJson(newSessionDraftProjectComputeSnapshot(publicNewSessionDraftOptions(row)))
  ) {
    return undefined;
  }
  if (row.selectedProjectChannelId === null) return null;
  return PROJECT_CHANNEL_ID_PATTERN.test(row.selectedProjectChannelId)
    ? row.selectedProjectChannelId
    : undefined;
}

export function publicNewSessionDraftOptions(row: NewSessionDraftRow): NewSessionDraftOptionsValue {
  const options = { ...(row.sessionOptions as StoredNewSessionDraftOptions) };
  delete options.toolsProvided;
  delete options.modelProvided;
  delete options.selectionHistory;
  delete options.selectedProjectChannelId;
  return options;
}

/** Every create option a new-session draft can hold, from the contract itself. */
export const NEW_SESSION_DRAFT_OPTION_KEYS = Object.keys(
  NewSessionDraftOptions.shape,
) as readonly (keyof NewSessionDraftOptionsValue)[];

// The fence reads each draft option from the create field of the same name. A
// draft option the create request cannot carry would make every Send conflict,
// so it must not compile.
const draftOptionsAreCreateFields: [
  Exclude<keyof NewSessionDraftOptionsValue, keyof CreateSessionRequest>,
] extends [never]
  ? true
  : never = true;
void draftOptionsAreCreateFields;
// ...and the create field must accept the draft option's value, or a draft
// option whose create field later changed shape would conflict on every Send.
type DraftOptionsCreateFieldsDisagree = {
  [K in keyof NewSessionDraftOptionsValue]-?: [
    NonNullable<NewSessionDraftOptionsValue[K]>,
  ] extends [NonNullable<CreateSessionRequest[K & keyof CreateSessionRequest]>]
    ? never
    : K;
}[keyof NewSessionDraftOptionsValue];
const draftOptionValuesAreCreateValues: [DraftOptionsCreateFieldsDisagree] extends [never]
  ? true
  : never = true;
void draftOptionValuesAreCreateValues;

/**
 * The form both sides of the exact-draft fence compare. It holds exactly the
 * contract's draft option keys, read from the saved options or from a create
 * request alike, so a new draft option is compared without a hand-written
 * list. Absent, null and empty-object values (an Agent learning override with
 * nothing overridden) all mean "not set"; arrays are kept even when empty,
 * because an empty list is a deliberate choice.
 */
export function comparableNewSessionDraftOptions(
  source: Partial<Record<keyof NewSessionDraftOptionsValue, unknown>>,
): NewSessionDraftOptionsValue {
  const comparable: Record<string, unknown> = {};
  for (const key of NEW_SESSION_DRAFT_OPTION_KEYS) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    if (
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.values(value).every((entry) => entry === undefined)
    ) {
      continue;
    }
    comparable[key] = value;
  }
  return comparable as NewSessionDraftOptionsValue;
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

function newSessionDraftProjectComputeSnapshot(
  options: NewSessionDraftOptionsValue,
): Record<string, unknown> {
  return {
    ...(Object.hasOwn(options, "sandboxBackend") ? { sandboxBackend: options.sandboxBackend } : {}),
    ...(Object.hasOwn(options, "targetSandboxId")
      ? { targetSandboxId: options.targetSandboxId }
      : {}),
    ...(Object.hasOwn(options, "workingDir") ? { workingDir: options.workingDir } : {}),
  };
}

function resolvedProjectProvenance(
  current: NewSessionDraftRow | null | undefined,
  incomingOptions: NewSessionDraftOptionsValue,
  explicitChannelId: string | null | undefined,
  explicit: boolean,
): {
  selectedProjectChannelId: string | null;
  selectedProjectComputeSnapshot: Record<string, unknown> | null;
} {
  if (explicit && explicitChannelId !== undefined) {
    return {
      selectedProjectChannelId: explicitChannelId,
      selectedProjectComputeSnapshot: newSessionDraftProjectComputeSnapshot(incomingOptions),
    };
  }
  if (
    current &&
    projectComputeMatches(publicNewSessionDraftOptions(current), incomingOptions) &&
    newSessionDraftSelectedProjectChannelId(current) !== undefined
  ) {
    return {
      selectedProjectChannelId: current.selectedProjectChannelId,
      selectedProjectComputeSnapshot: current.selectedProjectComputeSnapshot,
    };
  }
  return {
    selectedProjectChannelId: null,
    selectedProjectComputeSnapshot: null,
  };
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
    /** Omitted by older clients; the row then carries no marker. */
    modelProvided?: boolean;
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
          membershipOutsidePersonalWorkspace(),
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
  const projectProvenance = resolvedProjectProvenance(
    current,
    input.options,
    input.selectedProjectChannelId,
    Object.hasOwn(input, "selectedProjectChannelId"),
  );
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
      input.modelProvided,
    ),
    ...projectProvenance,
    updatedAt: new Date(),
  };
  if (current) {
    const [saved] = await db
      .update(schema.newSessionDrafts)
      .set(values)
      .where(eq(schema.newSessionDrafts.id, current.id))
      .returning();
    if (!saved) throw new Error("New-session draft did not save");
    await notifyActorDraftChanged(db, { ...input, sessionId: null });
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
  if (inserted) {
    await notifyActorDraftChanged(db, { ...input, sessionId: null });
    return inserted;
  }
  const raced = await getNewSessionDraftInTransaction(db, {
    ...input,
    lock: true,
  });
  throw new NewSessionDraftConflictError(raced?.revision ?? 0);
}

export function reusableNewSessionRepositoryResource(
  resource: RepositoryResourceRef,
): RepositoryResourceRef {
  // A repository's URI/ref/mount and GitHub identity are ordinary selection
  // state. Credential bindings, connection refs, access intent, and generic
  // provider ids are per-session authorization/runtime state and must not seed
  // the next create.
  const base: RepositoryResourceRef = {
    kind: "repository",
    uri: resource.uri,
    ref: resource.ref,
    ...(resource.mountPath ? { mountPath: resource.mountPath } : {}),
    ...(resource.subpath ? { subpath: resource.subpath } : {}),
  };
  // "As you" (personal GitHub) is a selection, not a grant: the next create is
  // authorized again against the person's live connection and allowlist. Its
  // lane fields are what tells that selection apart from a typed URL, and the
  // draft schema requires the binding selector and access with it, so keep the
  // complete lane; dropping it would bring the repository back as a manual URL.
  if (
    resource.connectionType === "github_personal" &&
    resource.provider === "github" &&
    typeof resource.credentialBindingId === "string" &&
    typeof resource.repositoryId === "string" &&
    (resource.access === "read" || resource.access === "write")
  ) {
    return {
      ...base,
      provider: "github",
      connectionType: "github_personal",
      credentialBindingId: resource.credentialBindingId,
      repositoryId: resource.repositoryId,
      access: resource.access,
    };
  }
  return {
    ...base,
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
        newSessionDraftModelProvided(current),
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

/**
 * Whether creating from this draft pins an explicit tool list. The composer
 * saves "Customize on, following workspace connectors minus exclusions" as an
 * explicit empty `tools` array plus `excludedMcpServerIds`, while its create
 * request omits `tools` (workspace defaults) and sends only the exclusions:
 * the create boundary rejects exclusions next to explicit tools. Both forms
 * are the same policy, so the exact-draft fence compares them as one.
 */
function newSessionDraftCreateToolsProvided(
  row: NewSessionDraftRow,
  options: NewSessionDraftOptionsValue,
): boolean {
  if (!newSessionDraftToolsProvided(row)) return false;
  return !(options.excludedMcpServerIds !== undefined && row.tools.length === 0);
}

/**
 * Whether the stored draft holds exactly what a create sent: the same text,
 * files, tools, model policy and create options.
 */
function newSessionDraftHolds(row: NewSessionDraftRow, sent: NewSessionDraftSnapshot): boolean {
  const options = publicNewSessionDraftOptions(row);
  const toolsProvided = newSessionDraftCreateToolsProvided(row, options);
  return (
    stableJson({
      text: row.text,
      resources: row.resources,
      tools: toolsProvided ? row.tools : [],
      toolsProvided,
      model: row.model,
      reasoningEffort: row.reasoningEffort,
      latencyMode: row.latencyMode,
      options: comparableNewSessionDraftOptions(options),
    }) ===
    stableJson({
      ...sent,
      options: comparableNewSessionDraftOptions(sent.options),
    })
  );
}

async function workspacePlacementDefaults(db: Database, workspaceId: string, subjectId: string) {
  const [row] = await db
    .select({ defaultRigId: schema.workspaces.defaultRigId, settings: schema.workspaces.settings })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);
  // The caller's own default ("Your default machine"). The seed runs with the
  // subject's RLS context, so only their own row is visible.
  const [memberRow] = await db
    .select({ subjectId: schema.workspaceMemberExecutionDefaults.subjectId })
    .from(schema.workspaceMemberExecutionDefaults)
    .where(
      and(
        eq(schema.workspaceMemberExecutionDefaults.workspaceId, workspaceId),
        eq(schema.workspaceMemberExecutionDefaults.subjectId, subjectId),
      ),
    )
    .limit(1);
  return {
    hasDefaultRig: Boolean(row?.defaultRigId),
    // Even a malformed configured value must not silently restore a different
    // computer. Session creation validates the configured target fail-closed.
    hasDefaultExecutionTarget:
      row?.settings?.defaultExecutionTarget != null || memberRow !== undefined,
  };
}

/**
 * After an accepted create, clear the draft it was sent from: replace it with
 * the next-create safe seed. Send carries its own content and is never refused
 * because of the draft. The draft is cleared only while it still holds what was
 * sent: it is still at the revision the sender last saw (`expectedRevision`),
 * or it holds exactly the sent content (`expectedSnapshot`). A newer draft
 * saved from another device since then stays as the draft; only the accepted
 * project and machine choice is remembered. A missing row is a no-op.
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
  const current = await lockCurrentNewSessionDraft(db, input);
  if (!current) return false;
  const holdsSent =
    current.revision === input.expectedRevision ||
    (input.expectedSnapshot !== undefined && newSessionDraftHolds(current, input.expectedSnapshot));
  if (!holdsSent) {
    if (input.acceptedSelection) {
      await db
        .update(schema.newSessionDrafts)
        .set({
          sessionOptions: storedOptions(
            publicNewSessionDraftOptions(current),
            newSessionDraftToolsProvided(current),
            rememberNewSessionSelection(
              newSessionSelectionHistory(current),
              input.acceptedSelection,
            ),
            newSessionDraftModelProvided(current),
          ),
        })
        .where(eq(schema.newSessionDrafts.id, current.id));
    }
    return false;
  }

  const parsedOptions = NewSessionDraftOptions.safeParse(publicNewSessionDraftOptions(current));
  const options = parsedOptions.success ? parsedOptions.data : {};
  const targetSandboxId =
    typeof options.targetSandboxId === "string" ? options.targetSandboxId : undefined;
  const selectedProjectChannelId = input.acceptedSelection
    ? input.acceptedSelection.channelId
    : newSessionDraftSelectedProjectChannelId(current);
  // A Sandbox Environment choice replaces the workspace default and the
  // default Variable Sets it carries. When the workspace or the person has a
  // default, that choice covers only the session it was made for: the next
  // form starts on the default again. Without a default nothing is replaced,
  // so the choice is remembered like any other selection.
  const defaults = await workspacePlacementDefaults(db, input.workspaceId, input.subjectId);
  const rememberCompute = !defaults.hasDefaultExecutionTarget;
  const rememberRig =
    typeof options.rigId === "string" && options.rigId.length > 0 && !defaults.hasDefaultRig;
  const safeOptions: NewSessionDraftOptionsValue = {
    // Keep the connector policy together. An exclusion-only draft stores
    // [] + toolsProvided=true; dropping its exclusions (even []) would turn
    // the next restored draft into an explicit selection of no connectors.
    ...(options.excludedMcpServerIds !== undefined
      ? { excludedMcpServerIds: options.excludedMcpServerIds }
      : {}),
    ...(options.visibility ? { visibility: options.visibility } : {}),
    ...(rememberCompute && options.sandboxBackend
      ? { sandboxBackend: options.sandboxBackend }
      : {}),
    ...(rememberCompute && targetSandboxId ? { targetSandboxId } : {}),
    ...(rememberCompute && targetSandboxId && typeof options.workingDir === "string"
      ? { workingDir: options.workingDir }
      : {}),
    ...(rememberRig ? { rigId: options.rigId } : {}),
  };
  const resources = (Array.isArray(current.resources) ? current.resources : []).flatMap((raw) => {
    if (!raw || typeof raw !== "object" || (raw as { kind?: unknown }).kind !== "repository") {
      return [];
    }
    return [reusableNewSessionRepositoryResource(raw as RepositoryResourceRef)];
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
        newSessionDraftModelProvided(current),
      ),
      selectedProjectChannelId: selectedProjectChannelId ?? null,
      selectedProjectComputeSnapshot:
        selectedProjectChannelId !== undefined
          ? newSessionDraftProjectComputeSnapshot(safeOptions)
          : null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.newSessionDrafts.id, current.id),
        eq(schema.newSessionDrafts.revision, current.revision),
      ),
    )
    .returning({ id: schema.newSessionDrafts.id });
  if (seeded) await notifyActorDraftChanged(db, { ...input, sessionId: null });
  return Boolean(seeded);
}

/** @deprecated Kept as a compatibility name for low-level callers. */
export const consumeNewSessionDraftInTransaction = seedNewSessionDraftInTransaction;
