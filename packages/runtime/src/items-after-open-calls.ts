import { TOOL_CALL_RESULT_TYPE_BY_CALL_TYPE } from "./history-sanitizer";
import { toolCallIdFromSdkItem } from "./tool-call-identity";

export type ItemsAfterOpenCallsOptions<T> = {
  /**
   * Call item types that open a step, mapped to the result item type that
   * settles each. Defaults to every SDK tool-call kind.
   */
  resultTypeByCallType?: Readonly<Record<string, string>>;
  /**
   * Where a waiting item goes. `after-step` (the default): any waiting item
   * that falls while calls are open moves to just after the result that closes
   * the last of them. `before-results`: only one that falls among a step's
   * results moves, to just before the step's first result, for a wire API
   * that accepts other content after the calls (as Claude does inside its
   * reply) but not between two results of one step.
   */
  placement?: "after-step" | "before-results";
  /**
   * A message that ends an unfinished step: its calls never get results, so
   * waiting items wait no further than just before it, and those calls are
   * forgotten. Defaults to any user, system or developer message.
   */
  endsStep?: (item: T) => boolean;
};

/**
 * Keeps each item that `waits` selects out of an unfinished tool step, keeping
 * relative order (see {@link ItemsAfterOpenCallsOptions.placement}). A message
 * that is not the model's own never comes between a call and its result, so
 * it ends the wait ({@link ItemsAfterOpenCallsOptions.endsStep}). An item's
 * place depends only on the items up to the one that ends its wait. A later
 * request therefore reproduces the same prefix, provided no request ends while
 * calls are still open: history repair removes calls that never got a result
 * before projection. Returns `items` itself when nothing moves.
 */
export function withItemsAfterOpenCalls<T>(
  items: T[],
  waits: (item: T) => boolean,
  options: ItemsAfterOpenCallsOptions<T> = {},
): T[] {
  const resultTypeByCallType = options.resultTypeByCallType ?? TOOL_CALL_RESULT_TYPE_BY_CALL_TYPE;
  const resultTypes = new Set(Object.values(resultTypeByCallType));
  const beforeResults = options.placement === "before-results";
  const endsStep = options.endsStep ?? isOutsideMessage;
  const open = new Set<string>();
  // Output position of the open step's first result, once it has one.
  let resultsAt: number | null = null;
  let deferred: T[] = [];
  let out: T[] | null = null;
  const release = () => {
    if (deferred.length > 0) out!.push(...deferred);
    deferred = [];
  };
  for (const [index, item] of items.entries()) {
    if (open.size > 0 && waits(item)) {
      if (!beforeResults) {
        out ??= items.slice(0, index);
        deferred.push(item);
        continue;
      }
      if (resultsAt !== null) {
        out ??= items.slice(0, index);
        out.splice(resultsAt, 0, item);
        resultsAt += 1;
        continue;
      }
    }
    if (open.size > 0 && endsStep(item)) {
      release();
      open.clear();
    }
    const position = out ? out.length : index;
    out?.push(item);
    const type = record(item)?.type;
    const callId = typeof type === "string" ? toolCallIdFromSdkItem(item) : undefined;
    if (typeof type === "string" && callId) {
      const resultType = resultTypeByCallType[type];
      if (resultType) open.add(`${resultType}\u0000${callId}`);
      else if (resultTypes.has(type) && open.delete(`${type}\u0000${callId}`))
        resultsAt ??= position;
    }
    if (open.size === 0) {
      resultsAt = null;
      release();
    }
  }
  release();
  return out ?? items;
}

/** A message that is not the model's own: user, system or developer input. */
function isOutsideMessage(item: unknown): boolean {
  const value = record(item);
  if (!value || typeof value.role !== "string" || value.role === "assistant") return false;
  return value.type === undefined || value.type === "message";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
