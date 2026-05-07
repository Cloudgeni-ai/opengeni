export type SessionStatus = "queued" | "running" | "idle" | "requires_action" | "failed" | "cancelled";

export type ResourceRef = {
  kind: "repository" | "object" | "url";
  uri: string;
  metadata: Record<string, unknown>;
};

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type ClientConfig = {
  defaultModel: string;
  allowedModels: string[];
  defaultReasoningEffort: ReasoningEffort;
  allowedReasoningEfforts: ReasoningEffort[];
};

export type Session = {
  id: string;
  status: SessionStatus;
  initialMessage: string;
  resources: ResourceRef[];
  metadata: Record<string, unknown>;
  model: string;
  sandboxBackend: "docker" | "modal" | "local" | "none";
  temporalWorkflowId: string | null;
  activeTurnId: string | null;
  lastSequence: number;
  createdAt: string;
  updatedAt: string;
};

export type SessionEvent = {
  id: string;
  sessionId: string;
  sequence: number;
  type: string;
  payload: unknown;
  occurredAt: string;
  clientEventId?: string | null;
  turnId?: string | null;
};

export type GitHubRepository = {
  id: number;
  installationId: number;
  fullName: string;
  name: string;
  private: boolean;
  htmlUrl: string;
  cloneUrl: string;
  defaultBranch: string;
  accountLogin: string;
  accountType: string | null;
};
