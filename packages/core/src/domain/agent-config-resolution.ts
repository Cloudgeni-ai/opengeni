import {
  agentConfigDeploymentPolicy,
  allowedFirstPartyMcpToolsForSession,
  type Settings,
} from "@opengeni/config";
import {
  AgentConfigError,
  agentConfigFirstPartyMcpTools,
  agentConfigToolRefs,
  legacyEffectiveAgentCapabilities,
  resolveAgentConfig,
  resolveWorkspaceAgentDefaults,
  resolveWorkspaceAgentHumanInputEnabled,
  type AgentConfigCreator,
  type AgentConfigParent,
  type AgentConfigRequest,
  type FirstPartyMcpToolName,
  type ResolvedAgentCapabilities,
  type ResolvedAgentConfig,
  type Session,
  type SessionToolPolicy,
  type ToolRef,
} from "@opengeni/contracts";
import { HTTPException } from "hono/http-exception";

/**
 * Run an agent-config resolution step and surface its typed failure as a 422
 * whose `cause` keeps the `AgentConfigError` (the API renders its code as
 * `details.code`; MCP and Slack keep the plain message).
 */
export function withAgentConfigHttpErrors<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof AgentConfigError) {
      throw new HTTPException(422, { message: error.message, cause: error });
    }
    throw error;
  }
}

/** The current effective capabilities of a null-config session (the conversion/child ceiling). */
export function legacySessionAgentCapabilities(
  settings: Settings,
  session: Pick<Session, "firstPartyMcpTools" | "tools" | "toolPolicy">,
  workspaceSettings: unknown,
  /** The workspace's current omitted-tools default server ids, when known. */
  defaultServerIds?: Iterable<string>,
): ResolvedAgentCapabilities {
  return legacyEffectiveAgentCapabilities({
    firstPartyMcpTools: allowedFirstPartyMcpToolsForSession(settings, session.firstPartyMcpTools),
    tools: session.tools,
    toolPolicy: session.toolPolicy,
    humanInputEnabled: resolveWorkspaceAgentHumanInputEnabled(workspaceSettings),
    ...(defaultServerIds ? { defaultServerIds } : {}),
  });
}

/** A parent session as a resolution input: its frozen config, or its legacy ceiling. */
export function agentConfigParentFor(
  settings: Settings,
  parent: Session,
  workspaceSettings: unknown,
): AgentConfigParent {
  return parent.agent
    ? { kind: "configured", config: parent.agent }
    : {
        kind: "legacy",
        ceiling: legacySessionAgentCapabilities(settings, parent, workspaceSettings),
      };
}

/**
 * Resolve the frozen agent configuration for a new session. Every creator
 * calls this: `createSessionForRequest` (public API, MCP `session_create`,
 * Slack, drafts), automations, and the scheduled worker. Returns `config:
 * null` for exact legacy behavior.
 */
export function resolveSessionAgentConfigForCreate(input: {
  settings: Settings;
  creator: AgentConfigCreator;
  request: AgentConfigRequest | undefined;
  instructions: string | undefined;
  workspaceSettings: unknown;
  parent: Session | null;
  goal: boolean;
}): { config: ResolvedAgentConfig | null; instructions: string | undefined } {
  return withAgentConfigHttpErrors(() =>
    resolveAgentConfig({
      creator: input.creator,
      request: input.request,
      instructions: input.instructions,
      workspace: {
        defaults: resolveWorkspaceAgentDefaults(input.workspaceSettings),
        humanInputEnabled: resolveWorkspaceAgentHumanInputEnabled(input.workspaceSettings),
      },
      deployment: agentConfigDeploymentPolicy(input.settings),
      ...(input.parent
        ? {
            parent: agentConfigParentFor(input.settings, input.parent, input.workspaceSettings),
          }
        : {}),
      goal: input.goal,
    }),
  );
}

/**
 * Write a resolved configuration through to the legacy columns the runtime
 * reads today. `null` returns the inputs unchanged; `"all"` also does.
 */
export function applySessionAgentConfigWriteThrough(input: {
  config: ResolvedAgentConfig | null;
  firstPartyMcpTools: FirstPartyMcpToolName[];
  explicitFirstPartyMcpTools?: readonly FirstPartyMcpToolName[] | undefined;
  tools: ToolRef[];
  toolPolicy: SessionToolPolicy;
  productServerIds: Iterable<string>;
  explicitServerIds?: Iterable<string> | undefined;
}): {
  firstPartyMcpTools: FirstPartyMcpToolName[];
  tools: ToolRef[];
  toolPolicy: SessionToolPolicy;
} {
  const { config } = input;
  if (!config) {
    return {
      firstPartyMcpTools: input.firstPartyMcpTools,
      tools: input.tools,
      toolPolicy: input.toolPolicy,
    };
  }
  return withAgentConfigHttpErrors(() => {
    const firstPartyMcpTools = agentConfigFirstPartyMcpTools(
      config,
      input.firstPartyMcpTools,
      input.explicitFirstPartyMcpTools,
    );
    const refs = agentConfigToolRefs({
      config,
      tools: input.tools,
      toolPolicy: input.toolPolicy,
      productServerIds: new Set(input.productServerIds),
      ...(input.explicitServerIds ? { explicitServerIds: new Set(input.explicitServerIds) } : {}),
    });
    return { firstPartyMcpTools, tools: refs.tools, toolPolicy: refs.toolPolicy };
  });
}

/**
 * Stored `agent` inputs (scheduled tasks, automation templates, workspace
 * defaults) are admitted only with the admission switch on: pre-0542 workers
 * would ignore them.
 */
export function requireAgentConfigAdmission(
  settings: Pick<Settings, "agentConfigAdmissionEnabled">,
  agent: unknown,
): void {
  if (agent !== undefined && settings.agentConfigAdmissionEnabled !== true) {
    throw new HTTPException(422, {
      message: "agent configuration is not enabled on this deployment",
      cause: new AgentConfigError(
        "agent_config_not_enabled",
        "agent configuration is not enabled on this deployment",
      ),
    });
  }
}

/** The `agent` object of a scheduled-task create/update payload, if any. */
export function scheduledTaskAgentInput(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return undefined;
  const agentConfig = (payload as { agentConfig?: unknown }).agentConfig;
  if (!agentConfig || typeof agentConfig !== "object") return undefined;
  return (agentConfig as { agent?: unknown }).agent;
}

/**
 * Whether a create could resolve a non-null configuration at all. False means
 * exact legacy without reading the workspace (admission off, default switch
 * off, no request `agent`, no configured parent), so legacy creators keep
 * their historical reads.
 */
export function agentConfigMayResolve(
  settings: Pick<Settings, "agentConfigAdmissionEnabled" | "agentConfigDefaultForNewSessions">,
  request: unknown,
): boolean {
  return (
    request !== undefined ||
    settings.agentConfigAdmissionEnabled === true ||
    settings.agentConfigDefaultForNewSessions === true
  );
}
