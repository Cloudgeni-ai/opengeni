import {
  MODEL_ATTACHMENT_REFS_FIELD,
  FileResourceRef,
  resourceMountPath,
  type FileAsset,
  type ResourceRef,
} from "@opengeni/contracts";
import { createHash } from "node:crypto";
import {
  getActiveSessionHistoryItemsPaged,
  getFilesForSubject,
  getLatestRunState,
  getHumanInputResumeForEvent,
  getSandboxSessionEnvelope,
  getSessionEvent,
  listSessionSystemUpdatesForTurn,
  listTurnOpenSuffixToolCalls,
  type Database,
} from "@opengeni/db";
import {
  projectHistoryForProvider,
  projectRejectedProviderArtifactsFromSerializedRunState,
  projectRejectedReasoningArtifact,
  hasOpaqueProviderArtifact,
  type HistoryProviderApi,
  type OpenGeniRuntime,
} from "@opengeni/runtime";

/** Project only artifacts explicitly rejected by the provider out of its next view. */
export function projectRejectedProviderArtifacts(
  rows: ReadonlyArray<{
    item: Record<string, unknown>;
    providerArtifactInvalidatedAt?: Date | null;
  }>,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    if (!row.providerArtifactInvalidatedAt) {
      out.push(row.item);
      continue;
    }
    const type = typeof row.item.type === "string" ? row.item.type : undefined;
    if (type === "reasoning") {
      out.push(projectRejectedReasoningArtifact(row.item));
      continue;
    }
    if (type === "compaction") {
      continue;
    }
    out.push(row.item);
  }
  return out;
}

/** Build the attempt-local RunState view after an explicit provider rejection. */
export function resumeRunState(state: {
  serializedRunState: string;
  providerArtifactInvalidatedAt?: Date | null;
}): string {
  if (!state.providerArtifactInvalidatedAt) {
    return state.serializedRunState;
  }
  return projectRejectedProviderArtifactsFromSerializedRunState(state.serializedRunState);
}

/** Prepared input and its exact durable-history prefix length for reconciliation. */
export type PreparedTurnInput = {
  input: Awaited<ReturnType<OpenGeniRuntime["prepareInput"]>>;
  persistedHistoryCount: number;
  providerArtifactCandidates: {
    knownHistoryItemIds: string[];
    historyItemIds: string[];
    runStateId?: string;
  };
};

export type TurnInputOptions = {
  turnId: string;
  /** Frozen initiating-human authority for every model-visible file read. */
  fileAuthority: { accountId: string; subjectId: string | null };
  recovering?: boolean;
  unavailableSandboxFilesNote?: string;
  runCredentialsNote?: string;
  mcpAvailabilityNote?: string;
  providerApi: HistoryProviderApi;
  projectCanonicalHistory?: ModelHistoryAttachmentProjector;
  materializeModelHistory?: ModelHistoryAttachmentProjector;
  materializeSerializedRunState?: (serialized: string) => Promise<string>;
  projectModelHistory?: ModelHistoryAttachmentProjector;
  loadActiveHistory?: typeof getActiveSessionHistoryItemsPaged;
  /** Bounded critical-path timings; telemetry failures never affect preparation. */
  onPreparationPhase?: (measurement: HistoryPreparationPhaseMeasurement) => void;
};

export type HistoryPreparationPhase =
  | "system_update_load"
  | "current_attachment_resolution"
  | "durable_history_load"
  | "sandbox_envelope_load"
  | "canonical_projection"
  | "provider_projection"
  | "attachment_ref_projection"
  | "screenshot_materialization"
  | "model_attachment_projection"
  | "runtime_input_assembly"
  | "artifact_candidate_scan";

export type HistoryPreparationPhaseMeasurement = {
  phase: HistoryPreparationPhase;
  outcome: "completed" | "failed";
  durationSeconds: number;
};

