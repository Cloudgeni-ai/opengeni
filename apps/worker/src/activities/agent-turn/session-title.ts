import { hasPermission } from "@opengeni/core";
import type { AttemptToolDefinition } from "@opengeni/codemode";
import {
  claudeNativeModelProfile,
  isManagedOpenRouterFreeRoute,
  type ModelCapabilitiesV1,
} from "@opengeni/config";
import type {
  GeneratedSessionTitle,
  GenerateSessionTitleOptions,
  OpenGeniRuntime,
} from "@opengeni/runtime";
import {
  AUTOMATIC_SESSION_TITLE_FALLBACK,
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  ReasoningEffort,
  type FirstPartyMcpToolName,
  type Permission,
  type ResolvedAgentConfig,
  type ToolRef,
} from "@opengeni/contracts";

export const SESSION_TITLE_MODEL_TOOL_NAME = "opengeni__set_session_title";

const SESSION_TITLE_DESCRIPTION =
  "Set this session's display title to a concise 3-7 word topic label. Use a stable noun phrase about the actual task or subject, never a quote/prefix of a prompt, greeting, request boilerplate, URL, identifier, credential, token, or other sensitive value. Call once on a new session, then only when the topic materially changes. Never call it as routine setup after a continuation, resume, or interruption, or merely to reassert the same title. A human-set title cannot be replaced.";

export function shouldRequestMissingSessionTitle(input: {
  title: string | null;
  titleSource: "user" | "agent" | null;
  agentConfig?: ResolvedAgentConfig | null;
  firstPartyMcpTools: readonly FirstPartyMcpToolName[];
  firstPartyMcpPermissions: readonly Permission[] | null;
}): boolean {
  const title = input.title?.trim() ?? "";
  const needsSemanticTitle =
    input.titleSource !== "user" && (!title || title === AUTOMATIC_SESSION_TITLE_FALLBACK);
  if (!needsSemanticTitle) return false;
  // Configured sessions title through the runtime, not an opted-in capability.
  // Legacy sessions keep their exact selected-tool and permission admission.
  if (!input.agentConfig && !input.firstPartyMcpTools.includes("set_session_title")) return false;
  const permissions = input.firstPartyMcpPermissions ?? DEFAULT_FIRST_PARTY_MCP_PERMISSIONS;
  return hasPermission([...permissions], "sessions:control");
}

/**
 * Whether the turn's route can afford a model request spent only on a title.
 * The managed OpenRouter free route draws on one deployment-wide per-minute
 * and per-day request quota that users' turns need, so an untitled session on
 * it gets no title sidecar and no title tool (whose call would cost a
 * follow-up request). Clients keep showing the prompt preview, and a later
 * turn on another route titles the session.
 */
export function routeAllowsSessionTitleRequests(
  resolvedModel: ReturnType<OpenGeniRuntime["resolveTurnModel"]>,
): boolean {
  return !resolvedModel || !isManagedOpenRouterFreeRoute(resolvedModel);
}

export function sessionTitleToolPlan(input: {
  tools: readonly ToolRef[];
  agentConfig?: ResolvedAgentConfig | null;
  selectedFirstPartyMcpTools: readonly FirstPartyMcpToolName[];
  shouldRequestTitle: boolean;
  parallelGenerationAvailable: boolean;
  routeAllowsTitleRequests: boolean;
}): {
  promoteTitleTool: boolean;
  generateTitleInParallel: boolean;
  remoteFirstPartyMcpTools: FirstPartyMcpToolName[];
  preparationIndependentToolNames: string[];
} {
  const titleToolAvailable =
    input.shouldRequestTitle &&
    (input.agentConfig != null ||
      input.tools.some((tool) => tool.kind === "mcp" && tool.id === "opengeni"));
  const titleRequestAllowed = titleToolAvailable && input.routeAllowsTitleRequests;
  const generateTitleInParallel = titleRequestAllowed && input.parallelGenerationAvailable;
  const promoteTitleTool = titleRequestAllowed && !generateTitleInParallel;
  return {
    promoteTitleTool,
    generateTitleInParallel,
    remoteFirstPartyMcpTools: titleToolAvailable
      ? input.selectedFirstPartyMcpTools.filter((tool) => tool !== "set_session_title")
      : [...input.selectedFirstPartyMcpTools],
    preparationIndependentToolNames: promoteTitleTool ? [SESSION_TITLE_MODEL_TOOL_NAME] : [],
  };
}

