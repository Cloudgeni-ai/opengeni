import {
  allowedFirstPartyMcpToolsForSession,
  codeSearchDeploymentPolicy,
  resolveModelProviderForTurn,
  resolveFirstPartyDelegationSecret,
  type Settings,
} from "@opengeni/config";
import {
  AGENT_SKILL_MANAGE_TOOL_NAMES,
  AUTOMATIC_SESSION_TITLE_FALLBACK,
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  FIRST_PARTY_IN_PROCESS_TOOL_NAMES,
  type FirstPartyMcpToolName,
  SESSION_EFFECTIVE_TOOL_POLICY_ID_LIMIT,
  SESSION_EFFECTIVE_TOOL_POLICY_ID_MAX_LENGTH,
  mergeToolRefs,
  projectAgentEffectiveTools,
  resolveAgentToolFamilies,
  resolveAgentMediaToolSurface,
  resolveWorkspaceAgentHumanInputEnabled,
  resolveWorkspaceSessionToolDefaults,
  type AgentFunctionToolName,
  type AgentToolEnvironment,
  type AgentMediaAttachment,
  type Session,
  type SessionTurn,
  type SessionEffectiveToolPolicy,
  type SessionToolPolicy,
  type ToolRef,
} from "@opengeni/contracts";
import { codeSearchEnabledForTurn } from "@opengeni/contracts/code-search";
import {
  getSandbox,
  listSkillDescriptors,
  requireWorkspace,
  sessionHasToolRouterHistory,
  type Database,
} from "@opengeni/db";
import { resolveWorkspaceCatalogSettings } from "../model-catalog";
import { settingsWithEnabledCapabilityMcpServers } from "./capabilities";

const MANDATORY_SESSION_MCP_SERVER_IDS = ["opengeni"] as const;
const PROJECTABLE_REGISTRY_ID = /^[A-Za-z0-9_-]+$/;

export type ResolvedSessionToolPolicy = {
  toolRefs: ToolRef[];
  effectivePolicy: SessionEffectiveToolPolicy;
};

export type SessionToolPolicyInput = {
  toolPolicy: SessionToolPolicy;
  sessionTools: ToolRef[];
  availableMcpServerIds: Iterable<string>;
  /** Current omitted-tools defaults, intentionally narrower than all servers. */
  defaultMcpServerIds?: Iterable<string>;
};

function sortedIds(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort();
}

/** Every configured runtime MCP defaults on; mandatory carrier IDs are separate. */
export function defaultSessionMcpServerIds(servers: Iterable<{ id: string }>): string[] {
  const mandatory = new Set<string>(MANDATORY_SESSION_MCP_SERVER_IDS);
  return sortedIds([...servers].map((server) => server.id).filter((id) => !mandatory.has(id)));
}

function projectIds(ids: readonly string[]): { ids: string[]; truncated: boolean } {
  const projectable = ids.filter(
    (id) =>
      id.length <= SESSION_EFFECTIVE_TOOL_POLICY_ID_MAX_LENGTH && PROJECTABLE_REGISTRY_ID.test(id),
  );
  return {
    ids: projectable.slice(0, SESSION_EFFECTIVE_TOOL_POLICY_ID_LIMIT),
    truncated:
      projectable.length !== ids.length ||
      projectable.length > SESSION_EFFECTIVE_TOOL_POLICY_ID_LIMIT,
  };
}

/**
 * Resolve the same ID-only policy used by API projections and worker turns.
 * This function never receives endpoint URLs, credentials, schemas, or live
 * probe results. `availableMcpServerIds` is the resolved runtime registry;
 * `defaultMcpServerIds` is the current configured omitted-tools default.
 */
