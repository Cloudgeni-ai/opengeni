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

import { SCREENSHOT_FAILURE_CARD_IMAGE_URL } from "./screenshot-error-card";

/** A history item is any JSON object; we only inspect a few discriminator fields. */
export type HistoryItem = Record<string, unknown>;

/**
 * Tool-call item types and the result-item type that settles them. Kept in
 * sync with the SDK's `TOOL_CALL_RESULT_TYPE_BY_CALL_TYPE`; `function_call` is
 * the one observed live, the rest are included so the same pairing logic holds
 * for every tool-call kind the SDK can emit.
 */
export const TOOL_CALL_RESULT_TYPE_BY_CALL_TYPE: Record<string, string> = {
  function_call: "function_call_result",
  computer_call: "computer_call_result",
  shell_call: "shell_call_output",
  apply_patch_call: "apply_patch_call_output",
  // Progressive connector disclosure (codex tool_search): a replayed
  // `tool_search_call` must be settled by its `tool_search_output` exactly like a
  // function call — an unpaired one 400s the store:false replay. The SDK pairs
  // these OUTSIDE its own TOOL_CALL_RESULT_TYPE_BY_CALL_TYPE (sessionPersistence's
  // hasToolSearchCallId), so we mirror the semantics here; the correlation id can
  // additionally ride providerData (see callIdOf).
  tool_search_call: "tool_search_output",
};

