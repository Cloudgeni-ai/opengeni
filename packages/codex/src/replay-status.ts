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
