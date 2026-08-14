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
   * One physical MCP tools/call invocation. The closed outcome enum deliberately
   * excludes server, tool, tenant, request, and error-content labels.
   */
  onMcpToolCall?: (input: { outcome: McpToolCallOutcome; durationSeconds: number }) => void;
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
