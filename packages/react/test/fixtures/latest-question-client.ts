import type { SessionEvent, SessionQueueSnapshot } from "@opengeni/sdk";
import { fakeClient, fakeTurn, SESSION_ID, WORKSPACE_ID } from "../fake-client";

/** Real feed/queue projection fixture shared by DOM and Chromium harnesses. */
export function latestQuestionClient(mode: "pending" | "started" | "withdrawn" | "legacy-running" | "legacy-settled") {
  const started = mode === "started" || mode === "legacy-running" || mode === "legacy-settled";
  const event = (sequence: number, type: string, payload: unknown, turnId: string | null = null): SessionEvent => ({
    id: `question-event-${sequence}`, sequence, type, payload, turnId,
    sessionId: SESSION_ID, workspaceId: WORKSPACE_ID, clientEventId: null,
    occurredAt: new Date(Date.UTC(2026, 8, 28, 12, 0, sequence)).toISOString(),
  });
  const question = event(1000, "user.message", { text: "Newest queued question", routing: "queued_for_execution" });
  const turn = fakeTurn({ id: "newest-queued-turn", triggerEventId: question.id, prompt: "Newest queued question" });
  const snapshot: SessionQueueSnapshot = {
    version: 1,
    effectiveControl: { state: "active", controlVersion: 1, controlEtag: "control-1", directState: "active", primaryBlocker: null, additionalBlockerCount: 0, blockers: [], resumeOptions: [], override: null, settlement: null },
    activePersonalConnections: [], stoppingPreviousAttempt: false,
    items: mode === "pending" ? [turn] : [], pendingInputs: [], pendingInputAttachment: null,
  };
  const store = [
    event(1, "user.message", { text: "Previous valid question", routing: "accepted_for_execution" }),
    event(2, "agent.message.completed", { text: "Previous answer", messageId: "previous-answer" }, "previous-turn"),
    question,
    event(1001, "turn.queued", { triggerEventId: question.id, turnId: turn.id }, turn.id),
    ...(mode === "withdrawn" ? [event(1002, "session.queue.changed", { operation: "delete", turnId: turn.id }, turn.id)] : []),
    ...Array.from({ length: 1997 }, (_, index) => event(1003 + index, "agent.reasoning.delta", { text: "Working on the prior request. ", itemId: "old-reasoning" }, "previous-turn")),
    ...(started ? [mode === "started"
      ? event(3000, "turn.started", { triggerEventId: question.id }, turn.id)
      : event(3000, "agent.toolCall.created", { id: "legacy-tool", name: "exec_command", arguments: { cmd: "verify" } }, turn.id)] : []),
    ...Array.from({ length: 40 }, (_, index) => event(3001 + index, "agent.message.completed", { text: `Progress ${index + 1}. **Readable work** for the current request.\n\nDetails remain in the conversation.`, messageId: `progress-${index}` }, started ? turn.id : "previous-turn")),
    ...(mode === "legacy-settled" ? [event(3041, "turn.completed", { output: "Verified" }, turn.id)] : []),
  ];
  const reads: Array<{ includeTypes?: string[] }> = [];
  const client = fakeClient({
    listEvents: async (_workspace, _session, options = {}) => {
      reads.push(options);
      let rows = store.filter((item) => item.sequence > (options.after ?? 0) && (options.before === undefined || item.sequence < options.before));
      if (options.includeTypes) rows = rows.filter((item) => options.includeTypes!.includes(item.type));
      return options.direction === "before" || options.before !== undefined ? rows.slice(-(options.limit ?? 500)) : rows.slice(0, options.limit ?? 500);
    },
    getQueue: async () => snapshot,
    getSession: async () => ({ id: SESSION_ID, status: mode === "legacy-settled" ? "idle" : "running", activeTurnId: started ? turn.id : "previous-turn", effectiveControl: snapshot.effectiveControl }) as never,
    getWorkspaceModelCatalog: async () => ({ models: [] }) as never,
    listHumanInputRequests: async () => [],
    streamEvents: async function* (_workspace, _session, options) {
      await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
      yield* [];
    },
  });
  return { client, snapshot, question, turn, store, reads };
}