async function measureHistoryPreparationPhase<T>(
  options: Pick<TurnInputOptions, "onPreparationPhase">,
  phase: HistoryPreparationPhase,
  operation: () => T | Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  let outcome: HistoryPreparationPhaseMeasurement["outcome"] = "completed";
  try {
    return await operation();
  } catch (error) {
    outcome = "failed";
    throw error;
  } finally {
    try {
      options.onPreparationPhase?.({
        phase,
        outcome,
        durationSeconds: (performance.now() - startedAt) / 1_000,
      });
    } catch {
      // Diagnostics must not change durable history or provider input.
    }
  }
}

export const MAX_INLINE_MODEL_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export type ModelAttachmentContent = {
  kind: "image" | "file";
  fileId: string;
  filename: string;
  contentType: string;
  dataUrl: string;
};

export type ModelHistoryAttachmentProjector = (
  items: Array<Record<string, unknown>>,
  options?: ModelHistoryAttachmentProjectionOptions,
) => Promise<Array<Record<string, unknown>>>;

export type ModelHistoryAttachmentProjectionOptions = {
  /** Exact, already-authorized files attached to the triggering message. */
  inlineFiles?: readonly FileAsset[];
};

export type ModelAttachmentInputPolicy = {
  supportsImageInput: boolean;
  inputFileMediaTypes: readonly string[];
};

const MODEL_IMAGE_CONTENT_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);

const MODEL_FILE_CONTENT_TYPES = new Set([
  "application/json",
  "application/pdf",
  "application/x-yaml",
  "application/yaml",
]);

// Generic XML has equivalent application/* and text/* registrations. Keep both
// aliases on the sandbox-path fallback until a provider parser boundary is
// explicitly supported and verified; MIME spelling must not bypass the fence.
const BLOCKED_TEXT_CONTENT_TYPES = new Set([
  "text/css",
  "text/html",
  "text/javascript",
  "text/xml",
]);

function safeErrorType(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const name = error.name.trim();
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name) ? name : "Error";
}

function modelAttachmentDescriptor(
  contentType: string,
): Pick<ModelAttachmentContent, "kind" | "contentType"> | null {
  const normalized = contentType.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  if (MODEL_IMAGE_CONTENT_TYPES.has(normalized)) {
    return { kind: "image", contentType: normalized };
  }
  if (
    MODEL_FILE_CONTENT_TYPES.has(normalized) ||
    (normalized.startsWith("text/") && !BLOCKED_TEXT_CONTENT_TYPES.has(normalized))
  ) {
    return { kind: "file", contentType: normalized };
  }
  return null;
}

export async function modelAttachmentContentForFiles(
  files: FileAsset[],
  readFileBytes: (file: FileAsset) => Promise<Uint8Array>,
): Promise<ModelAttachmentContent[]> {
  const selected: Array<{
    file: FileAsset;
    descriptor: Pick<ModelAttachmentContent, "kind" | "contentType">;
    checksum: string;
  }> = [];
  let remainingBytes = MAX_INLINE_MODEL_ATTACHMENT_BYTES;
  for (const file of files) {
    const descriptor = modelAttachmentDescriptor(file.contentType);
    const checksum = file.sha256?.trim().toLowerCase() ?? "";
    if (
      file.status !== "ready" ||
      !descriptor ||
      file.sizeBytes > remainingBytes ||
      !/^[a-f0-9]{64}$/.test(checksum)
    ) {
      continue;
    }
    selected.push({ file, descriptor, checksum });
    remainingBytes -= file.sizeBytes;
  }

  const attachments = new Array<ModelAttachmentContent | undefined>(selected.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < selected.length) {
      const index = cursor++;
      const { file, descriptor, checksum } = selected[index]!;
      try {
        const bytes = await readFileBytes(file);
        if (bytes.byteLength !== file.sizeBytes) {
          console.error("model attachment bytes did not match finalized metadata", {
            fileId: file.id,
            expectedSizeBytes: file.sizeBytes,
            actualSizeBytes: bytes.byteLength,
          });
          continue;
        }
        if (createHash("sha256").update(bytes).digest("hex") !== checksum) {
          console.error("model attachment checksum did not match finalized metadata", {
            fileId: file.id,
          });
          continue;
        }
        attachments[index] = {
          kind: descriptor.kind,
          fileId: file.id,
          filename: file.safeFilename,
          contentType: descriptor.contentType,
          dataUrl: `data:${descriptor.contentType};base64,${Buffer.from(bytes).toString("base64")}`,
        };
      } catch (error) {
        // The sandbox-path projection remains available for every file. A direct
        // provider-content read is an additive fast path and must not turn a
        // transient storage read into loss of the accepted prompt.
        console.error("model attachment content read failed; retaining sandbox path fallback", {
          fileId: file.id,
          errorType: safeErrorType(error),
        });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(8, selected.length) }, async () => await worker()),
  );
  return attachments.filter(
    (attachment): attachment is ModelAttachmentContent => attachment !== undefined,
  );
}

