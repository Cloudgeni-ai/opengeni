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
  getFiles,
  getLatestRunState,
  getHumanInputResumeForEvent,
  getSandboxSessionEnvelope,
  getSessionEvent,
  listSessionSystemUpdatesForTurn,
  requireFile,
  type Database,
} from "@opengeni/db";
import {
  stripReasoningEncryptedContent,
  stripReasoningIdentityFromSerializedRunState,
  neutralizeToolSearchItemsInSerializedRunState,
  type OpenGeniRuntime,
} from "@opengeni/runtime";

/**
 * The codex account THIS turn runs on, threaded into every history read path so a
 * cross-account turn never replays another account's encrypted reasoning. The
 * single rule across all paths: DROP any reasoning item whose producing codex
 * account differs from `currentCodexCredentialId`.
 *
 * `currentCodexCredentialId` is the resolved codex credential id on a codex turn,
 * or NULL on a non-codex turn (the "account" of the built-in Azure/OpenAI path).
 * NULL is a real value in the comparison, not a "skip" sentinel: a non-codex turn
 * (current = null) still drops codex-produced reasoning (producer != null) so a
 * foreign encrypted blob never reaches the Azure/built-in Responses call. A
 * session with no codex history (every producer == null == current) is a no-op.
 */
export type TurnCodexAccount = { currentCodexCredentialId: string | null };

/** A non-codex turn's account (current = null): no codex credential resolved. */
const NON_CODEX_TURN: TurnCodexAccount = { currentCodexCredentialId: null };

/**
 * Apply the cross-account reasoning strip to a set of stored history rows. Pure +
 * non-mutating. The single rule: a row whose producing codex account EQUALS the
 * turn's current account replays verbatim (by reference); a row produced by a
 * DIFFERENT account is treated by item type —
 *
 *  - `reasoning`  → DROPPED WHOLE (id + blob filtered out of the history). The
 *    foreign `rs_…` id is validated by the Responses backend, which rejects a
 *    reasoning item that has a foreign id and no encrypted_content (store:false),
 *    so blanking only the blob is not enough — the whole item must go.
 *  - `compaction` → kept, with only its account-bound `encrypted_content` blob
 *    stripped (its summary is real conversation content that must survive).
 *  - everything else (messages, tool calls, tool outputs) → kept verbatim by
 *    reference; message and tool content are never account-bound, never touched.
 *
 * Mismatch covers a foreign codex account, the non-codex/Azure producer (null on
 * a codex turn), and legacy untagged rows (null): all are stripped, which is
 * defensive and harmless (at most one turn of lost chain-of-thought continuity,
 * never any content). No-op (rows by reference) when every producer equals the
 * current account — a single-account workspace, an unchanged-account turn, or a
 * non-codex turn over a history with no codex-produced reasoning.
 */
export function applyCodexHistoryStrip(
  rows: ReadonlyArray<{
    item: Record<string, unknown>;
    producerCodexCredentialId: string | null;
    providerArtifactInvalidatedAt?: Date | null;
  }>,
  current: TurnCodexAccount,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    if (
      row.producerCodexCredentialId === current.currentCodexCredentialId &&
      !row.providerArtifactInvalidatedAt
    ) {
      out.push(row.item);
      continue;
    }
    const type = typeof row.item.type === "string" ? row.item.type : undefined;
    if (type === "reasoning") {
      // Foreign reasoning: drop the WHOLE item (id + blob) — see rule above.
      continue;
    }
    if (type === "tool_search_call" || type === "tool_search_output") {
      // Foreign tool_search items (progressive connector disclosure): drop WHOLE,
      // like reasoning. The `tsc_…` id is minted by the producing account's
      // backend, and the output's disclosure set reflects THAT account's
      // connectors — replaying either into a different account risks a 400 /
      // wrong-connector disclosure. Dropping both sides keeps the pair invariant
      // (the history sanitizer would drop a stranded half anyway); the model
      // simply re-searches on the new account, re-disclosing from the NEW
      // account's own connector pool. Never any content loss — search items
      // carry tool metadata, not conversation content.
      continue;
    }
    if (type === "compaction") {
      out.push(stripReasoningEncryptedContent(row.item));
      continue;
    }
    out.push(row.item);
  }
  return out;
}

/**
 * Resolve the serialized RunState used only for an approval resume, applying
 * the same cross-account rule as the canonical history-items path. The blob
 * carries no per-item producer tag, so we
 * compare the codex account that FROZE the state to the resuming turn's account:
 * when they differ, neutralize every reasoning item's account-bound identity
 * (encrypted_content + provider id) in the blob; when they match (including
 * null == null for non-codex / single-account) the blob replays byte-for-byte
 * (same string reference). This closes the gap where a frozen A-minted RunState
 * was replayed verbatim into a turn that switched to account B (or to a non-codex
 * turn), 400ing the resume.
 */
