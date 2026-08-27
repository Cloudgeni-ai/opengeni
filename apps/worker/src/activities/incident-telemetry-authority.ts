import {
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  type McpPersonalConnectionDelegation,
  type ScheduledTask,
  type ScheduledTaskRunAcceptedExecution,
  type Session,
  type SessionSystemUpdate,
} from "@opengeni/contracts";
import { defaultSessionMcpServerIds, resolveSessionToolPolicy } from "@opengeni/core";
import {
  getRig,
  getScheduledScopedRigVersionMetadata,
  getScheduledTaskRunAcceptedExecution,
  getVariableSet,
  listEnabledMcpCapabilityServerIds,
  listInstalledApiIntegrationServerIdsForDelegations,
  markScheduledTaskRunAuthorityRejectedInTransaction,
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

/** Resolve only exact selected responder metadata; never read/decrypt values or call providers. */
export async function resolveIncidentTelemetryResponderMetadata(input: {
  db: Database;
  settings: Settings;
  task: ScheduledTask;
  session: Session | null;
  personalConnectionDelegations: readonly McpPersonalConnectionDelegation[];
  personalResourceAuthoritySubjectId?: string | null;
  executionPolicy?: {
    tools: ScheduledTaskRunAcceptedExecution["resolvedTools"];
    firstPartyMcpTools: ScheduledTaskRunAcceptedExecution["resolvedFirstPartyMcpTools"];
    firstPartyMcpPermissions:
      | ScheduledTaskRunAcceptedExecution["resolvedFirstPartyMcpPermissions"]
      | null;
    variableSetIds?: readonly string[];
    variableSetId: string | null;
    rigId: string | null;
    rigVersionId: string | null;
    toolPolicy: Session["toolPolicy"];
    mcpServerIds: readonly string[];
    toolPolicyVersion: number | null;
  };
}): Promise<IncidentTelemetryResponderMetadata> {
  const [capabilityServerIds, apiIntegrationServerIds] = await Promise.all([
    listEnabledMcpCapabilityServerIds(input.db, input.task.workspaceId),
    listInstalledApiIntegrationServerIdsForDelegations(
      input.db,
      input.task.workspaceId,
      input.personalConnectionDelegations,
    ),
  ]);
  const sessionTools = input.executionPolicy
    ? input.executionPolicy.tools
    : input.session
      ? input.session.tools
      : withFirstPartyTools(input.settings, input.task.agentConfig.tools);
  const resolvedToolPolicy = resolveIncidentTelemetryResponderToolPolicy({
    settingsMcpServerIds: input.settings.mcpServers.map((server) => server.id),
    capabilityServerIds,
    apiIntegrationServerIds,
    ...(input.executionPolicy
      ? { acceptedSessionMcpServerIds: input.executionPolicy.mcpServerIds }
      : {}),
    session: input.executionPolicy
      ? {
          mcpServers: input.executionPolicy.mcpServerIds.map((id) => ({ id })),
          tools: input.executionPolicy.tools,
          toolPolicy: input.executionPolicy.toolPolicy,
        }
      : input.session,
    plannedTools: sessionTools,
  });

  let metadataComplete = true;
  let rig: IncidentTelemetryResponderMetadata["rig"] = null;
  const variableSetIds = new Set<string>();
  if (input.executionPolicy ?? input.session) {
    for (const id of input.executionPolicy?.variableSetIds ?? input.session?.variableSetIds ?? []) {
      variableSetIds.add(id);
    }
    const variableSetId = input.executionPolicy?.variableSetId ?? input.session?.variableSetId;
    const rigId = input.executionPolicy?.rigId ?? input.session?.rigId ?? null;
    const rigVersionId = input.executionPolicy?.rigVersionId ?? input.session?.rigVersionId ?? null;
    if (variableSetId) variableSetIds.add(variableSetId);
    if ((rigId === null) !== (rigVersionId === null)) {
      metadataComplete = false;
    } else if (rigId && rigVersionId) {
      const selected = await getScheduledScopedRigVersionMetadata(
        input.db,
        {
          accountId: input.task.accountId,
          workspaceId: input.task.workspaceId,
          subjectId: input.personalResourceAuthoritySubjectId ?? input.task.createdBy.subjectId,
        },
        rigId,
        rigVersionId,
      );
      if (!selected) {
        metadataComplete = false;
      } else {
        rig = {
          name: selected.name,
          credentialHooks: selected.version.credentialHooks,
          checkHealth: selected.health.checkHealth,
        };
        for (const id of selected.version.defaultVariableSetIds) variableSetIds.add(id);
      }
    }
  } else {
    if (input.task.variableSetId) variableSetIds.add(input.task.variableSetId);
    if (input.task.rigId) {
      const selectedRig = await getRig(
        input.db,
        {
          accountId: input.task.accountId,
          workspaceId: input.task.workspaceId,
          subjectId: input.personalResourceAuthoritySubjectId ?? input.task.createdBy.subjectId,
        },
        input.task.rigId,
      );
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
      async (id) =>
        await getVariableSet(
          input.db,
          {
            accountId: input.task.accountId,
            workspaceId: input.task.workspaceId,
            subjectId: input.personalResourceAuthoritySubjectId ?? input.task.createdBy.subjectId,
          },
          id,
        ),
    ),
  );
  if (variableSets.some((variableSet) => variableSet === null)) {
    metadataComplete = false;
  }

  return {
    metadataComplete,
    resources: input.executionPolicy
      ? input.task.agentConfig.resources
      : (input.session?.resources ?? input.task.agentConfig.resources),
    mcpServerIds: resolvedToolPolicy.toolRefs.map((tool) => tool.id),
    firstPartyMcpTools: input.executionPolicy
      ? input.executionPolicy.firstPartyMcpTools
      : input.session
        ? allowedFirstPartyMcpToolsForSession(input.settings, input.session.firstPartyMcpTools)
        : resolveFirstPartyMcpToolPolicy(input.settings).default,
    firstPartyMcpPermissions: input.executionPolicy
      ? (input.executionPolicy.firstPartyMcpPermissions ?? DEFAULT_FIRST_PARTY_MCP_PERMISSIONS)
      : (input.session?.firstPartyMcpPermissions ?? DEFAULT_FIRST_PARTY_MCP_PERMISSIONS),
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
    toolPolicyVersion:
      input.executionPolicy?.toolPolicyVersion ?? input.session?.toolPolicyVersion ?? null,
  };
}

/** Resolve the responder's current ID-only MCP policy without materializing runtime secrets. */
export function resolveIncidentTelemetryResponderToolPolicy(input: {
  settingsMcpServerIds: readonly string[];
  capabilityServerIds: readonly string[];
  apiIntegrationServerIds: readonly string[];
  acceptedSessionMcpServerIds?: readonly string[];
  session: {
    mcpServers: readonly { id: string }[];
    tools: Session["tools"];
    toolPolicy: Session["toolPolicy"];
  } | null;
  plannedTools: Session["tools"];
}) {
  const workspaceDefaultMcpServerIds = new Set(input.settingsMcpServerIds);
  for (const id of input.capabilityServerIds) workspaceDefaultMcpServerIds.add(id);
  for (const id of input.apiIntegrationServerIds) workspaceDefaultMcpServerIds.add(id);
  for (const id of input.acceptedSessionMcpServerIds ?? []) {
    workspaceDefaultMcpServerIds.add(id);
  }

  const availableMcpServerIds = new Set(workspaceDefaultMcpServerIds);
  for (const server of input.session?.mcpServers ?? []) {
    availableMcpServerIds.add(server.id);
  }

  return resolveSessionToolPolicy({
    toolPolicy: input.session?.toolPolicy ?? {
      mode: "explicit",
      inheritedFromSessionId: null,
    },
    sessionTools: input.plannedTools,
    availableMcpServerIds,
    defaultMcpServerIds: defaultSessionMcpServerIds(
      [...workspaceDefaultMcpServerIds].map((id) => ({ id })),
    ),
  });
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
        sessionId: input.sessionId,
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
  const acceptedExecution = await getScheduledTaskRunAcceptedExecution(input.db, {
    workspaceId: input.workspaceId,
    runId,
  });
  if (
    !acceptedExecution ||
    acceptedExecution.task.id !== taskId ||
    !acceptedExecution.incidentPreflightRequired
  ) {
    return await reject();
  }
  const task = acceptedExecution.task;
  const personalConnectionDelegations = acceptedExecution.personalConnectionDelegations;
  const responder = await resolveIncidentTelemetryResponderMetadata({
    db: input.db,
    settings: input.settings,
    task,
    session,
    personalConnectionDelegations,
    personalResourceAuthoritySubjectId: acceptedExecution.personalResourceAuthoritySubjectId,
    executionPolicy: acceptedExecution.targetSessionExecution
      ? {
          tools: acceptedExecution.targetSessionExecution.tools,
          firstPartyMcpTools: acceptedExecution.targetSessionExecution.firstPartyMcpTools,
          firstPartyMcpPermissions:
            acceptedExecution.targetSessionExecution.firstPartyMcpPermissions,
          variableSetIds: acceptedExecution.targetSessionExecution.variableSets.map(
            (variableSet) => variableSet.id,
          ),
          variableSetId: acceptedExecution.targetSessionExecution.variableSetId,
          rigId: acceptedExecution.targetSessionExecution.rigId,
          rigVersionId: acceptedExecution.targetSessionExecution.rigVersionId,
          toolPolicy: acceptedExecution.targetSessionExecution.toolPolicy,
          mcpServerIds: acceptedExecution.targetSessionExecution.mcpServerIds,
          toolPolicyVersion: acceptedExecution.targetSessionExecution.toolPolicyVersion,
        }
      : {
          tools: acceptedExecution.resolvedTools,
          firstPartyMcpTools: acceptedExecution.resolvedFirstPartyMcpTools,
          firstPartyMcpPermissions: acceptedExecution.resolvedFirstPartyMcpPermissions,
          variableSetId: acceptedExecution.resolvedVariableSet?.id ?? null,
          rigId: acceptedExecution.resolvedRig?.id ?? null,
          rigVersionId: acceptedExecution.resolvedRig?.versionId ?? null,
          toolPolicy: session.toolPolicy,
          mcpServerIds: [],
          toolPolicyVersion: session.toolPolicyVersion,
        },
  });
  const preflight = evaluateIncidentTelemetryPreflight({
    agentConfig: task.agentConfig,
    incidentTriggered: acceptedExecution.alertOccurrenceLabels !== null,
    alertOccurrenceLabels: acceptedExecution.alertOccurrenceLabels,
    responder,
  });
  if (preflight.action !== "ready") return await reject();
  const current = incidentTelemetryAuthorityFence({
    task,
    responder,
    alertOccurrenceLabels: acceptedExecution.alertOccurrenceLabels,
  });
  return current &&
    current.toolPolicyVersion === fence.toolPolicyVersion &&
    current.responderDigest === fence.responderDigest &&
    current.taskDigest === fence.taskDigest &&
    current.alertSelectorDigest === fence.alertSelectorDigest
    ? { action: "accept" }
    : await reject();
}
