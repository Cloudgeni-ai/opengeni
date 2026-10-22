import type { AttemptToolDefinition } from "@opengeni/codemode";
import { decisionModelConfiguration, type Settings } from "@opengeni/config";
import { DecisionUnavailableError, DecisionRequestError } from "@opengeni/decisions";
import {
  CODE_SEARCH_TOOL_DESCRIPTION,
  CODE_SEARCH_TOOL_NAME,
  CodeSearchArgumentError,
  CodeSearchRipgrepMissingError,
  CodeSearchWorkspaceError,
  JevCircuitBreaker,
  codeSearchInputSchema,
  parseCodeSearchArguments,
  renderCodeSearchError,
  runCodeSearch,
  type CodeSearchWorkspace,
  type JevCircuitLease,
} from "@opengeni/jev";
import type { Observability } from "@opengeni/observability";
import {
  ChannelANotFoundError,
  ChannelAUnavailableError,
  ChannelAUnsupportedError,
  ChannelAValidationError,
  isWindowsConnectedMachinePath,
  type SandboxChannelAService,
} from "@opengeni/runtime/sandbox";
import { recordCodeSearchCall, type CodeSearchCallOutcome } from "../../observability-metrics";
import { configuredDecisionModel, type WorkerDecisionSettings } from "./decision-model";

/**
 * One breaker per worker process. Repeated decision-provider outages (including an exhausted
 * account) make `code_search` calls on this worker fail at once for a cooldown
 * instead of each running a full retry cycle. The breaker never changes which
 * tools a turn is offered: the tool list and instructions are the start of the
 * model's cached prompt, and sessions move between workers whose breakers
 * disagree.
 */
export const codeSearchCircuitBreaker = new JevCircuitBreaker();

/** Ripgrep output kept on the box per call before framing. */
const CODE_SEARCH_RIPGREP_MAX_BYTES = 32 * 1024 * 1024;

type CodeSearchChannel = Pick<
  SandboxChannelAService,
  "codeSearchRipgrep" | "codeSearchPathKinds" | "fsRead"
>;

/** Adapt the turn's sandbox or Connected Machine to the code search engine. */
export function codeSearchWorkspaceFromChannel(channel: CodeSearchChannel): CodeSearchWorkspace {
  return {
    ripgrep: async (args, options) => {
      options.signal?.throwIfAborted();
      const outcome = await channel.codeSearchRipgrep(args, {
        timeoutMs: options.timeoutMs,
        maxBytes: CODE_SEARCH_RIPGREP_MAX_BYTES,
      });
      if (!outcome.available) throw new CodeSearchRipgrepMissingError();
      return {
        stdout: outcome.stdout,
        exitCode: outcome.exitCode,
        truncated: outcome.truncated,
        timedOut: outcome.timedOut,
      };
    },
    readText: async (path, options) => {
      options.signal?.throwIfAborted();
      try {
        const read = await channel.fsRead({ path, encoding: "utf8", maxBytes: options.maxBytes });
        return { text: read.content, truncated: read.truncated, binary: read.isBinary };
      } catch (error) {
        if (error instanceof ChannelANotFoundError) return null;
        throw error;
      }
    },
    pathKinds: async (paths, options) => {
      options.signal?.throwIfAborted();
      return await channel.codeSearchPathKinds(paths);
    },
  };
}

/** Typed inference used by one code-search call, owned by the deployment. */
export type CodeSearchUsage = {
  operationId: string;
  decisionRequests: number;
  decisionInputTokens: number | null;
  decisionCostUsd: number | null;
  model: string | null;
  provider: string | null;
  costSources: Array<"provider-reported" | "estimate" | "unknown">;
};

function textResult(text: string, isError: boolean) {
  return { isError, content: [{ type: "text" as const, text }] };
}

/**
 * The model-facing `code_search` tool. A typed decision model scores candidates
 * inside the worker; the sandbox only runs read-only ripgrep and file reads, so
 * provider credentials never leave this process. A provider failure is reported instead of
 * degrading to keyword-only ranking, which lowered answer quality in testing.
 */
