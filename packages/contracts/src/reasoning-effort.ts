import { defineSchema } from "./define-schema";
import { z } from "zod";

/** Every reasoning effort a model can declare, lowest to highest. */
export const REASONING_EFFORT_LEVELS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export const ReasoningEffort = /* @__PURE__ */ defineSchema(() => z.enum(REASONING_EFFORT_LEVELS));
export type ReasoningEffort = z.infer<typeof ReasoningEffort>;
