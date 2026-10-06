import type { Observability } from "./index";

/**
 * Closed, low-cardinality families for agent tool calls. A tool's exact name,
 * MCP server, connector domain, arguments, and output never become labels;
 * unknown future tools collapse to `other` until reviewed here.
 */
export const AGENT_TOOL_METRIC_FAMILIES = [
  "shell",
  "apply_patch",
  "browser",
  "computer",
  "human_handoff",
  "human_input",
  "image",
  "video",
  "web",
  "memory",
  "goal",
  "session",
  "machine",
  "skill",
  "tool_router",
  "files",
  "connector",
  "integration",
  "custom_mcp",
  "codemode",
  "other",
] as const;
export type AgentToolMetricFamily = (typeof AGENT_TOOL_METRIC_FAMILIES)[number];

export const AGENT_TOOL_CALL_OUTCOMES = ["ok", "error", "rejected", "cancelled"] as const;
export type AgentToolCallOutcome = (typeof AGENT_TOOL_CALL_OUTCOMES)[number];

const EXACT: Record<string, AgentToolMetricFamily> = {
  exec_command: "shell",
  write_stdin: "shell",
  local_shell_call: "shell",
  shell_call: "shell",
  shell: "shell",
  command_wait: "shell",
  command_read: "shell",
  interaction_discover: "browser",
  interaction_request_human: "human_handoff",
  request_human_input: "human_input",
  wait_for_input: "human_input",
  session_human_input_respond: "human_input",
  generate_image: "image",
  view_image: "image",
  image_generation_call: "image",
  generate_video: "video",
  get_video_generation_capabilities: "video",
  web_fetch: "web",
  set_session_title: "session",
  notify_user: "session",
  set_other_session_title: "session",
  sessions_list: "session",
  sandboxes_list: "machine",
  sandbox_attach: "machine",
  sandbox_swap: "machine",
  sandbox_provision: "machine",
  run_on: "machine",
  load_skill: "skill",
  repository_skill_read: "skill",
  tool_search: "tool_router",
  tool_list: "tool_router",
  tool_invoke: "tool_router",
  sandbox_file_publish: "files",
  google_drive_publish_file: "files",
  custom_mcp_setup_request: "connector",
  list_models: "other",
};

const PREFIXES: ReadonlyArray<readonly [string, AgentToolMetricFamily]> = [
  ["apply_patch", "apply_patch"],
  ["browser_", "browser"],
  ["computer_", "computer"],
  ["web_search", "web"],
  ["knowledge_", "memory"],
  ["memory_", "memory"],
  ["instruction_policy_", "memory"],
  ["preference_", "memory"],
  ["task_note", "memory"],
  ["remember", "memory"],
  ["company_profile_", "memory"],
  ["work_claim_", "memory"],
  ["goal_", "goal"],
  ["session_", "session"],
  ["project_", "session"],
  ["rig_", "session"],
  ["scheduled_task", "session"],
  ["connected_machine_", "machine"],
  ["skill_", "skill"],
  ["artifacts_", "files"],
  ["editable_artifact_", "files"],
  ["files_", "files"],
  ["slack_", "connector"],
  ["fiken_", "connector"],
  ["x_", "connector"],
  ["reddit_", "connector"],
  ["social_", "connector"],
  ["github_", "connector"],
  ["atlassian_", "connector"],
  ["gmail_", "connector"],
  ["variable_set_", "connector"],
  ["environment_", "connector"],
  ["capability_", "connector"],
];

/**
 * Map the content-free analytics family computed for a tool call
 * (`toolCallFamily`: a first-party tool name, `integration:<domain>`, or
 * `custom`) — or, when absent, the model-facing tool name — onto the closed
 * metric family set.
 */
export function agentToolMetricFamily(
  toolFamily: string | null | undefined,
  name?: string | null,
): AgentToolMetricFamily {
  if (toolFamily === "custom") return "custom_mcp";
  if (toolFamily?.startsWith("integration:")) return "integration";
  const candidate = (toolFamily ?? name ?? "")
    .replace(/^(?:opengeni|interaction)__/, "")
    .toLowerCase();
  if (!candidate) return "other";
  const exact = EXACT[candidate];
  if (exact) return exact;
  for (const [prefix, family] of PREFIXES) {
    if (candidate.startsWith(prefix)) return family;
  }
  return "other";
}

const SDK_NOT_APPROVED = "Tool execution was not approved.";
const SDK_TOOL_ERROR_PREFIX = "An error occurred while running the tool";

/** Structural outcome of a normalized `agent.toolCall.output` payload. */
export function agentToolCallOutcome(payload: unknown): AgentToolCallOutcome {
  if (!payload || typeof payload !== "object") return "ok";
  const record = payload as Record<string, unknown>;
  if (record.error === true || record.failed === true) return "error";
  const output = record.output;
  if (output && typeof output === "object" && (output as { isError?: unknown }).isError === true) {
    return "error";
  }
  const text =
    typeof output === "string"
      ? output
      : output &&
          typeof output === "object" &&
          typeof (output as { text?: unknown }).text === "string"
        ? (output as { text: string }).text
        : null;
  if (text !== null) {
    const trimmed = text.trim();
    if (trimmed === SDK_NOT_APPROVED) return "rejected";
    if (trimmed === "aborted") return "cancelled";
    if (trimmed.startsWith(SDK_TOOL_ERROR_PREFIX)) return "error";
  }
  return "ok";
}

/** Count one completed agent tool call. Telemetry failures never reach the turn. */
export function recordAgentToolCall(
  observability: Observability | null | undefined,
  input: { family: AgentToolMetricFamily; outcome: AgentToolCallOutcome; durationMs?: number },
): void {
  if (!observability) return;
  const family = (AGENT_TOOL_METRIC_FAMILIES as readonly string[]).includes(input.family)
    ? input.family
    : "other";
  const outcome = (AGENT_TOOL_CALL_OUTCOMES as readonly string[]).includes(input.outcome)
    ? input.outcome
    : "ok";
  try {
    observability.incrementCounter({
      name: "opengeni_agent_tool_calls_total",
      help: "Completed agent tool calls by closed tool family and structural outcome.",
      labels: { family, outcome },
    });
    if (input.durationMs !== undefined && Number.isFinite(input.durationMs)) {
      observability.observeHistogram({
        name: "opengeni_agent_tool_call_duration_seconds",
        help: "Agent tool-call duration in seconds by closed tool family.",
        labels: { family },
        value: Math.max(0, input.durationMs) / 1_000,
      });
    }
  } catch {
    // Product execution never inherits an observability failure.
  }
}
