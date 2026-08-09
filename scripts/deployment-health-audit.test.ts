import { describe, expect, test } from "bun:test";

import {
  auditDeploymentHealth,
  parseDeploymentHealthAuditArgs,
  type DeploymentHealthAuditArgs,
  type DeploymentHealthAuditDependencies,
  type DeploymentHealthCommandResult,
} from "./deployment-health-audit";

const NOW = new Date("2026-08-05T12:00:00.000Z");
const REVISION = "1111111111111111111111111111111111111111";
const UPSTREAM = "2222222222222222222222222222222222222222";

describe("deployment health audit", () => {
  test("reports a healthy pinned deployment even when upstream is newer", () => {
    const result = auditDeploymentHealth(args({ upstreamRevision: UPSTREAM }), healthyDeps());

    expect(result.status).toBe("healthy");
    expect(result.exitCode).toBe(0);
    expect(result.deployment.observedRevisions).toEqual([REVISION]);
    expect(result.deployment.upstreamLagPolicy).toBe("informational");
    expect(result.checks.find((check) => check.id === "deployment-revision")).toMatchObject({
      status: "passed",
      remediationClass: "none",
    });
  });

  test("reports recent restarts and warnings as degraded without inventing an incident", () => {
    const deps = healthyDeps({
      pods: podList({ restartCount: 1, finishedAt: "2026-08-05T11:45:00.000Z" }),
      events: warningEventList("2026-08-05T11:50:00.000Z"),
    });
    const result = auditDeploymentHealth(args(), deps);

    expect(result.status).toBe("degraded");
    expect(result.exitCode).toBe(1);
    expect(result.checks.find((check) => check.id === "kubernetes-pods")?.status).toBe("degraded");
    expect(result.checks.find((check) => check.id === "kubernetes-warning-events")?.status).toBe(
      "degraded",
    );
  });

  test("reports unavailable workloads and revision skew as an incident", () => {
    const deps = healthyDeps({
      workloads: workloadList({ available: false }),
      workerTurnsHealth: healthPayload("3333333333333333333333333333333333333333", {
        role: "turn",
        state: "ready",
      }),
    });
    const result = auditDeploymentHealth(args(), deps);

    expect(result.status).toBe("incident");
    expect(result.exitCode).toBe(2);
    expect(result.checks.find((check) => check.id === "kubernetes-workloads")?.status).toBe(
      "failed",
    );
    expect(result.checks.find((check) => check.id === "deployment-revision")).toMatchObject({
      status: "failed",
      remediationClass: "rollback_candidate",
    });
  });

  test("fails declarative revision drift closed", () => {
    const result = auditDeploymentHealth(
      args({ expectedRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }),
      healthyDeps(),
    );

    expect(result.status).toBe("incident");
    expect(result.checks.find((check) => check.id === "deployment-revision")).toMatchObject({
      status: "failed",
      remediationClass: "reconcile_declarative",
    });
  });

  test("classifies malformed inventory as an audit error and never copies command stderr", () => {
    const deps = healthyDeps({
      overrides: new Map([
        [
          commandKey(["kubectl", "get", "nodes", "-o", "json"]),
          {
            exitCode: 1,
            stdout: "",
            stderr: "Bearer secret-token https://user:password@example.invalid/private",
          },
        ],
      ]),
    });
    const result = auditDeploymentHealth(args(), deps);
    const serialized = JSON.stringify(result);

    expect(result.status).toBe("audit_error");
    expect(result.exitCode).toBe(3);
    expect(serialized).not.toContain("secret-token");
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("example.invalid");
  });

  test("drops credential-shaped or unbounded service facts", () => {
    const result = auditDeploymentHealth(
      args(),
      healthyDeps({
        workerTurnsHealth: JSON.stringify({
          ok: true,
          deploymentRevision: "Bearer secret-token",
          state: "private value",
          role: "turn",
        }),
      }),
    );
    const serialized = JSON.stringify(result);

    expect(result.status).toBe("healthy");
    expect(result.deployment.observedRevisions).toEqual([REVISION]);
    expect(serialized).not.toContain("secret-token");
    expect(serialized).not.toContain("private value");
  });

  test("composes the canonical observability verifier only when requested", () => {
    const result = auditDeploymentHealth(
      args({ verifyObservability: true }),
      healthyDeps({ verifyObservability: true }),
    );

    expect(result.status).toBe("healthy");
    expect(result.checks.find((check) => check.id === "observability-verification")).toMatchObject({
      status: "passed",
    });
  });

  test("bounds repeated evidence while preserving total counts", () => {
    const result = auditDeploymentHealth(args(), healthyDeps({ pods: unavailablePodList(25) }));
    const facts = result.checks.find((check) => check.id === "kubernetes-pods")?.facts;

    expect(result.status).toBe("incident");
    expect(facts?.unavailablePodCount).toBe(25);
    expect(facts?.unavailablePods).toHaveLength(20);
  });
});

