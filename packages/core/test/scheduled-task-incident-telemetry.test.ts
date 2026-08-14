import { describe, expect, test } from "bun:test";
import type { ScheduledTaskAgentConfig } from "@opengeni/contracts";
import { validateIncidentTelemetryPreflightSelection } from "../src/domain/scheduled-tasks";

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
      requiredRig: null,
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
            labels: ["workspace_id", "pod"],
          },
        ],
      },
    },
  };
}

describe("scheduled incident telemetry static selection", () => {
  test("leaves ordinary tasks unchanged", () => {
    expect(() =>
      validateIncidentTelemetryPreflightSelection(
        {},
        {
          prompt: "ordinary task",
          resources: [],
          tools: [],
          metadata: {},
        },
      ),
    ).not.toThrow();
  });

  test("accepts only requirements already present in the selected resources and tool policy", () => {
    expect(() => validateIncidentTelemetryPreflightSelection({}, incidentConfig())).not.toThrow();

    const missingRepository = incidentConfig();
    missingRepository.resources = [];
    expect(() => validateIncidentTelemetryPreflightSelection({}, missingRepository)).toThrow(
      /requiredResources/,
    );

    const missingMcp = incidentConfig();
    missingMcp.tools = [];
    expect(() => validateIncidentTelemetryPreflightSelection({}, missingMcp)).toThrow(
      /requiredMcpServerIds/,
    );

    expect(() =>
      validateIncidentTelemetryPreflightSelection(
        { defaultFirstPartyMcpTools: [] },
        incidentConfig(),
      ),
    ).toThrow(/requiredFirstPartyMcpTools/);
  });

  test("requires the declared data route to be part of the exact selected authority", () => {
    const config = incidentConfig();
    config.incidentTelemetryPreflight!.dataSource.route = {
      kind: "mcp",
      serverId: "missing-observability",
    };
    expect(() => validateIncidentTelemetryPreflightSelection({}, config)).toThrow(
      /dataSource\.route/,
    );
  });
});
