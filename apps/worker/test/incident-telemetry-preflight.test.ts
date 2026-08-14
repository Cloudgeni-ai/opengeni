import { describe, expect, test } from "bun:test";
import type {
  FirstPartyMcpToolName,
  Rig,
  ScheduledTaskAgentConfig,
  VariableSet,
} from "@opengeni/contracts";
import { evaluateIncidentTelemetryPreflight } from "../src/activities/incident-telemetry-preflight";

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
        route: {
          kind: "variable_set",
          variableSetName: "incident-production",
          variableNames: ["PROMETHEUS_URL", "PROMETHEUS_TOKEN"],
        },
        requiredSeries: [
          {
            metric: "opengeni_turn_worker_rss_bytes",
            labels: ["workspace_id", "pod"],
          },
        ],
        availableSeries: [
          {
            metric: "opengeni_turn_worker_rss_bytes",
            labels: ["workspace_id", "pod", "region"],
          },
        ],
      },
    },
  };
}

const rig: Rig = {
  id: "00000000-0000-4000-8000-000000000010",
  accountId: "00000000-0000-4000-8000-000000000011",
  workspaceId: "00000000-0000-4000-8000-000000000012",
  name: "incident-response",
  description: null,
  createdBy: null,
  activeVersion: {
    id: "00000000-0000-4000-8000-000000000013",
    rigId: "00000000-0000-4000-8000-000000000010",
    version: 1,
    image: null,
    setupScript: null,
    checks: [],
    credentialHooks: ["azure-monitor"],
    defaultVariableSetIds: [],
    changelog: null,
    providerImages: {},
    createdBy: null,
    active: true,
    createdAt: new Date(0).toISOString(),
  },
  activeVersionHealth: {
    checkHealth: "passing",
    lastVerifiedAt: new Date(0).toISOString(),
  },
  versionCount: 1,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

const variableSets: VariableSet[] = [
  {
    id: "00000000-0000-4000-8000-000000000020",
    accountId: rig.accountId,
    workspaceId: rig.workspaceId,
    name: "incident-production",
    description: null,
    variables: ["PROMETHEUS_TOKEN", "PROMETHEUS_URL"].map((name) => ({
      name,
      version: 1,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    })),
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  },
];

const firstPartyTools: FirstPartyMcpToolName[] = ["github_repositories_list"];

function evaluate(
  agentConfig: ScheduledTaskAgentConfig,
  overrides: Partial<{
    firstPartyMcpTools: FirstPartyMcpToolName[];
    rig: Rig | null;
    variableSets: VariableSet[];
  }> = {},
) {
  return evaluateIncidentTelemetryPreflight({
    agentConfig,
    firstPartyMcpTools: overrides.firstPartyMcpTools ?? firstPartyTools,
    rig: overrides.rig === undefined ? rig : overrides.rig,
    variableSets: overrides.variableSets ?? variableSets,
  });
}

describe("incident telemetry dispatch preflight", () => {
  test("does not affect ordinary scheduled tasks", () => {
    expect(evaluate({ prompt: "ordinary task", resources: [], tools: [], metadata: {} })).toEqual({
      action: "not_required",
    });
  });

  test("fails closed when incident metadata is missing or malformed", () => {
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

  test("blocks an under-capable responder before retrieval", () => {
    const config = incidentConfig();
    config.tools = [];
    expect(evaluate(config, { rig: null, variableSets: [] })).toEqual({
      action: "blocked",
      reason: "incident_responder_under_capable",
    });
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
  });

  test("allows a capable responder with the exact selected authority and data metadata", () => {
    expect(evaluate(incidentConfig())).toEqual({ action: "ready" });
  });

  test("returns fixed blockers without secret, endpoint, repository, or identity leakage", () => {
    const blocked = evaluate(incidentConfig(), { variableSets: [] });
    const rendered = JSON.stringify(blocked);
    expect(rendered).toBe('{"action":"blocked","reason":"incident_responder_under_capable"}');
    for (const privateFact of [
      "PROMETHEUS_TOKEN",
      "PROMETHEUS_URL",
      repository.uri,
      variableSets[0]!.id,
      rig.workspaceId,
    ]) {
      expect(rendered).not.toContain(privateFact);
    }
  });
});
