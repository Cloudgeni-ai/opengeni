import { TOOL_CALL_RESULT_TYPE_BY_CALL_TYPE } from "./history-sanitizer";
import { toolCallIdFromSdkItem } from "./tool-call-identity";

export type ItemsAfterOpenCallsOptions = {
  /**
   * Call item types that open a step, mapped to the result item type that
   * settles each. Defaults to every SDK tool-call kind.
   */
  resultTypeByCallType?: Readonly<Record<string, string>>;
  /**
   * Wait only once a result of the open step has been seen. For a wire API
   * that accepts other assistant content between a call and its results (as
   * Claude does inside its reply), but not between two results of one step.
   */
  onlyAmongResults?: boolean;
};

/**
 * Moves each item that `waits` selects out of an unfinished tool step: an
 * item that falls while calls are open moves to just after the result that
 * closes the last of them, keeping relative order. A message that is not the
 * model's own (a user, system or developer message) never comes between a
 * call and its result, so calls still open there never get one: waiting items
 * wait no further than just before it, and those calls are forgotten. An
 * item's place therefore depends only on the items up to the one that ends
 * its wait, so a later request reproduces the same prefix, also when stored
 * history holds a call that never got its result. Returns `items` itself when
 * nothing moves.
 */
export function withItemsAfterOpenCalls<T>(
  items: T[],
  waits: (item: T) => boolean,
  options: ItemsAfterOpenCallsOptions = {},
): T[] {
  const resultTypeByCallType = options.resultTypeByCallType ?? TOOL_CALL_RESULT_TYPE_BY_CALL_TYPE;
  const resultTypes = new Set(Object.values(resultTypeByCallType));
  const open = new Set<string>();
  let answered = false;
  let deferred: T[] = [];
  let out: T[] | null = null;
  const release = () => {
    if (deferred.length > 0) out!.push(...deferred);
    deferred = [];
  };
  for (const [index, item] of items.entries()) {
    if (open.size > 0 && (answered || !options.onlyAmongResults) && waits(item)) {
      out ??= items.slice(0, index);
      deferred.push(item);
      continue;
    }
    if (open.size > 0 && isOutsideMessage(item)) {
      release();
      open.clear();
    }
    out?.push(item);
    const type = record(item)?.type;
    const callId = typeof type === "string" ? toolCallIdFromSdkItem(item) : undefined;
    if (typeof type === "string" && callId) {
      const resultType = resultTypeByCallType[type];
      if (resultType) open.add(`${resultType}\u0000${callId}`);
      else if (resultTypes.has(type) && open.delete(`${type}\u0000${callId}`)) answered = true;
    }
    if (open.size === 0) {
      answered = false;
      release();
    }
  }
  release();
  return out ?? items;
}

/** A message that is not the model's own: user, system or developer input. */
export function isOutsideMessage(item: unknown): boolean {
  const value = record(item);
  if (!value || typeof value.role !== "string" || value.role === "assistant") return false;
  return value.type === undefined || value.type === "message";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