function modelAcceptsFileMediaType(
  policy: ModelAttachmentInputPolicy,
  contentType: string,
): boolean {
  const normalized = contentType.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  return policy.inputFileMediaTypes.some(
    (accepted) =>
      accepted === normalized ||
      (accepted.endsWith("/*") && normalized.startsWith(accepted.slice(0, -1))),
  );
}

function attachmentRefsFromItem(item: Record<string, unknown>): FileResourceRef[] {
  const raw = item[MODEL_ATTACHMENT_REFS_FIELD];
  if (!Array.isArray(raw)) return [];
  const refs: FileResourceRef[] = [];
  for (const candidate of raw) {
    const parsed = FileResourceRef.safeParse(candidate);
    if (parsed.success) refs.push(parsed.data);
  }
  return refs;
}

function attachmentReceiptText(ref: FileResourceRef, file: FileAsset | undefined): string {
  if (!file) {
    return (
      `[Earlier attachment: fileId=${ref.fileId}; mountDirectory=/workspace/${resourceMountPath(ref)}. ` +
      `Use the existing file there, or call files__files_get_download_url with this fileId and ` +
      `download it with the shell.]`
    );
  }
  const path = sandboxFilePath(ref, file);
  return (
    `[Attachment: ${file.safeFilename}; fileId=${file.id}; type=${file.contentType}; ` +
    `bytes=${file.sizeBytes}; path=${path}. If the local path is absent, call ` +
    `files__files_get_download_url with this fileId and download it with the shell.]`
  );
}

/**
 * Build one turn-scoped durable-attachment projector. Current attachment
 * metadata arrives already authorized; bytes are memoized for same-turn retry.
 * Historical projection has no database or object-storage path.
 */