const RESULT_TYPE_BY_CALL_TYPE = TOOL_CALL_RESULT_TYPE_BY_CALL_TYPE;
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
  const record = item as { callId?: unknown; call_id?: unknown; providerData?: unknown };
  if (typeof record.callId === "string" && record.callId.length > 0) {
    return record.callId;
  }
  if (typeof record.call_id === "string" && record.call_id.length > 0) {
    return record.call_id;
  }
  // tool_search items may carry their correlation id ONLY in providerData
  // (mirrors the SDK's getToolSearchProviderCallId: providerData.call_id ??
  // providerData.callId ?? call_id ?? callId). Harmless for other item kinds —
  // their ids never live there.
  const provider = record.providerData as
    | { call_id?: unknown; callId?: unknown }
    | null
    | undefined;
  if (provider && typeof provider === "object") {
    if (typeof provider.call_id === "string" && provider.call_id.length > 0) {
      return provider.call_id;
    }
    if (typeof provider.callId === "string" && provider.callId.length > 0) {
      return provider.callId;
    }
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
 * Drop the account/org-bound `reasoning.encrypted_content` blob from a single
 * history item, preserving everything else (the visible chain-of-thought text in
 * `summary`/`content`, and every non-reasoning field). Pure + non-mutating: when
 * there is nothing to strip the SAME reference is returned (so the common,
 * same-account path stays byte-identical); otherwise a shallow clone is returned.
 *
 * WHY. A codex-subscription turn round-trips `reasoning.encrypted_content` — an
 * opaque blob minted by the ChatGPT/Codex backend that is bound to the account
 * (org) that produced it. After a manual switch from codex account A to B, the
 * carried history items still hold A-minted blobs; replaying them into a turn
 * running on B is rejected (400). The blob is purely a chain-of-thought
 * continuity optimization — dropping it costs at most one turn of lost CoT
 * continuity and never any message content.
 *
 * USED FOR `compaction` items only on the history-items read path: a foreign
 * `compaction` summary carries account-bound `encrypted_content` but its summary
 * is real conversation content that must be preserved, so we strip only the blob
 * (we do NOT drop the whole item). Foreign `reasoning` items are instead dropped
 * WHOLESALE by the caller (id + blob), because the Responses backend validates
 * the foreign `rs_…` id and rejects a reasoning item that has a foreign id and no
 * encrypted_content (so blanking the blob alone is not enough — see
 * {@link applyCodexHistoryStrip}).
 *
 * The SDK's Responses converter reads the blob via `providerData.encryptedContent`
 * (camel) or `providerData.encrypted_content` (snake); persisted rows use the
 * snake form, but we delete both casings defensively. We also clear a top-level
 * `encrypted_content` (the `compaction`-item shape) belt-and-braces — that blob
 * is likewise source-bound. Only `reasoning` and `compaction` items are touched;
 * messages, tool calls, and tool outputs pass through untouched by reference.
 */
export function stripReasoningEncryptedContent<T extends HistoryItem>(item: T): T {
  const type = itemType(item);
  if (type !== "reasoning" && type !== "compaction") {
    return item;
  }
  const record = item as Record<string, unknown>;
  const providerData = record.providerData;
  const providerHasBlob =
    !!providerData &&
    typeof providerData === "object" &&
    ("encryptedContent" in (providerData as Record<string, unknown>) ||
      "encrypted_content" in (providerData as Record<string, unknown>));
  const topLevelHasBlob = "encrypted_content" in record;
  if (!providerHasBlob && !topLevelHasBlob) {
    // Nothing encrypted to strip — return the same reference (byte-identical).
    return item;
  }
  const clone: Record<string, unknown> = { ...record };
  if (providerHasBlob) {
    const providerClone = { ...(providerData as Record<string, unknown>) };
    delete providerClone.encryptedContent;
    delete providerClone.encrypted_content;
    clone.providerData = providerClone;
  }
  if (topLevelHasBlob) {
    delete clone.encrypted_content;
  }
  return clone as unknown as T;
}

/**
 * Neutralize the account/org-bound identity of EVERY `reasoning` item embedded
 * in a serialized RunState JSON string, returning the re-serialized string. Pure:
 * a parse failure or a no-op returns the SAME string reference (so an unchanged
 * or non-codex run-state replays byte-for-byte).
 *
 * WHY (HOLE C — the run-state REPLAY paths). The approval-decision resume and the
 * items-mode run-state fallback replay the serialized RunState blob verbatim. That
 * blob round-trips `reasoning.encrypted_content` minted by the ChatGPT/Codex
 * backend (bound to the freezing account/org — a foreign account 400s it) AND the
 * foreign `rs_…` reasoning ids the Responses backend validates (rejected once the
 * blob is gone). Unlike `session_history_items`, the blob carries NO per-item
 * producer tag, so foreign-ness cannot be decided per item; the worker instead
 * records the FREEZING codex account on the run-state row and calls this only when
 * the resuming turn's codex account DIFFERS from it. When the accounts differ we
 * conservatively neutralize every reasoning item: delete its provider id and its
 * `encrypted_content` (both casings, in `providerData`). The visible reasoning
 * `content`/`summary` and every message / tool-call / tool-output item are left
 * intact (message and tool content are never account-bound).
 *
 * A reasoning item with no id and no encrypted_content is exactly the shape the
 * production Azure path already sends (see `stripProviderItemIdsFilter`), so it
 * deserializes and replays cleanly. Reasoning items live in several places in the
 * blob — `originalInput` (when an array), each `modelResponses[].output`,
 * `lastModelResponse.output`, and the `generatedItems` wrappers (`reasoning_item`
 * → `rawItem`) — and we scrub all of them. `compaction` items are deliberately
 * left untouched: their `encrypted_content` is a protocol-REQUIRED field whose
 * removal would fail the SDK's run-state schema validation on deserialize.
 */
export function stripReasoningIdentityFromSerializedRunState(serialized: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    // Not JSON (e.g. a cleared-state sentinel handled elsewhere): forward as-is.
    return serialized;
  }
  if (!parsed || typeof parsed !== "object") {
    return serialized;
  }
  let changed = false;
  const scrubReasoning = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== "object") {
      return;
    }
    const record = candidate as Record<string, unknown>;
    if (record.type !== "reasoning") {
      return;
    }
    if ("id" in record) {
      delete record.id;
      changed = true;
    }
    const providerData = record.providerData;
    if (providerData && typeof providerData === "object") {
      const provider = providerData as Record<string, unknown>;
      if ("encryptedContent" in provider) {
        delete provider.encryptedContent;
        changed = true;
      }
      if ("encrypted_content" in provider) {
        delete provider.encrypted_content;
        changed = true;
      }
    }
    if ("encrypted_content" in record) {
      delete record.encrypted_content;
      changed = true;
    }
  };
  const scrubItemArray = (arr: unknown): void => {
    if (Array.isArray(arr)) {
      for (const item of arr) {
        scrubReasoning(item);
      }
    }
  };
  const root = parsed as Record<string, unknown>;
  // 1. originalInput is either a string (no items) or an array of protocol items.
  scrubItemArray(root.originalInput);
  // 2. generatedItems are SDK run-item wrappers; a `reasoning_item` carries the
  //    protocol reasoning shape under `rawItem`.
  if (Array.isArray(root.generatedItems)) {
    for (const wrapper of root.generatedItems) {
      if (
        wrapper &&
        typeof wrapper === "object" &&
        "rawItem" in (wrapper as Record<string, unknown>)
      ) {
        scrubReasoning((wrapper as Record<string, unknown>).rawItem);
      }
    }
  }
  // 3. modelResponses[].output and lastModelResponse.output hold protocol items.
  const scrubResponseOutput = (response: unknown): void => {
    if (response && typeof response === "object") {
      scrubItemArray((response as Record<string, unknown>).output);
    }
  };
  if (Array.isArray(root.modelResponses)) {
    for (const response of root.modelResponses) {
      scrubResponseOutput(response);
    }
  }
  scrubResponseOutput(root.lastModelResponse);
  if (!changed) {
    return serialized;
  }
  return JSON.stringify(parsed);
}

