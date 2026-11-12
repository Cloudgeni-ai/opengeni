// Compile-time contract between `@opengeni/codex`'s REPLAY_STATUS_ITEM_TYPES
// and the pinned `openai` SDK's Responses input schema. `bun run typecheck`
// fails when an SDK upgrade adds, removes or relaxes an input item whose
// `status` is required, so history canonicalization and the Codex normalizer
// can never again strip a field a replayed request needs.
import type { ReplayStatusItemType } from "@opengeni/codex";
import type { ResponseInputItem } from "openai/resources/responses/responses";

type StatusRequiredInputItemType<U> = U extends { type: infer T }
  ? "status" extends keyof U
    ? object extends Pick<U, Extract<keyof U, "status">>
      ? never
      : T
    : never
  : never;

type Equal<A, B> =
  (<V>() => V extends A ? 1 : 2) extends <V>() => V extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

/**
 * `message` is excluded: its input form (`EasyInputMessage`) has no status.
 * `hosted_tool_call` is the Agents SDK envelope for the hosted calls.
 */
export type ReplayStatusMatchesResponsesInputSchema = Assert<
  Equal<
    Exclude<StatusRequiredInputItemType<ResponseInputItem>, "message">,
    Exclude<ReplayStatusItemType, "hosted_tool_call">
  >
>;
