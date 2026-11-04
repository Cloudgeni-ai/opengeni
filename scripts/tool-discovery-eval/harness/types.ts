import type { Tool } from "@openai/agents";

/** One model-visible function tool of an exported catalog, with its published identity. */
export type CatalogTool = {
  /** The name the model sees, for example `mcp_<digest>__projects_search`. */
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** The MCP server (registry id) and the name it publishes, when the tool comes from one. */
  server?: string;
  published?: string;
  /** Sent on every request rather than found through search. */
  eager: boolean;
};

export type Catalog = {
  tools: CatalogTool[];
  functionTools: Tool[];
  sha256: string;
  /** Resolves a model name, `server.tool`, a published name or its `_`/`-` forms to model names. */
  resolve(reference: string): string[];
};

export type Scenario = {
  id: string;
  /** What the user asked, in their words. Optional task context for strategies that use it. */
  task?: string;
  /** Search queries to evaluate. When omitted, the task text is the query. */
  queries: string[];
  /** Model names of every tool that would be a right answer. */
  acceptable: string[];
  tags: string[];
  /** Where the scenario came from, for reading reports; not a slice. */
  source?: string;
  notes?: string;
};

export type SearchInput = { query: string; task?: string; signal?: AbortSignal };

export type StageTrace = {
  name: string;
  /** Ranked candidate names, best first, with an optional score. */
  candidates?: { name: string; score?: number }[];
  detail?: unknown;
  latencyMs?: number;
};

export type SearchTrace = {
  /** Tools whose schemas the agent receives, in order. */
  loaded: string[];
  /** Tools the agent sees named but not loaded (alternatives, suggestions, candidate notes). */
  shown: string[];
  /** The exact text the agent receives for this search. */
  agentText: string;
  stages: StageTrace[];
  /** Why a strategy fell back from its intended path, if it did. */
  fallback?: string;
  latencyMs: number;
  costUsd: number;
};

export interface Strategy {
  readonly name: string;
  readonly description: string;
  search(input: SearchInput): Promise<SearchTrace>;
  /**
   * A fresh instance for one scenario's searches, when the strategy keeps
   * per-turn state (the runtime's search memory). Stateless strategies omit it.
   */
  turn?(): Strategy;
}

export type SearchRecord = {
  scenario: string;
  tags: string[];
  query: string;
  task?: string;
  acceptable: string[];
  strategy: string;
  trace?: SearchTrace;
  error?: string;
};