export function resolveSessionToolPolicy(input: SessionToolPolicyInput): ResolvedSessionToolPolicy {
  const policy = input.toolPolicy;
  const availableIds = new Set(input.availableMcpServerIds);
  const defaultIds = new Set(input.defaultMcpServerIds ?? []);
  const mandatoryIds: string[] = MANDATORY_SESSION_MCP_SERVER_IDS.filter((id) =>
    availableIds.has(id),
  );
  const mandatoryIdSet = new Set<string>(mandatoryIds);
  const tracksWorkspaceDefaults = policy.mode === "workspace_default";
  const excludedIds = new Set(tracksWorkspaceDefaults ? policy.excludedMcpServerIds : []);
  const selectedRefs = mergeToolRefs([], input.sessionTools).filter(
    (tool) => !excludedIds.has(tool.id) || mandatoryIdSet.has(tool.id),
  );

  // Persisted refs may outlive a capability installation, deployment config,
  // or its credentials. Admission remains strict for newly requested refs, but
  // turn-time materialization must not hand any no-longer-registered id to the
  // runtime router: doing so fails before the model can respond and traps the
  // session in an "Unknown MCP server id" loop. Keep the stale selection in the
  // effective-policy projection below, while executable refs contain only the
  // registry that is available for this exact turn.
  let toolRefs = selectedRefs.filter((tool) => availableIds.has(tool.id));
  if (tracksWorkspaceDefaults) {
    toolRefs = mergeToolRefs(
      toolRefs,
      sortedIds(defaultIds)
        .filter((id) => availableIds.has(id) && !excludedIds.has(id))
        .map((id) => ({ kind: "mcp" as const, id, optional: true as const })),
    );
  }
  toolRefs = mergeToolRefs(
    toolRefs,
    mandatoryIds.map((id) => ({ kind: "mcp" as const, id })),
  );

  // `effectiveIds` is the requested policy truth, including unavailable
  // optional refs retained in the persisted selection. `toolRefs` above is
  // the runtime-safe materialization, so projections can distinguish dropped
  // history from what is actually handed to the MCP router.
  const requestedEffectiveRefs = mergeToolRefs(
    selectedRefs,
    tracksWorkspaceDefaults
      ? sortedIds(defaultIds)
          .filter((id) => availableIds.has(id) && !excludedIds.has(id))
          .map((id) => ({ kind: "mcp" as const, id, optional: true as const }))
      : [],
  );
  const effectiveIds = sortedIds(
    mergeToolRefs(
      requestedEffectiveRefs,
      mandatoryIds.map((id) => ({ kind: "mcp" as const, id })),
    ).map((tool) => tool.id),
  );
  const configuredIds = effectiveIds.filter((id) => availableIds.has(id));
  const configuredIdSet = new Set(configuredIds);
  const droppedIds = effectiveIds.filter((id) => !configuredIdSet.has(id));
  // Lazy discovery is scoped to the effective MCP allow-list. Mandatory means
  // selected/fail-loud, not eager: only an exact session ref with eager:true
  // belongs on the first model request's critical path.
  const deferredIds = sortedIds(
    toolRefs
      .filter((tool) => configuredIdSet.has(tool.id) && tool.eager !== true)
      .map((tool) => tool.id),
  );
  const selectedIds = sortedIds(
    selectedRefs
      .filter(
        (tool) =>
          !mandatoryIdSet.has(tool.id) && !(tracksWorkspaceDefaults && tool.optional === true),
      )
      .map((tool) => tool.id),
  );
  const projections = {
    selected: projectIds(selectedIds),
    effective: projectIds(effectiveIds),
    mandatory: projectIds(sortedIds(mandatoryIds)),
    deferred: projectIds(deferredIds),
    configured: projectIds(configuredIds),
    dropped: projectIds(droppedIds),
  };

  return {
    toolRefs,
    effectivePolicy: {
      mode: policy.mode,
      inheritedFromSessionId: policy.inheritedFromSessionId,
      selectedIds: projections.selected.ids,
      effectiveIds: projections.effective.ids,
      mandatoryIds: projections.mandatory.ids,
      lazyRouter: {
        state: deferredIds.length > 0 ? "required" : "disabled",
        deferredIds: projections.deferred.ids,
      },
      configuredIds: projections.configured.ids,
      droppedIds: projections.dropped.ids,
      counts: {
        selected: selectedIds.length,
        effective: effectiveIds.length,
        mandatory: mandatoryIds.length,
        deferred: deferredIds.length,
        configured: configuredIds.length,
        dropped: droppedIds.length,
      },
      idsTruncated: Object.values(projections).some((projection) => projection.truncated),
    },
  };
}

