import type {
  AgentRun,
  AgentRunStatus,
  EventType,
  RunEvent,
} from "./types";

export interface UserTurn {
  kind: "user";
  id: string;
  content: string;
  createdAt: string;
  turn: number;
}

export interface AssistantTurn {
  kind: "assistant";
  id: string;
  content: string | null;
  createdAt: string;
  turn: number;
  status: "pending" | "complete" | "interrupted";
}

export type ConversationTurn = UserTurn | AssistantTurn;

export type TerminalMarker =
  | { kind: "succeeded"; message?: string }
  | { kind: "failed"; message: string }
  | { kind: "cancelled"; message?: string };

export interface Conversation {
  turns: ConversationTurn[];
  terminal: TerminalMarker | null;
  hasPendingAssistant: boolean;
}

const LIFECYCLE_ONLY: ReadonlySet<EventType> = new Set([
  "run.created",
  "run.dispatched",
  "run.started",
  "run.waiting",
  "run.cancel_requested",
  "artifact.created",
]);

const TERMINAL_STATUSES: ReadonlySet<AgentRunStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

function stringPayload(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" ? value : null;
}

function numberPayload(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === "number" ? value : null;
}

export function projectConversation(run: AgentRun, events: RunEvent[]): Conversation {
  const sorted = [...events].sort((a, b) => a.sequence - b.sequence);
  const turns: ConversationTurn[] = [
    {
      kind: "user",
      id: `user-initial-${run.id}`,
      content: run.prompt,
      createdAt: run.created_at,
      turn: 1,
    },
  ];

  let currentTurn = 1;
  let terminal: TerminalMarker | null = null;

  for (const event of sorted) {
    const type = event.type as EventType;
    if (LIFECYCLE_ONLY.has(type)) {
      continue;
    }

    if (type === "run.completed") {
      const output = stringPayload(event.payload as Record<string, unknown>, "output") ?? "";
      const turnIndex = numberPayload(event.payload as Record<string, unknown>, "turn") ?? currentTurn;
      turns.push({
        kind: "assistant",
        id: event.id,
        content: output,
        createdAt: event.created_at,
        turn: turnIndex,
        status: "complete",
      });
      continue;
    }

    if (type === "run.follow_up_requested" || type === "run.follow_up") {
      const prompt = stringPayload(event.payload as Record<string, unknown>, "prompt");
      const turnIndex =
        numberPayload(event.payload as Record<string, unknown>, "turn") ?? currentTurn + 1;
      // follow_up_requested is API-side; follow_up is workflow-side. Merge into one user turn
      // per distinct prompt so duplicate events do not double up.
      let lastUser: UserTurn | null = null;
      for (let i = turns.length - 1; i >= 0; i -= 1) {
        const candidate = turns[i];
        if (candidate && candidate.kind === "user") {
          lastUser = candidate;
          break;
        }
      }
      if (prompt && (!lastUser || lastUser.content !== prompt || lastUser.turn !== turnIndex)) {
        turns.push({
          kind: "user",
          id: event.id,
          content: prompt,
          createdAt: event.created_at,
          turn: turnIndex,
        });
      }
      currentTurn = turnIndex;
      continue;
    }

    if (type === "run.failed") {
      const message = stringPayload(event.payload as Record<string, unknown>, "error") ?? "Run failed";
      terminal = { kind: "failed", message };
      continue;
    }

    if (type === "run.cancelled") {
      terminal = { kind: "cancelled" };
      continue;
    }
  }

  if (!terminal && run.status === "succeeded") {
    terminal = { kind: "succeeded" };
  } else if (!terminal && run.status === "failed") {
    terminal = { kind: "failed", message: "Run failed" };
  } else if (!terminal && run.status === "cancelled") {
    terminal = { kind: "cancelled" };
  }

  const isActive = !TERMINAL_STATUSES.has(run.status) && terminal === null;
  const lastTurn = turns[turns.length - 1];
  const needsPendingAssistant =
    isActive && lastTurn != null && lastTurn.kind === "user";

  if (needsPendingAssistant) {
    turns.push({
      kind: "assistant",
      id: `assistant-pending-${run.id}-${lastTurn.turn}`,
      content: null,
      createdAt: run.updated_at,
      turn: lastTurn.turn,
      status: "pending",
    });
  }

  return {
    turns,
    terminal,
    hasPendingAssistant: Boolean(needsPendingAssistant),
  };
}
