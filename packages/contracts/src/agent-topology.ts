import { z } from "zod";

import {
  NestedAgentDepthValue,
  SessionGoalStatus,
  SessionStatus,
} from "./session-topology-primitives";
import { WorkDiscoveryProjection } from "./work-claims";

/** Compact, bounded session projection for workspace agent-topology browsers. */
export const AgentTopologySession = z.object({
  id: z.string().uuid(),
  title: z.string().nullable(),
  titleTruncated: z.boolean(),
  parentSessionId: z.string().uuid().nullable(),
  rootSessionId: z.string().uuid(),
  nestedAgentDepth: NestedAgentDepthValue,
  ancestorPath: z.array(
    z.object({
      id: z.string().uuid(),
      title: z.string().nullable(),
      titleTruncated: z.boolean(),
    }),
  ),
  status: SessionStatus,
  goal: z
    .object({
      status: SessionGoalStatus,
      summary: z.string(),
      summaryTruncated: z.boolean(),
    })
    .nullable(),
  pause: z.object({
    state: z.enum(["active", "paused"]),
    additionalBlockerCount: z.number().int().nonnegative(),
    source: z
      .object({
        kind: z.enum(["session", "workspace"]),
        sessionId: z.string().uuid().optional(),
        displayName: z.string(),
        displayNameTruncated: z.boolean(),
      })
      .nullable(),
  }),
  children: z.object({
    directChildren: z.number().int().nonnegative(),
    totalDescendants: z.number().int().nonnegative(),
    runningDescendants: z.number().int().nonnegative(),
    queuedDescendants: z.number().int().nonnegative(),
    attentionDescendants: z.number().int().nonnegative(),
    pausedDescendants: z.number().int().nonnegative(),
    failedDescendants: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }),
  relatedWork: WorkDiscoveryProjection,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AgentTopologySession = z.infer<typeof AgentTopologySession>;

export const AgentTopologyPageResponse = z.object({
  sessions: z.array(AgentTopologySession),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  /** Operator rollout decision for human advisory presentation. */
  humanAdvisoriesEnabled: z.boolean().optional(),
  nextCursor: z.string().nullable(),
});
export type AgentTopologyPageResponse = z.infer<typeof AgentTopologyPageResponse>;
