import {
  UNATTRIBUTED_LEGACY_INITIATOR_SUBJECT_ID,
  type TurnInitiator,
  type TurnInitiatorContext,
} from "@opengeni/contracts";
import { and, eq } from "drizzle-orm";
import type { Database } from "./index";
import type { SessionCommandActor } from "./session-control";
import * as schema from "./schema";

export const UNATTRIBUTED_LEGACY_INITIATOR: TurnInitiator = {
  kind: "service",
  subjectId: UNATTRIBUTED_LEGACY_INITIATOR_SUBJECT_ID,
};

export type FrozenTurnInitiator = {
  initiator: TurnInitiator;
  context: TurnInitiatorContext;
};

const MAX_AGENT_PROVENANCE_HOPS = 32;

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
    };
  }

  const [turn] = await db
    .select({
      initiatorKind: schema.sessionTurns.initiatorKind,
      initiatorSubjectId: schema.sessionTurns.initiatorSubjectId,
      initiatorContext: schema.sessionTurns.initiatorContext,
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
  const clipped = hops.slice(-MAX_AGENT_PROVENANCE_HOPS);
  return {
    initiator: initiatorFromStorage(turn.initiatorKind, turn.initiatorSubjectId, storedContext),
    context: {
      ...storedContext,
      via: clipped,
      ...(hops.length > clipped.length ? { viaTruncated: true } : {}),
    },
  };
}
