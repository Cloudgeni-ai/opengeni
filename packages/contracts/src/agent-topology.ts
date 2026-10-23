import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
import { z } from "zod";

import {
  NestedAgentDepthValue,
  SessionGoalStatus,
  SessionStatus,
} from "./session-topology-primitives";
import { WorkDiscoveryProjection } from "./work-claims";

/** Compact, bounded session projection for workspace agent-topology browsers. */
export const AgentTopologySession = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: primitives.uuid,
    title: primitives.nullableString,
    titleTruncated: primitives.boolean,
    parentSessionId: primitives.nullableUuid,
    rootSessionId: primitives.uuid,
    nestedAgentDepth: NestedAgentDepthValue,
    ancestorPath: z.array(
      z.object({
        id: primitives.uuid,
        title: primitives.nullableString,
        titleTruncated: primitives.boolean,
      }),
    ),
    status: SessionStatus,
    goal: z
      .object({
        status: SessionGoalStatus,
        summary: primitives.string,
        summaryTruncated: primitives.boolean,
      })
      .nullable(),
    pause: z.object({
      state: z.enum(["active", "paused"]),
      additionalBlockerCount: primitives.nonnegativeInteger,
      source: z
        .object({
          kind: z.enum(["session", "workspace"]),
          sessionId: primitives.optionalUuid,
          displayName: primitives.string,
          displayNameTruncated: primitives.boolean,
        })
        .nullable(),
    }),
    children: z.object({
      directChildren: primitives.nonnegativeInteger,
      totalDescendants: primitives.nonnegativeInteger,
      runningDescendants: primitives.nonnegativeInteger,
      queuedDescendants: primitives.nonnegativeInteger,
      attentionDescendants: primitives.nonnegativeInteger,
      pausedDescendants: primitives.nonnegativeInteger,
      failedDescendants: primitives.nonnegativeInteger,
      truncated: primitives.boolean,
    }),
    relatedWork: WorkDiscoveryProjection,
    createdAt: primitives.string,
    updatedAt: primitives.string,
  }),
);
export type AgentTopologySession = z.infer<typeof AgentTopologySession>;

export const AgentTopologyPageResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    sessions: z.array(AgentTopologySession),
    total: primitives.nonnegativeInteger,
    hasMore: primitives.boolean,
    /** Operator rollout decision for human advisory presentation. */
    humanAdvisoriesEnabled: primitives.optionalBoolean,
    nextCursor: primitives.nullableString,
  }),
);
export type AgentTopologyPageResponse = z.infer<typeof AgentTopologyPageResponse>;
