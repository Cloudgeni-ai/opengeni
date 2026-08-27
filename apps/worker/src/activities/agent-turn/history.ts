import {
  normalizeProtocolJsonValue,
  sanitizeHistoryItemsForModel,
  toolCallIdFromSdkItem,
} from "@opengeni/runtime";
import { opaqueProviderArtifactFingerprint } from "@opengeni/codex";

export function historyRowsToAppend(
  rawHistory: Array<Record<string, unknown>>,
  // How many items of the CURRENT in-memory history are already persisted (the
  // slice index into `sanitized`). This is the in-memory history length, NOT the
  // total persisted-row count: after a compaction the in-memory history is the
  // short [summary, ...tail, ...new] list, far shorter than the total rows in
  // the table (which still hold the superseded prefix).
  persistedHistoryCount: number,
  // Next free WHOLE-NUMBER absolute position to write at. Decoupled from the
  // slice index because compaction inserts a fractional summary position, so the
  // total-row count no longer equals max(position)+1. Defaults to
  // persistedHistoryCount to preserve the pre-compaction behaviour (contiguous
  // positions from 0) when callers do not pass an explicit next position.
  nextPosition: number = persistedHistoryCount,
  toolOutputTruncationTokens?: number,
): {
  rows: Array<{ position: number; item: Record<string, unknown> }>;
  nextWatermark: number;
  nextPosition: number;
} {
  const modelReady = sanitizeHistoryItemsForModel(rawHistory, toolOutputTruncationTokens);
  if (modelReady.length <= persistedHistoryCount) {
    return { rows: [], nextWatermark: persistedHistoryCount, nextPosition };
  }
  // Canonical model-facing inputs (including machine-input batches) are
  // persisted before inference and therefore live inside the prefix represented
  // by persistedHistoryCount. System messages synthesized only for this
  // attempt—recovery diagnostics, credential notices, attachment materialization
  // notes—must not accidentally become conversation memory during reconciliation.
  // Advance the in-memory watermark past them, but only allocate durable
  // positions to actual model/tool output.
  const rows: Array<{ position: number; item: Record<string, unknown> }> = [];
  for (const [offset, item] of modelReady.slice(persistedHistoryCount).entries()) {
    if (item.type === "message" && item.role === "system") {
      continue;
    }
    rows.push({
      position: nextPosition + rows.length,
      item: normalizeProtocolJsonValue(
        item as Record<string, unknown>,
        `$[${persistedHistoryCount + offset}]`,
      ),
    });
  }
  return {
    rows,
    nextWatermark: modelReady.length,
    nextPosition: nextPosition + rows.length,
  };
}

/** Select only opaque rows that participated in the provider's rejected wire request. */
export function selectRejectedProviderArtifactHistoryIds(
  activeHistory: ReadonlyArray<{
    id: string;
    item: Record<string, unknown>;
    providerArtifactInvalidatedAt: Date | null;
  }>,
  candidates: {
    knownHistoryItemIds: readonly string[];
    historyItemIds: readonly string[];
  },
  wireFingerprints: readonly string[],
): string[] {
  const remainingWireArtifacts = new Map<string, number>();
  for (const fingerprint of wireFingerprints) {
    remainingWireArtifacts.set(fingerprint, (remainingWireArtifacts.get(fingerprint) ?? 0) + 1);
  }
  const knownHistoryItemIds = new Set(candidates.knownHistoryItemIds);
  const initialCandidateIds = new Set(candidates.historyItemIds);
  const selected: string[] = [];
  for (const row of activeHistory) {
    if (row.providerArtifactInvalidatedAt !== null) continue;
    // A row present before this attempt is eligible only when the exact
    // model-facing projection retained it. Rows appended during this run are
    // eligible after durable reconciliation.
    if (knownHistoryItemIds.has(row.id) && !initialCandidateIds.has(row.id)) continue;
    const fingerprint = opaqueProviderArtifactFingerprint(row.item);
    if (!fingerprint) continue;
    const remaining = remainingWireArtifacts.get(fingerprint) ?? 0;
    if (remaining === 0) continue;
    selected.push(row.id);
    remainingWireArtifacts.set(fingerprint, remaining - 1);
  }
  return selected;
}

/** Literal final per-call boundary for replayed and current-turn model input. */
export function isModelOrToolProgressHistoryItem(item: Record<string, unknown>): boolean {
  if (item.type === "message") {
    return item.role === "assistant";
  }
  if (item.type === "reasoning" || item.type === "compaction") {
    return true;
  }
  if (typeof item.type === "string") {
    return item.type !== "message";
  }
  return false;
}