/**
 * Neutralize tool_search items IN PLACE in a serialized RunState blob for a
 * cross-account codex resume — the run-state sibling of
 * `applyCodexHistoryStrip`'s tool_search rule, but COUNT-PRESERVING (HOLE E: the
 * blob path's reconcile watermark counts the blob's history length, so items
 * must never be removed — only mutated, exactly like the reasoning
 * neutralization above).
 *
 * The hazard: on deserialize, the SDK re-runs the registered CLIENT tool_search
 * execute callback per frozen pair (`rehydrateToolSearchRuntimeTools`) and
 * THROWS a UserError when the re-run's runtime-tool keys mismatch the serialized
 * expectation — which is exactly what happens when the RESUMING account's
 * connector pool differs from the FREEZING account's. The SDK skips that
 * rehydration entirely for `execution === 'server'` calls, so flipping the
 * frozen pairs' `execution` to `"server"` in place defuses the throw without
 * touching counts, ids, pairing, or content. The flipped shape is wire-safe:
 * LIVE-VERIFIED against /codex/responses — a replayed server-execution pair is
 * accepted (200) and its disclosure still holds. The account-bound `tsc_…` id is
 * separately stripped by the codex transport normalizer (all input item ids).
 *
 * Walks the same blob locations as {@link stripReasoningIdentityFromSerializedRunState}:
 * `originalInput` (array form), `generatedItems` (SDK run-item wrappers — the
 * raw shape under `rawItem`), every `modelResponses[].output`, and
 * `lastModelResponse.output`. Returns the input string unchanged when nothing
 * matched.
 */
export function neutralizeToolSearchItemsInSerializedRunState(serialized: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return serialized;
  }
  if (!parsed || typeof parsed !== "object") {
    return serialized;
  }
  let changed = false;
  const neutralize = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== "object") {
      return;
    }
    const record = candidate as Record<string, unknown>;
    if (record.type !== "tool_search_call" && record.type !== "tool_search_output") {
      return;
    }
    if (record.execution !== "server") {
      record.execution = "server";
      changed = true;
    }
  };
  const neutralizeArray = (arr: unknown): void => {
    if (Array.isArray(arr)) {
      for (const item of arr) {
        neutralize(item);
      }
    }
  };
  const root = parsed as Record<string, unknown>;
  neutralizeArray(root.originalInput);
  if (Array.isArray(root.generatedItems)) {
    for (const wrapper of root.generatedItems) {
      if (
        wrapper &&
        typeof wrapper === "object" &&
        "rawItem" in (wrapper as Record<string, unknown>)
      ) {
        neutralize((wrapper as Record<string, unknown>).rawItem);
      }
    }
  }
  const neutralizeResponseOutput = (response: unknown): void => {
    if (response && typeof response === "object") {
      neutralizeArray((response as Record<string, unknown>).output);
    }
  };
  if (Array.isArray(root.modelResponses)) {
    for (const response of root.modelResponses) {
      neutralizeResponseOutput(response);
    }
  }
  neutralizeResponseOutput(root.lastModelResponse);
  if (!changed) {
    return serialized;
  }
  return JSON.stringify(parsed);
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

