import {
  IncidentTelemetryPreflight,
  stableJson,
  type FirstPartyMcpToolName,
  type Permission,
  type ResourceRef,
  type ScheduledTaskAgentConfig,
} from "@opengeni/contracts";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export type IncidentTelemetryPreflightBlockReason =
  | "incident_preflight_metadata_missing"
  | "incident_responder_under_capable"
  | "incident_data_source_unsuitable";

export type IncidentTelemetryPreflightResult =
  | { action: "not_required" }
  | { action: "ready" }
  | { action: "blocked"; reason: IncidentTelemetryPreflightBlockReason };

export type IncidentTelemetryRigMetadata = {
  name: string;
  credentialHooks: readonly string[];
  checkHealth: "passing" | "failing" | "unknown";
};

export type IncidentTelemetryVariableSetMetadata = {
  name: string;
  variables: readonly { name: string }[];
};

export type IncidentTelemetryResponderMetadata = {
  /** False when an exact selected attachment could not be projected safely. */
  metadataComplete: boolean;
  resources: readonly ResourceRef[];
  mcpServerIds: readonly string[];
  firstPartyMcpTools: readonly FirstPartyMcpToolName[];
  firstPartyMcpPermissions: readonly Permission[];
  rig: IncidentTelemetryRigMetadata | null;
  variableSets: readonly IncidentTelemetryVariableSetMetadata[];
  /** Exact durable session policy version, or null for a not-yet-created session. */
  toolPolicyVersion: number | null;
};

export type IncidentTelemetryPreflightInput = {
  agentConfig: ScheduledTaskAgentConfig;
  /** A valid structured alert occurrence also makes a legacy task incident-triggered. */
  incidentTriggered: boolean;
  /** Exact bounded labels from that validated occurrence; values are never rendered in blockers. */
  alertOccurrenceLabels: Readonly<Record<string, string>> | null;
  responder: IncidentTelemetryResponderMetadata;
};

export const INCIDENT_TELEMETRY_AUTHORITY_FENCE_LINEAGE_KEY = "incidentTelemetryAuthorityFence";

export type IncidentTelemetryAuthorityFence = {
  version: 1;
  toolPolicyVersion: number;
  responderDigest: string;
};

export type IncidentTelemetryPreflightDeclaration =
  | { action: "not_required" }
  | {
      action: "blocked";
      reason: "incident_preflight_metadata_missing" | "incident_data_source_unsuitable";
    }
  | { action: "required"; preflight: IncidentTelemetryPreflight };

export function incidentTelemetryPreflightDeclaration(
  agentConfig: ScheduledTaskAgentConfig,
  incidentTriggered: boolean,
): IncidentTelemetryPreflightDeclaration {
  const rawConfig = agentConfig as ScheduledTaskAgentConfig & Record<string, unknown>;
  const executionClass = rawConfig.executionClass;
  const rawPreflight = rawConfig.incidentTelemetryPreflight;
  if (executionClass === undefined && rawPreflight === undefined && !incidentTriggered) {
    return { action: "not_required" };
  }
  if (executionClass !== "incident_telemetry" || rawPreflight === undefined) {
    return { action: "blocked", reason: "incident_preflight_metadata_missing" };
  }

  const parsed = IncidentTelemetryPreflight.safeParse(rawPreflight);
  if (!parsed.success) {
    const dataSourceInvalid = parsed.error.issues.some((issue) => issue.path[0] === "dataSource");
    return {
      action: "blocked",
      reason: dataSourceInvalid
        ? "incident_data_source_unsuitable"
        : "incident_preflight_metadata_missing",
    };
  }
  return { action: "required", preflight: parsed.data };
}

/**
 * Pure, metadata-only incident admission. No provider request, public endpoint
 * fetch, secret read/decrypt, session creation, or ambient credential lookup is
 * reachable from this evaluator.
 */