/**
 * Resolve the EFFECTIVE/active compute backend a turn should gate
 * filesystem-touching agent lifecycle hooks on (today: the repository clone).
 *
 * WHY (Case B — clone-onto-real-disk hazard): a session keeps its CLOUD HOME
 * backend (`settings.sandboxBackend`, e.g. "modal") but its ACTIVE sandbox may
 * have been swapped to a connected machine (`active_sandbox_id` → a selfhosted
 * lease). `runtime.buildAgent`'s repository-clone hook keys off the backend it is
 * told; if the worker passes nothing it defaults to the HOME backend and the hook
 * would `git clone` a private GitHub-App repo onto the user's REAL disk — a
 * bring-your-own machine owns its own filesystem and must NEVER be cloned onto. So
 * we look at where the agent ACTUALLY runs, not where the session was created.
 *
 * Returns "selfhosted" ONLY when the selfhosted feature is on AND the session has
 * a non-null active pointer whose sandbox `kind` is "selfhosted". Otherwise
 * returns undefined so buildAgent falls back to the home backend — byte-for-byte
 * unchanged cloud behavior.
 *
 * Total + best-effort by contract: it NEVER throws (a lookup failure is logged and
 * falls back to the home default), so wiring it at turn start can't fail the turn.
 * The DB I/O is injected (the real call site passes readActiveSandbox + getSandbox,
 * the same helpers wrapTurnBoxWithRouting reuses) so the gate/decision/safety
 * contract is unit-testable without a live database.
 */
export function pendingToolCallFromSdkEvent(event: unknown): {
  callId: string;
  callType: string;
  callName: string | null;
  callItem: Record<string, unknown>;
} | null {
  if (!event || typeof event !== "object") return null;
  if ((event as { type?: unknown }).type !== "run_item_stream_event") return null;
  const item = (event as { item?: { type?: unknown; rawItem?: unknown } }).item;
  if (
    !item ||
    (item.type !== "tool_call_item" && item.type !== "tool_search_call_item") ||
    !item.rawItem ||
    typeof item.rawItem !== "object" ||
    Array.isArray(item.rawItem)
  ) {
    return null;
  }
  const raw = item.rawItem as Record<string, unknown>;
  // The hosted image call is a complete provider fact carried by one item; it
  // never receives a separate function result and therefore must not enter the
  // pending function-call ledger.
  if (raw.type === "hosted_tool_call" && raw.name === "image_generation_call") return null;
  const callId = toolCallIdFromSdkItem(raw) ?? raw.id;
  const callType = raw.type;
  if (typeof callId !== "string" || callId.length === 0 || typeof callType !== "string") {
    return null;
  }
  const callItem = normalizeProtocolJsonValue(raw, '$["item"]["rawItem"]');
  return {
    callId,
    callType,
    callName: typeof raw.name === "string" ? raw.name : null,
    callItem,
  };
}

/** Tools whose intentional visual result must survive inline-media sanitization. */
export function toolCallProducesRetainableSessionImage(name: string | null): boolean {
  return name === "computer_screenshot" || name === "view_image";
}

export function completedToolCallFromSdkEvent(event: unknown): {
  callId: string;
  resultItem: Record<string, unknown>;
} | null {
  if (!event || typeof event !== "object") return null;
  if ((event as { type?: unknown }).type !== "run_item_stream_event") return null;
  const item = (event as { item?: { type?: unknown; rawItem?: unknown; id?: unknown } }).item;
  if (!item || (item.type !== "tool_call_output_item" && item.type !== "tool_search_output_item")) {
    return null;
  }
  const raw =
    item.rawItem && typeof item.rawItem === "object" && !Array.isArray(item.rawItem)
      ? (item.rawItem as Record<string, unknown>)
      : {};
  const callId = toolCallIdFromSdkItem(raw) ?? item.id;
  if (typeof callId !== "string" || callId.length === 0) return null;
  return {
    callId,
    resultItem: normalizeProtocolJsonValue(raw, '$["item"]["rawItem"]'),
  };
}

/**
 * Budget/limit exhaustion detected between model calls. This is account
 * state, not an agent failure: the segment ends gracefully (session idles,
 * run state preserved) so a top-up or limit reset lets the same session
 * continue — a failed session would reject the user's next message. An
 * active goal pauses visibly (reason "limits") at the next continuation
 * evaluation without consuming continuation budget.
 */