export function createModelHistoryAttachmentProjector(
  policy: ModelAttachmentInputPolicy,
  readFileBytes?: (file: FileAsset) => Promise<Uint8Array>,
): ModelHistoryAttachmentProjector {
  const contentById = new Map<string, ModelAttachmentContent>();
  const attemptedContentIds = new Set<string>();

  return async (items, options = {}) => {
    const currentFileById = new Map((options.inlineFiles ?? []).map((file) => [file.id, file]));
    const refsByIndex = new Map<number, FileResourceRef[]>();
    const orderedFileIds: string[] = [];
    const seenFileIds = new Set<string>();
    for (let index = 0; index < items.length; index += 1) {
      const refs = attachmentRefsFromItem(items[index]!);
      if (refs.length === 0) continue;
      refsByIndex.set(index, refs);
      for (const ref of refs) {
        if (seenFileIds.has(ref.fileId)) continue;
        seenFileIds.add(ref.fileId);
        orderedFileIds.push(ref.fileId);
      }
    }
    if (refsByIndex.size === 0) return items;

    if (readFileBytes) {
      // Only the triggering message's attachments cross the provider byte
      // boundary. Historical messages retain compact durable receipts and can
      // recover bytes explicitly through the existing Files MCP + shell path.
      const readable = [...orderedFileIds]
        .reverse()
        .map((id) => currentFileById.get(id))
        .filter((file): file is FileAsset => {
          if (!file || attemptedContentIds.has(file.id)) return false;
          const descriptor = modelAttachmentDescriptor(file.contentType);
          return Boolean(
            descriptor &&
            ((descriptor.kind === "image" && policy.supportsImageInput) ||
              (descriptor.kind === "file" && modelAcceptsFileMediaType(policy, file.contentType))),
          );
        });
      for (const file of readable) attemptedContentIds.add(file.id);
      const content = await modelAttachmentContentForFiles(readable, readFileBytes);
      for (const attachment of content) contentById.set(attachment.fileId, attachment);
    }

    const projected = [...items];
    for (const [index, refs] of refsByIndex) {
      const original = items[index]!;
      const existingContent = Array.isArray(original.content)
        ? [...original.content]
        : [{ type: "input_text", text: String(original.content ?? "") }];
      const attachmentParts = refs.flatMap((ref) => {
        const currentFile = currentFileById.get(ref.fileId);
        const attachment = currentFile ? contentById.get(ref.fileId) : undefined;
        const receipt = {
          type: "input_text",
          text: attachmentReceiptText(ref, currentFile),
        };
        if (!attachment) {
          return [receipt];
        }
        return [
          receipt,
          attachment.kind === "image"
            ? { type: "input_image", image: attachment.dataUrl }
            : {
                type: "input_file",
                file: attachment.dataUrl,
                filename: attachment.filename,
              },
        ];
      });
      const clone: Record<string, unknown> = {
        ...original,
        content: [...existingContent, ...attachmentParts],
      };
      delete clone[MODEL_ATTACHMENT_REFS_FIELD];
      projected[index] = clone;
    }
    return projected;
  };
}

/** Add current trigger refs only when older/local history predates durable stamping. */
export function withCurrentUserAttachmentRefs(
  historyItems: Array<Record<string, unknown>>,
  refs: FileResourceRef[],
): Array<Record<string, unknown>> {
  if (refs.length === 0) return historyItems;
  for (let index = historyItems.length - 1; index >= 0; index -= 1) {
    const item = historyItems[index]!;
    if (item.type !== "message" || item.role !== "user") continue;
    const existing = attachmentRefsFromItem(item);
    const existingIds = new Set(existing.map((ref) => ref.fileId));
    const additions = refs.filter((ref) => !existingIds.has(ref.fileId));
    if (additions.length === 0) return historyItems;
    const projected = [...historyItems];
    projected[index] = { ...item, [MODEL_ATTACHMENT_REFS_FIELD]: [...existing, ...additions] };
    return projected;
  }
  return historyItems;
}

