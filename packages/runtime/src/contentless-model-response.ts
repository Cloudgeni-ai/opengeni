import type { StreamEvent } from "@openai/agents";
import { isPreemptedModelResponse } from "./model-preemption";
import { ModelStepHandover } from "./model-step-handover";

/**
 * A completed model response with nothing the run can act on: no text, no
 * refusal and no call of any kind (at most reasoning). The SDK treats it as
 * "not final yet" and samples again, and since it adds nothing to the input,
 * the next request is the same request: with a high model-call cap the turn
 * would re-sample without end. A Steer's preempted response is not one.
 */
export function isContentlessModelResponse(event: StreamEvent): boolean {
  if (event.type !== "response_done" || isPreemptedModelResponse(event)) return false;
  const output = (event.response as { output?: unknown }).output;
  if (!Array.isArray(output)) return false;
  return output.every((item) => !carriesContent(item));
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
 * with an empty final output) instead of sending the same request again. The
 * host decides what the empty result means (for a turn: one reply reminder,
 * then a visible empty-reply notice).
 */
export function contentlessModelResponseGuard(onHandover?: () => void) {
  let previousContentless = false;
  return {
    observe(event: StreamEvent): void {
      if (event.type === "response_done") previousContentless = isContentlessModelResponse(event);
    },
    check(): void {
      if (!previousContentless) return;
      previousContentless = false;
      onHandover?.();
      throw new ContentlessModelResponseHandover();
    },
  };
}
