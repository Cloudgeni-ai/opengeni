import type { Settings } from "@opengeni/config";
import { contextInputBudgetTokens, resolveContextCompactionMode } from "@opengeni/config";
import type { FileAsset, ResourceRef } from "@opengeni/contracts";
import {
  getActiveSessionHistoryItems,
  getLatestRunState,
  getSandboxSessionEnvelope,
  getSessionEvent,
  requireFile,
  type Database,
} from "@opengeni/db";
import { stripReasoningEncryptedContent, type OpenGeniRuntime } from "@opengeni/runtime";

/**
 * The turn's current codex account, threaded into the history read path so it can
 * strip cross-account `reasoning.encrypted_content` blobs. Non-null ONLY for a
 * codex-billed turn with a resolved account; null for every non-codex turn (then
 * the strip is a no-op and stored items replay byte-for-byte). When non-null, any
 * carried history item whose producer != `currentCodexCredentialId` has its
 * encrypted reasoning dropped (message content is always preserved).
 */
export type CodexHistoryStrip = { currentCodexCredentialId: string };

/**
 * Apply the cross-account encrypted-reasoning strip to a set of stored history
 * rows. Pure + non-mutating. A row keeps its item verbatim unless this is a codex
 * turn (`codexStrip` non-null) AND the row was produced by a DIFFERENT codex
 * account (`producerCodexCredentialId !== currentCodexCredentialId`) — in which
 * case the item's account/org-bound reasoning.encrypted_content is dropped
 * (message content preserved). Mismatch covers a foreign codex account, the
 * non-codex/Azure producer (null), and legacy untagged rows (null): all are
 * stripped on a codex turn, which is defensive and harmless (one turn of lost
 * chain-of-thought continuity at most). No-op when `codexStrip` is null
 * (non-codex turn) or every producer equals the current account (single-account
 * workspace / unchanged-account turn) — those rows pass through by reference.
 */
export function applyCodexHistoryStrip(
  rows: ReadonlyArray<{ item: Record<string, unknown>; producerCodexCredentialId: string | null }>,
  codexStrip: CodexHistoryStrip | null,
): Array<Record<string, unknown>> {
  return rows.map((row) =>
    codexStrip && row.producerCodexCredentialId !== codexStrip.currentCodexCredentialId
      ? stripReasoningEncryptedContent(row.item)
      : row.item);
}

export async function turnInput(
  db: Database,
  runtime: OpenGeniRuntime,
  agent: any,
  trigger: Awaited<ReturnType<typeof getSessionEvent>>,
  settings?: Settings,
  codexStrip: CodexHistoryStrip | null = null,
) {
  if (!trigger) {
    throw new Error("Missing trigger event");
  }
  if (trigger.type === "user.message") {
    const payload = trigger.payload as { text?: unknown; resources?: unknown };
    if (typeof payload.text !== "string" || payload.text.trim().length === 0) {
      throw new Error("user.message payload is missing text");
    }
    const text = await userMessageTextWithAttachments(
      db,
      trigger.workspaceId,
      payload.text,
      Array.isArray(payload.resources) ? payload.resources as ResourceRef[] : [],
    );
    return await messageInput(db, runtime, agent, trigger, text, settings, codexStrip);
  }
  if (trigger.type === "goal.continuation") {
    const payload = trigger.payload as { text?: unknown };
    if (typeof payload.text !== "string" || payload.text.trim().length === 0) {
      throw new Error("goal.continuation payload is missing text");
    }
    // Threading the stored conversation keeps the agent's full context across
    // continuations — this is what makes "keep working" coherent.
    return await messageInput(db, runtime, agent, trigger, payload.text, settings, codexStrip);
  }
  if (trigger.type === "turn.preempted") {
    const payload = trigger.payload as { text?: unknown };
    if (typeof payload.text !== "string" || payload.text.trim().length === 0) {
      throw new Error("turn.preempted payload is missing text");
    }
    // A turn re-entering after a graceful worker shutdown checkpointed it
    // mid-flight: thread the stored conversation (which includes the turn's
    // original input and its progress so far) behind a resume notice.
    return await messageInput(db, runtime, agent, trigger, payload.text, settings, codexStrip);
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
    return await runtime.prepareInput(agent, {
      kind: "approval",
      serializedRunState: state.serializedRunState,
      approvalId: String(payload.approvalId ?? ""),
      decision: payload.decision === "approve" ? "approve" : "reject",
      ...(typeof payload.message === "string" ? { message: payload.message } : {}),
    });
  }
  throw new Error(`Unsupported trigger event type: ${trigger.type}`);
}

