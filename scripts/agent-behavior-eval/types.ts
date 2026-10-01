/** Shared, dependency-free types for the behavior eval (scoring stays pure). */

export type ToolCallRecord = {
  /** Normalized tool name (server prefix stripped, e.g. `memory_save`, `search_documents`). */
  name: string;
  /** Raw name as recorded on the timeline. */
  rawName: string;
  /** Parsed JSON arguments when available, otherwise the raw string. */
  arguments: unknown;
  output: string | null;
};

export type UsageTotals = {
  modelCalls: number;
  inputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
};

export type SessionObservation = {
  sessionId: string;
  /** User messages sent by the harness, in order. */
  userMessages: string[];
  /** One entry per completed turn (`turn.completed` output). */
  turnOutputs: string[];
  /** Last turn output (the answer a user would read last). */
  finalAnswer: string;
  toolCalls: ToolCallRecord[];
  eventTypes: Record<string, number>;
  humanInputRequests: number;
  usage: UsageTotals;
  /** System prompt (instructions) size of the last captured model request, when captured. */
  systemPromptChars: number | null;
  /** Estimated instructions + tool-schema prefix tokens of the last captured request. */
  prefixTokens: number | null;
  /** Tool names sent upfront on the last captured request. */
  upfrontTools: string[];
  /** Normalized names the model could reach: upfront tools ∪ the attempt's MCP catalog. */
  availableTools: string[];
  drive: {
    turns: number;
    goalContinuations: number;
    humanInputAnswered: number;
    approvalsGranted: number;
    stop: string;
    errors: string[];
  };
};

export type RunObservation = {
  sessions: SessionObservation[];
  /** Relative path → content of text files in the (first) session's sandbox after the run. */
  files: Record<string, string> | null;
  /** Other workspace sessions (e.g. spawned children) not created by the harness. */
  extraSessionCount: number;
  /** Scenario-specific facts recorded during the run (fixture ids, expected values). */
  facts: Record<string, string>;
};

export type CheckResult = {
  id: string;
  description: string;
  pass: boolean;
  detail?: string;
  /** Informational checks are reported but never affect the deterministic pass. */
  informational?: boolean;
};

export type JudgeResult = { score: number; rationale: string } | { error: string };

export type RunMetrics = {
  latencyMs: number;
  turns: number;
  toolCallCount: number;
  toolNames: string[];
  usage: UsageTotals;
  costUsd: number | null;
  systemPromptChars: number | null;
  prefixTokens: number | null;
  upfrontToolCount: number | null;
};

export type ScenarioRunResult = {
  scenarioId: string;
  variant: string;
  repeat: number;
  status: "completed" | "skipped" | "error";
  skipReason?: string;
  error?: string;
  checks: CheckResult[];
  deterministicPass: boolean;
  judge: JudgeResult | null;
  metrics: RunMetrics | null;
  transcript: {
    sessions: Array<{
      sessionId: string;
      userMessages: string[];
      turnOutputs: string[];
      toolCalls: Array<{ name: string; arguments: string; output: string | null }>;
      availableTools: string[];
      driveStop: string;
      driveErrors: string[];
    }>;
  } | null;
};
