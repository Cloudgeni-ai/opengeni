/**
 * Read-path sanitizer for replayed conversation history (issue: orphaned
 * tool outputs brick a session).
 *
 * Conversation truth is persisted as a flat list of SDK history items in
 * `session_history_items` and replayed verbatim into the model on every turn.
 * The OpenAI Responses API rejects the whole request (HTTP 400) when that list
 * violates its tool-call pairing rules — most destructively:
 *
 *   `400 No tool call found for function call output with call_id <X>`
 *
 * when a `function_call_result` (a.k.a. function_call_output) has no matching
 * `function_call` earlier in the list. Because the corrupt item is replayed on
 * every subsequent turn, one orphaned output permanently bricks the session
 * across revival — it stays dead until the row is hand-deleted.
 *
 * This module is the reliability net: before history items are sent to the
 * model they pass through `sanitizeHistoryItemsForModel`, which removes any
 * item that would make the request invalid. It mirrors the SDK's own
 * `dropOrphanToolCalls` continuation logic (which only runs over the SDK's
 * in-memory `state.history`, not over rows we reload from the database) so a
 * reloaded history is shaped exactly like a freshly-generated one.
 *
 * It is a pure function over plain JSON item shapes (no SDK import, no I/O) so
 * it is cheap to unit-test exhaustively. It NEVER mutates its input items and
 * NEVER touches the stored rows — only the in-memory copy sent to the model is
 * filtered, keeping the persisted audit trail intact.
 */

/** A history item is any JSON object; we only inspect a few discriminator fields. */
export type HistoryItem = Record<string, unknown>;

/**
 * Tool-call item types and the result-item type that settles them. Kept in
 * sync with the SDK's `TOOL_CALL_RESULT_TYPE_BY_CALL_TYPE`; `function_call` is
 * the one observed live, the rest are included so the same pairing logic holds
 * for every tool-call kind the SDK can emit.
 */
const RESULT_TYPE_BY_CALL_TYPE: Record<string, string> = {
  function_call: "function_call_result",
  computer_call: "computer_call_result",
  shell_call: "shell_call_output",
  apply_patch_call: "apply_patch_call_output",
};

const RESULT_TYPES = new Set(Object.values(RESULT_TYPE_BY_CALL_TYPE));

function itemType(item: unknown): string | undefined {
  if (!item || typeof item !== "object") {
    return undefined;
  }
  const type = (item as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}

/**
 * Correlation id for a tool call / result. The SDK's canonical history shape
 * uses camelCase `callId`; the raw Responses wire shape uses snake_case
 * `call_id`. Persisted rows are the SDK shape, but we accept either so a row
 * written by any code path (or hand-repaired) still correlates.
 */
function callIdOf(item: unknown): string | undefined {
  if (!item || typeof item !== "object") {
    return undefined;
  }
  const record = item as { callId?: unknown; call_id?: unknown };
  if (typeof record.callId === "string") {
    return record.callId;
  }
  if (typeof record.call_id === "string") {
    return record.call_id;
  }
  return undefined;
}

/**
 * Sanitize a replayed history item list into a sequence the Responses API
 * accepts. Pure: returns a new array of the same item references in order,
 * with invalid items omitted. Valid histories come back byte-identical
 * (same references, same order).
 *
 * Rules, each motivated by a concrete 400 the API raises:
 *
 *  1. Drop every tool-call RESULT whose matching tool CALL does not appear
 *     earlier in the list. This is the session-bricking orphan: a
 *     `function_call_result` with no preceding `function_call` of the same
 *     `call_id`. ("No tool call found for function call output…")
 *
 *  2. Drop every tool CALL that has no matching RESULT anywhere after it.
 *     The Responses API requires each tool call to be settled by its output
 *     before the conversation can continue; a dangling call left in replayed
 *     history 400s with "No tool output found for function call…". Dropping
 *     the dangling call (rather than synthesizing a fake output) is what the
 *     SDK itself does for in-memory continuation, so a reloaded history is
 *     shaped identically. The matching result, if it later exists, is kept;
 *     only genuinely unpaired calls are removed.
 *
 *  3. Drop any `reasoning` item that immediately precedes (across a run of
 *     reasoning items) a dropped tool call. The Responses API ties an
 *     encrypted reasoning item to the tool call it produced; a reasoning item
 *     orphaned by rule 2 trips "Item 'rs_…' of type 'reasoning' was provided
 *     without its required following item". Mirrors the SDK's
 *     `dropReasoningItemsPrecedingDroppedCalls`.
 *
 * A `call_id` is paired only when BOTH a call and a result of the matching
 * types exist with that id, the call appearing before the result. Calls and
 * results that satisfy that survive untouched.
 */
export function sanitizeHistoryItemsForModel<T extends HistoryItem>(items: readonly T[]): T[] {
  if (items.length === 0) {
    return [];
  }

  // Pre-scan: for every (call-type, call_id) record the index of a RESULT that
  // appears strictly after the call. A call is valid only when such a result
  // exists; a result is valid only when its call appears strictly before it.
  // We resolve pairs in order so ordering is enforced both ways (a result that
  // precedes its call is an orphan, and a call whose only result precedes it is
  // dangling).
  const dropped = new Set<number>();

  // For each result-type, the call_ids of CALLs we have seen so far that are
  // still waiting to be settled by a following result.
  const openCallIdsByResultType = new Map<string, Set<string>>();

  items.forEach((item, index) => {
    const type = itemType(item);
    const callId = callIdOf(item);
    if (!type || !callId) {
      return;
    }
    const callResultType = RESULT_TYPE_BY_CALL_TYPE[type];
    if (callResultType) {
      const open = openCallIdsByResultType.get(callResultType) ?? new Set<string>();
      open.add(callId);
      openCallIdsByResultType.set(callResultType, open);
      return;
    }
    if (RESULT_TYPES.has(type)) {
      const open = openCallIdsByResultType.get(type);
      if (open && open.has(callId)) {
        // Settles a call we have already seen — keep both, close the call.
        open.delete(callId);
      } else {
        // Rule 1: result whose call is absent or appears later — the orphan.
        dropped.add(index);
      }
    }
  });

  // Rule 2: any call still open after the full scan has no result after it —
  // a dangling call the API rejects. Drop those calls. We re-walk to find the
  // indices of the still-open call_ids (the last unmatched call per id).
  const stillOpen = new Map<string, Set<string>>();
  for (const [resultType, open] of openCallIdsByResultType) {
    if (open.size > 0) {
      stillOpen.set(resultType, new Set(open));
    }
  }
  if (stillOpen.size > 0) {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      const type = itemType(item);
      const callId = callIdOf(item);
      if (!type || !callId) {
        continue;
      }
      const resultType = RESULT_TYPE_BY_CALL_TYPE[type];
      if (!resultType) {
        continue;
      }
      const open = stillOpen.get(resultType);
      if (open && open.has(callId)) {
        dropped.add(index);
        open.delete(callId);
      }
    }
  }

  if (dropped.size > 0) {
    // Rule 3: drop reasoning items stranded by a dropped tool call. A reasoning
    // item is stranded when the next non-reasoning item after it is dropped.
    for (let index = 0; index < items.length; index += 1) {
      if (dropped.has(index) || itemType(items[index]) !== "reasoning") {
        continue;
      }
      for (let next = index + 1; next < items.length; next += 1) {
        if (itemType(items[next]) === "reasoning") {
          continue;
        }
        if (dropped.has(next)) {
          dropped.add(index);
        }
        break;
      }
    }
  }

  if (dropped.size === 0) {
    return items.slice();
  }
  return items.filter((_item, index) => !dropped.has(index));
}