export function resumeRunStateForCodexAccount(
  state: {
    serializedRunState: string;
    frozenCodexCredentialId: string | null;
    providerArtifactInvalidatedAt?: Date | null;
  },
  current: TurnCodexAccount,
): string {
  if (
    state.frozenCodexCredentialId === current.currentCodexCredentialId &&
    !state.providerArtifactInvalidatedAt
  ) {
    return state.serializedRunState;
  }
  // Cross-account: neutralize reasoning identity in place AND flip frozen
  // tool_search pairs to execution:"server" in place (count-preserving — HOLE E
  // forbids removing blob items). The server flip makes the SDK skip its
  // client-executor rehydration (which would THROW when the resuming account's
  // connector pool differs from the freezing account's); the flipped shape is
  // live-verified wire-safe. The model can still re-search on this account.
  return neutralizeToolSearchItemsInSerializedRunState(
    stripReasoningIdentityFromSerializedRunState(state.serializedRunState),
  );
}

/**
 * Prepared model input plus the exact sanitized durable prefix represented by
 * that input. Carrying the runtime-produced count keeps item-mode cross-account
 * stripping and approval RunState neutralization path-correct without a second
 * active-history read during reconciliation.
 */
export type PreparedTurnInput = {
  input: Awaited<ReturnType<OpenGeniRuntime["prepareInput"]>>;
  persistedHistoryCount: number;
};

export type TurnInputOptions = {
  turnId: string;
  recovering?: boolean;
  unavailableSandboxFilesNote?: string;
  runCredentialsNote?: string;
  projectModelHistory?: ModelHistoryAttachmentProjector;
};

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
) => Promise<Array<Record<string, unknown>>>;

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

function attachmentUnavailableText(ref: FileResourceRef, file: FileAsset | undefined): string {
  const filename = file?.safeFilename ?? ref.fileId;
  const mediaType = file?.contentType ?? "unknown type";
  const path = file ? sandboxFilePath(ref, file) : `/workspace/${resourceMountPath(ref)}`;
  return (
    `[Attachment not included directly because the selected model does not accept this input ` +
    `or it exceeded the safe inline limit: ${filename} (${mediaType}). ` +
    `It remains available to tools in the sandbox at ${path}.]`
  );
}

/**
 * Build one turn-scoped durable-attachment projector. Metadata is batch-loaded
 * and file bytes are memoized, so compaction/retry can reuse the same work and
 * the SDK's repeated tool loop never touches storage or rescans old history.
 */
