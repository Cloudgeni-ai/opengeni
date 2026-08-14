import { describe, expect, test } from "bun:test";
import {
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  type FirstPartyMcpToolName,
  type Permission,
  type ScheduledTaskAgentConfig,
} from "@opengeni/contracts";
import {
  evaluateIncidentTelemetryPreflight,
  incidentTelemetryPreflightDeclaration,
  type IncidentTelemetryResponderMetadata,
} from "../src/activities/incident-telemetry-preflight";

const repository = {
  kind: "repository" as const,
  uri: "https://github.com/Cloudgeni-ai/opengeni",
  ref: "main",
  provider: "github" as const,
  credentialBindingId: "github-installation:123",
  access: "read" as const,
};

function incidentConfig(): ScheduledTaskAgentConfig {
  return {
    prompt: "investigate alert",
    resources: [repository],
    tools: [{ kind: "mcp", id: "cloud-observability" }],
    metadata: {},
    executionClass: "incident_telemetry",
    incidentTelemetryPreflight: {
      requiredResources: [repository],
      requiredMcpServerIds: ["cloud-observability"],
      requiredFirstPartyMcpTools: ["github_repositories_list"],
      requiredFirstPartyMcpPermissions: ["github:use"],
      requiredRig: {
        name: "incident-response",
        credentialHookIds: ["azure-monitor"],
      },
      requiredVariableSetNames: ["incident-production"],
      requiredVariableNames: ["PROMETHEUS_URL", "PROMETHEUS_TOKEN"],
      dataSource: {
        kind: "prometheus",
        queryPath: "/api/v1/query_range",
        workspaceLabel: "workspace_id",
        alertSelectorLabels: ["alertname"],
        route: {
          kind: "variable_set",
          variableSetName: "incident-production",
          variableNames: ["PROMETHEUS_URL", "PROMETHEUS_TOKEN"],
        },
        requiredSeries: [
          {
            metric: "opengeni_turn_worker_rss_bytes",
            labels: ["workspace_id", "alertname", "pod"],
          },
        ],
        availableSeries: [
          {
            metric: "opengeni_turn_worker_rss_bytes",
            labels: ["workspace_id", "alertname", "pod", "region"],
          },
        ],
      },
    },
  };
}

const firstPartyTools: FirstPartyMcpToolName[] = ["github_repositories_list"];
const firstPartyPermissions: Permission[] = [...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS];

function responder(
  overrides: Partial<IncidentTelemetryResponderMetadata> = {},
): IncidentTelemetryResponderMetadata {
  return {
    metadataComplete: true,
    resources: [repository],
    mcpServerIds: ["cloud-observability", "opengeni"],
    firstPartyMcpTools: firstPartyTools,
    firstPartyMcpPermissions: firstPartyPermissions,
    rig: {
      name: "incident-response",
      credentialHooks: ["azure-monitor"],
      checkHealth: "passing",
    },
    variableSets: [
      {
        name: "incident-production",
        variables: [{ name: "PROMETHEUS_TOKEN" }, { name: "PROMETHEUS_URL" }],
      },
    ],
    toolPolicyVersion: 1,
    ...overrides,
  };
}

function evaluate(
  agentConfig: ScheduledTaskAgentConfig,
  overrides: Partial<IncidentTelemetryResponderMetadata> = {},
  incidentTriggered = false,
  alertOccurrenceLabels: Readonly<Record<string, string>> | null = {
    alertname: "OpenGeniTurnWorkerMemoryConsumesReserve",
  },
) {
  return evaluateIncidentTelemetryPreflight({
    agentConfig,
    incidentTriggered,
    alertOccurrenceLabels,
    responder: responder(overrides),
  });
}

