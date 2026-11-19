/**
 * What a Responses item loses when an earlier response's output is sent back
 * as input. One definition serves both sides of that round trip: the Codex
 * request normalizer applies it to every replayed item, and the Responses
 * WebSocket continuation check applies it to the previous output and to the
 * replayed input before comparing them, so an item that differs only in what
 * replay strips always continues the response chain, whatever its type.
 */

/**
 * Responses input items whose `status` is required replay data.
 *
 * Most Responses `status` fields are output annotations (pairing uses
 * `call_id`) and Codex's strict input schema rejects them on messages and
 * function calls, so canonical history and the Codex normalizer drop them.
 * The item types below are different: the Responses input schema REQUIRES
 * their `status`, so dropping it makes every later request that replays them
 * invalid (`missing_required_parameter: input[N].status`) on any route that
 * forwards the item as stored, which is how a session that used native
 * `apply_patch` on one billing route broke after switching to Codex.
 *
 * The list mirrors every `ResponseInputItem` variant of the `openai` SDK whose
 * `status` is non-optional; `packages/runtime/src/replay-status-contract.ts`
 * fails to typecheck when the SDK adds or removes one. `message` is excluded:
 * it also has input forms with optional status (`EasyInputMessage`), and Codex
 * rejects status on messages. `hosted_tool_call` is the Agents SDK's own
 * envelope for the hosted calls and carries their status.
 */
export const REPLAY_STATUS_ITEM_TYPES = [
  "hosted_tool_call",
  "web_search_call",
  "file_search_call",
  "code_interpreter_call",
  "image_generation_call",
  "computer_call",
  "local_shell_call",
  "apply_patch_call",
  "apply_patch_call_output",
  "program_output",
] as const;

export type ReplayStatusItemType = (typeof REPLAY_STATUS_ITEM_TYPES)[number];

const REPLAY_STATUS_ITEM_TYPE_SET: ReadonlySet<unknown> = new Set(REPLAY_STATUS_ITEM_TYPES);

/** True when the item's `status` must survive persistence and replay. */
export function preservesReplayStatus(type: unknown): type is ReplayStatusItemType {
  return REPLAY_STATUS_ITEM_TYPE_SET.has(type);
}

/**
 * One item as replay sends it back: without its provider `id` (every type),
 * without its output-only `status` (every type not in
 * {@link REPLAY_STATUS_ITEM_TYPES}; a required status is kept as it is, never
 * fabricated), and with a `tool_search_call`'s `arguments` as an object, the
 * shape the backend requires (an unparseable string becomes `{}`).
 *
 * Copy-on-write: returns the same value when nothing changes, otherwise a
 * shallow copy. The caller's item is never mutated.
 */
export function replayedResponsesItem(item: unknown): unknown {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  const record = item as Record<string, unknown>;
  const stripStatus = "status" in record && !preservesReplayStatus(record.type);
  const parseArguments = record.type === "tool_search_call" && typeof record.arguments === "string";
  if (!("id" in record) && !stripStatus && !parseArguments) return item;
  const replayed = { ...record };
  delete replayed.id;
  if (stripStatus) delete replayed.status;
  if (parseArguments) {
    try {
      const parsed = JSON.parse(record.arguments as string) as unknown;
      replayed.arguments = parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      replayed.arguments = {};
    }
  }
  return replayed;
}
