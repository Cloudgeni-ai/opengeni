import { describe, expect, test } from "bun:test";
import { IncidentTelemetryPreflight, ScheduledTask, ScheduledTaskAgentConfig } from "../src";

const repository = {
  kind: "repository" as const,
  uri: "https://github.com/Cloudgeni-ai/opengeni",
  ref: "main",
  provider: "github" as const,
  credentialBindingId: "github-installation:123",
  access: "read" as const,
};

const preflight = {
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
};

describe("scheduled incident telemetry contract", () => {
  test("requires the exact scheduled-task execution digest", () => {
    const task = {
      id: crypto.randomUUID(),
      accountId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      name: "digest-bound task",
      status: "active",
      schedule: { type: "manual" },
      temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      agentConfig: { prompt: "bound", resources: [], tools: [], metadata: {} },
      authorityRevision: 2,
      executionDigest: "a".repeat(64),
      reusableSessionId: null,
      metadata: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    expect(ScheduledTask.parse(task)).toMatchObject({
      authorityRevision: 2,
      executionDigest: "a".repeat(64),
    });
    expect(ScheduledTask.safeParse({ ...task, executionDigest: "A".repeat(64) }).success).toBe(
      false,
    );
  });

  test("keeps ordinary scheduled task agent config unchanged", () => {
    expect(
      ScheduledTaskAgentConfig.parse({
        prompt: "ordinary maintenance",
        resources: [],
        tools: [],
        metadata: {},
      }),
    ).toEqual({
      prompt: "ordinary maintenance",
      resources: [],
      tools: [],
      metadata: {},
    });
  });

  test("requires the preflight declaration exactly for incident telemetry tasks", () => {
    expect(
      ScheduledTaskAgentConfig.safeParse({
        prompt: "investigate alert",
        resources: [repository],
        tools: [{ kind: "mcp", id: "cloud-observability" }],
        metadata: {},
        executionClass: "incident_telemetry",
      }).success,
    ).toBe(false);

    expect(
      ScheduledTaskAgentConfig.safeParse({
        prompt: "ordinary maintenance",
        resources: [],
        tools: [],
        metadata: {},
        incidentTelemetryPreflight: preflight,
      }).success,
    ).toBe(false);

    expect(
      ScheduledTaskAgentConfig.parse({
        prompt: "investigate alert",
        resources: [repository],
        tools: [{ kind: "mcp", id: "cloud-observability" }],
        metadata: {},
        executionClass: "incident_telemetry",
        incidentTelemetryPreflight: preflight,
      }),
    ).toMatchObject({
      executionClass: "incident_telemetry",
      incidentTelemetryPreflight: preflight,
    });
  });

  test("limits Prometheus retrieval to targeted query endpoints with nonempty label metadata", () => {
    expect(IncidentTelemetryPreflight.safeParse(preflight).success).toBe(true);
    expect(
      IncidentTelemetryPreflight.safeParse({
        ...preflight,
        dataSource: { ...preflight.dataSource, queryPath: "/metrics" },
      }).success,
    ).toBe(false);
    expect(
      IncidentTelemetryPreflight.safeParse({
        ...preflight,
        dataSource: {
          ...preflight.dataSource,
          requiredSeries: [{ metric: "opengeni_turn_worker_rss_bytes", labels: [] }],
        },
      }).success,
    ).toBe(false);
    expect(
      IncidentTelemetryPreflight.safeParse({
        ...preflight,
        dataSource: {
          ...preflight.dataSource,
          alertSelectorLabels: ["workspace_id"],
        },
      }).success,
    ).toBe(false);
    expect(
      IncidentTelemetryPreflight.safeParse({
        ...preflight,
        dataSource: {
          ...preflight.dataSource,
          requiredSeries: [
            { metric: "opengeni_turn_worker_rss_bytes", labels: ["workspace_id", "pod"] },
          ],
        },
      }).success,
    ).toBe(false);
  });
});