describe("incident telemetry dispatch preflight", () => {
  test("does not affect ordinary or malformed non-alert scheduled tasks", () => {
    const ordinary = { prompt: "ordinary task", resources: [], tools: [], metadata: {} };
    expect(evaluate(ordinary, {}, false, null)).toEqual({ action: "not_required" });
    expect(incidentTelemetryPreflightDeclaration(ordinary, false)).toEqual({
      action: "not_required",
    });
  });

  test("fails closed for a valid legacy alert or incomplete incident declaration", () => {
    const legacy = { prompt: "legacy alert", resources: [], tools: [], metadata: {} };
    expect(evaluate(legacy, {}, true)).toEqual({
      action: "blocked",
      reason: "incident_preflight_metadata_missing",
    });
    expect(
      evaluate({
        prompt: "incident",
        resources: [],
        tools: [],
        metadata: {},
        executionClass: "incident_telemetry",
      } as ScheduledTaskAgentConfig),
    ).toEqual({ action: "blocked", reason: "incident_preflight_metadata_missing" });
  });

  test("blocks incomplete exact metadata and every missing authority dimension", () => {
    const config = incidentConfig();
    for (const missing of [
      { metadataComplete: false },
      { resources: [] },
      { mcpServerIds: ["opengeni"] },
      { firstPartyMcpTools: [] },
      { firstPartyMcpPermissions: [] },
      { rig: null },
      { variableSets: [] },
    ] satisfies Array<Partial<IncidentTelemetryResponderMetadata>>) {
      expect(evaluate(config, missing)).toEqual({
        action: "blocked",
        reason:
          missing.metadataComplete === false
            ? "incident_preflight_metadata_missing"
            : "incident_responder_under_capable",
      });
    }
  });

  test("requires passing health for the exact selected rig version", () => {
    for (const checkHealth of ["unknown", "failing"] as const) {
      expect(
        evaluate(incidentConfig(), {
          rig: {
            name: "incident-response",
            credentialHooks: ["azure-monitor"],
            checkHealth,
          },
        }),
      ).toEqual({ action: "blocked", reason: "incident_responder_under_capable" });
    }
  });

  test("blocks public exposition endpoints and absent alert-series labels", () => {
    const publicMetrics = incidentConfig() as ScheduledTaskAgentConfig & {
      incidentTelemetryPreflight: { dataSource: { queryPath: string } };
    };
    publicMetrics.incidentTelemetryPreflight.dataSource.queryPath = "/metrics";
    expect(evaluate(publicMetrics)).toEqual({
      action: "blocked",
      reason: "incident_data_source_unsuitable",
    });

    const missingLabels = incidentConfig();
    missingLabels.incidentTelemetryPreflight!.dataSource.availableSeries[0]!.labels = [
      "workspace_id",
    ];
    expect(evaluate(missingLabels)).toEqual({
      action: "blocked",
      reason: "incident_data_source_unsuitable",
    });

    const mismatchedSelector = incidentConfig();
    mismatchedSelector.incidentTelemetryPreflight!.dataSource.alertSelectorLabels = ["service"];
    mismatchedSelector.incidentTelemetryPreflight!.dataSource.requiredSeries[0]!.labels.push(
      "service",
    );
    mismatchedSelector.incidentTelemetryPreflight!.dataSource.availableSeries[0]!.labels.push(
      "service",
    );
    expect(evaluate(mismatchedSelector)).toEqual({
      action: "blocked",
      reason: "incident_data_source_unsuitable",
    });

    expect(evaluate(incidentConfig(), {}, false, null)).toEqual({
      action: "blocked",
      reason: "incident_data_source_unsuitable",
    });
  });

  test("uses the resolved responder, not task declarations, for all four run modes", () => {
    for (const mode of [
      "new_session_per_run",
      "reusable_session:new",
      "existing_session",
      "reusable_session:existing",
    ]) {
      expect(evaluate(incidentConfig()), mode).toEqual({ action: "ready" });
      expect(evaluate(incidentConfig(), { resources: [] }), mode).toEqual({
        action: "blocked",
        reason: "incident_responder_under_capable",
      });
    }
  });

  test("returns fixed blockers without secret, endpoint, repository, or identity leakage", () => {
    const blocked = evaluate(incidentConfig(), { variableSets: [] });
    const rendered = JSON.stringify(blocked);
    expect(rendered).toBe('{"action":"blocked","reason":"incident_responder_under_capable"}');
    for (const privateFact of [
      "PROMETHEUS_TOKEN",
      "PROMETHEUS_URL",
      repository.uri,
      "github-installation:123",
      "azure-monitor",
    ]) {
      expect(rendered).not.toContain(privateFact);
    }
  });

  test("is ordered before authority, admission, run/session creation and exposes no retrieval primitive", async () => {
    const dispatchSource = await Bun.file(
      new URL("../src/activities/scheduled-tasks.ts", import.meta.url),
    ).text();
    const evaluatorSource = await Bun.file(
      new URL("../src/activities/incident-telemetry-preflight.ts", import.meta.url),
    ).text();
    const preflight = dispatchSource.indexOf("incidentTelemetryPreflightDeclaration(");
    expect(preflight).toBeGreaterThan(0);
    for (const downstream of [
      "getScheduledTaskPersonalConnectionDelegations(",
      "getScheduledTaskXaiProviderAccountAuthoritySnapshot(",
      "agentRunAdmissionDenial(",
      "createScheduledTaskRun(",
      "createSessionWithIdempotencyKeyResult(",
    ]) {
      expect(dispatchSource.indexOf(downstream, preflight)).toBeGreaterThan(preflight);
    }
    expect(evaluatorSource).not.toContain("fetch(");
    expect(evaluatorSource).not.toContain("process.env");
    expect(evaluatorSource).not.toContain("getVariableSetValue");
  });
});
