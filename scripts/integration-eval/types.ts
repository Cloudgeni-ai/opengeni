/** Shared, dependency-free types for the integration eval. Grading stays pure. */

/** What a case checks. */
export type CaseKind =
  /** The integration is not connected: the agent should show its connect card. */
  | "not_connected"
  /** Answer from the integration's read tools using seeded synthetic data. */
  | "read"
  /** A write that should ask for approval; the harness approves and verifies. */
  | "write"
  /** The agent reports which account it is connected to. */
  | "identity"
  /** An ambiguous request that needs the right one of several integrations. */
  | "routing";

/** Failure categories reported in the results matrix. */
export type FailureCategory =
  | "wrong_tool"
  | "no_tool"
  | "missing_card"
  | "approval_problem"
  | "tool_error"
  | "hallucinated_result"
  /** Right tool and no error, but the answer misses the expected facts. */
  | "incomplete_answer"
  /** The agent was still working at the run deadline (looping or stalled). A product verdict. */
  | "timeout"
  /** The service's own rate limit, not the agent, failed the row. Excluded from pass rates. */
  | "rate_limited"
  /** The run itself failed (API error, timeout, model refusal to start). Not a product verdict. */
  | "harness_error";

export type IntegrationId =
  | "gmail"
  | "google_calendar"
  | "google_drive"
  | "linear"
  | "notion"
  | "asana"
  | "stripe"
  | "atlassian"
  | "slack"
  | "github"
  | "hubspot"
  | "sentry"
  | "airtable"
  | "apollo"
  | "posthog"
  | "vercel"
  | "supabase"
  | "cloudflare"
  | "dropbox"
  | "canva"
  | "front"
  | "outlook_mail"
  | "outlook_calendar"
  | "clickup"
  | "onedrive"
  | "sharepoint";

export type IntegrationSpec = {
  id: IntegrationId;
  label: string;
  /**
   * Tool families (`integration:<domain>`) the runtime stamps on this
   * integration's tool calls, or first-party families for built-in tools.
   */
  families: readonly string[];
  /** Lower-case words that identify this integration in a connect card or tool account label. */
  labelWords: readonly string[];
  /** Fallback: tool-name patterns (after the `mcp_<id>__` prefix) when no family is recorded. */
  toolNamePatterns?: readonly RegExp[];
  /** Why a deployment cannot test it, when known (e.g. disabled pending provider review). */
  skipReason?: string;
};

export type EvalCase = {
  /** Stable row id, e.g. `linear.read.urgent-issue`. Reruns select by id. */
  id: string;
  integration: IntegrationId;
  kind: CaseKind;
  prompt: string;
  /** Every pattern must match the final answer (fixture facts). */
  expectAnswer?: readonly RegExp[];
  /** Any of these patterns in the final answer means the agent made data up. */
  forbidAnswer?: readonly RegExp[];
  /** Routing: integrations whose tools must not be the only ones used. */
  forbidIntegrations?: readonly IntegrationId[];
  /**
   * Integrations whose tools reach the same data through the same account,
   * e.g. a OneDrive file read through SharePoint's drive or search tools on
   * one Microsoft Graph connection. Their calls count as the row's own.
   */
  servedBy?: readonly IntegrationId[];
  /**
   * Where the row runs. Rows default to the empty workspace for
   * `not_connected` and the connected workspace otherwise. A `not_connected`
   * row in the connected workspace checks that a connect card still appears
   * while other integrations' tools match the request strongly.
   */
  workspace?: "connected" | "empty";
  /**
   * Write: whether the deployment's default tool policy should ask for
   * approval first. `optional` when the default policy lets the write run
   * (for example personal Slack under the Recommended policy). Default required.
   */
  approval?: "required" | "optional";
  /**
   * Write: how the harness answers the approval, as the test user. `reject`
   * checks that a denied write leaves the service unchanged. Default approve.
   */
  decision?: "approve" | "reject";
  /** Write: name of the verifier in verify.ts that confirms the result in the service. */
  verify?: string;
  /**
   * Write on a personal ("Only me") connection: only its owner may approve.
   * The harness first tries to approve with a workspace key
   * (`OPENGENI_EVAL_WORKSPACE_API_KEY`), which must get 403, then approves
   * as the owner.
   */
  ownerOnlyApproval?: boolean;
  /** Write: the approved call's tool name must match, e.g. the personal Slack tool rather than the bot's. */
  approvedTool?: RegExp;
  /** Included in the model × effort grid (the core set). */
  core?: boolean;
  /** Free-form note shown in reports. */
  note?: string;
};

/** One tool call reconstructed from session events. */
export type ToolReceipt = {
  callId: string;
  /** Model-visible name, e.g. `mcp_<id>__list_issues`, `tool_invoke`, `exec_command`. */
  name: string;
  /** For `tool_invoke`, the invoked tool's name; otherwise the same as `name`. */
  effectiveName: string;
  family: string | null;
  /** Integration resolved from family, account label or name patterns. */
  integration: IntegrationId | null;
  arguments: unknown;
  output: string | null;
  /** The output reports an error (MCP error result, auth failure, exception). */
  errored: boolean;
  /** An output event exists. A call without one never finished (turn failed or was cancelled). */
  completed: boolean;
  /** The output says the service rate-limited the call. */
  rateLimited: boolean;
  sequence: number;
};

export type ApprovalReceipt = {
  approvalId: string;
  name: string;
  integration: IntegrationId | null;
  decision: "approve" | "reject" | null;
  sequence: number;
};

export type CardReceipt = {
  capabilityId: string | null;
  capabilityName: string | null;
  providerDomain: string | null;
  integration: IntegrationId | null;
  sequence: number;
};

export type Receipts = {
  tools: ToolReceipt[];
  approvals: ApprovalReceipt[];
  cards: CardReceipt[];
  humanInputRequests: number;
  finalAnswer: string;
  turnStatuses: string[];
  /** Credits (USD micros) or token usage seen in usage events, when present. */
  usage: {
    inputTokens: number;
    cachedTokens: number;
    outputTokens: number;
    costMicros: number | null;
  };
};

export type Grade = {
  pass: boolean;
  category: FailureCategory | null;
  reasons: string[];
};

export type RunRecord = {
  runId: string;
  caseId: string;
  integration: IntegrationId;
  kind: CaseKind;
  model: string;
  effort: string;
  repeat: number;
  workspaceId: string;
  sessionId: string | null;
  chatUrl: string | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  grade: Grade;
  verification: { ran: boolean; ok: boolean | null; detail: string } | null;
  toolsUsed: string[];
  cards: string[];
  approvals: string[];
  finalAnswerExcerpt: string;
  usage: Receipts["usage"];
  error: string | null;
  /** Approval decisions the harness sent, with the key used and the HTTP status (0: key not configured). */
  approvalAttempts?: ApprovalAttempt[];
};

export type ApprovalAttempt = {
  approvalId: string;
  key: "main" | "owner" | "workspace";
  decision: "approve" | "reject";
  status: number;
};
