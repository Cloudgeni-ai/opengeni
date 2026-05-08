import type { Settings } from "@infra-agents/config";
import type { ResourceRef, SessionTurn, ToolRef } from "@infra-agents/contracts";
import {
  createSession,
  enqueueSessionTurn,
  getSessionTurn,
  requireSession,
  setTemporalWorkflowId,
  type Database,
} from "@infra-agents/db";
import { appendAndPublishEvents, type EventBus } from "@infra-agents/events";
import { HTTPException } from "hono/http-exception";
import type { SessionWorkflowClient } from "../dependencies";

export async function createAndStartSession(input: {
  db: Database;
  bus: EventBus;
  workflowClient: SessionWorkflowClient;
  initialMessage: string;
  resources: ResourceRef[];
  tools: ToolRef[];
  clientEventId?: string;
  model: string;
  reasoningEffort: Settings["openaiReasoningEffort"];
  sandboxBackend: Settings["sandboxBackend"];
  metadata: Record<string, unknown>;
}) {
  const session = await createSession(input.db, {
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
  });
  const initialPayload = {
    text: input.initialMessage,
    ...(input.resources.length ? { resources: input.resources } : {}),
    ...(input.tools.length ? { tools: input.tools } : {}),
  };
  const events = await appendAndPublishEvents(input.db, input.bus, session.id, [
    { type: "session.created", payload: { status: "queued" } },
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
  await setTemporalWorkflowId(input.db, session.id, workflowId);
  const turn = await enqueueSessionTurn(input.db, {
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
  await appendAndPublishEvents(input.db, input.bus, session.id, [{
    type: "turn.queued",
    turnId: turn.id,
    payload: { turnId: turn.id, triggerEventId: userEvent.id, source: turn.source },
  }]);
  await input.workflowClient.wakeSessionWorkflow({ sessionId: session.id, workflowId });
  return await requireSession(input.db, session.id);
}

export function workflowIdForSession(sessionId: string): string {
  return `session-${sessionId}`;
}

export async function requireQueuedTurnForApi(db: Database, sessionId: string, turnId: string): Promise<SessionTurn> {
  const turn = await getSessionTurn(db, turnId);
  if (!turn || turn.sessionId !== sessionId) {
    throw new HTTPException(404, { message: "session turn not found" });
  }
  if (turn.status !== "queued") {
    throw new HTTPException(409, { message: `turn is ${turn.status}; only queued turns can be changed` });
  }
  return turn;
}

export function reasoningEffortForSession(metadata: Record<string, unknown>, fallback: Settings["openaiReasoningEffort"]): Settings["openaiReasoningEffort"] {
  const value = metadata.reasoningEffort;
  return value === "none" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh"
    ? value
    : fallback;
}
