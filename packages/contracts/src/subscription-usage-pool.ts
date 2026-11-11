import * as primitives from "./primitives";
import { z } from "zod";
import { defineSchema } from "./define-schema";

/** Informational limits, never a routing/admission decision or a spending total. */
export const SubscriptionUsagePool = /* @__PURE__ */ defineSchema(() =>
  z.object({
    provider: z.enum(["codex", "claude", "xai"]),
    observedAt: z.string().datetime().nullable(),
    windows: z.array(
      z.object({
        id: z.enum(["five_hour", "weekly"]),
        remainingPercent: z.number().min(0).max(100).nullable(),
        accounts: z.array(
          z.object({
            id: primitives.uuid,
            label: primitives.string,
            remainingPercent: z.number().min(0).max(100).nullable(),
            resetsAt: z.string().datetime().nullable(),
            weight: z.number().positive(),
            weightBasis: z.enum(["observed", "plan_estimate"]),
            observedAt: z.string().datetime().nullable(),
          }),
        ),
        forecast: z.object({
          kind: z.enum(["runs_out", "unused", "insufficient_history"]),
          basis: primitives.string,
          runsOutAt: z.string().datetime().nullable(),
          nextResetAt: z.string().datetime().nullable(),
          unusedPercent: z.number().min(0).max(100).nullable(),
          utilizationPercent: z.number().min(0).max(100).nullable().optional(),
          lowestPercent: z.number().min(0).max(100).nullable(),
          historyDays: z.number().nonnegative(),
        }),
      }),
    ),
  }),
);
export type SubscriptionUsagePool = z.infer<typeof SubscriptionUsagePool>;

export const SubscriptionUsagePoolsResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ pools: z.array(SubscriptionUsagePool), checkedAt: primitives.dateTime }),
);
export type SubscriptionUsagePoolsResponse = z.infer<typeof SubscriptionUsagePoolsResponse>;
