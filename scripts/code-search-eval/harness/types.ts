/** A line span in a repository file. Lines are 1-based and inclusive. */
export type Span = { file: string; start: number; end: number };

/** One localization task: a question or issue over a repository at a fixed commit. */
export type Task = {
  id: string;
  /** Owner/name, used to cluster confidence intervals and split dev/test by repository. */
  repo: string;
  repoUrl: string;
  commit: string;
  language: string;
  source: string;
  query: string;
  /** Evidence a correct answer or fix needs: human gold context, or files a gold patch edits. */
  oracle: { files: string[]; spans: Span[] };
  split?: "dev" | "test";
};

/** What an arm returns: files ranked best first, and the spans it would put in context. */
export type Prediction = {
  files: string[];
  spans: Span[];
  /** Per-file relevance from a scoring arm, kept so a cut chosen on dev can be applied afterwards. */
  fileScores?: Record<string, number>;
};

export type Usage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** Billed cash in US dollars. Subscription-backed calls report 0 here and price them in apiEquivalentUsd. */
  cashUsd: number;
  apiEquivalentUsd: number;
  modelCalls: number;
  toolCalls: number;
};

export type ArmRun = {
  taskId: string;
  arm: string;
  prediction: Prediction;
  usage: Usage;
  latencyMs: number;
  error?: string;
};

export type ArmContext = {
  /** Checked-out repository at the task commit. */
  repoDir: string;
  signal: AbortSignal;
};

export interface Arm {
  readonly name: string;
  /** True when the arm makes paid or subscription model calls. Live arms need --allow-live and a budget. */
  readonly live: boolean;
  run(
    task: Task,
    context: ArmContext,
  ): Promise<{ prediction: Prediction; usage: Usage }>;
}

export const zeroUsage = (): Usage => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  cashUsd: 0,
  apiEquivalentUsd: 0,
  modelCalls: 0,
  toolCalls: 0,
});

export function addUsage(into: Usage, more: Partial<Usage>): Usage {
  for (const key of Object.keys(more) as (keyof Usage)[])
    into[key] += more[key] ?? 0;
  return into;
}
