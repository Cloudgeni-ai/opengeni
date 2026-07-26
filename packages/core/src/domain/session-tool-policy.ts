import type { Settings } from "@opengeni/config";
import {
  SESSION_EFFECTIVE_TOOL_POLICY_ID_LIMIT,
  SESSION_EFFECTIVE_TOOL_POLICY_ID_MAX_LENGTH,
  mergeToolRefs,
  type Session,
  type SessionEffectiveToolPolicy,
  type SessionToolPolicy,
  type ToolRef,
} from "@opengeni/contracts";
import type { Database } from "@opengeni/db";
import { settingsWithEnabledCapabilityMcpServers } from "./capabilities";
import { enabledCapabilityMcpToolRefs } from "./resources";

const MANDATORY_SESSION_MCP_SERVER_IDS = ["opengeni"] as const;
const PROJECTABLE_REGISTRY_ID = /^[A-Za-z0-9_-]+$/;

export type ResolvedSessionToolPolicy = {
  toolRefs: ToolRef[];
  effectivePolicy: SessionEffectiveToolPolicy;
};

export type SessionToolPolicyInput = {
  toolPolicy?: SessionToolPolicy | null;
  sessionTools: ToolRef[];
  turnTools?: ToolRef[];
  /** Undefined preserves the legacy merge path for pre-provenance callers. */
  turnToolsProvided?: boolean;
  availableMcpServerIds: Iterable<string>;
  /** Current omitted-tools defaults, intentionally narrower than all servers. */
  defaultMcpServerIds?: Iterable<string>;
};

function sortedIds(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort();
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
 * `defaultMcpServerIds` is the capability-only omitted-tools set.
 */
export function resolveSessionToolPolicy(input: SessionToolPolicyInput): ResolvedSessionToolPolicy {
  const policy = input.toolPolicy ?? { mode: "legacy" as const, inheritedFromSessionId: null };
  const availableIds = new Set(input.availableMcpServerIds);
  // Never infer omitted-tools defaults from the full runtime registry: static
  // MCPs are explicit-only unless they are capability-derived defaults.
  const defaultIds = new Set(input.defaultMcpServerIds ?? []);
  const mandatoryIds: string[] = MANDATORY_SESSION_MCP_SERVER_IDS.filter((id) =>
    availableIds.has(id),
  );
  const mandatoryIdSet = new Set<string>(mandatoryIds);
  const selectedRefs =
    input.turnToolsProvided === true
      ? mergeToolRefs([], input.turnTools ?? [])
      : input.turnToolsProvided === false
        ? mergeToolRefs([], input.sessionTools)
        : mergeToolRefs(input.sessionTools, input.turnTools ?? []);
  const tracksWorkspaceDefaults =
    policy.mode === "workspace_default" && input.turnToolsProvided !== true;

  // Optional capability refs are a historical materialization of a
  // workspace-default selection. They may outlive an installation or its
  // credentials; do not hand an unavailable optional ref to runtime, where it
  // would otherwise be an unknown MCP id. Strict historical refs intentionally
  // remain so their fail-loud compatibility contract is preserved.
  let toolRefs = selectedRefs.filter((tool) => tool.optional !== true || availableIds.has(tool.id));
  if (tracksWorkspaceDefaults) {
    toolRefs = mergeToolRefs(
      toolRefs,
      sortedIds(defaultIds)
        .filter((id) => availableIds.has(id))
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
          .filter((id) => availableIds.has(id))
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
  const deferredIds = tracksWorkspaceDefaults
    ? sortedIds(
        toolRefs
          .filter(
            (tool) =>
              tool.optional === true &&
              configuredIdSet.has(tool.id) &&
              !mandatoryIdSet.has(tool.id),
          )
          .map((tool) => tool.id),
      )
    : [];
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
        state: tracksWorkspaceDefaults ? "required" : "disabled",
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

/** Current full runtime registry IDs, including configured static servers. */
export async function workspaceSessionToolPolicyServerIds(
  db: Database,
  workspaceId: string,
  settings: Settings,
): Promise<string[]> {
  const runtimeSettings = await settingsWithEnabledCapabilityMcpServers(db, workspaceId, settings);
  return sortedIds(runtimeSettings.mcpServers.map((server) => server.id));
}

/** Current omitted-tools defaults; this preserves capability-first behavior. */
export async function workspaceSessionToolPolicyDefaultServerIds(
  db: Database,
  workspaceId: string,
  settings: Settings,
): Promise<string[]> {
  const runtimeSettings = await settingsWithEnabledCapabilityMcpServers(db, workspaceId, settings);
  return sortedIds(enabledCapabilityMcpToolRefs(settings, runtimeSettings).map((tool) => tool.id));
}

/** Add a bounded, secret-safe effective projection to a session response. */
export function sessionWithEffectiveToolPolicy(
  session: Session,
  workspaceServerIds: Iterable<string>,
  workspaceDefaultServerIds: Iterable<string> = [],
): Session {
  const availableIds = new Set(workspaceServerIds);
  for (const server of session.mcpServers) {
    availableIds.add(server.id);
  }
  return {
    ...session,
    effectiveToolPolicy: resolveSessionToolPolicy({
      ...(session.toolPolicy ? { toolPolicy: session.toolPolicy } : {}),
      sessionTools: session.tools,
      availableMcpServerIds: availableIds,
      defaultMcpServerIds: workspaceDefaultServerIds,
    }).effectivePolicy,
  };
}
