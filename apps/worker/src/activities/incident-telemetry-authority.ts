import {
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  type McpPersonalConnectionDelegation,
  type ScheduledTask,
  type Session,
  type SessionSystemUpdate,
} from "@opengeni/contracts";
import { defaultSessionMcpServerIds, resolveSessionToolPolicy } from "@opengeni/core";
import {
  getRig,
  getRigName,
  getRigVersion,
  getRigVersionHealth,
  getVariableSet,
  listEnabledMcpCapabilityServerIds,
  listInstalledApiIntegrationServerIdsForDelegations,
  markScheduledTaskRunAuthorityRejectedInTransaction,
  requireScheduledTaskIncidentAuthorityInTransaction,
  requireSession,
  type Database,
} from "@opengeni/db";
import {
  allowedFirstPartyMcpToolsForSession,
  resolveFirstPartyMcpToolPolicy,
  type Settings,
} from "@opengeni/config";
import { withFirstPartyTools } from "./goals";
import {
  INCIDENT_TELEMETRY_AUTHORITY_FENCE_LINEAGE_KEY,
  incidentTelemetryAuthorityFence,
  parseIncidentTelemetryAuthorityFence,
  evaluateIncidentTelemetryPreflight,
  type IncidentTelemetryResponderMetadata,
} from "./incident-telemetry-preflight";
import { scheduledAlertOccurrenceIdentity } from "../scheduled-alert-occurrence";

/** Resolve only exact selected responder metadata; never read/decrypt values or call providers. */
export async function resolveIncidentTelemetryResponderMetadata(input: {
  db: Database;
  settings: Settings;
  task: ScheduledTask;
  session: Session | null;
  personalConnectionDelegations: readonly McpPersonalConnectionDelegation[];
}): Promise<IncidentTelemetryResponderMetadata> {
  const [capabilityServerIds, apiIntegrationServerIds] = await Promise.all([
    listEnabledMcpCapabilityServerIds(input.db, input.task.workspaceId),
    listInstalledApiIntegrationServerIdsForDelegations(
      input.db,
      input.task.workspaceId,
      input.personalConnectionDelegations,
    ),
  ]);
  const availableMcpServerIds = new Set(input.settings.mcpServers.map((server) => server.id));
  for (const id of capabilityServerIds) availableMcpServerIds.add(id);
  for (const id of apiIntegrationServerIds) availableMcpServerIds.add(id);
  for (const server of input.session?.mcpServers ?? []) {
    availableMcpServerIds.add(server.id);
  }

  const sessionTools = input.session
    ? input.session.tools
    : withFirstPartyTools(input.settings, input.task.agentConfig.tools);
  const resolvedToolPolicy = resolveSessionToolPolicy({
    toolPolicy: input.session?.toolPolicy ?? {
      mode: "explicit",
      inheritedFromSessionId: null,
    },
    sessionTools,
    availableMcpServerIds,
    defaultMcpServerIds: defaultSessionMcpServerIds(input.settings.mcpServers),
  });

  let metadataComplete = true;
  let rig: IncidentTelemetryResponderMetadata["rig"] = null;
  const variableSetIds = new Set<string>();
  if (input.session) {
    if (input.session.variableSetId) variableSetIds.add(input.session.variableSetId);
    if ((input.session.rigId === null) !== (input.session.rigVersionId === null)) {
      metadataComplete = false;
    } else if (input.session.rigId && input.session.rigVersionId) {
      const [name, version, health] = await Promise.all([
        getRigName(input.db, input.task.workspaceId, input.session.rigId),
        getRigVersion(
          input.db,
          input.task.workspaceId,
          input.session.rigId,
          input.session.rigVersionId,
        ),
        getRigVersionHealth(
          input.db,
          input.task.workspaceId,
          input.session.rigId,
          input.session.rigVersionId,
        ),
      ]);
      if (!name || !version || !health) {
        metadataComplete = false;
      } else {
        rig = {
          name,
          credentialHooks: version.credentialHooks,
          checkHealth: health.checkHealth,
        };
        for (const id of version.defaultVariableSetIds) variableSetIds.add(id);
      }
    }
  } else {
    if (input.task.variableSetId) variableSetIds.add(input.task.variableSetId);
    if (input.task.rigId) {
      const selectedRig = await getRig(input.db, input.task.workspaceId, input.task.rigId);
      if (!selectedRig?.activeVersion || !selectedRig.activeVersionHealth) {
        metadataComplete = false;
      } else {
        rig = {
          name: selectedRig.name,
          credentialHooks: selectedRig.activeVersion.credentialHooks,
          checkHealth: selectedRig.activeVersionHealth.checkHealth,
        };
        for (const id of selectedRig.activeVersion.defaultVariableSetIds) variableSetIds.add(id);
      }
    }
  }

  const variableSets = await Promise.all(
    [...variableSetIds].map(
      async (id) => await getVariableSet(input.db, input.task.workspaceId, id),
    ),
  );
  if (variableSets.some((variableSet) => variableSet === null)) {
    metadataComplete = false;
  }

  return {
    metadataComplete,
    resources: input.session?.resources ?? input.task.agentConfig.resources,
    mcpServerIds: resolvedToolPolicy.toolRefs.map((tool) => tool.id),
    firstPartyMcpTools: input.session
      ? allowedFirstPartyMcpToolsForSession(input.settings, input.session.firstPartyMcpTools)
      : resolveFirstPartyMcpToolPolicy(input.settings).default,
    firstPartyMcpPermissions:
      input.session?.firstPartyMcpPermissions ?? DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
    rig,
    variableSets: variableSets.flatMap((variableSet) =>
      variableSet
        ? [
            {
              name: variableSet.name,
              variables: variableSet.variables.map((variable) => ({
                name: variable.name,
              })),
            },
          ]
        : [],
    ),
    toolPolicyVersion: input.session?.toolPolicyVersion ?? null,
  };
}