export const PARALLEL_SESSION_TITLE_TIMEOUT_MS = 15_000;

/** Codex subscription turns title on this fast model of the same account. */
export const CODEX_SESSION_TITLE_MODEL_ID = "codex/gpt-6-luna";
/** Claude subscription turns title on this fast model of the same account. */
export const CLAUDE_SESSION_TITLE_UPSTREAM_MODEL_ID = "claude-haiku-5-5";

type ResolvedTitleModel = NonNullable<ReturnType<OpenGeniRuntime["resolveTurnModel"]>>;

export type SessionTitleRoute = {
  resolvedModel: ReturnType<OpenGeniRuntime["resolveTurnModel"]>;
  /** Upstream model name sent to the provider. */
  modelName: string;
  /** Product model id the title usage is recorded under, when it differs from the turn's. */
  usageModelId: string | null;
};

/**
 * The model for the auxiliary title request. A subscription turn titles on a
 * fast model of the same subscription account and request context, so the
 * title costs the subscription little and never another rail: Codex turns use
 * Luna and Claude subscription turns use Haiku. Other turns, and a
 * subscription whose catalog lacks the title model, title on the turn's model.
 */
export function sessionTitleRoute(input: {
  resolvedModel: ReturnType<OpenGeniRuntime["resolveTurnModel"]>;
  modelName: string;
  resolveTurnModel: (modelId: string) => ReturnType<OpenGeniRuntime["resolveTurnModel"]>;
}): SessionTitleRoute {
  const turnRoute = {
    resolvedModel: input.resolvedModel,
    modelName: input.modelName,
    usageModelId: null,
  };
  const turn = input.resolvedModel;
  if (!turn) return turnRoute;
  const sameAccount = (title: ResolvedTitleModel): SessionTitleRoute => ({
    // The turn's client and provider carry its account and credential binding.
    resolvedModel: { ...title, client: turn.client, provider: turn.provider },
    modelName: title.configured.upstreamModelId,
    usageModelId: title.configured.id,
  });
  if (turn.provider.kind === "codex-subscription") {
    if (turn.configured.id === CODEX_SESSION_TITLE_MODEL_ID) return turnRoute;
    const title = input.resolveTurnModel(CODEX_SESSION_TITLE_MODEL_ID);
    return title && title.provider.id === turn.provider.id ? sameAccount(title) : turnRoute;
  }
  if (turn.provider.kind?.startsWith("claude-subscription-")) {
    if (turn.configured.upstreamModelId === CLAUDE_SESSION_TITLE_UPSTREAM_MODEL_ID)
      return turnRoute;
    const titleModelId = `${turn.provider.id}/${CLAUDE_SESSION_TITLE_UPSTREAM_MODEL_ID}`;
    const listed = input.resolveTurnModel(titleModelId);
    if (listed && listed.provider.id === turn.provider.id) return sameAccount(listed);
    // Every Claude subscription can serve Haiku even when the connection's
    // picker list omits it; the native profile supplies its reasoning range.
    const profile = claudeNativeModelProfile(CLAUDE_SESSION_TITLE_UPSTREAM_MODEL_ID);
    if (!profile) return turnRoute;
    return sameAccount({
      ...turn,
      configured: {
        ...turn.configured,
        id: titleModelId,
        upstreamModelId: CLAUDE_SESSION_TITLE_UPSTREAM_MODEL_ID,
        capabilities: {
          ...turn.configured.capabilities,
          reasoning: {
            ...turn.configured.capabilities.reasoning,
            runnable: profile.efforts.length > 0,
            efforts: [...profile.efforts],
            defaultEffort: profile.defaultEffort,
          },
        },
      },
    });
  }
  return turnRoute;
}

/**
 * The lowest reasoning effort the resolved model can run, for the auxiliary
 * title request only. A title needs no deliberation, and a provider default
 * effort can use most of the output budget before any visible text. Returns
 * undefined when the model declares no runnable reasoning control, so the
 * request carries no reasoning parameter.
 */
