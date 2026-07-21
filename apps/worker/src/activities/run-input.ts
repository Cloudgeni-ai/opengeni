import type { FileAsset, ResourceRef, SessionSystemUpdate } from "@opengeni/contracts";
import {
  getActiveSessionHistoryItems,
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
  rows: ReadonlyArray<{ item: Record<string, unknown>; producerCodexCredentialId: string | null }>,
  current: TurnCodexAccount,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    if (row.producerCodexCredentialId === current.currentCodexCredentialId) {
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
  state: { serializedRunState: string; frozenCodexCredentialId: string | null },
  current: TurnCodexAccount,
): string {
  if (state.frozenCodexCredentialId === current.currentCodexCredentialId) {
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
 * A prepared turn input plus the watermark-seed discriminator the reconcile pass
 * needs (HOLE E). `modelHistoryFromItems` is TRUE iff `state.history` was seeded
 * from the cross-account-STRIPPED active history items (the items read path) — so
 * the turn-end reconcile must seed `persistedHistoryCount` from the SAME strip
 * (HOLE D). It is FALSE only when `state.history` was seeded from the approval
 * RunState: there
 * foreign reasoning is NEUTRALIZED-IN-PLACE by {@link resumeRunStateForCodexAccount}
 * (the item is KEPT, only its id/encrypted_content go), so the blob's history
 * length still COUNTS those items. Seeding the watermark with the strip on that
 * path under-counts by K and the reconcile re-appends K already-persisted items at
 * fresh positions — that is HOLE E. The watermark must therefore NOT strip on the
 * blob path (count the raw sanitized active length, matching the blob).
 */
export type PreparedTurnInput = {
  input: Awaited<ReturnType<OpenGeniRuntime["prepareInput"]>>;
  modelHistoryFromItems: boolean;
};

export type TurnInputOptions = {
  turnId: string;
  recovering?: boolean;
  unavailableSandboxFilesNote?: string;
};

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
  const updateContext = systemUpdateContext(updates);
  const internalContext = joinInternalContext(
    options.recovering
      ? [
          "[OpenGeni inference recovery]",
          "Continue the same inference from durable conversation and sandbox state. A previous execution stopped before it could finish. Do not repeat completed side effects; inspect actual state when uncertain.",
        ].join("\n")
      : undefined,
    updateContext,
    options.unavailableSandboxFilesNote,
  );
  if (trigger.type === "user.message") {
    const payload = trigger.payload as { text?: unknown; resources?: unknown };
    if (typeof payload.text !== "string" || payload.text.trim().length === 0) {
      throw new Error("user.message payload is missing text");
    }
    const attachmentContext = await userMessageAttachmentsContext(
      db,
      trigger.workspaceId,
      Array.isArray(payload.resources) ? (payload.resources as ResourceRef[]) : [],
    );
    return await messageInput(
      db,
      runtime,
      agent,
      trigger,
      undefined,
      joinInternalContext(internalContext, attachmentContext),
      current,
    );
  }
  if (trigger.type === "system.update.delivered") {
    if (!internalContext) throw new Error("Internal update inference has no delivered updates");
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
    return {
      input: await runtime.prepareInput(agent, {
        kind: "approval",
        // Cross-account run-state strip (HOLE C): if the account resuming this
        // frozen approval differs from the one that froze it, neutralize the
        // blob's account-bound reasoning before replay (else byte-for-byte).
        serializedRunState: resumeRunStateForCodexAccount(state, current),
        approvalId: String(payload.approvalId ?? ""),
        decision: payload.decision === "approve" ? "approve" : "reject",
        ...(typeof payload.message === "string" ? { message: payload.message } : {}),
      }),
      // Model seeded from the run-state BLOB (neutralize-in-place), NOT stripped
      // items: the reconcile watermark must NOT apply the cross-account strip
      // (HOLE E) — else a cross-account approval resume re-appends K
      // already-persisted items at fresh positions.
      modelHistoryFromItems: false,
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
    return {
      input: await runtime.prepareInput(agent, {
        kind: "human_input",
        serializedRunState: resumeRunStateForCodexAccount(state, current),
        toolCallId: resume.toolCallId,
      }),
      modelHistoryFromItems: false,
    };
  }
  throw new Error(`Unsupported trigger event type: ${trigger.type}`);
}

function joinInternalContext(...parts: Array<string | undefined>): string | undefined {
  const content = parts.map((part) => part?.trim()).filter((part): part is string => Boolean(part));
  return content.length > 0 ? content.join("\n\n") : undefined;
}

function systemUpdateContext(updates: SessionSystemUpdate[]): string | undefined {
  if (updates.length === 0) return undefined;
  return [
    "[OpenGeni internal updates]",
    "These platform updates were delivered together for this inference. They are not human prompts.",
    JSON.stringify({
      updates: updates.map((update) => ({
        id: update.id,
        kind: update.kind,
        classification: update.classification,
        sourceId: update.sourceId,
        summary: update.summary,
        payload: update.payload,
        lineage: update.lineage,
      })),
    }),
  ].join("\n");
}

/** Build one inference from canonical history plus optional ephemeral system context. */
async function messageInput(
  db: Database,
  runtime: OpenGeniRuntime,
  agent: any,
  trigger: NonNullable<Awaited<ReturnType<typeof getSessionEvent>>>,
  text: string | undefined,
  internalContext: string | undefined,
  current: TurnCodexAccount = NON_CODEX_TURN,
): Promise<PreparedTurnInput> {
  const stored = await getActiveSessionHistoryItems(db, trigger.workspaceId, trigger.sessionId);
  const envelope = await getSandboxSessionEnvelope(db, trigger.workspaceId, trigger.sessionId);
  const historyItems = applyCodexHistoryStrip(stored, current);
  return {
    input: await runtime.prepareInput(agent, {
      kind: "message",
      ...(text ? { text } : {}),
      ...(internalContext ? { internalContext } : {}),
      historyItems: historyItems as any,
      sandboxEnvelope: envelope,
    }),
    modelHistoryFromItems: true,
  };
}

export async function userMessageTextWithAttachments(
  db: Database,
  workspaceId: string,
  text: string,
  resources: ResourceRef[],
): Promise<string> {
  const attachmentContext = await userMessageAttachmentsContext(db, workspaceId, resources);
  return attachmentContext ? [text, "", attachmentContext].join("\n") : text;
}

async function userMessageAttachmentsContext(
  db: Database,
  workspaceId: string,
  resources: ResourceRef[],
): Promise<string | undefined> {
  const attachedFiles: string[] = [];
  for (const resource of resources) {
    if (resource.kind !== "file") {
      continue;
    }
    const file = await requireFile(db, workspaceId, resource.fileId);
    attachedFiles.push(
      `- ${file.filename} (${file.contentType}, ${file.sizeBytes} bytes): ${sandboxFilePath(resource, file)}`,
    );
  }
  if (attachedFiles.length === 0) {
    return undefined;
  }
  return ["Attached files are available in the sandbox:", ...attachedFiles].join("\n");
}

function sandboxFilePath(
  resource: Extract<ResourceRef, { kind: "file" }>,
  file: FileAsset,
): string {
  return `/workspace/${resource.mountPath ?? `files/${file.id}`}/${file.safeFilename}`;
}
