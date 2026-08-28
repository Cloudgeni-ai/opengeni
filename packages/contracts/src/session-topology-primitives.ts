import { z } from "zod";

export const SessionStatus = z.enum([
  "queued",
  "running",
  "idle",
  "requires_action",
  "recovering",
  "waiting_capacity",
  "failed",
  "cancelled",
]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const SessionGoalStatus = z.enum(["active", "paused", "completed"]);
export type SessionGoalStatus = z.infer<typeof SessionGoalStatus>;

/** Physical ceiling of the PostgreSQL integer columns that persist depth policy. */
export const MAX_NESTED_AGENT_DEPTH = 2_147_483_647;
export const NestedAgentDepthValue = z.number().int().nonnegative().max(MAX_NESTED_AGENT_DEPTH);
export type NestedAgentDepthValue = z.infer<typeof NestedAgentDepthValue>;