/**
 * Rewrite EVERY `computer_call` item in a serialized Responses request body to
 * the ACTIONS-ONLY shape the GA Azure computer tool accepts, mutating the parsed
 * JSON object in place and returning whether anything changed.
 *
 * WHY THIS LIVES AT THE WIRE LEVEL (not the input-item filter). The input-item
 * normalizer above ({@link normalizeComputerCallActions}, wired as a
 * callModelInputFilter) runs BEFORE the SDK's responses converter
 * (`convertAgentItemToResponsesInput`). That converter then re-derives the wire
 * payload from the item: when `actions` is present it emits BOTH
 * `{action: ..., actions: [...]}`, and when only `action` is present it emits
 * `action`-only. It can NEVER emit actions-only. Probed live against the
 * deployed Azure gpt-5.5-2026-04-24 GA computer tool (`{type:"computer"}`):
 *   - `action`-only  -> 400 "Computer call input must include exactly one of
 *                       `action` or `actions`." (rejected)
 *   - both           -> 400 same message (rejected)
 *   - `actions`-only -> passes the action/actions structural validation
 * So neither the input-filter nor the converter can produce an accepted body.
 * The ONLY seam that sees — and can rewrite — the final serialized JSON is a
 * custom `fetch` on the OpenAI client (it runs after the converter and after
 * `responses.create` serialization). This function is that rewriter's core.
 *
 * It collapses each computer_call to actions-only: it prefers an existing
 * non-empty `actions` array, else wraps the singular `action` into
 * `actions:[action]`, then deletes `action`. A computer_call with neither field
 * is left untouched (nothing to derive; let the provider report it).
 *
 * Mutates `body` in place (the caller has already JSON.parsed a private copy of
 * the request body). Returns `true` iff at least one computer_call was changed.
 */
export function rewriteComputerCallsToActionsOnly(body: unknown): boolean {
  if (!body || typeof body !== "object") {
    return false;
  }
  const input = (body as Record<string, unknown>).input;
  if (!Array.isArray(input)) {
    return false;
  }
  let changed = false;
  for (const item of input) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (record.type !== "computer_call") {
      continue;
    }
    const existingActions =
      Array.isArray(record.actions) && (record.actions as unknown[]).length > 0
        ? (record.actions as unknown[])
        : undefined;
    const actions =
      existingActions ??
      (record.action !== undefined && record.action !== null ? [record.action] : undefined);
    if (actions === undefined) {
      // Neither action nor actions present: nothing to normalize.
      continue;
    }
    const hadAction = "action" in record;
    const actionsAlreadyExact = existingActions !== undefined && !hadAction;
    if (actionsAlreadyExact) {
      // Already actions-only with a non-empty array — leave byte-identical.
      continue;
    }
    delete record.action;
    record.actions = actions;
    changed = true;
  }
  return changed;
}

/**
 * Backstop for the empty `computer_call_output` image_url: walk the `input` array of
 * a serialized Responses request body and replace any `computer_call_output` item
 * whose `output.image_url` is empty/missing with a LEGIBLE "screen capture failed"
 * error card ({@link SCREENSHOT_FAILURE_CARD_IMAGE_URL}).
 *
 * WHY A CARD, NOT A BLANK. An empty `image_url` reaches this seam ONLY when the
 * computer op genuinely FAILED to produce a screen: agents-core's `toolExecution.mjs`
 * catch sets `output = ''` when the action OR the follow-up `computer.screenshot()`
 * throws, building `{type:"computer_call_output",output:{type:"computer_screenshot",
 * image_url:""}}`. Azure then rejects the whole request with
 * `400 Invalid 'input[N].output.image_url'`. The previous fix substituted a 1×1
 * TRANSPARENT placeholder to dodge the 400 — but that reaches the model as a
 * plausible BLANK DESKTOP it confidently reports ("the screen appears blank/empty"),
 * turning a hard capture FAILURE into a silent, wrong observation. That is the worst
 * failure mode for computer use, and it is exactly what the 0.1.3 TCC-denied incident
 * produced. Substituting a legible error card instead makes the failure REACH THE
 * MODEL as an error (the only channel the hosted `computer_use_preview` protocol has
 * is the image), so the model stops and tells the user rather than hallucinating.
 *
 * WHY THIS IS SAFE (empty = failure, never an intentional blank). Post-af289e3 the
 * intentional-blank cases carry a NON-empty data URI already: agents-core's
 * tool-approval-rejection screenshot is its own non-empty 1×1 placeholder, and the
 * SandboxComputer action-timeout now warn+returns to a REAL screenshot rather than an
 * empty output. So an EMPTY image_url at this seam is unambiguously a capture/interact
 * FAILURE — the error card is the correct substitution for every empty case, and this
 * function never touches a non-empty (real screenshot OR intentional blank) output.
 *
 * The failure REASON (permission denied / null image / timeout / display down) is not
 * on the card; it is logged worker-side by `NativeDesktopComputer.screenshot()`.
 *
 * Mutates `body` in place (the caller has already JSON.parsed a private copy).
 * Returns `true` iff at least one image_url was replaced.
 */
