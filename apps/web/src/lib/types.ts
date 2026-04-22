export type AgentRunStatus =
  | "queued"
  | "dispatched"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled";

export const TERMINAL_STATUSES: ReadonlySet<AgentRunStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

export type EventType =
  | "run.created"
  | "run.dispatched"
  | "run.started"
  | "run.waiting"
  | "run.follow_up_requested"
  | "run.follow_up"
  | "run.cancel_requested"
  | "run.completed"
  | "run.failed"
  | "run.cancelled"
  | "artifact.created";

export interface ResourceRef {
  kind: string;
  uri: string;
  metadata: Record<string, unknown>;
}

export interface AgentRun {
  id: string;
  status: AgentRunStatus;
  prompt: string;
  resource: ResourceRef | null;
  metadata: Record<string, unknown>;
  temporal_workflow_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface RunEvent {
  id: string;
  run_id: string;
  sequence: number;
  type: EventType;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface RunProgress {
  run_id: string;
  state: string;
  turn: number;
  queue_depth: number;
  cancellation_requested: boolean;
  waiting_for_follow_up: boolean;
  last_output: string | null;
}

export type StreamMessage =
  | { type: "run"; run: AgentRun }
  | { type: "event"; event: RunEvent }
  | { type: "progress"; progress: RunProgress }
  | { type: "progress.error"; error: string }
  | { type: "error"; error: string; code?: number };
