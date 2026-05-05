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
  resources: ResourceRef[];
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

export interface GitHubAppManifestStart {
  action_url: string;
  state: string;
  manifest: Record<string, unknown>;
}

export interface GitHubAppStatus {
  configured: boolean;
  app_id: string | null;
  client_id: string | null;
  app_slug: string | null;
  install_url: string | null;
  missing: string[];
}

export interface GitHubRepository {
  id: number;
  installation_id: number;
  full_name: string;
  name: string;
  private: boolean;
  html_url: string;
  clone_url: string;
  default_branch: string;
  account_login: string;
  account_type: string | null;
}

export interface GitHubRepositoryList {
  repositories: GitHubRepository[];
}

export type StreamMessage =
  | { type: "run"; run: AgentRun }
  | { type: "event"; event: RunEvent }
  | { type: "progress"; progress: RunProgress }
  | { type: "progress.error"; error: string }
  | { type: "error"; error: string; code?: number };