export function rewriteEmptyComputerCallOutputImageUrls(body: unknown): boolean {
  if (!body || typeof body !== "object") {
    return false;
  }
  const input = (body as Record<string, unknown>).input;
  if (!Array.isArray(input)) {
    return false;
  }
  let changed = false;
  for (const item of input) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (record.type !== "computer_call_output") {
      continue;
    }
    const output = record.output;
    if (!output || typeof output !== "object") {
      continue;
    }
    const out = output as Record<string, unknown>;
    const imageUrl = out.image_url;
    // Replace the image_url when it is not a non-empty string (covers: "", null,
    // undefined, missing) — an empty output is always a genuine capture failure, so
    // it becomes the legible error card, never a silent blank.
    if (typeof imageUrl !== "string" || imageUrl.length === 0) {
      out.image_url = SCREENSHOT_FAILURE_CARD_IMAGE_URL;
      changed = true;
    }
  }
  return changed;
}

/**
 * Wrap a `fetch` so every outbound OpenAI Responses request body that contains a
 * `computer_call` is rewritten to the ACTIONS-ONLY shape (see
 * {@link rewriteComputerCallsToActionsOnly}) before it reaches the network, AND
 * any `computer_call_output` item with an empty/missing `output.image_url` is
 * patched with the 1×1 transparent PNG placeholder (see
 * {@link rewriteEmptyComputerCallOutputImageUrls}).
 *
 * Installed as the `fetch:` option on the Azure OpenAI client, this is the
 * lowest reachable seam — below the agents-core input filter and below the SDK's
 * responses converter — so it neutralizes the converter's both-fields synthesis
 * regardless of what the input item carried, and backstops the action-timeout
 * empty image_url regardless of how it was produced.
 *
 * Surgical and cheap: it only parses the body when it is a string that contains
 * the prefix `"computer_call` (matching both `"computer_call"` action items and
 * `"computer_call_output"` result items). Every other request — non-computer-use
 * turns, streaming SSE responses, non-string bodies — forwards untouched, the
 * SAME `init` reference, so streaming and other providers are unaffected. A JSON
 * parse failure or a no-op rewrite also forwards the original `init` unchanged.
 *
 * Typed structurally (the `(input, init) => Promise<Response>` call signature)
 * rather than as the DOM `typeof fetch` so it omits the `preconnect` static the
 * global type carries; this matches the OpenAI SDK's `Fetch` option, which only
 * needs the call signature. The wiring site passes it as the client `fetch:`.
 */
type FetchLike = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>;

export function computerCallNormalizingFetch(base: FetchLike): FetchLike {
  return (input, init) => {
    // Match any request that mentions either `computer_call` (the action call) or
    // `computer_call_output` (the output/result item). Both strings begin with
    // `"computer_call` so a single prefix-substring check covers both.
    if (init && typeof init.body === "string" && init.body.includes('"computer_call')) {
      try {
        const parsed = JSON.parse(init.body) as unknown;
        const changed1 = rewriteComputerCallsToActionsOnly(parsed);
        const changed2 = rewriteEmptyComputerCallOutputImageUrls(parsed);
        if (changed1 || changed2) {
          return base(input, { ...init, body: JSON.stringify(parsed) });
        }
      } catch {
        // Non-JSON or parse failure: forward the request unchanged.
      }
    }
    return base(input, init);
  };
}