describe("deployment health audit arguments", () => {
  test("parses bounded operator inputs", () => {
    expect(
      parseDeploymentHealthAuditArgs([
        "--namespace=team-a",
        "--release",
        "geni-a",
        "--expected-revision",
        REVISION,
        "--upstream-revision",
        UPSTREAM,
        "--restart-window-seconds=900",
        "--warning-window-seconds",
        "1200",
        "--verify-observability",
      ]),
    ).toMatchObject({
      namespace: "team-a",
      release: "geni-a",
      expectedRevision: REVISION,
      upstreamRevision: UPSTREAM,
      restartWindowSeconds: 900,
      warningWindowSeconds: 1200,
      verifyObservability: true,
    });
  });

  test("rejects unsafe identifiers and invalid windows", () => {
    expect(() => parseDeploymentHealthAuditArgs(["--namespace", "../../secret"])).toThrow();
    expect(() => parseDeploymentHealthAuditArgs(["--restart-window-seconds", "0"])).toThrow();
  });
});

function args(overrides: Partial<DeploymentHealthAuditArgs> = {}): DeploymentHealthAuditArgs {
  return {
    namespace: "opengeni",
    release: "opengeni",
    expectedRevision: REVISION,
    restartWindowSeconds: 3_600,
    warningWindowSeconds: 3_600,
    verifyObservability: false,
    observabilityNamespace: "observability",
    observabilityRelease: "opengeni-observability",
    ...overrides,
  };
}

function healthyDeps(
  options: {
    pods?: unknown;
    workloads?: unknown;
    events?: unknown;
    workerTurnsHealth?: string;
    verifyObservability?: boolean;
    overrides?: Map<string, DeploymentHealthCommandResult>;
  } = {},
): DeploymentHealthAuditDependencies {
  const fixtures = new Map<string, DeploymentHealthCommandResult>([
    [commandKey(["kubectl", "get", "nodes", "-o", "json"]), ok(nodeList())],
    [
      commandKey([
        "kubectl",
        "-n",
        "opengeni",
        "get",
        "deployments,statefulsets,daemonsets",
        "-l",
        "app.kubernetes.io/instance=opengeni",
        "-o",
        "json",
      ]),
      ok(options.workloads ?? workloadList()),
    ],
    [
      commandKey([
        "kubectl",
        "-n",
        "opengeni",
        "get",
        "pods",
        "-l",
        "app.kubernetes.io/instance=opengeni",
        "-o",
        "json",
      ]),
      ok(options.pods ?? podList()),
    ],
    [
      commandKey([
        "helm",
        "list",
        "--namespace",
        "opengeni",
        "--filter",
        "^opengeni$",
        "--output",
        "json",
      ]),
      ok([{ name: "opengeni", status: "deployed", revision: "48", chart: "opengeni-1" }]),
    ],
    [
      commandKey([
        "kubectl",
        "-n",
        "opengeni",
        "get",
        "pvc",
        "-l",
        "app.kubernetes.io/instance=opengeni",
        "-o",
        "json",
      ]),
      ok({ items: [{ metadata: { name: "data" }, status: { phase: "Bound" } }] }),
    ],
    [
      commandKey([
        "kubectl",
        "-n",
        "opengeni",
        "get",
        "events",
        "--field-selector",
        "type=Warning",
        "-o",
        "json",
      ]),
      ok(options.events ?? { items: [] }),
    ],
  ]);

  for (const [id, service, port, path, payload] of [
    ["api-health", "opengeni-api", 8_000, "healthz", healthPayload(REVISION)],
    ["api-readiness", "opengeni-api", 8_000, "readyz", JSON.stringify({ ok: true })],
    [
      "api-traffic-readiness",
      "opengeni-api",
      8_000,
      "traffic-readyz",
      JSON.stringify({ ok: true }),
    ],
    [
      "worker-control-health",
      "opengeni-worker-control",
      8_001,
      "healthz",
      healthPayload(REVISION, { role: "control", state: "ready" }),
    ],
    [
      "worker-control-readiness",
      "opengeni-worker-control",
      8_001,
      "readyz",
      JSON.stringify({ ok: true, state: "ready" }),
    ],
    [
      "worker-turns-health",
      "opengeni-worker-turns",
      8_001,
      "healthz",
      options.workerTurnsHealth ?? healthPayload(REVISION, { role: "turn", state: "ready" }),
    ],
    [
      "worker-turns-readiness",
      "opengeni-worker-turns",
      8_001,
      "readyz",
      JSON.stringify({ ok: true, state: "ready" }),
    ],
  ] as const) {
    void id;
    fixtures.set(
      commandKey([
        "kubectl",
        "get",
        "--raw",
        `/api/v1/namespaces/opengeni/services/http:${service}:${port}/proxy/${path}`,
      ]),
      { exitCode: 0, stdout: payload, stderr: "" },
    );
  }
  fixtures.set(
    commandKey([
      "kubectl",
      "get",
      "--raw",
      "/api/v1/namespaces/opengeni/services/http:opengeni-relay:8443/proxy/healthz",
    ]),
    { exitCode: 0, stdout: "ok\n", stderr: "" },
  );
  if (options.verifyObservability) {
    fixtures.set(
      commandKey([
        "bun",
        "scripts/verify-observability-stack.ts",
        "--namespace",
        "observability",
        "--release",
        "opengeni-observability",
        "--app-namespace",
        "opengeni",
        "--source-revision",
        REVISION,
      ]),
      { exitCode: 0, stdout: JSON.stringify({ ok: true }), stderr: "" },
    );
  }
  for (const [key, value] of options.overrides ?? []) fixtures.set(key, value);

  return {
    now: () => NOW,
    bunExecutable: "bun",
    run(command) {
      const fixture = fixtures.get(commandKey(command));
      if (!fixture) throw new Error(`missing fixture: ${commandKey(command)}`);
      return fixture;
    },
  };
}