/** Null is ordinary work; an empty list is a frozen scheduled selection. */
export function scheduledTurnMcpServerIds(turn: Pick<SessionTurn, "metadata">): string[] | null {
  const metadata = turn.metadata;
  const value =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? metadata.scheduledEffectiveMcpServerIds
      : null;
  return Array.isArray(value) && value.every((id) => typeof id === "string")
    ? sortedIds(value)
    : null;
}

/**
 * Execution's canonical turn selection. Ordinary turns use the durable session
 * policy, not the queue's omitted-tools `[]`. Scheduled turns instead retain
 * their frozen registry and refs, including an explicitly empty selection.
 */
export function resolveTurnToolPolicy(
  input: Omit<SessionToolPolicyInput, "sessionTools"> & {
    session: Pick<Session, "tools">;
    turn: Pick<SessionTurn, "tools" | "metadata">;
  },
): ResolvedSessionToolPolicy {
  const scheduledIds = scheduledTurnMcpServerIds(input.turn);
  const availableIds = new Set(input.availableMcpServerIds);
  return resolveSessionToolPolicy({
    toolPolicy: input.toolPolicy,
    sessionTools: scheduledIds ? input.turn.tools : input.session.tools,
    availableMcpServerIds: scheduledIds
      ? scheduledIds.filter((id) => availableIds.has(id))
      : availableIds,
    defaultMcpServerIds: scheduledIds ?? input.defaultMcpServerIds ?? [],
  });
}

/** Current full runtime registry IDs, including configured static servers. */
export async function workspaceSessionToolPolicyServerIds(
  db: Database,
  workspaceId: string,
  settings: Settings,
  subjectId?: string,
): Promise<string[]> {
  const runtimeSettings = await settingsWithEnabledCapabilityMcpServers(db, workspaceId, settings, {
    ...(subjectId ? { subjectId } : {}),
  });
  return sortedIds(runtimeSettings.mcpServers.map((server) => server.id));
}

/** Current omitted-tools defaults: every configured runtime MCP is on. */
export async function workspaceSessionToolPolicyDefaultServerIds(
  db: Database,
  workspaceId: string,
  settings: Settings,
  subjectId?: string,
): Promise<string[]> {
  const runtimeSettings = await settingsWithEnabledCapabilityMcpServers(db, workspaceId, settings, {
    ...(subjectId ? { subjectId } : {}),
  });
  const workspace = await requireWorkspace(db, workspaceId);
  return workspaceSessionToolPolicyDefaultServerIdsFor(
    runtimeSettings.mcpServers,
    workspace.settings,
  );
}

/**
 * The omitted-tools default for one resolved runtime registry and one
 * workspace settings bag. Pure so a caller that already holds both never has
 * to re-query the capability registry to agree with the worker and the
 * composer on which connectors a `workspace_default` session executes with.
 */
export function workspaceSessionToolPolicyDefaultServerIdsFor(
  runtimeMcpServers: Iterable<{ id: string }>,
  workspaceSettings: unknown,
): string[] {
  const availableDefaults = defaultSessionMcpServerIds(runtimeMcpServers);
  const configured = resolveWorkspaceSessionToolDefaults(workspaceSettings);
  if (!configured?.mcpServerIds) return availableDefaults;
  const available = new Set(availableDefaults);
  return sortedIds([
    ...configured.mcpServerIds.filter((id) => available.has(id)),
    ...(configured.inheritConnectedMcpServers
      ? availableDefaults.filter((id) => !["opengeni", "files", "docs"].includes(id))
      : []),
  ]);
}

/** Metadata only: no MCP listing, provider probes, account selection or credentials. */
export type SessionEffectiveToolsContext = {
  settings: Settings;
  humanInputEnabled: boolean;
  hasWorkspaceSkills: boolean;
  workspaceSettings?: unknown;
  objectStorageAvailable: boolean;
  activeSandboxBackends?: ReadonlyMap<string, Settings["sandboxBackend"]>;
  /** Exact build options after adapter/credential resolution, keyed by session. No pool-readiness inference. */
  mediaAttachments?: ReadonlyMap<string, AgentMediaAttachment>;
  routerInHistory?: boolean;
  routerHistorySessionIds?: ReadonlySet<string>;
};

