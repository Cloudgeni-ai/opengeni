import type { StreamEvent } from "@openai/agents";
import { isPreemptedModelResponse } from "./model-preemption";
import { ModelStepHandover } from "./model-step-handover";

/**
 * Consecutive reasoning-only responses stopped by the output limit that a run
 * continues. Long high-effort reasoning can fill a response's output budget;
 * the next request carries that reasoning and goes on from it.
 */
export const MAX_OUTPUT_LIMITED_REASONING_CONTINUATIONS = 3;

/**
 * A completed model response with nothing the run can act on: no text, no
 * refusal and no call of any kind (at most reasoning). The SDK treats it as
 * "not final yet" and samples again. An empty response adds nothing to the
 * input, so the next request is the same request, and a reasoning-only one
 * that finished normally adds only reasoning the model already ended on: with
 * a high model-call cap the turn would re-sample without end. A Steer's
 * preempted response is not one.
 */
export function isContentlessModelResponse(event: StreamEvent): boolean {
  if (event.type !== "response_done" || isPreemptedModelResponse(event)) return false;
  const output = (event.response as { output?: unknown }).output;
  if (!Array.isArray(output)) return false;
  return output.every((item) => !carriesContent(item));
}

/**
 * The provider stopped the response at its output-token limit. Responses
 * reports `status: "incomplete"`; the Claude and Chat adapters mark the same
 * shape (Claude also keeps its `stopReason`). A content-filter stop is not one.
 */
export function stoppedAtOutputLimit(event: StreamEvent): boolean {
  if (event.type !== "response_done") return false;
  const providerData = (event.response as { providerData?: unknown }).providerData as
    | {
        status?: unknown;
        incomplete_details?: { reason?: unknown } | null;
        anthropic?: { stopReason?: unknown };
      }
    | undefined;
  if (providerData?.anthropic?.stopReason === "max_tokens") return true;
  return (
    providerData?.status === "incomplete" &&
    providerData.incomplete_details?.reason !== "content_filter"
  );
}

function hasReasoning(event: StreamEvent): boolean {
  const output = (event as { response?: { output?: unknown } }).response?.output;
  return (
    Array.isArray(output) &&
    output.some((item) => (item as { type?: unknown } | null)?.type === "reasoning")
  );
}

function carriesContent(item: unknown): boolean {
  if (!item || typeof item !== "object") return false;
  const { type, content } = item as { type?: unknown; content?: unknown };
  if (type === "reasoning") return false;
  if (type !== undefined && type !== "message") return true;
  if (!Array.isArray(content)) return typeof content === "string" && content.trim().length > 0;
  return content.some((part) => {
    if (!part || typeof part !== "object") return false;
    const { type: partType, text, refusal } = part as Record<string, unknown>;
    if (partType === "output_text" || partType === "input_text" || partType === "text")
      return typeof text === "string" && text.trim().length > 0;
    if (partType === "refusal") return typeof refusal === "string" && refusal.trim().length > 0;
    return true;
  });
}

/** Ends a run whose previous model response was contentless (see isContentlessModelResponse). */
export class ContentlessModelResponseHandover extends ModelStepHandover {
  constructor() {
    super("the model response had no text and no tool call");
    this.name = "ContentlessModelResponseHandover";
  }
}

/**
 * Per-run guard: after a contentless response, the next model entry ends the
 * run at that step boundary (a ModelStepHandover, so the run finishes cleanly
 * with an empty final output) instead of sampling again. A reasoning-only
 * response stopped by the output limit is continued, up to
 * {@link MAX_OUTPUT_LIMITED_REASONING_CONTINUATIONS} in a row. The host
 * decides what the empty result means (for a turn: one reply reminder, then
 * a visible empty-reply notice).
 */
export function contentlessModelResponseGuard(onHandover?: () => void) {
  let endRun = false;
  let limitedReasoning = 0;
  return {
    observe(event: StreamEvent): void {
      if (event.type !== "response_done") return;
      if (!isContentlessModelResponse(event)) {
        endRun = false;
        limitedReasoning = 0;
        return;
      }
      if (hasReasoning(event) && stoppedAtOutputLimit(event)) {
        limitedReasoning++;
        endRun = limitedReasoning > MAX_OUTPUT_LIMITED_REASONING_CONTINUATIONS;
        return;
      }
      endRun = true;
    },
    check(): void {
      if (!endRun) return;
      endRun = false;
      limitedReasoning = 0;
      onHandover?.();
      throw new ContentlessModelResponseHandover();
    },
  };
}
