import type { Settings } from "@opengeni/config";
import {
  reasoningEffortForMetadata,
  type GoalSpec,
  type ResourceRef,
  type SessionTurn,
  type ToolRef,
} from "@opengeni/contracts";
import {
  createSession,
  createSessionGoal,
  enqueueSessionTurn,
  getSessionTurn,
  requireSession,
  setTemporalWorkflowId,
  type Database,
} from "@opengeni/db";
import { appendAndPublishEvents, type EventBus } from "@opengeni/events";
import { HTTPException } from "hono/http-exception";
import type { SessionWorkflowClient } from "../dependencies";

export async function createAndStartSession(input: {
  db: Database;
  bus: EventBus;
  workflowClient: SessionWorkflowClient;
  accountId: string;
  workspaceId: string;
  initialMessage: string;
  resources: ResourceRef[];
  tools: ToolRef[];
  clientEventId?: string;
  model: string;
  reasoningEffort: Settings["openaiReasoningEffort"];
  sandboxBackend: Settings["sandboxBackend"];
  metadata: Record<string, unknown>;
  // Names/ids only; the session.created payload never carries variable values.
  environment?: { id: string; name: string } | null;
  goal?: GoalSpec | null;
}) {
  const session = await createSession(input.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    initialMessage: input.initialMessage,
    resources: input.resources,
    tools: input.tools,
    metadata: {
      ...input.metadata,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
    },
    model: input.model,
    sandboxBackend: input.sandboxBackend,
    environmentId: input.environment?.id ?? null,
  });
  // The goal row is durable session state; the workflow picks it up from the
  // database once the first turn completes — no extra workflow plumbing here.
  const goal = input.goal
    ? await createSessionGoal(input.db, {
      accountId: session.accountId,
      workspaceId: session.workspaceId,
      sessionId: session.id,
      text: input.goal.text,
      successCriteria: input.goal.successCriteria ?? null,
      maxAutoContinuations: input.goal.maxAutoContinuations ?? null,
      createdBy: "api",
    })
    : null;
  const initialPayload = {
    text: input.initialMessage,
    ...(input.resources.length ? { resources: input.resources } : {}),
    ...(input.tools.length ? { tools: input.tools } : {}),
  };
  const events = await appendAndPublishEvents(input.db, input.bus, session.workspaceId, session.id, [
    {
      type: "session.created",
      payload: {
        status: "queued",
        ...(input.environment ? { environmentId: input.environment.id, environmentName: input.environment.name } : {}),
      },
    },
    ...(goal ? [{
      type: "goal.set" as const,
      payload: {
        goalId: goal.id,
        text: goal.text,
        ...(goal.successCriteria ? { successCriteria: goal.successCriteria } : {}),
        version: goal.version,
        actor: "api",
        replaced: false,
      },
    }] : []),
    {
      type: "user.message",
      payload: initialPayload,
      ...(input.clientEventId ? { clientEventId: input.clientEventId } : {}),
    },
    { type: "session.status.changed", payload: { status: "queued" } },
  ]);
  const userEvent = events.find((event) => event.type === "user.message");
  if (!userEvent) {
    throw new HTTPException(500, { message: "failed to append initial user event" });
  }
  const workflowId = workflowIdForSession(session.id);
  await setTemporalWorkflowId(input.db, session.workspaceId, session.id, workflowId);
  const turn = await enqueueSessionTurn(input.db, {
    accountId: session.accountId,
    workspaceId: session.workspaceId,
    sessionId: session.id,
    triggerEventId: userEvent.id,
    temporalWorkflowId: workflowId,
    source: "user",
    prompt: input.initialMessage,
    resources: input.resources,
    tools: input.tools,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    sandboxBackend: input.sandboxBackend,
    metadata: {},
  });
  await appendAndPublishEvents(input.db, input.bus, session.workspaceId, session.id, [{
    type: "turn.queued",
    turnId: turn.id,
    payload: { turnId: turn.id, triggerEventId: userEvent.id, source: turn.source },
  }]);
  await input.workflowClient.wakeSessionWorkflow({ accountId: session.accountId, workspaceId: session.workspaceId, sessionId: session.id, workflowId });
  return await requireSession(input.db, session.workspaceId, session.id);
}

export function workflowIdForSession(sessionId: string): string {
  return `session-${sessionId}`;
}

export async function requireQueuedTurnForApi(db: Database, workspaceId: string, sessionId: string, turnId: string): Promise<SessionTurn> {
  const turn = await getSessionTurn(db, workspaceId, turnId);
  if (!turn || turn.sessionId !== sessionId) {
    throw new HTTPException(404, { message: "session turn not found" });
  }
  if (turn.status !== "queued") {
    throw new HTTPException(409, { message: `turn is ${turn.status}; only queued turns can be changed` });
  }
  return turn;
}

export function reasoningEffortForSession(metadata: Record<string, unknown>, fallback: Settings["openaiReasoningEffort"]): Settings["openaiReasoningEffort"] {
  return reasoningEffortForMetadata(metadata, fallback);
}
