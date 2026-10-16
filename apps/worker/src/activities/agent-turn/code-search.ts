import { AsyncLocalStorage } from "node:async_hooks";
import type { AttemptToolDefinition, AttemptToolScope } from "@opengeni/codemode";
import { usableJevApiKey, type Settings } from "@opengeni/config";
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
  type JevFetch,
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
 * One breaker per worker process. Repeated Jev outages (including an exhausted
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

/** Jev work done by one completed `code_search` call, for per-workspace usage records. */
export type CodeSearchUsage = {
  operationId: string;
  jevRequests: number;
  jevInputTokens: number;
  jevCostUsd: number;
};

/** Trusted host correlation only; never part of the model-facing tool or Jev payload. */
export type CodeSearchTransportInvocation = Readonly<AttemptToolScope & { operationId: string }>;

/**
 * Optional in-process transport seam. The wrapper sees every physical fetch, including retries and
 * health GETs. It owns any observation/admission policy; this seam adds no ledger or request cap.
 * Returning the original Response preserves streaming/body errors and cancellation. A resolved
 * fetch is only a headers observation, not proof of a completed or unbilled provider request.
 */
export type CodeSearchFetchWrapper = (
  invocation: CodeSearchTransportInvocation,
  next: JevFetch,
) => JevFetch;

export type CodeSearchTransport = {
  scope: AttemptToolScope;
  wrapFetch: CodeSearchFetchWrapper;
};

function textResult(text: string, isError: boolean) {
  return { isError, content: [{ type: "text" as const, text }] };
}

/**
 * The model-facing `code_search` tool. Jev scores candidates inside the worker;
 * the sandbox only runs read-only ripgrep and file reads, so the Jev key never
 * leaves this process. A Jev failure is reported to the model instead of
 * degrading to keyword-only ranking, which lowered answer quality in testing.
 */
export function createCodeSearchAttemptToolDefinition(input: {
  settings: Pick<Settings, "jevApiKey" | "jevBaseUrl" | "jevModel" | "jevRequestTimeoutMs">;
  apiKey: string;
  workspace: () => Promise<CodeSearchWorkspace>;
  observability: Observability;
  /** Records Jev usage against the workspace. Failures are logged, never surfaced. */
  recordUsage?: (usage: CodeSearchUsage) => Promise<void>;
  breaker?: JevCircuitBreaker;
  fetch?: typeof fetch;
  transport?: CodeSearchTransport;
}): AttemptToolDefinition {
  const breaker = input.breaker ?? codeSearchCircuitBreaker;
  const transport = input.transport;
  const scope = transport ? Object.freeze({ ...transport.scope }) : undefined;
  const invocationFetch = transport ? new AsyncLocalStorage<JevFetch>() : undefined;
  const nextFetch: JevFetch = input.fetch ?? ((url, init) => fetch(url, init));
  const jev = new JevClient({
    apiKey: input.apiKey,
    baseUrl: input.settings.jevBaseUrl,
    model: input.settings.jevModel,
    timeoutMs: input.settings.jevRequestTimeoutMs,
    ...(invocationFetch
      ? {
          fetch: (url: string, init: RequestInit) => {
            const current = invocationFetch.getStore();
            if (!current) throw new Error("code_search transport is outside its invocation");
            return current(url, init);
          },
        }
      : input.fetch
        ? { fetch: input.fetch }
        : {}),
  });
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
        const workspace = await input.workspace();
        const search = () =>
          runCodeSearch({
            ...request,
            workspace,
            jev,
            ...(context.signal ? { signal: context.signal } : {}),
          });
        const result = await (transport && scope && invocationFetch
          ? invocationFetch.run(
              transport.wrapFetch(
                Object.freeze({ ...scope, operationId: context.operationId }),
                nextFetch,
              ),
              search,
            )
          : search());
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
              jevRequests,
              jevInputTokens: result.stats.jev.inputTokens,
              jevCostUsd,
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
        });
      }
    },
  };
}

/**
 * The `code_search` definition for one turn, or none. It is offered only when
 * the session's frozen decision and the deployment enable it, a usable Jev key
 * exists, and the turn has compute that can run its POSIX shell commands (not
 * a Windows Connected Machine). Every input is durable, so the tool list stays
 * the same from turn to turn and on every worker. Transient Jev health never
 * hides the tool; the breaker only refuses calls.
 */
export function codeSearchToolDefinitions(input: {
  enabled: boolean;
  settings: Pick<Settings, "jevApiKey" | "jevBaseUrl" | "jevModel" | "jevRequestTimeoutMs">;
  backend: Settings["sandboxBackend"];
  /** The turn's Connected Machine workspace root, when a machine is primary. */
  machineWorkspaceRoot?: string | null;
  observability: Observability;
  workspace: () => Promise<CodeSearchWorkspace>;
  recordUsage?: (usage: CodeSearchUsage) => Promise<void>;
  breaker?: JevCircuitBreaker;
  fetch?: typeof fetch;
  transport?: CodeSearchTransport;
}): AttemptToolDefinition[] {
  const apiKey = usableJevApiKey(input.settings);
  const breaker = input.breaker ?? codeSearchCircuitBreaker;
  if (!input.enabled || !apiKey || input.backend === "none") return [];
  if (input.machineWorkspaceRoot && isWindowsConnectedMachinePath(input.machineWorkspaceRoot)) {
    return [];
  }
  return [
    createCodeSearchAttemptToolDefinition({
      settings: input.settings,
      apiKey,
      workspace: input.workspace,
      observability: input.observability,
      ...(input.recordUsage ? { recordUsage: input.recordUsage } : {}),
      breaker,
      ...(input.fetch ? { fetch: input.fetch } : {}),
      ...(input.transport ? { transport: input.transport } : {}),
    }),
  ];
}