export function createCodeSearchAttemptToolDefinition(input: {
  settings: WorkerDecisionSettings;
  /** Compatibility for existing direct Jev constructor callers. */
  apiKey?: string;
  workspace: () => Promise<CodeSearchWorkspace>;
  observability: Observability;
  /** Records decision usage against the workspace. Persistence failures are logged. */
  recordUsage?: (usage: CodeSearchUsage) => Promise<void>;
  breaker?: JevCircuitBreaker;
  fetch?: typeof fetch;
}): AttemptToolDefinition {
  const breaker = input.breaker ?? codeSearchCircuitBreaker;
  const configured = configuredDecisionModel(
    {
      ...input.settings,
      ...(input.apiKey ? { jevApiKey: input.apiKey } : {}),
    },
    {
      allowLegacyCodeSearch: true,
      ...(input.fetch ? { fetch: input.fetch } : {}),
    },
  );
  if (!configured)
    throw new DecisionUnavailableError("Code search needs a configured decision model");
  return {
    identity: { serverId: "opengeni", toolName: CODE_SEARCH_TOOL_NAME },
    modelName: CODE_SEARCH_TOOL_NAME,
    codemodePath: ["opengeni", CODE_SEARCH_TOOL_NAME],
    title: "Search code",
    description: CODE_SEARCH_TOOL_DESCRIPTION,
    inputSchema: codeSearchInputSchema,
    annotations: {
      title: "Search code",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    source: "opengeni",
    approval: "none",
    execute: async (args, context) => {
      const startedAt = performance.now();
      let outcome: CodeSearchCallOutcome = "failed";
      let decisionRequests = 0;
      let decisionCostUsd: number | null = 0;
      let decisionInputTokens: number | null = 0;
      let decisionModel: string | null = null,
        decisionProvider: string | null = null;
      const costSources = new Set<"provider-reported" | "estimate" | "unknown">();
      // The breaker lease (the single trial while half-open) is settled exactly
      // once: by what the provider did, or released when no judgment ran. Settling
      // takes it, so the finally block releases only a lease still held.
      let lease: JevCircuitLease | null = null;
      try {
        const request = parseCodeSearchArguments(args);
        lease = breaker.tryAcquire(Date.now());
        if (!lease) {
          outcome = "breaker_open";
          return textResult(
            renderCodeSearchError(
              new DecisionUnavailableError(
                "The decision model is not responding; calls are paused for a few minutes",
              ),
            ),
            true,
          );
        }
        const workspace = await input.workspace();
        const result = await runCodeSearch({
          ...request,
          workspace,
          decisionModel: configured.model,
          onDecisionUsage: (usage) => {
            decisionRequests += usage.requests;
            decisionInputTokens =
              decisionInputTokens === null || usage.inputTokens === null
                ? null
                : decisionInputTokens + usage.inputTokens;
            decisionCostUsd =
              decisionCostUsd === null || usage.costUsd === null
                ? null
                : decisionCostUsd + usage.costUsd;
            decisionModel = usage.model;
            decisionProvider = usage.provider;
            costSources.add(usage.costSource);
          },
          ...(context.signal ? { signal: context.signal } : {}),
        });
        const held = lease;
        lease = null;
        // A pack whose final status check hit an outage still counts against the provider.
        if (result.statusCheckError instanceof DecisionUnavailableError) {
          breaker.recordFailure(result.statusCheckError, Date.now(), held);
        } else if (result.stats.decision.requests > 0) {
          breaker.recordSuccess(held);
        } else {
          breaker.release(held);
        }
        outcome = "completed";
        return textResult(result.text, false);
      } catch (error) {
        if (context.signal?.aborted) {
          outcome = "cancelled";
          throw error;
        }
        if (error instanceof CodeSearchArgumentError) {
          outcome = "invalid_arguments";
          return textResult(error.message, true);
        }
        if (error instanceof DecisionUnavailableError) {
          const held = lease;
          lease = null;
          breaker.recordFailure(error, Date.now(), held);
          outcome = "decision_unavailable";
          return textResult(renderCodeSearchError(error), true);
        }
        if (error instanceof DecisionRequestError) {
          outcome = "decision_rejected";
          return textResult(renderCodeSearchError(error), true);
        }
        if (error instanceof CodeSearchWorkspaceError) {
          outcome = "workspace_unavailable";
          return textResult(renderCodeSearchError(error), true);
        }
        if (
          error instanceof ChannelAUnavailableError ||
          error instanceof ChannelAUnsupportedError ||
          error instanceof ChannelAValidationError
        ) {
          outcome = "workspace_unavailable";
          return textResult(
            renderCodeSearchError(new CodeSearchWorkspaceError(error.message)),
            true,
          );
        }
        throw error;
      } finally {
        if (lease) breaker.release(lease);
        if (input.recordUsage && decisionRequests > 0) {
          await input
            .recordUsage({
              operationId: context.operationId,
              decisionRequests,
              decisionInputTokens,
              decisionCostUsd,
              model: decisionModel,
              provider: decisionProvider,
              costSources: [...costSources],
            })
            .catch((error: unknown) => {
              input.observability.warn("code_search usage record failed", {
                error: error instanceof Error ? error.message : String(error),
              });
            });
        }
        recordCodeSearchCall(input.observability, {
          outcome,
          durationSeconds: (performance.now() - startedAt) / 1_000,
          decisionRequests,
          decisionCostUsd,
        });
      }
    },
  };
}

/**
 * The `code_search` definition for one turn, or none. It is offered only when
 * the session's frozen decision and the deployment enable it, a usable typed model
 * exists, and the turn has compute that can run its POSIX shell commands (not
 * a Windows Connected Machine). Every input is durable, so the tool list stays
 * the same from turn to turn and on every worker. Transient provider health never
 * hides the tool; the breaker only refuses calls.
 */
export function codeSearchToolDefinitions(input: {
  enabled: boolean;
  settings: WorkerDecisionSettings;
  backend: Settings["sandboxBackend"];
  /** The turn's Connected Machine workspace root, when a machine is primary. */
  machineWorkspaceRoot?: string | null;
  observability: Observability;
  workspace: () => Promise<CodeSearchWorkspace>;
  recordUsage?: (usage: CodeSearchUsage) => Promise<void>;
  breaker?: JevCircuitBreaker;
}): AttemptToolDefinition[] {
  const config = decisionModelConfiguration(input.settings, true);
  const breaker = input.breaker ?? codeSearchCircuitBreaker;
  if (!input.enabled || !config || input.backend === "none") return [];
  if (input.machineWorkspaceRoot && isWindowsConnectedMachinePath(input.machineWorkspaceRoot)) {
    return [];
  }
  return [
    createCodeSearchAttemptToolDefinition({
      settings: input.settings,
      workspace: input.workspace,
      observability: input.observability,
      ...(input.recordUsage ? { recordUsage: input.recordUsage } : {}),
      breaker,
    }),
  ];
}