/**
 * Normalize `computer_call` items so each carries EXACTLY ONE of the two
 * mutually-exclusive action fields the provider accepts.
 *
 * The OpenAI Agents SDK 0.11.6 `computer_call` schema (protocol.mjs) carries
 * BOTH the legacy singular `action` and the GA batched `actions`, each
 * `.optional()`, and only requires "at least one" (its superRefine errors only
 * when both are absent). The Azure computer-use endpoint is stricter: it
 * requires EXACTLY one and rejects the whole request with
 *
 *   `400 Computer call input must include exactly one of `action` or `actions`.`
 *
 * when an emitted `computer_call` carries both (observed live: a screenshot
 * call carrying `action:{type:"screenshot"}` AND `actions:[{type:"screenshot"}]`).
 *
 * Which singular do we keep? LIVE-PROVEN against the deployed Azure deployment
 * (gpt-5.5-2026-04-24): for gpt-5.5 the SDK serializes the GA computer tool as
 * `{type:"computer"}` (not the legacy `computer_use_preview`), and that GA tool
 * accepts ONLY the batched plural `actions`. Probing all three shapes:
 *   - `action`-only  -> 400 "exactly one of action or actions" (STILL rejected)
 *   - `actions`-only -> passes the action/actions structural validation
 *   - both           -> 400 "exactly one …"
 * The "exactly one" wording is misleading: only the `actions`-only form is
 * accepted by the GA tool. So when both are present we KEEP `actions` (the GA
 * batched plural) and DROP `action`. Calls that already carry exactly one field
 * — or the legacy `action`-only form — pass through untouched (this transform's
 * sole job is to resolve the both-present conflict, not to rewrite singulars).
 *
 * Pure and non-mutating: only the conflicting item(s) are cloned; every other
 * item passes through by reference (byte-identical). Unlike
 * {@link sanitizeHistoryItemsForModel} (which only *filters* items), this is a
 * read-path *transform* of a single item's shape.
 */
export function normalizeComputerCallActions<T extends HistoryItem>(items: readonly T[]): T[] {
  let changed = false;
  const out = items.map((item) => {
    if (itemType(item) !== "computer_call") {
      return item;
    }
    const record = item as Record<string, unknown>;
    const hasAction = record.action !== undefined && record.action !== null;
    const hasActions = Array.isArray(record.actions) && (record.actions as unknown[]).length > 0;
    if (hasAction && hasActions) {
      changed = true;
      const { action: _droppedAction, ...rest } = record;
      return rest as unknown as T;
    }
    return item;
  });
  return changed ? out : items.slice();
}
