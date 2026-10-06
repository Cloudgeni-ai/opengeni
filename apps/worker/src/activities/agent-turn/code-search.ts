import type { AttemptToolDefinition } from "@opengeni/codemode";
import { codeSearchDeploymentJudge, type Settings } from "@opengeni/config";
import type { CodeSearchJudgeRoute } from "@opengeni/contracts/code-search";
import {
  CODE_SEARCH_TOOL_DESCRIPTION,
  CODE_SEARCH_TOOL_NAME,
  CodeSearchArgumentError,
  CodeSearchRipgrepMissingError,
  CodeSearchWorkspaceError,
  JevCircuitBreaker,
  JevClient,
  JevRequestError,
  JevUnavailableError,
  codeSearchInputSchema,
  parseCodeSearchArguments,
  renderCodeSearchError,
  runCodeSearch,
  type CodeSearchJudgeClient,
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

/**
 * One breaker per deployment judge provider per worker process. Repeated
 * outages of the deployment's judge (including an exhausted account) make
 * `code_search` calls on this worker fail at once for a cooldown instead of
 * each running a full retry cycle. A customer's own connection never shares
 * these: its bad key must not pause searches for everyone else. No breaker
 * changes which tools a turn is offered: the tool list and instructions are
 * the start of the model's cached prompt, and sessions move between workers
 * whose breakers disagree.
 */
const deploymentJudgeBreakers = {
  typesafe: new JevCircuitBreaker(),
  openrouter: new JevCircuitBreaker(),
  vercel_gateway: new JevCircuitBreaker(),
} as const;

/** The TypeSafe deployment breaker (the default judge). */
export const codeSearchCircuitBreaker = deploymentJudgeBreakers.typesafe;

export function deploymentCodeSearchCircuitBreaker(
  provider: CodeSearchJudgeRoute["provider"],
): JevCircuitBreaker {
  return deploymentJudgeBreakers[provider];
}

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

/** Judge work done by one completed `code_search` call, for per-workspace usage records. */
export type CodeSearchUsage = {
  operationId: string;
  /** Who paid the judge and with which key. */
  route: CodeSearchJudgeRoute;
  jevRequests: number;
  jevInputTokens: number;
  /** Provider-reported cost when every request reported one, else Jev's list price. */
  jevCostUsd: number;
  costSource: "provider_reported" | "list_price";
};

/**
 * The judge for one turn's route. The client is built at call time: a
 * customer's key is read only when a search runs, and null means it can no
 * longer be read (the connection was revoked or its key cannot be decrypted).
 */
export type CodeSearchJudgeBinding = {
  route: CodeSearchJudgeRoute;
  /** Synchronous for the deployment's judge; a customer's key is read on first use. */
  client: () => CodeSearchJudgeClient | null | Promise<CodeSearchJudgeClient | null>;
};

type JudgeSettings = Pick<Settings, "jevRequestTimeoutMs"> &
  Parameters<typeof codeSearchDeploymentJudge>[0];

/**
 * The judge a route uses: the deployment's own judge for `credits` and
 * `deployment` routes (null when its key is missing), or Jev on the customer's
 * OpenRouter or Gateway connection with its own key and that provider's Jev
 * model for `external` routes.
 */
export function codeSearchJudgeBinding(input: {
  route: CodeSearchJudgeRoute;
  settings: JudgeSettings;
  /** Reads the customer's key for an `external` route; null when unavailable. */
  loadCustomerKey?: (route: CodeSearchJudgeRoute) => Promise<string | null>;
  fetch?: typeof fetch;
}): CodeSearchJudgeBinding | null {
  const { route, settings } = input;
  const transport = {
    timeoutMs: settings.jevRequestTimeoutMs,
    ...(input.fetch ? { fetch: input.fetch } : {}),
  };
  if (route.keySource === "deployment") {
    const deployment = codeSearchDeploymentJudge(settings);
    if (!deployment || deployment.provider !== route.provider) return null;
    const client = new JevClient({ ...deployment, ...transport });
    return { route, client: () => client };
  }
  const loadCustomerKey = input.loadCustomerKey;
  if (!loadCustomerKey) return null;
  // Only a key that was read is kept; a missing one is retried on the next call.
  let cached: CodeSearchJudgeClient | null = null;
  return {
    route,
    client: async () => {
      if (cached) return cached;
      const apiKey = await loadCustomerKey(route);
      if (!apiKey) return null;
      cached = new JevClient({ provider: route.provider, apiKey, ...transport });
      return cached;
    },
  };
}

function textResult(text: string, isError: boolean) {
  return { isError, content: [{ type: "text" as const, text }] };
}

/**
 * The model-facing `code_search` tool. The judge scores candidates inside the
 * worker; the sandbox only runs read-only ripgrep and file reads, so no judge
 * key ever leaves this process. A judge failure is reported to the model
 * instead of degrading to keyword-only ranking, which lowered answer quality
 * in testing.
 */
export function createCodeSearchAttemptToolDefinition(input: {
  judge: CodeSearchJudgeBinding;
  workspace: () => Promise<CodeSearchWorkspace>;
  observability: Observability;
  /** Records judge usage against the workspace. Failures are logged, never surfaced. */
  recordUsage?: (usage: CodeSearchUsage) => Promise<void>;
  /** Defaults to the deployment provider's breaker, or a breaker of this tool's own for a customer key. */
  breaker?: JevCircuitBreaker;
}): AttemptToolDefinition {
  const { route } = input.judge;
  const breaker =
    input.breaker ??
    (route.keySource === "deployment"
      ? deploymentCodeSearchCircuitBreaker(route.provider)
      : new JevCircuitBreaker());
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
      let jevRequests = 0;
      let jevCostUsd = 0;
      // The breaker lease (the single trial while half-open) is settled exactly
      // once: by what Jev did, or released when Jev was never judged. Settling
      // takes it, so the finally block releases only a lease still held.
      let lease: JevCircuitLease | null = null;
      try {
        const request = parseCodeSearchArguments(args);
        lease = breaker.tryAcquire(Date.now());
        if (!lease) {
          outcome = "breaker_open";
          return textResult(
            renderCodeSearchError(
              new JevUnavailableError("Jev is not responding; calls are paused for a few minutes"),
            ),
            true,
          );
        }
        // A missing customer key never reached the judge, so the finally block
        // releases the lease without judging the provider.
        const pending = input.judge.client();
        const jev =
          pending instanceof Promise
            ? await pending.catch((error: unknown) => {
                input.observability.warn("code_search judge key could not be read", {
                  error: error instanceof Error ? error.message : String(error),
                });
                return null;
              })
            : pending;
        if (!jev) {
          outcome = "judge_key_unavailable";
          return textResult(
            renderCodeSearchError(
              new JevUnavailableError(
                "the workspace's OpenRouter or Vercel AI Gateway connection is no longer usable",
              ),
            ),
            true,
          );
        }
        const workspace = await input.workspace();
        const result = await runCodeSearch({
          ...request,
          workspace,
          jev,
          ...(context.signal ? { signal: context.signal } : {}),
        });
        const held = lease;
        lease = null;
        // A pack whose final status check hit an outage still counts against Jev.
        if (result.statusCheckError instanceof JevUnavailableError) {
          breaker.recordFailure(result.statusCheckError, Date.now(), held);
        } else if (result.stats.jev.requests > 0) {
          breaker.recordSuccess(held);
        } else {
          breaker.release(held);
        }
        outcome = "completed";
        jevRequests = result.stats.jev.requests;
        jevCostUsd = result.stats.jev.costUsd;
        if (input.recordUsage && jevRequests > 0) {
          await input
            .recordUsage({
              operationId: context.operationId,
              route,
              jevRequests,
              jevInputTokens: result.stats.jev.inputTokens,
              jevCostUsd,
              costSource: result.stats.jev.costSource,
            })
            .catch((error: unknown) => {
              input.observability.warn("code_search usage record failed", {
                error: error instanceof Error ? error.message : String(error),
              });
            });
        }
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
        if (error instanceof JevUnavailableError) {
          const held = lease;
          lease = null;
          breaker.recordFailure(error, Date.now(), held);
          outcome = "jev_unavailable";
          return textResult(renderCodeSearchError(error), true);
        }
        if (error instanceof JevRequestError) {
          outcome = "jev_rejected";
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
        recordCodeSearchCall(input.observability, {
          outcome,
          durationSeconds: (performance.now() - startedAt) / 1_000,
          jevRequests,
          jevCostUsd,
          funding: route.funding,
          provider: route.provider,
        });
      }
    },
  };
}