function nodeList(): unknown {
  return {
    items: [
      {
        metadata: { name: "node-a" },
        status: { conditions: [{ type: "Ready", status: "True" }] },
      },
    ],
  };
}

function workloadList(options: { available?: boolean } = {}): unknown {
  const available = options.available ?? true;
  return {
    items: [
      {
        kind: "Deployment",
        metadata: { name: "opengeni-api", generation: 1 },
        spec: { replicas: 1 },
        status: {
          availableReplicas: available ? 1 : 0,
          updatedReplicas: available ? 1 : 0,
          observedGeneration: 1,
        },
      },
      {
        kind: "StatefulSet",
        metadata: { name: "opengeni-postgres", generation: 1 },
        spec: { replicas: 1 },
        status: { readyReplicas: 1 },
      },
    ],
  };
}

function podList(options: { restartCount?: number; finishedAt?: string } = {}): unknown {
  return {
    items: [
      {
        metadata: { name: "opengeni-api-1" },
        status: {
          phase: "Running",
          conditions: [{ type: "Ready", status: "True" }],
          containerStatuses: [
            {
              name: "api",
              restartCount: options.restartCount ?? 0,
              lastState: options.finishedAt
                ? { terminated: { finishedAt: options.finishedAt } }
                : {},
            },
          ],
        },
      },
    ],
  };
}

function unavailablePodList(count: number): unknown {
  return {
    items: Array.from({ length: count }, (_, index) => ({
      metadata: { name: `opengeni-api-${index}` },
      status: {
        phase: "Pending",
        conditions: [{ type: "Ready", status: "False" }],
        containerStatuses: [],
      },
    })),
  };
}

function warningEventList(lastTimestamp: string): unknown {
  return {
    items: [
      {
        reason: "Unhealthy",
        lastTimestamp,
        involvedObject: { kind: "Pod", name: "opengeni-api-1" },
      },
    ],
  };
}

function healthPayload(revision: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ok: true, deploymentRevision: revision, ...extra });
}

function ok(value: unknown): DeploymentHealthCommandResult {
  return { exitCode: 0, stdout: JSON.stringify(value), stderr: "" };
}

function commandKey(command: string[]): string {
  return JSON.stringify(command);
}
