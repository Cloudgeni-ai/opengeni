import {
  UNATTRIBUTED_LEGACY_INITIATOR_SUBJECT_ID,
  type TurnInitiator,
  type TurnInitiatorContext,
} from "@opengeni/contracts";
import { and, eq } from "drizzle-orm";
import type { Database } from "./database";
import type { SessionCommandActor } from "./session-control";
import * as schema from "./schema";

export const UNATTRIBUTED_LEGACY_INITIATOR: TurnInitiator = {
  kind: "service",
  subjectId: UNATTRIBUTED_LEGACY_INITIATOR_SUBJECT_ID,
};

export type FrozenTurnInitiator = {
  initiator: TurnInitiator;
  context: TurnInitiatorContext;
  /** Exact causal human frozen only after the caller/attempt authority is validated. */
  initiatingHumanSubjectId?: string | null;
};

/** A legacy task has no asserted service identity. Its occurrence is still
 * initiated by the scheduler, not by the missing-attribution sentinel. */
export function frozenScheduledOccurrenceInitiator(
  task: { createdBy: TurnInitiator; createdByContext: TurnInitiatorContext },
  scheduler: FrozenTurnInitiator,
): FrozenTurnInitiator {
  if (
    task.createdBy.kind !== "service" ||
    task.createdBy.subjectId === UNATTRIBUTED_LEGACY_INITIATOR_SUBJECT_ID
  ) {
    return scheduler;
  }
  const { label: _label, ...serviceContext } = task.createdByContext;
  return {
    initiator:
      task.createdBy.subjectId === "scheduler" && !task.createdBy.label
        ? { ...task.createdBy, label: "OpenGeni scheduler" }
        : task.createdBy,
    context: { ...serviceContext, ...scheduler.context },
    initiatingHumanSubjectId: null,
  };
}

const MAX_AGENT_PROVENANCE_HOPS = 32;

/**
 * Bound agent provenance without discarding its causal authority. Once the
 * chain exceeds the cap, retain the first hop and the newest hops in order;
 * consumers can still identify the root attempt while recent diagnostics stay
 * useful. The omitted middle is signalled separately by `viaTruncated`.
 */
export function clipAgentProvenanceHops(
  hops: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  if (hops.length <= MAX_AGENT_PROVENANCE_HOPS) return hops;
  return [hops[0]!, ...hops.slice(-(MAX_AGENT_PROVENANCE_HOPS - 1))];
}

export function initiatorContextForStorage(
  initiator: TurnInitiator,
  context: TurnInitiatorContext = {},
): TurnInitiatorContext {
  return initiator.label ? { ...context, label: initiator.label } : { ...context };
}

export function initiatorFromStorage(
  kind: string,
  subjectId: string,
  context: TurnInitiatorContext,
): TurnInitiator {
  const label =
    typeof context.label === "string" && context.label.length > 0 ? context.label : null;
  return {
    kind: kind === "subject" ? "subject" : "service",
    subjectId,
    ...(label ? { label } : {}),
  };
}

export function initiatorColumns(value: FrozenTurnInitiator): {
  initiatorKind: TurnInitiator["kind"];
  initiatorSubjectId: string;
  initiatorContext: TurnInitiatorContext;
} {
  return {
    initiatorKind: value.initiator.kind,
    initiatorSubjectId: value.initiator.subjectId,
    initiatorContext: initiatorContextForStorage(value.initiator, value.context),
  };
}

export function creatorColumns(value: FrozenTurnInitiator): {
  createdByKind: TurnInitiator["kind"];
  createdBySubjectId: string;
  createdByContext: TurnInitiatorContext;
} {
  return {
    createdByKind: value.initiator.kind,
    createdBySubjectId: value.initiator.subjectId,
    createdByContext: initiatorContextForStorage(value.initiator, value.context),
  };
}

function validAgentHops(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (hop): hop is Record<string, unknown> =>
      typeof hop === "object" && hop !== null && !Array.isArray(hop),
  );
}

/** Freeze the exact target turn's provenance without changing the new service principal. */
export function contextForCausalTurn(
  current: TurnInitiatorContext,
  causal: FrozenTurnInitiator,
  reference: { sessionId: string; turnId: string },
): TurnInitiatorContext {
  const { via, viaTruncated, ...context } = causal.context;
  const hops = [
    ...validAgentHops(via),
    {
      kind: causal.initiator.kind === "subject" ? "human" : "service",
      ...reference,
      initiator: causal.initiator,
      context,
    },
  ];
  const clipped = clipAgentProvenanceHops(hops);
  return {
    ...current,
    via: clipped,
    ...(viaTruncated === true || hops.length > clipped.length ? { viaTruncated: true } : {}),
  };
}

export async function frozenInitiatorForCommandActor(
  db: Database,
  workspaceId: string,
  actor: SessionCommandActor,
  subjectLabel?: string,
): Promise<FrozenTurnInitiator> {
  if (actor.type === "service") {
    return {
      initiator: {
        kind: "service",
        subjectId: actor.subjectId,
        ...(actor.subjectLabel ? { label: actor.subjectLabel } : {}),
      },
      context: { ...(actor.context ?? {}) },
      initiatingHumanSubjectId: null,
    };
  }
  if (actor.type !== "agent_attempt") {
    return {
      initiator: {
        kind: "subject",
        subjectId: actor.subjectId,
        ...(subjectLabel ? { label: subjectLabel } : {}),
      },
      context: {},
      initiatingHumanSubjectId: actor.subjectId,
    };
  }

  const [turn] = await db
    .select({
      initiatorKind: schema.sessionTurns.initiatorKind,
      initiatorSubjectId: schema.sessionTurns.initiatorSubjectId,
      initiatorContext: schema.sessionTurns.initiatorContext,
      initiatingHumanSubjectId: schema.sessionTurns.initiatingHumanSubjectId,
    })
    .from(schema.sessionTurns)
    .where(
      and(
        eq(schema.sessionTurns.workspaceId, workspaceId),
        eq(schema.sessionTurns.sessionId, actor.sessionId),
        eq(schema.sessionTurns.id, actor.turnId),
      ),
    )
    .limit(1);
  if (!turn) {
    throw new Error(`Agent initiator turn not found: ${actor.turnId}`);
  }
  const storedContext = turn.initiatorContext ?? {};
  const inheritedHops = validAgentHops(storedContext.via);
  const hops = [
    ...inheritedHops,
    {
      kind: "agent",
      sessionId: actor.sessionId,
      turnId: actor.turnId,
      attemptId: actor.attemptId,
      executionGeneration: actor.executionGeneration,
    },
  ];
  const clipped = clipAgentProvenanceHops(hops);
  return {
    initiator: initiatorFromStorage(turn.initiatorKind, turn.initiatorSubjectId, storedContext),
    context: {
      ...storedContext,
      via: clipped,
      ...(hops.length > clipped.length ? { viaTruncated: true } : {}),
    },
    initiatingHumanSubjectId:
      turn.initiatingHumanSubjectId ??
      (turn.initiatorKind === "subject" ? turn.initiatorSubjectId : null),
  };
}