export function sessionTitleReasoningEffort(
  capabilities: Pick<ModelCapabilitiesV1, "reasoning"> | undefined,
): ReasoningEffort | undefined {
  const reasoning = capabilities?.reasoning;
  if (!reasoning?.runnable) return undefined;
  const order = ReasoningEffort.options;
  let lowest: ReasoningEffort | undefined;
  for (const effort of reasoning.efforts) {
    if (!lowest || order.indexOf(effort) < order.indexOf(lowest)) lowest = effort;
  }
  return lowest;
}

/**
 * Options for the parallel title request. It uses the turn's resolved
 * provider and credential authority, but its own lowest runnable reasoning
 * effort rather than the turn's effort.
 */
export function sessionTitleGenerationOptions(input: {
  resolvedModel: ReturnType<OpenGeniRuntime["resolveTurnModel"]>;
  modelName: string;
  serviceTier: GenerateSessionTitleOptions["serviceTier"] | null | undefined;
  signal: AbortSignal;
}): GenerateSessionTitleOptions {
  const { resolvedModel, serviceTier } = input;
  const reasoningEffort = sessionTitleReasoningEffort(resolvedModel?.configured.capabilities);
  return {
    ...(resolvedModel
      ? {
          client: resolvedModel.client,
          provider: resolvedModel.provider,
          model: resolvedModel.model,
        }
      : {}),
    modelName: input.modelName,
    ...(serviceTier ? { serviceTier } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    signal: input.signal,
  };
}

export type ParallelSessionTitleGeneration = {
  finish: () => Promise<GeneratedSessionTitle | null>;
  cancel: () => Promise<void>;
};

/**
 * Start title inference immediately and keep it independent of the main agent
 * stream. finish() waits for the already-running bounded request, so a quick
 * main response does not discard a valid title merely because it completed
 * first. cancel() aborts and joins exceptional/cancelled exits so no provider
 * work escapes the owning runAgentTurn activity.
 */
export function startParallelSessionTitleGeneration(input: {
  generate: (signal: AbortSignal) => Promise<GeneratedSessionTitle>;
  signal?: AbortSignal;
  timeoutMs?: number;
  onError?: (error: unknown) => void;
}): ParallelSessionTitleGeneration {
  const cancellationController = new AbortController();
  const timeoutSignal = AbortSignal.timeout(input.timeoutMs ?? PARALLEL_SESSION_TITLE_TIMEOUT_MS);
  const signals = [cancellationController.signal, timeoutSignal];
  if (input.signal) signals.push(input.signal);
  const signal = AbortSignal.any(signals);
  const generation = input
    .generate(signal)
    .then((result) => (signal.aborted ? null : result))
    .catch((error: unknown) => {
      if (!signal.aborted) input.onError?.(error);
      return null;
    });
  let finished: Promise<GeneratedSessionTitle | null> | null = null;

  return {
    finish: () => {
      if (finished) return finished;
      finished = generation;
      return finished;
    },
    cancel: async () => {
      cancellationController.abort();
      await generation;
    },
  };
}

export function createSessionTitleAttemptToolDefinition(input: {
  updateTitle: (title: string) => Promise<{ updated: boolean; title: string | null }>;
}): AttemptToolDefinition {
  return {
    identity: { serverId: "opengeni", toolName: "set_session_title" },
    modelName: SESSION_TITLE_MODEL_TOOL_NAME,
    codemodePath: ["opengeni", "set_session_title"],
    title: "Set session title",
    description: SESSION_TITLE_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 200 },
      },
      required: ["title"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean", const: true },
        updated: { type: "boolean" },
        title: { type: "string" },
      },
      required: ["ok", "updated", "title"],
      additionalProperties: false,
    },
    annotations: {
      title: "Set session title",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    source: "opengeni",
    approval: "none",
    execute: async (args) => {
      const title = args.title;
      if (typeof title !== "string") {
        throw new Error("set_session_title requires a title string");
      }
      const result = await input.updateTitle(title);
      const output = {
        ok: true as const,
        updated: result.updated,
        title: result.title ?? title,
      };
      return {
        isError: false,
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  };
}