export function createModelHistoryAttachmentProjector(
  db: Database,
  workspaceId: string,
  policy: ModelAttachmentInputPolicy,
  readFileBytes?: (file: FileAsset) => Promise<Uint8Array>,
): ModelHistoryAttachmentProjector {
  const fileById = new Map<string, FileAsset>();
  const missingFileIds = new Set<string>();
  const contentById = new Map<string, ModelAttachmentContent>();
  const attemptedContentIds = new Set<string>();

  return async (items) => {
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

    const unknownIds = orderedFileIds.filter((id) => !fileById.has(id) && !missingFileIds.has(id));
    if (unknownIds.length > 0) {
      const files = await getFiles(db, workspaceId, unknownIds);
      for (const file of files) fileById.set(file.id, file);
      for (const id of unknownIds) {
        if (!fileById.has(id)) missingFileIds.add(id);
      }
    }

    if (readFileBytes) {
      // Prefer the newest attachments if the aggregate request safety limit is
      // reached; an old image becomes a marker instead of hiding the new prompt.
      const readable = [...orderedFileIds]
        .reverse()
        .map((id) => fileById.get(id))
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
      const attachmentParts = refs.map((ref) => {
        const attachment = contentById.get(ref.fileId);
        if (!attachment) {
          return {
            type: "input_text",
            text: attachmentUnavailableText(ref, fileById.get(ref.fileId)),
          };
        }
        return attachment.kind === "image"
          ? { type: "input_image", image: attachment.dataUrl }
          : {
              type: "input_file",
              file: attachment.dataUrl,
              filename: attachment.filename,
            };
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
  current: TurnCodexAccount = NON_CODEX_TURN,
  options: TurnInputOptions,
): Promise<PreparedTurnInput> {
  if (!trigger) {
    throw new Error("Missing trigger event");
  }
  const updates = await listSessionSystemUpdatesForTurn(
    db,
    trigger.workspaceId,
    trigger.sessionId,
    options.turnId,
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
  );
  if (trigger.type === "user.message") {
    const payload = trigger.payload as { text?: unknown; resources?: unknown };
    if (typeof payload.text !== "string" || payload.text.trim().length === 0) {
      throw new Error("user.message payload is missing text");
    }
    const resources = Array.isArray(payload.resources) ? (payload.resources as ResourceRef[]) : [];
    const fileAttachments = await resolveUserMessageFileAttachments(
      db,
      trigger.workspaceId,
      resources,
    );
    const attachmentContext = userMessageAttachmentsContext(fileAttachments);
    return await messageInput(
      db,
      runtime,
      agent,
      trigger,
      undefined,
      joinInternalContext(internalContext, attachmentContext),
      current,
      fileAttachments.map((attachment) => attachment.resource),
      options.projectModelHistory,
    );
  }
  if (trigger.type === "system.update.delivered") {
    if (updates.length === 0) {
      throw new Error("Internal update inference has no delivered updates");
    }
    return await messageInput(db, runtime, agent, trigger, undefined, internalContext, current);
  }
  if (trigger.type === "user.approvalDecision") {
    const payload = trigger.payload as {
      approvalId?: unknown;
      decision?: unknown;
      message?: unknown;
    };
    // Approvals are the one path that legitimately requires the RunState blob:
    // a turn frozen mid-flight cannot be represented as plain history items.
    const state = await getLatestRunState(db, trigger.workspaceId, trigger.sessionId);
    if (!state) {
      throw new Error("No saved run state is available for approval decision");
    }
    const input = await runtime.prepareInput(agent, {
      kind: "approval",
      // Cross-account run-state strip (HOLE C): if the account resuming this
      // frozen approval differs from the one that froze it, neutralize the
      // blob's account-bound reasoning before replay (else byte-for-byte).
      serializedRunState: resumeRunStateForCodexAccount(state, current),
      approvalId: String(payload.approvalId ?? ""),
      decision: payload.decision === "approve" ? "approve" : "reject",
      ...(typeof payload.message === "string" ? { message: payload.message } : {}),
    });
    return {
      input,
      // The approval RunState neutralizes foreign reasoning in place, so its
      // materialized history count includes those retained items (HOLE E).
      persistedHistoryCount: input.historyItemCount,
    };
  }
  if (trigger.type === "user.humanInputResponse") {
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
    const input = await runtime.prepareInput(agent, {
      kind: "human_input",
      serializedRunState: resumeRunStateForCodexAccount(state, current),
      toolCallId: resume.toolCallId,
    });
    return { input, persistedHistoryCount: input.historyItemCount };
  }
  throw new Error(`Unsupported trigger event type: ${trigger.type}`);
}

function joinInternalContext(...parts: Array<string | undefined>): string | undefined {
  const content = parts.map((part) => part?.trim()).filter((part): part is string => Boolean(part));
  return content.length > 0 ? content.join("\n\n") : undefined;
}

/** Build one inference from canonical history plus attempt-local operational context. */
async function messageInput(
  db: Database,
  runtime: OpenGeniRuntime,
  agent: any,
  trigger: NonNullable<Awaited<ReturnType<typeof getSessionEvent>>>,
  text: string | undefined,
  internalContext: string | undefined,
  current: TurnCodexAccount = NON_CODEX_TURN,
  currentAttachmentRefs: FileResourceRef[] = [],
  projectModelHistory?: ModelHistoryAttachmentProjector,
): Promise<PreparedTurnInput> {
  const stored = await getActiveSessionHistoryItemsPaged(
    db,
    trigger.workspaceId,
    trigger.sessionId,
  );
  const envelope = await getSandboxSessionEnvelope(db, trigger.workspaceId, trigger.sessionId);
  const referencedHistory = withCurrentUserAttachmentRefs(
    applyCodexHistoryStrip(stored, current),
    currentAttachmentRefs,
  );
  const historyItems = projectModelHistory
    ? await projectModelHistory(referencedHistory)
    : referencedHistory;
  const input = await runtime.prepareInput(agent, {
    kind: "message",
    ...(text ? { text } : {}),
    ...(internalContext ? { internalContext } : {}),
    historyItems: historyItems as any,
    sandboxEnvelope: envelope,
    ...(projectModelHistory ? { modelInputAlreadyProjected: true } : {}),
  });
  return { input, persistedHistoryCount: input.historyItemCount };
}

export async function userMessageTextWithAttachments(
  db: Database,
  workspaceId: string,
  text: string,
  resources: ResourceRef[],
): Promise<string> {
  const fileAttachments = await resolveUserMessageFileAttachments(db, workspaceId, resources);
  const attachmentContext = userMessageAttachmentsContext(fileAttachments);
  return attachmentContext ? [text, "", attachmentContext].join("\n") : text;
}

type UserMessageFileAttachment = {
  resource: Extract<ResourceRef, { kind: "file" }>;
  file: FileAsset;
};

async function resolveUserMessageFileAttachments(
  db: Database,
  workspaceId: string,
  resources: ResourceRef[],
): Promise<UserMessageFileAttachment[]> {
  const attachments: UserMessageFileAttachment[] = [];
  for (const resource of resources) {
    if (resource.kind !== "file") continue;
    const file = await requireFile(db, workspaceId, resource.fileId);
    attachments.push({ resource, file });
  }
  return attachments;
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