/**
 * Resolve one context for a response page, not one catalog per session. Legacy
 * rows require no additional reads and never acquire an effectiveTools field.
 */
export async function workspaceSessionEffectiveToolsContext(
  deps: { db: Database; settings: Settings; objectStorage?: unknown },
  workspaceId: string,
  subjectId: string,
  sessions: readonly Session[],
): Promise<SessionEffectiveToolsContext> {
  const configured = sessions.filter((session) => session.agent != null);
  const baseline: SessionEffectiveToolsContext = {
    settings: deps.settings,
    humanInputEnabled: false,
    hasWorkspaceSkills: false,
    objectStorageAvailable: Boolean(deps.objectStorage),
  };
  if (configured.length === 0) return baseline;
  const [workspace, catalog, descriptors, sandboxes, routerHistory] = await Promise.all([
    requireWorkspace(deps.db, workspaceId),
    resolveWorkspaceCatalogSettings(deps.db, deps.settings, {
      accountId: configured[0]!.accountId,
      workspaceId,
      retainedProductModelIds: configured.map((session) => session.model),
    }),
    configured.some((session) => session.agent?.capabilities.skills === "read")
      ? listSkillDescriptors(deps.db, {
          accountId: configured[0]!.accountId,
          workspaceId,
          subjectId,
        })
      : Promise.resolve([]),
    deps.settings.sandboxSelfhostedEnabled
      ? Promise.all(
          sortedIds(configured.flatMap((session) => session.activeSandboxId ?? [])).map(
            async (id) =>
              [
                id,
                await getSandbox(
                  deps.db,
                  { accountId: configured[0]!.accountId, workspaceId, subjectId },
                  id,
                ),
              ] as const,
          ),
        )
      : Promise.resolve([]),
    Promise.all(
      [...new Map(configured.map((session) => [session.id, session])).values()].map(
        async (session) =>
          [
            session.id,
            await sessionHasToolRouterHistory(deps.db, {
              accountId: session.accountId,
              workspaceId,
              sessionId: session.id,
            }),
          ] as const,
      ),
    ),
  ]);
  return {
    ...baseline,
    settings: catalog.settings,
    workspaceSettings: workspace.settings,
    humanInputEnabled: resolveWorkspaceAgentHumanInputEnabled(workspace.settings),
    hasWorkspaceSkills: descriptors.some((entry) => entry.activationMode === "workspace_managed"),
    activeSandboxBackends: new Map(
      sandboxes.flatMap(([id, sandbox]) =>
        sandbox?.kind === "selfhosted" ? [[id, "selfhosted" as const]] : [],
      ),
    ),
    routerHistorySessionIds: new Set(
      routerHistory.filter(([, present]) => present).map(([id]) => id),
    ),
  };
}

function sessionHasSkills(session: Session, context: SessionEffectiveToolsContext): boolean {
  if (context.hasWorkspaceSkills || session.skills.length > 0) return true;
  // Undefined is the worker's bundled default. Explicit [] means no bundles.
  if (session.bundledSkillIds === undefined) return true;
  const tools = new Set(
    resolveAgentToolFamilies(session.agent).firstPartyTools(
      allowedFirstPartyMcpToolsForSession(context.settings, session.firstPartyMcpTools),
    ),
  );
  return session.bundledSkillIds.some((id) => {
    if (
      [
        "builtin:opengeni-documents",
        "builtin:opengeni-spreadsheets",
        "builtin:opengeni-presentations",
      ].includes(id)
    ) {
      return tools.has("editable_artifact_list") && tools.has("editable_artifact_get");
    }
    if (id === "builtin:opengeni-sites") {
      return tools.has("artifacts_create") && tools.has("artifacts_publish");
    }
    if (id === "builtin:opengeni-video-generation") {
      return context.mediaAttachments?.get(session.id)?.video === true;
    }
    return true;
  });
}

