// Hand-written mirrors of the public wire shapes in `@opengeni/contracts`.
// The SDK keeps zero runtime dependencies so it stays framework-agnostic and
// publishable on its own; `test/contract-parity.test.ts` pins these types to
// the contracts package so drift fails the gate instead of shipping.

export type SessionStatus =
  | "queued"
  | "running"
  | "idle"
  | "requires_action"
  | "failed"
  | "cancelled";

export type SandboxBackend = "docker" | "modal" | "local" | "none";

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type RepositoryResourceRef = {
  kind: "repository";
  uri: string;
  ref: string;
  mountPath?: string | undefined;
  subpath?: string | undefined;
  githubInstallationId?: number | undefined;
  githubRepositoryId?: number | undefined;
};

export type FileResourceRef = {
  kind: "file";
  fileId: string;
  mountPath?: string | undefined;
};

export type ResourceRef = RepositoryResourceRef | FileResourceRef;

export type ToolRef = {
  kind: "mcp";
  id: string;
};

export type GoalSpec = {
  text: string;
  successCriteria?: string | undefined;
  maxAutoContinuations?: number | undefined;
};

export type Session = {
  id: string;
  workspaceId: string;
  accountId: string;
  status: SessionStatus;
  initialMessage: string;
  resources: ResourceRef[];
  tools: ToolRef[];
  metadata: Record<string, unknown>;
  model: string;
  sandboxBackend: SandboxBackend;
  environmentId: string | null;
  firstPartyMcpPermissions: string[] | null;
  temporalWorkflowId: string | null;
  activeTurnId: string | null;
  lastSequence: number;
  createdAt: string;
  updatedAt: string;
};

export type SessionTurnStatus =
  | "queued"
  | "running"
  | "requires_action"
  | "completed"
  | "failed"
  | "cancelled";

export type SessionTurnSource = "user" | "scheduled_task" | "api" | "goal";

export type SessionTurn = {
  id: string;
  workspaceId: string;
  sessionId: string;
  triggerEventId: string;
  temporalWorkflowId: string;
  status: SessionTurnStatus;
  source: SessionTurnSource;
  position: number;
  prompt: string;
  resources: ResourceRef[];
  tools: ToolRef[];
  model: string;
  reasoningEffort: ReasoningEffort;
  sandboxBackend: SandboxBackend;
  metadata: Record<string, unknown>;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export const SESSION_EVENT_TYPES = [
  "session.created",
  "session.status.changed",
  "session.requiresAction",
  "user.message",
  "user.interrupt",
  "user.approvalDecision",
  "turn.queued",
  "turn.updated",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "turn.preempted",
  "agent.message.delta",
  "agent.message.completed",
  "agent.reasoning.delta",
  "agent.toolCall.created",
  "agent.toolCall.output",
  "agent.updated",
  "sandbox.operation.started",
  "sandbox.operation.completed",
  "sandbox.operation.failed",
  "sandbox.command.output.delta",
  "artifact.created",
  "goal.set",
  "goal.updated",
  "goal.completed",
  "goal.paused",
  "goal.resumed",
  "goal.continuation",
] as const;

export type KnownSessionEventType = (typeof SESSION_EVENT_TYPES)[number];

/**
 * Event types the SDK knows about today, kept open so a newer OpenGeni server
 * can introduce event types without breaking older SDK consumers.
 */
export type SessionEventType = KnownSessionEventType | (string & {});

export type SessionEvent = {
  id: string;
  workspaceId: string;
  sessionId: string;
  /** Per-session sequence number: positive, contiguous, strictly increasing. */
  sequence: number;
  type: SessionEventType;
  payload: unknown;
  occurredAt: string;
  clientEventId?: string | null | undefined;
  turnId?: string | null | undefined;
};

// Payload shapes for the high-traffic event types. `SessionEvent.payload` is
// `unknown` on the wire; these are the documented shapes producers emit today.
export type AgentTextDeltaPayload = { text: string };
export type AgentMessageCompletedPayload = { text: string };
export type AgentToolCallCreatedPayload = {
  id: string | null;
  name: string;
  arguments: unknown;
  raw?: unknown | undefined;
};
export type AgentToolCallOutputPayload = { id: string | null; output: unknown };
export type SessionStatusChangedPayload = { status: SessionStatus };

export type ScheduledTaskStatus = "active" | "paused";

export type ScheduledTaskRunMode = "new_session_per_run" | "reusable_session";

export type ScheduledTaskOverlapPolicy = "allow_concurrent" | "skip" | "buffer_one";

export type ScheduledTaskDayOfWeek =
  | "SUNDAY"
  | "MONDAY"
  | "TUESDAY"
  | "WEDNESDAY"
  | "THURSDAY"
  | "FRIDAY"
  | "SATURDAY";

export type ScheduledTaskScheduleSpec =
  | { type: "once"; runAt: string; timeZone: string }
  | {
      type: "interval";
      everySeconds: number;
      startAt?: string | undefined;
      endAt?: string | undefined;
    }
  | {
      type: "calendar";
      timeZone: string;
      hour: number;
      minute: number;
      daysOfWeek?: ScheduledTaskDayOfWeek[] | undefined;
    };

export type ScheduledTaskAgentConfig = {
  prompt: string;
  resources: ResourceRef[];
  tools: ToolRef[];
  metadata: Record<string, unknown>;
  model?: string | undefined;
  reasoningEffort?: ReasoningEffort | undefined;
  sandboxBackend?: SandboxBackend | undefined;
  goal?: GoalSpec | undefined;
};

export type ScheduledTask = {
  id: string;
  accountId: string;
  workspaceId: string;
  name: string;
  status: ScheduledTaskStatus;
  schedule: ScheduledTaskScheduleSpec;
  temporalScheduleId: string;
  runMode: ScheduledTaskRunMode;
  overlapPolicy: ScheduledTaskOverlapPolicy;
  agentConfig: ScheduledTaskAgentConfig;
  reusableSessionId: string | null;
  environmentId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type CreateSessionRequest = {
  initialMessage: string;
  resources?: ResourceRef[] | undefined;
  tools?: ToolRef[] | undefined;
  metadata?: Record<string, unknown> | undefined;
  model?: string | undefined;
  reasoningEffort?: ReasoningEffort | undefined;
  sandboxBackend?: SandboxBackend | undefined;
  environmentId?: string | undefined;
  goal?: GoalSpec | undefined;
  clientEventId?: string | undefined;
  firstPartyMcpPermissions?: string[] | undefined;
};

export type UserMessageEventInput = {
  type: "user.message";
  clientEventId?: string | undefined;
  payload: {
    text: string;
    resources?: ResourceRef[] | undefined;
    tools?: ToolRef[] | undefined;
    model?: string | undefined;
    reasoningEffort?: ReasoningEffort | undefined;
  };
};

export type UserInterruptEventInput = {
  type: "user.interrupt";
  clientEventId?: string | undefined;
  payload?: { reason?: string | undefined } | undefined;
};

export type UserApprovalDecisionEventInput = {
  type: "user.approvalDecision";
  clientEventId?: string | undefined;
  payload: {
    approvalId: string;
    decision: "approve" | "reject";
    message?: string | undefined;
  };
};

/** Control/user events a client may POST to a session's event log. */
export type ClientSessionEventInput =
  | UserMessageEventInput
  | UserInterruptEventInput
  | UserApprovalDecisionEventInput;