/**
 * The `code_search` definition for one turn, or none. It is offered only when
 * the turn has a judge route (the session's frozen decision, the deployment
 * and the workspace enable it, and someone may pay for the judge), the route's
 * judge is configured, and the turn has compute that can run its POSIX shell
 * commands (not a Windows Connected Machine). Every input is durable, so the
 * tool list stays the same from turn to turn and on every worker. Transient
 * judge health never hides the tool; the breaker only refuses calls.
 */
export function codeSearchToolDefinitions(input: {
  route: CodeSearchJudgeRoute | null;
  settings: JudgeSettings;
  backend: Settings["sandboxBackend"];
  /** The turn's Connected Machine workspace root, when a machine is primary. */
  machineWorkspaceRoot?: string | null;
  observability: Observability;
  workspace: () => Promise<CodeSearchWorkspace>;
  recordUsage?: (usage: CodeSearchUsage) => Promise<void>;
  /** Reads the customer's key for an `external` route; null when unavailable. */
  loadCustomerKey?: (route: CodeSearchJudgeRoute) => Promise<string | null>;
  breaker?: JevCircuitBreaker;
  fetch?: typeof fetch;
}): AttemptToolDefinition[] {
  if (!input.route || input.backend === "none") return [];
  if (input.machineWorkspaceRoot && isWindowsConnectedMachinePath(input.machineWorkspaceRoot)) {
    return [];
  }
  const judge = codeSearchJudgeBinding({
    route: input.route,
    settings: input.settings,
    ...(input.loadCustomerKey ? { loadCustomerKey: input.loadCustomerKey } : {}),
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
  if (!judge) return [];
  return [
    createCodeSearchAttemptToolDefinition({
      judge,
      workspace: input.workspace,
      observability: input.observability,
      ...(input.recordUsage ? { recordUsage: input.recordUsage } : {}),
      ...(input.breaker ? { breaker: input.breaker } : {}),
    }),
  ];
}