/** Revalidate a source-frozen incident responder fence before a turn can claim it. */
export async function validateIncidentTelemetrySystemUpdateAuthority(input: {
  db: Database;
  settings: Settings;
  workspaceId: string;
  sessionId: string;
  update: SessionSystemUpdate;
}): Promise<{ action: "accept" } | { action: "reject"; reason: string }> {
  if (!(INCIDENT_TELEMETRY_AUTHORITY_FENCE_LINEAGE_KEY in input.update.lineage)) {
    return { action: "accept" };
  }
  const fence = parseIncidentTelemetryAuthorityFence(input.update.lineage);
  const payload = input.update.payload;
  const taskId = input.update.lineage.scheduledTaskId;
  const runId = payload.type === "scheduled_occurrence" ? payload.scheduledTaskRunId : null;
  const reject = async () => {
    if (runId) {
      await markScheduledTaskRunAuthorityRejectedInTransaction(input.db, {
        workspaceId: input.workspaceId,
        runId,
      });
    }
    return {
      action: "reject",
      reason: "incident_responder_under_capable",
    } as const;
  };
  if (!fence || typeof taskId !== "string" || !runId) return await reject();

  const session = await requireSession(input.db, input.workspaceId, input.sessionId);
  const { task, personalConnectionDelegations } =
    await requireScheduledTaskIncidentAuthorityInTransaction(input.db, {
      workspaceId: input.workspaceId,
      taskId,
    });
  const occurrence = scheduledAlertOccurrenceIdentity({
    workspaceId: input.workspaceId,
    scheduledTaskId: task.id,
    metadata: task.metadata,
  });
  const responder = await resolveIncidentTelemetryResponderMetadata({
    db: input.db,
    settings: input.settings,
    task,
    session,
    personalConnectionDelegations,
  });
  const preflight = evaluateIncidentTelemetryPreflight({
    agentConfig: task.agentConfig,
    incidentTriggered: occurrence !== null,
    alertOccurrenceLabels: occurrence?.labels ?? null,
    responder,
  });
  if (preflight.action !== "ready") return await reject();
  const current = incidentTelemetryAuthorityFence({
    task,
    responder,
    alertOccurrenceLabels: occurrence?.labels ?? null,
  });
  return current &&
    current.toolPolicyVersion === fence.toolPolicyVersion &&
    current.responderDigest === fence.responderDigest &&
    current.taskDigest === fence.taskDigest &&
    current.alertSelectorDigest === fence.alertSelectorDigest
    ? { action: "accept" }
    : await reject();
}