export async function turnInput(
  db: Database,
  runtime: OpenGeniRuntime,
  agent: any,
  trigger: Awaited<ReturnType<typeof getSessionEvent>>,
  options: TurnInputOptions,
): Promise<PreparedTurnInput> {
  if (!trigger) {
    throw new Error("Missing trigger event");
  }
  const updates = await measureHistoryPreparationPhase(
    options,
    "system_update_load",
    async () =>
      await listSessionSystemUpdatesForTurn(
        db,
        trigger.workspaceId,
        trigger.sessionId,
        options.turnId,
      ),
  );
  if (updates.length > 0) {
    const historyItemIds = new Set(
      updates.map((update) => update.deliveredHistoryItemId).filter(Boolean),
    );
    if (historyItemIds.size !== 1 || updates.some((update) => !update.deliveredHistoryItemId)) {
      throw new Error("Delivered internal updates have no single durable model-memory batch");
    }
  }
  const internalContext = joinInternalContext(
    options.recovering
      ? [
          "[OpenGeni inference recovery]",
          "Continue the same inference from durable conversation and sandbox state. A previous execution stopped before it could finish. Do not repeat completed side effects; inspect actual state when uncertain.",
        ].join("\n")
      : undefined,
    options.unavailableSandboxFilesNote,
    options.runCredentialsNote,
    options.mcpAvailabilityNote,
  );
  if (trigger.type === "user.message") {
    const payload = trigger.payload as {
      text?: unknown;
      annotations?: unknown;
      resources?: unknown;
    };
    const hasAnnotations = Array.isArray(payload.annotations) && payload.annotations.length > 0;
    if (typeof payload.text !== "string" || (payload.text.trim().length === 0 && !hasAnnotations)) {
      throw new Error("user.message payload is missing text and annotations");
    }
    const resources = Array.isArray(payload.resources) ? (payload.resources as ResourceRef[]) : [];
    const fileAttachments = await measureHistoryPreparationPhase(
      options,
      "current_attachment_resolution",
      async () =>
        await resolveUserMessageFileAttachments(
          db,
          options.fileAuthority.accountId,
          trigger.workspaceId,
          options.fileAuthority.subjectId,
          resources,
        ),
    );
    const attachmentContext = userMessageAttachmentsContext(fileAttachments);
    return await messageInput(
      db,
      runtime,
      agent,
      trigger,
      undefined,
      joinInternalContext(internalContext, attachmentContext),
      fileAttachments,
      options.providerApi,
      options.projectCanonicalHistory,
      options.materializeModelHistory,
      options.projectModelHistory,
      options.loadActiveHistory,
      options,
    );
  }
  if (trigger.type === "system.update.delivered") {
    if (updates.length === 0) {
      throw new Error("Internal update inference has no delivered updates");
    }
    return await messageInput(
      db,
      runtime,
      agent,
      trigger,
      undefined,
      internalContext,
      [],
      options.providerApi,
      options.projectCanonicalHistory,
      options.materializeModelHistory,
      options.projectModelHistory,
      options.loadActiveHistory,
      options,
    );
  }
  if (trigger.type === "user.approvalDecision") {
    const payload = trigger.payload as {
      approvalId?: unknown;
      decision?: unknown;
      message?: unknown;
    };
    const suffixInput = await openSuffixMessageInputIfReady(
      db,
      runtime,
      agent,
      trigger,
      internalContext,
      options,
    );
    if (suffixInput) {
      return suffixInput;
    }
    // Expand-era leftover: writers without an open suffix still resume from the
    // SDK RunState blob. New pauses persist interruption rows and prefer them.
    const state = await getLatestRunState(db, trigger.workspaceId, trigger.sessionId);
    if (!state) {
      throw new Error("No saved run state is available for approval decision");
    }
    const serializedRunState = resumeRunState(state);
    const prepared = await runtime.prepareInput(agent, {
      kind: "approval",
      serializedRunState: options.materializeSerializedRunState
        ? await options.materializeSerializedRunState(serializedRunState)
        : serializedRunState,
      approvalId: String(payload.approvalId ?? ""),
      decision: payload.decision === "approve" ? "approve" : "reject",
      ...(typeof payload.message === "string" ? { message: payload.message } : {}),
    });
    return {
      input: prepared,
      persistedHistoryCount: prepared.persistedHistoryCount,
      providerArtifactCandidates: {
        knownHistoryItemIds: [],
        historyItemIds: [],
        runStateId: state.id,
      },
    };
  }
  if (trigger.type === "user.humanInputResponse") {
    const suffixInput = await openSuffixMessageInputIfReady(
      db,
      runtime,
      agent,
      trigger,
      internalContext,
      options,
    );
    if (suffixInput) {
      return suffixInput;
    }
    const [state, resume] = await Promise.all([
      getLatestRunState(db, trigger.workspaceId, trigger.sessionId),
      getHumanInputResumeForEvent(db, trigger.workspaceId, trigger.sessionId, trigger),
    ]);
    if (!state) {
      throw new Error("No saved run state is available for human-input response");
    }
    if (!resume) {
      throw new Error("Human-input response does not resolve to a durable request");
    }
    const serializedRunState = resumeRunState(state);
    const prepared = await runtime.prepareInput(agent, {
      kind: "human_input",
      serializedRunState: options.materializeSerializedRunState
        ? await options.materializeSerializedRunState(serializedRunState)
        : serializedRunState,
      toolCallId: resume.toolCallId,
    });
    return {
      input: prepared,
      persistedHistoryCount: prepared.persistedHistoryCount,
      providerArtifactCandidates: {
        knownHistoryItemIds: [],
        historyItemIds: [],
        runStateId: state.id,
      },
    };
  }
  throw new Error(`Unsupported trigger event type: ${trigger.type}`);
}