/** The server can prove attachment policy, not successful future provider calls. */
export function sessionEffectiveToolProjectionInput(
  session: Session & { agent: NonNullable<Session["agent"]> },
  toolRefs: readonly ToolRef[],
  context?: SessionEffectiveToolsContext,
) {
  const model = context ? resolveModelProviderForTurn(context.settings, session.model) : undefined;
  const sandboxBackend =
    (session.activeSandboxId
      ? context?.activeSandboxBackends?.get(session.activeSandboxId)
      : undefined) ?? session.sandboxBackend;
  const sandboxAvailable = context !== undefined && sandboxBackend !== "none";
  const supportsImages =
    model?.model.api === "responses" && model.model.capabilities.inputModalities.includes("image");
  const hostedToolNames: AgentFunctionToolName[] = [];
  if (model?.provider.kind === "xai-subscription") {
    if (context?.settings.webSearchEnabled) hostedToolNames.push("web_search", "x_search");
  } else if (model?.model.hostedWebSearch) hostedToolNames.push("web_search");
  const mediaAttachment =
    context?.mediaAttachments?.get(session.id) ??
    (context?.objectStorageAvailable === false
      ? ({ image: null, video: false } as const)
      : undefined);
  const media = resolveAgentMediaToolSurface(session.agent, mediaAttachment);
  hostedToolNames.push(...media.hosted);
  const runtimeToolNames: AgentFunctionToolName[] = context
    ? [
        "request_human_input",
        "list_models",
        "skill_read",
        ...AGENT_SKILL_MANAGE_TOOL_NAMES,
        ...media.runtime,
      ]
    : [];
  const sandboxToolNames: AgentFunctionToolName[] = sandboxAvailable
    ? [
        "exec_command",
        "write_stdin",
        "apply_patch",
        ...(supportsImages ? ["view_image" as const] : []),
        ...(session.resources.some((resource) => resource.kind === "repository")
          ? ["repository_skill_read" as const]
          : []),
        ...(codeSearchEnabledForTurn(
          session.codeSearchEnabled,
          context?.workspaceSettings,
          codeSearchDeploymentPolicy(context!.settings),
        ) && session.sandboxOs !== "windows"
          ? ["code_search" as const]
          : []),
      ]
    : [];
  const needsTitle =
    session.titleSource !== "user" &&
    (!session.title?.trim() || session.title.trim() === AUTOMATIC_SESSION_TITLE_FALLBACK);
  const firstPartyMcpTools =
    context && toolRefs.some((ref) => ref.id === "opengeni")
      ? resolveAgentToolFamilies(session.agent)
          .firstPartyTools(
            allowedFirstPartyMcpToolsForSession(context.settings, session.firstPartyMcpTools),
          )
          .filter((name) => name !== "set_session_title" || !needsTitle)
      : [];
  const interactionNames = new Set<string>(FIRST_PARTY_IN_PROCESS_TOOL_NAMES);
  const firstPartyModelNames = new Map<FirstPartyMcpToolName, string>();
  const permissions: readonly string[] =
    session.firstPartyMcpPermissions ?? DEFAULT_FIRST_PARTY_MCP_PERMISSIONS;
  const permissionAllowed = (permission: string) =>
    permissions.includes(permission as never) || permissions.includes("workspace:admin");
  if (context && resolveFirstPartyDelegationSecret(context.settings)) {
    for (const name of FIRST_PARTY_IN_PROCESS_TOOL_NAMES) {
      const readOnly = [
        "interaction_discover",
        "browser_observe",
        "browser_read",
        "browser_screenshot",
        "browser_clipboard",
        "browser_debug",
        "computer_targets",
        "computer_observe",
        "computer_clipboard",
      ].includes(name);
      if (permissionAllowed(readOnly ? "sessions:read" : "sessions:control")) {
        firstPartyModelNames.set(name, `interaction__${name}`);
        if (
          !firstPartyMcpTools.includes(name) &&
          resolveAgentToolFamilies(session.agent).allowsFirstPartyTool(name) &&
          session.firstPartyMcpTools.includes(name)
        )
          firstPartyMcpTools.push(name);
      }
    }
  }
  // Interaction names are never registered by the remote first-party server.
  for (let index = firstPartyMcpTools.length - 1; index >= 0; index--) {
    const name = firstPartyMcpTools[index]!;
    if (interactionNames.has(name) && !firstPartyModelNames.has(name))
      firstPartyMcpTools.splice(index, 1);
  }
  const codex = model?.provider.kind === "codex-subscription";
  const retainedRouter =
    context?.routerInHistory === true || context?.routerHistorySessionIds?.has(session.id) === true;
  const progressiveDisclosure =
    retainedRouter ||
    (context
      ? codex
        ? context.settings.codexToolSearchEnabled
        : context.settings.lazyToolSearchEnabled
      : false);
  const upfrontToolNames = new Set<string>([
    ...hostedToolNames,
    ...sandboxToolNames,
    "skill_read",
    "request_human_input",
    "list_models",
    ...(toolRefs.some((ref) => ref.id === "opengeni" && ref.eager === true) ||
    !progressiveDisclosure
      ? firstPartyMcpTools.filter((name) => !interactionNames.has(name) || !progressiveDisclosure)
      : []),
    ...(!progressiveDisclosure ? runtimeToolNames : []),
  ]);
  const environment: AgentToolEnvironment = {
    productServerIds: new Set([
      ...session.mcpServers.map((server) => server.id),
      ...(session.toolPolicy.mode !== "workspace_default"
        ? session.tools.map((tool) => tool.id)
        : []),
    ]),
    hasSkills: context ? sessionHasSkills(session, context) : false,
    webSearch: hostedToolNames.includes("web_search"),
    humanInput: context?.humanInputEnabled ?? false,
    media: media.toolsKnown ? media.hosted.length + media.runtime.length > 0 : undefined,
    routerInHistory:
      context?.routerInHistory === true ||
      context?.routerHistorySessionIds?.has(session.id) === true,
  };
  const families = resolveAgentToolFamilies(session.agent, environment);
  environment.hasDeferredTools =
    toolRefs.some(
      (ref) => ref.id !== "opengeni" && ref.eager !== true && families.allowsMcpServer(ref.id),
    ) ||
    firstPartyMcpTools.some(
      (name) => families.allowsFirstPartyTool(name) && !upfrontToolNames.has(name),
    ) ||
    runtimeToolNames.some(
      (name) => families.allowsFunctionTool(name) && !upfrontToolNames.has(name),
    );
  const provider = model?.provider;
  const native =
    codex ||
    (provider?.api === "responses" &&
      (provider.wireProfile === "azure-openai" ||
        (provider.builtin && provider.id === "openai" && provider.baseUrl === undefined)));
  const routerToolNames: AgentFunctionToolName[] =
    progressiveDisclosure && resolveAgentToolFamilies(session.agent, environment).router
      ? ["tool_search", "tool_list", ...(native ? [] : ["tool_invoke" as const])]
      : [];
  for (const name of routerToolNames) upfrontToolNames.add(name);
  return {
    config: session.agent,
    firstPartyMcpTools,
    firstPartyModelNames,
    mcpServerIds: toolRefs.map((ref) => ref.id),
    productServerIds: environment.productServerIds ?? new Set<string>(),
    environment,
    runtimeToolNames,
    hostedToolNames,
    sandboxToolNames,
    routerToolNames,
    upfrontToolNames,
    mediaAttachment,
  };
}

/** Add a bounded, secret-safe effective projection to a session response. */
export function sessionWithEffectiveToolPolicy(
  session: Session,
  workspaceServerIds: Iterable<string>,
  workspaceDefaultServerIds: Iterable<string> = [],
  effectiveToolsContext?: SessionEffectiveToolsContext,
): Session {
  const availableIds = new Set(workspaceServerIds);
  for (const server of session.mcpServers) {
    availableIds.add(server.id);
  }
  const { effectivePolicy: effectiveToolPolicy, toolRefs } = resolveSessionToolPolicy({
    toolPolicy: session.toolPolicy,
    sessionTools: session.tools,
    availableMcpServerIds: availableIds,
    defaultMcpServerIds: workspaceDefaultServerIds,
  });
  return {
    ...session,
    effectiveToolPolicy,
    // Configured sessions also report what they can use at capability level.
    ...(session.agent
      ? {
          effectiveTools: projectAgentEffectiveTools(
            sessionEffectiveToolProjectionInput(
              { ...session, agent: session.agent },
              toolRefs,
              effectiveToolsContext,
            ),
          ),
        }
      : {}),
  };
}
