import { FIRST_PARTY_MCP_TOOL_NAMES } from "@opengeni/contracts";

export const MCP_TOOL_CALL_OUTCOMES = [
  "success",
  "provider_declared_error",
  "auth_needed",
  "outcome_uncertain",
  "timeout",
  "cancelled",
  "thrown_transport_error",
  "thrown_protocol_error",
] as const;

export type McpToolCallOutcome = (typeof MCP_TOOL_CALL_OUTCOMES)[number];

/**
 * Fixed `tool` label for every MCP tool call that is not a first-party Opengeni
 * catalog tool: workspace, connector, API-integration, and Codex Apps tools are
 * user- or provider-defined names, so they share one bucket instead of becoming
 * unbounded metric series.
 */
export const MCP_TOOL_METRIC_EXTERNAL_LABEL = "external";

/**
 * Closed set of tool names that may appear as a metric label: the first-party
 * `opengeni`/`docs` catalog plus the dedicated `files` server tool.
 */
const MCP_TOOL_METRIC_FIRST_PARTY_NAMES: ReadonlySet<string> = new Set<string>([
  ...FIRST_PARTY_MCP_TOOL_NAMES,
  "files_get_download_url",
]);

/**
 * Bounded-cardinality `tool` label for one MCP tool call. A name is kept only
 * when the call went to a verified first-party server and the name is in the
 * fixed first-party catalog; everything else collapses to `external`.
 */
export function mcpToolMetricLabel(input: { firstParty: boolean; toolName: string }): string {
  return input.firstParty && MCP_TOOL_METRIC_FIRST_PARTY_NAMES.has(input.toolName)
    ? input.toolName
    : MCP_TOOL_METRIC_EXTERNAL_LABEL;
}

/** True only for a value `mcpToolMetricLabel` can return. */
export function isMcpToolMetricLabel(value: unknown): value is string {
  return (
    value === MCP_TOOL_METRIC_EXTERNAL_LABEL ||
    (typeof value === "string" && MCP_TOOL_METRIC_FIRST_PARTY_NAMES.has(value))
  );
}

export const MCP_LIFECYCLE_PHASES = ["connect", "close"] as const;
export const MCP_LIFECYCLE_POLICIES = ["strict", "best_effort"] as const;
export const MCP_LIFECYCLE_OUTCOMES = ["completed", "failed"] as const;

/**
 * Closed outcomes of one fresh-box command-readiness replacement decision:
 * the replacement became ready, it also missed readiness, it failed for another
 * typed reason, cancellation won the pause or the replacement, or the turn
 * attempt had already spent its single replacement.
 */
export const SANDBOX_READINESS_REPLACEMENT_OUTCOMES = [
  "replaced",
  "failed_again",
  "replacement_failed",
  "cancelled",
  "budget_spent",
] as const;

export type SandboxReadinessReplacementOutcome =
  (typeof SANDBOX_READINESS_REPLACEMENT_OUTCOMES)[number];

export type McpLifecyclePhase = (typeof MCP_LIFECYCLE_PHASES)[number];
export type McpLifecyclePolicy = (typeof MCP_LIFECYCLE_POLICIES)[number];
export type McpLifecycleOutcome = (typeof MCP_LIFECYCLE_OUTCOMES)[number];

export type RuntimeMetricsHooks = {
  onModelCall?: (input: {
    provider: string;
    outcome: "completed" | "failed";
    durationSeconds: number;
  }) => void;
  onSandboxCreate?: (input: {
    backend: string;
    imageSource: "logical" | "provider_immutable";
    outcome: "completed" | "failed";
    durationSeconds: number;
  }) => void;
  onSandboxWarmingTimeout?: (input: {
    backend: string;
    stage: "exec_readiness" | "sibling_warming";
  }) => void;
  /**
   * One fresh-box readiness replacement decision. The first readiness miss is
   * still counted by `onSandboxWarmingTimeout`; this hook says whether the
   * single per-turn-attempt replacement happened and whether it worked.
   */
  onSandboxReadinessReplacement?: (input: {
    backend: string;
    outcome: SandboxReadinessReplacementOutcome;
  }) => void;
  onSandboxProviderApiThrottle?: (input: {
    backend: string;
    operation: "create" | "renew";
  }) => void;
  onSandboxTtlRenewal?: (input: { backend: string; outcome: "completed" | "failed" }) => void;
  onOpenSandboxSignedEndpoint?: (input: {
    outcome: "minted" | "mint_failed" | "host_fetch_unauthorized";
    port: number;
  }) => void;
  onWorkspaceArchiveObject?: (input: {
    outcome: "put" | "put_failed" | "deleted_unpublished";
    backend: string;
  }) => void;
  /** Physical capture plus publication; emitted at settlement, not caller timeout. */
  onWorkspaceCapture?: (input: {
    backend: string;
    outcome: "completed" | "failed";
    durationSeconds: number;
  }) => void;
  /**
   * One physical MCP tools/call invocation. `tool` is the bounded
   * `mcpToolMetricLabel` value (a first-party catalog name or `external`); server,
   * raw user-defined tool, tenant, request, and error-content labels stay excluded.
   */
  onMcpToolCall?: (input: {
    outcome: McpToolCallOutcome;
    tool: string;
    durationSeconds: number;
  }) => void;
  /**
   * One physical MCP connection lifecycle operation. Labels stay structural:
   * no server, tenant, request, URL, or error-content dimensions are admitted.
   */
  onMcpLifecycle?: (input: {
    phase: McpLifecyclePhase;
    policy: McpLifecyclePolicy;
    outcome: McpLifecycleOutcome;
    durationSeconds: number;
  }) => void;
  /**
   * One completed Connected Machine (selfhosted) control op — the out-of-band
   * telemetry twin of the in-band fault rendering. `code` is the typed wire-code
   * NAME on a failure (bounded label cardinality); `healed` marks a success that
   * only landed after ≥1 retry (the leading indicator of the next unhealed fault);
   * `replyBytes` is set only on a payload-wall fault. Wired from the runtime's
   * `SelfhostedOpObserver` seam.
   */
  onSandboxOp?: (input: {
    backend: string;
    op: string;
    outcome: "ok" | "failed";
    code?: string;
    healed: boolean;
    retries: number;
    durationSeconds: number;
    replyBytes?: number;
  }) => void;
};