export function evaluateIncidentTelemetryPreflight(
  input: IncidentTelemetryPreflightInput,
): IncidentTelemetryPreflightResult {
  const declaration = incidentTelemetryPreflightDeclaration(
    input.agentConfig,
    input.incidentTriggered,
  );
  if (declaration.action !== "required") return declaration;
  const preflight = declaration.preflight;

  if (!input.responder.metadataComplete) {
    return blocked("incident_preflight_metadata_missing");
  }

  if (
    preflight.requiredResources.some(
      (required) =>
        !input.responder.resources.some((selected) => isDeepStrictEqual(selected, required)),
    )
  ) {
    return blocked("incident_responder_under_capable");
  }

  const selectedMcpServerIds = new Set(input.responder.mcpServerIds);
  if (preflight.requiredMcpServerIds.some((id) => !selectedMcpServerIds.has(id))) {
    return blocked("incident_responder_under_capable");
  }

  const selectedFirstPartyTools = new Set(input.responder.firstPartyMcpTools);
  if (preflight.requiredFirstPartyMcpTools.some((tool) => !selectedFirstPartyTools.has(tool))) {
    return blocked("incident_responder_under_capable");
  }

  const selectedFirstPartyPermissions = new Set(input.responder.firstPartyMcpPermissions);
  if (
    preflight.requiredFirstPartyMcpPermissions.some(
      (permission) => !selectedFirstPartyPermissions.has(permission),
    )
  ) {
    return blocked("incident_responder_under_capable");
  }

  if (preflight.requiredRig && !rigSatisfies(input.responder.rig, preflight.requiredRig)) {
    return blocked("incident_responder_under_capable");
  }

  const variableSetsByName = new Map(input.responder.variableSets.map((set) => [set.name, set]));
  if (preflight.requiredVariableSetNames.some((name) => !variableSetsByName.has(name))) {
    return blocked("incident_responder_under_capable");
  }
  const attachedVariableNames = new Set(
    input.responder.variableSets.flatMap((set) => set.variables.map((variable) => variable.name)),
  );
  if (preflight.requiredVariableNames.some((name) => !attachedVariableNames.has(name))) {
    return blocked("incident_responder_under_capable");
  }

  const route = preflight.dataSource.route;
  if (route.kind === "mcp" && !selectedMcpServerIds.has(route.serverId)) {
    return blocked("incident_responder_under_capable");
  }
  if (route.kind === "first_party" && !selectedFirstPartyTools.has(route.tool)) {
    return blocked("incident_responder_under_capable");
  }
  if (route.kind === "variable_set") {
    const selected = variableSetsByName.get(route.variableSetName);
    const names = new Set(selected?.variables.map((variable) => variable.name) ?? []);
    if (!selected || route.variableNames.some((name) => !names.has(name))) {
      return blocked("incident_responder_under_capable");
    }
  }
  if (
    route.kind === "rig_credential_hook" &&
    !rigSatisfies(input.responder.rig, {
      name: preflight.requiredRig?.name ?? "",
      credentialHookIds: [route.credentialHookId],
    })
  ) {
    return blocked("incident_responder_under_capable");
  }

  if (!seriesMetadataSatisfies(preflight.dataSource)) {
    return blocked("incident_data_source_unsuitable");
  }
  if (!alertSelectorsSatisfy(preflight.dataSource, input.alertOccurrenceLabels)) {
    return blocked("incident_data_source_unsuitable");
  }
  return { action: "ready" };
}

export function incidentTelemetryAuthorityFence(
  responder: IncidentTelemetryResponderMetadata,
): IncidentTelemetryAuthorityFence | null {
  if (responder.toolPolicyVersion === null) return null;
  const normalized = {
    metadataComplete: responder.metadataComplete,
    resources: [...responder.resources].map((resource) => stableJson(resource)).sort(),
    mcpServerIds: [...responder.mcpServerIds].sort(),
    firstPartyMcpTools: [...responder.firstPartyMcpTools].sort(),
    firstPartyMcpPermissions: [...responder.firstPartyMcpPermissions].sort(),
    rig: responder.rig
      ? {
          name: responder.rig.name,
          credentialHooks: [...responder.rig.credentialHooks].sort(),
          checkHealth: responder.rig.checkHealth,
        }
      : null,
    variableSets: [...responder.variableSets]
      .map((set) => ({
        name: set.name,
        variables: set.variables.map((variable) => variable.name).sort(),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
  return {
    version: 1,
    toolPolicyVersion: responder.toolPolicyVersion,
    responderDigest: createHash("sha256").update(stableJson(normalized)).digest("hex"),
  };
}

export function parseIncidentTelemetryAuthorityFence(
  lineage: Record<string, unknown>,
): IncidentTelemetryAuthorityFence | null {
  const raw = lineage[INCIDENT_TELEMETRY_AUTHORITY_FENCE_LINEAGE_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  return value.version === 1 &&
    typeof value.toolPolicyVersion === "number" &&
    Number.isInteger(value.toolPolicyVersion) &&
    value.toolPolicyVersion > 0 &&
    typeof value.responderDigest === "string" &&
    /^[0-9a-f]{64}$/.test(value.responderDigest)
    ? {
        version: 1,
        toolPolicyVersion: value.toolPolicyVersion,
        responderDigest: value.responderDigest,
      }
    : null;
}

function blocked(reason: IncidentTelemetryPreflightBlockReason): IncidentTelemetryPreflightResult {
  return { action: "blocked", reason };
}

function rigSatisfies(
  rig: IncidentTelemetryRigMetadata | null,
  required: { name: string; credentialHookIds: readonly string[] },
): boolean {
  if (!rig || rig.name !== required.name || rig.checkHealth !== "passing") {
    return false;
  }
  const hookIds = new Set(rig.credentialHooks);
  return required.credentialHookIds.every((hookId) => hookIds.has(hookId));
}

function seriesMetadataSatisfies(dataSource: IncidentTelemetryPreflight["dataSource"]): boolean {
  if (dataSource.queryPath !== "/api/v1/query" && dataSource.queryPath !== "/api/v1/query_range") {
    return false;
  }
  return dataSource.requiredSeries.every((required) =>
    dataSource.availableSeries.some((available) => {
      if (available.metric !== required.metric) return false;
      const labels = new Set(available.labels);
      return (
        labels.has(dataSource.workspaceLabel) && required.labels.every((label) => labels.has(label))
      );
    }),
  );
}

function alertSelectorsSatisfy(
  dataSource: IncidentTelemetryPreflight["dataSource"],
  occurrenceLabels: Readonly<Record<string, string>> | null,
): boolean {
  if (!occurrenceLabels) return false;
  return dataSource.alertSelectorLabels.every(
    (label) =>
      label !== dataSource.workspaceLabel &&
      typeof occurrenceLabels[label] === "string" &&
      occurrenceLabels[label]!.length > 0 &&
      dataSource.requiredSeries.every((series) => series.labels.includes(label)) &&
      dataSource.availableSeries.some(
        (series) =>
          dataSource.requiredSeries.some((required) => required.metric === series.metric) &&
          series.labels.includes(dataSource.workspaceLabel) &&
          series.labels.includes(label),
      ),
  );
}