function joinInternalContext(...parts: Array<string | undefined>): string | undefined {
  const content = parts.map((part) => part?.trim()).filter((part): part is string => Boolean(part));
  return content.length > 0 ? content.join("\n\n") : undefined;
}

async function openSuffixMessageInputIfReady(
  db: Database,
  runtime: OpenGeniRuntime,
  agent: any,
  trigger: NonNullable<Awaited<ReturnType<typeof getSessionEvent>>>,
  internalContext: string | undefined,
  options: TurnInputOptions,
): Promise<PreparedTurnInput | null> {
  const suffixRows = await listTurnOpenSuffixToolCalls(
    db,
    trigger.workspaceId,
    trigger.sessionId,
    options.turnId,
  );
  if (suffixRows.length === 0) {
    return null;
  }
  if (suffixRows.some((row) => row.resultItem == null)) {
    throw new Error("Open suffix resume still has unresolved members");
  }
  return await messageInput(
    db,
    runtime,
    agent,
    trigger,
    undefined,
    internalContext,
    [],
    options.providerApi,
    options.projectCanonicalHistory,
    options.materializeModelHistory,
    options.projectModelHistory,
    options.loadActiveHistory,
    options,
  );
}

/** Build one inference from canonical history plus attempt-local operational context. */
async function messageInput(
  db: Database,
  runtime: OpenGeniRuntime,
  agent: any,
  trigger: NonNullable<Awaited<ReturnType<typeof getSessionEvent>>>,
  text: string | undefined,
  internalContext: string | undefined,
  currentAttachments: UserMessageFileAttachment[] = [],
  providerApi: HistoryProviderApi = "responses",
  projectCanonicalHistory?: ModelHistoryAttachmentProjector,
  materializeModelHistory?: ModelHistoryAttachmentProjector,
  projectModelHistory?: ModelHistoryAttachmentProjector,
  loadActiveHistory: typeof getActiveSessionHistoryItemsPaged = getActiveSessionHistoryItemsPaged,
  preparationOptions: Pick<TurnInputOptions, "onPreparationPhase"> = {},
): Promise<PreparedTurnInput> {
  const currentAttachmentRefs = currentAttachments.map((attachment) => attachment.resource);
  const [stored, envelope] = await Promise.all([
    measureHistoryPreparationPhase(preparationOptions, "durable_history_load", async () =>
      loadActiveHistory(db, trigger.workspaceId, trigger.sessionId),
    ),
    measureHistoryPreparationPhase(preparationOptions, "sandbox_envelope_load", async () =>
      getSandboxSessionEnvelope(db, trigger.workspaceId, trigger.sessionId),
    ),
  ]);
  const canonicalView = await measureHistoryPreparationPhase(
    preparationOptions,
    "canonical_projection",
    async () => {
      const active = projectRejectedProviderArtifacts(stored);
      return projectCanonicalHistory ? await projectCanonicalHistory(active) : active;
    },
  );
  const providerView = await measureHistoryPreparationPhase(
    preparationOptions,
    "provider_projection",
    () => projectHistoryForProvider(canonicalView, providerApi),
  );
  const referencedHistory = await measureHistoryPreparationPhase(
    preparationOptions,
    "attachment_ref_projection",
    () => withCurrentUserAttachmentRefs(providerView, currentAttachmentRefs),
  );
  const materializedHistory = await measureHistoryPreparationPhase(
    preparationOptions,
    "screenshot_materialization",
    async () =>
      materializeModelHistory
        ? await materializeModelHistory(referencedHistory)
        : referencedHistory,
  );
  const historyItems = await measureHistoryPreparationPhase(
    preparationOptions,
    "model_attachment_projection",
    async () =>
      projectModelHistory
        ? await projectModelHistory(materializedHistory, {
            inlineFiles: currentAttachments.map((attachment) => attachment.file),
          })
        : materializedHistory,
  );
  const prepared = await measureHistoryPreparationPhase(
    preparationOptions,
    "runtime_input_assembly",
    async () =>
      await runtime.prepareInput(agent, {
        kind: "message",
        ...(text ? { text } : {}),
        ...(internalContext ? { internalContext } : {}),
        historyItems: historyItems as any,
        sandboxEnvelope: envelope,
        ...(projectModelHistory ? { modelInputAlreadyProjected: true } : {}),
      }),
  );
  const providerArtifactCandidates = await measureHistoryPreparationPhase(
    preparationOptions,
    "artifact_candidate_scan",
    () => {
      const preparedItems = Array.isArray(prepared.input)
        ? new Set(prepared.input)
        : new Set<unknown>();
      return {
        knownHistoryItemIds: stored.map((row) => row.id),
        historyItemIds: stored
          .filter(
            (row) =>
              row.providerArtifactInvalidatedAt === null &&
              hasOpaqueProviderArtifact(row.item) &&
              preparedItems.has(row.item),
          )
          .map((row) => row.id),
      };
    },
  );
  return {
    input: prepared,
    persistedHistoryCount: prepared.persistedHistoryCount,
    providerArtifactCandidates,
  };
}