/**
 * Build a message/continuation turn input from the configured history source.
 * Items mode reads conversation truth from session_history_items and the
 * sandbox envelope from its own store; a session with no stored items yet
 * (created before dual-write, or its first turn) falls back to the RunState
 * blob for this turn — the turn-end reconciliation then backfills its items,
 * so the fallback is self-eliminating (issue #35).
 */
async function messageInput(
  db: Database,
  runtime: OpenGeniRuntime,
  agent: any,
  trigger: NonNullable<Awaited<ReturnType<typeof getSessionEvent>>>,
  text: string,
  settings?: Settings,
  codexStrip: CodexHistoryStrip | null = null,
) {
  // Read-path budget guard (the last-resort backstop behind best-effort pre-turn
  // compaction): supply B only when the client-side compaction path is active
  // (Azure). On the OpenAI server path the SDK manages the window, so we leave
  // the guard off and never crudely trim. Undefined = guard disabled.
  const inputBudgetTokens = readPathBudgetTokens(settings);
  if (settings?.sessionHistorySource === "items") {
    // Active rows only: after a client-side context compaction this is
    // [active summary, ...active recent tail]; superseded (summarized-away)
    // prefix rows stay in the table as an audit trail but never reach the model.
    const stored = await getActiveSessionHistoryItems(db, trigger.workspaceId, trigger.sessionId);
    if (stored.length > 0) {
      const envelope = await getSandboxSessionEnvelope(db, trigger.workspaceId, trigger.sessionId);
      // Cross-account encrypted-reasoning strip: on a codex turn, drop the
      // account/org-bound reasoning.encrypted_content of any carried item NOT
      // produced by THIS turn's codex account (a foreign blob 400s the codex
      // backend). No-op for non-codex turns (codexStrip null), single-account
      // workspaces, and unchanged-account turns (every producer == current), so
      // those replay byte-for-byte. Message content is never touched.
      const historyItems = applyCodexHistoryStrip(stored, codexStrip);
      return await runtime.prepareInput(
        agent,
        {
          kind: "message",
          text,
          historyItems: historyItems as any,
          sandboxEnvelope: envelope,
        },
        inputBudgetTokens ? { inputBudgetTokens } : {},
      );
    }
  }
  const latestState = await getLatestRunState(db, trigger.workspaceId, trigger.sessionId);
  return await runtime.prepareInput(
    agent,
    {
      kind: "message",
      text,
      serializedRunState: latestState?.serializedRunState ?? null,
    },
    inputBudgetTokens ? { inputBudgetTokens } : {},
  );
}

/**
 * The usable input-token budget B to hand the read-path guard, or undefined
 * when the guard should stay off. Active only when the resolved compaction mode
 * is "client" (the Azure path that runs our own compaction); on the server path
 * the SDK enforces the window, and with no settings we can't compute B.
 */
function readPathBudgetTokens(settings?: Settings): number | undefined {
  if (!settings || resolveContextCompactionMode(settings) !== "client") {
    return undefined;
  }
  const budget = contextInputBudgetTokens(settings);
  return budget > 0 ? budget : undefined;
}

export async function userMessageTextWithAttachments(
  db: Database,
  workspaceId: string,
  text: string,
  resources: ResourceRef[],
): Promise<string> {
  const attachedFiles: string[] = [];
  for (const resource of resources) {
    if (resource.kind !== "file") {
      continue;
    }
    const file = await requireFile(db, workspaceId, resource.fileId);
    attachedFiles.push(`- ${file.filename} (${file.contentType}, ${file.sizeBytes} bytes): ${sandboxFilePath(resource, file)}`);
  }
  if (attachedFiles.length === 0) {
    return text;
  }
  return [
    text,
    "",
    "Attached files are available in the sandbox:",
    ...attachedFiles,
  ].join("\n");
}

function sandboxFilePath(resource: Extract<ResourceRef, { kind: "file" }>, file: FileAsset): string {
  return `/workspace/${resource.mountPath ?? `files/${file.id}`}/${file.safeFilename}`;
}