export async function userMessageTextWithAttachments(
  db: Database,
  accountId: string,
  workspaceId: string,
  subjectId: string | null,
  text: string,
  resources: ResourceRef[],
): Promise<string> {
  const fileAttachments = await resolveUserMessageFileAttachments(
    db,
    accountId,
    workspaceId,
    subjectId,
    resources,
  );
  const attachmentContext = userMessageAttachmentsContext(fileAttachments);
  return attachmentContext ? [text, "", attachmentContext].join("\n") : text;
}

type UserMessageFileAttachment = {
  resource: Extract<ResourceRef, { kind: "file" }>;
  file: FileAsset;
};

async function resolveUserMessageFileAttachments(
  db: Database,
  accountId: string,
  workspaceId: string,
  subjectId: string | null,
  resources: ResourceRef[],
): Promise<UserMessageFileAttachment[]> {
  const fileResources = resources.filter(
    (resource): resource is FileResourceRef => resource.kind === "file",
  );
  if (fileResources.length === 0) return [];
  const files = await getFilesForSubject(db, {
    accountId,
    workspaceId,
    subjectId,
    fileIds: fileResources.map((resource) => resource.fileId),
  });
  const fileById = new Map(files.map((file) => [file.id, file]));
  return fileResources.map((resource) => {
    const file = fileById.get(resource.fileId);
    if (!file) throw new Error(`File not found: ${resource.fileId}`);
    return { resource, file };
  });
}

function userMessageAttachmentsContext(
  attachments: UserMessageFileAttachment[],
): string | undefined {
  const attachedFiles = attachments.map(
    ({ resource, file }) =>
      `- ${file.filename} (${file.contentType}, ${file.sizeBytes} bytes): ${sandboxFilePath(resource, file)}`,
  );
  if (attachedFiles.length === 0) {
    return undefined;
  }
  return ["Attached files are available in the sandbox:", ...attachedFiles].join("\n");
}

function sandboxFilePath(
  resource: Extract<ResourceRef, { kind: "file" }>,
  file: FileAsset,
): string {
  return `/workspace/${resourceMountPath(resource)}/${file.safeFilename}`;
}
