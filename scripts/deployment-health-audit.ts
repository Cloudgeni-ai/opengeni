export type DeploymentHealthStatus = "healthy" | "degraded" | "incident" | "audit_error";

export type DeploymentHealthCheckStatus = "passed" | "degraded" | "failed" | "error" | "skipped";

export type DeploymentHealthRemediationClass =
  | "none"
  | "observe"
  | "retry_read_only"
  | "reconcile_declarative"
  | "rollback_candidate"
  | "operator_required";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface DeploymentHealthCheck {
  id: string;
  status: DeploymentHealthCheckStatus;
  remediationClass: DeploymentHealthRemediationClass;
  summary: string;
  facts?: Record<string, JsonValue>;
}

export interface DeploymentHealthAuditResult {
  schemaVersion: "opengeni.deployment-health-audit.v1";
  observedAt: string;
  status: DeploymentHealthStatus;
  ok: boolean;
  exitCode: 0 | 1 | 2 | 3;
  deployment: {
    namespace: string;
    release: string;
    expectedRevision?: string;
    upstreamRevision?: string;
    observedRevisions: string[];
    upstreamLagPolicy: "informational";
  };
  checks: DeploymentHealthCheck[];
}

export interface DeploymentHealthAuditArgs {
  namespace: string;
  release: string;
  expectedRevision?: string;
  upstreamRevision?: string;
  restartWindowSeconds: number;
  warningWindowSeconds: number;
  verifyObservability: boolean;
  observabilityNamespace: string;
  observabilityRelease: string;
}

export interface DeploymentHealthCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface DeploymentHealthAuditDependencies {
  run(command: string[]): DeploymentHealthCommandResult;
  now(): Date;
  bunExecutable?: string;
}

interface CommandFailure {
  command: string[];
  exitCode: number;
}

const DEFAULT_ARGS: DeploymentHealthAuditArgs = {
  namespace: "opengeni",
  release: "opengeni",
  restartWindowSeconds: 3_600,
  warningWindowSeconds: 3_600,
  verifyObservability: false,
  observabilityNamespace: "observability",
  observabilityRelease: "opengeni-observability",
};

const HEALTH_AUDIT_EXIT_CODES = {
  healthy: 0,
  degraded: 1,
  incident: 2,
  audit_error: 3,
} as const;

const MAX_FACT_ITEMS = 20;
const MAX_FACT_STRING_BYTES = 256;
const SAFE_FACT_STRING = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/;

const defaultDependencies: DeploymentHealthAuditDependencies = {
  run(command) {
    const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  },
  now: () => new Date(),
  bunExecutable: "bun",
};

export function parseDeploymentHealthAuditArgs(values: string[]): DeploymentHealthAuditArgs {
  const out: DeploymentHealthAuditArgs = { ...DEFAULT_ARGS };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--verify-observability") {
      out.verifyObservability = true;
      continue;
    }
    const [key, inline] = value.split("=", 2);
    const next = inline ?? values[index + 1];
    if (
      ![
        "--namespace",
        "--release",
        "--expected-revision",
        "--upstream-revision",
        "--restart-window-seconds",
        "--warning-window-seconds",
        "--observability-namespace",
        "--observability-release",
      ].includes(key)
    ) {
      throw new Error(`unknown argument: ${value}`);
    }
    if (!next) throw new Error(`${key} requires a value`);
    if (inline === undefined) index += 1;
    if (key === "--namespace") out.namespace = boundedIdentifier(next, key);
    if (key === "--release") out.release = boundedIdentifier(next, key);
    if (key === "--expected-revision") out.expectedRevision = boundedRevision(next, key);
    if (key === "--upstream-revision") out.upstreamRevision = boundedRevision(next, key);
    if (key === "--restart-window-seconds") {
      out.restartWindowSeconds = positiveInteger(next, key);
    }
    if (key === "--warning-window-seconds") {
      out.warningWindowSeconds = positiveInteger(next, key);
    }
    if (key === "--observability-namespace") {
      out.observabilityNamespace = boundedIdentifier(next, key);
    }
    if (key === "--observability-release") {
      out.observabilityRelease = boundedIdentifier(next, key);
    }
  }
  return out;
}

export function auditDeploymentHealth(
  args: DeploymentHealthAuditArgs,
  dependencies: DeploymentHealthAuditDependencies = defaultDependencies,
): DeploymentHealthAuditResult {
  const checks: DeploymentHealthCheck[] = [];
  const observedRevisions = new Set<string>();
  const now = dependencies.now();

  inventoryCheck(
    checks,
    dependencies,
    "kubernetes-nodes",
    ["kubectl", "get", "nodes", "-o", "json"],
    (value) => evaluateNodes(value),
  );

  const selector = `app.kubernetes.io/instance=${args.release}`;
  inventoryCheck(
    checks,
    dependencies,
    "kubernetes-workloads",
    [
      "kubectl",
      "-n",
      args.namespace,
      "get",
      "deployments,statefulsets,daemonsets",
      "-l",
      selector,
      "-o",
      "json",
    ],
    (value) => evaluateWorkloads(value),
  );

  inventoryCheck(
    checks,
    dependencies,
    "kubernetes-pods",
    ["kubectl", "-n", args.namespace, "get", "pods", "-l", selector, "-o", "json"],
    (value) => evaluatePods(value, now, args.restartWindowSeconds),
  );

  inventoryCheck(
    checks,
    dependencies,
    "helm-release",
    [
      "helm",
      "list",
      "--namespace",
      args.namespace,
      "--filter",
      `^${escapeRegex(args.release)}$`,
      "--output",
      "json",
    ],
    (value) => evaluateHelmRelease(value, args.release),
  );

  inventoryCheck(
    checks,
    dependencies,
    "persistent-volume-claims",
    ["kubectl", "-n", args.namespace, "get", "pvc", "-l", selector, "-o", "json"],
    (value) => evaluatePersistentVolumeClaims(value),
  );

  inventoryCheck(
    checks,
    dependencies,
    "kubernetes-warning-events",
    [
      "kubectl",
      "-n",
      args.namespace,
      "get",
      "events",
      "--field-selector",
      "type=Warning",
      "-o",
      "json",
    ],
    (value) => evaluateWarningEvents(value, now, args.warningWindowSeconds),
  );

  const serviceChecks = [
    { id: "api-health", service: `${args.release}-api`, port: 8_000, path: "healthz" },
    { id: "api-readiness", service: `${args.release}-api`, port: 8_000, path: "readyz" },
    {
      id: "api-traffic-readiness",
      service: `${args.release}-api`,
      port: 8_000,
      path: "traffic-readyz",
    },
    {
      id: "worker-control-health",
      service: `${args.release}-worker-control`,
      port: 8_001,
      path: "healthz",
    },
    {
      id: "worker-control-readiness",
      service: `${args.release}-worker-control`,
      port: 8_001,
      path: "readyz",
    },
    {
      id: "worker-turns-health",
      service: `${args.release}-worker-turns`,
      port: 8_001,
      path: "healthz",
    },
    {
      id: "worker-turns-readiness",
      service: `${args.release}-worker-turns`,
      port: 8_001,
      path: "readyz",
    },
  ] as const;

  for (const service of serviceChecks) {
    const check = serviceProxyJsonCheck(args.namespace, service, dependencies);
    checks.push(check.check);
    if (check.revision) observedRevisions.add(check.revision);
  }

  checks.push(
    serviceProxyTextCheck(
      args.namespace,
      {
        id: "relay-health",
        service: `${args.release}-relay`,
        port: 8_443,
        path: "healthz",
        expected: "ok",
      },
      dependencies,
    ),
  );

  const revisionFacts: Record<string, JsonValue> = {
    observedRevisions: [...observedRevisions].sort(),
    upstreamLagPolicy: "informational",
  };
  if (args.expectedRevision) revisionFacts.expectedRevision = args.expectedRevision;
  if (args.upstreamRevision) revisionFacts.upstreamRevision = args.upstreamRevision;
  if (observedRevisions.size === 0) {
    checks.push(
      errorCheck(
        "deployment-revision",
        "No deployment revision could be read from API or worker health responses",
      ),
    );
  } else if (observedRevisions.size > 1) {
    checks.push({
      id: "deployment-revision",
      status: "failed",
      remediationClass: "rollback_candidate",
      summary: "API and worker workloads do not report one deployment revision",
      facts: revisionFacts,
    });
  } else {
    const observedRevision = [...observedRevisions][0];
    if (args.expectedRevision && observedRevision !== args.expectedRevision) {
      checks.push({
        id: "deployment-revision",
        status: "failed",
        remediationClass: "reconcile_declarative",
        summary: "The running deployment revision differs from the declared expected revision",
        facts: revisionFacts,
      });
    } else {
      checks.push({
        id: "deployment-revision",
        status: "passed",
        remediationClass: "none",
        summary:
          args.upstreamRevision && observedRevision !== args.upstreamRevision
            ? "The deployment is internally consistent and intentionally may lag upstream"
            : "The deployment revision is internally consistent",
        facts: revisionFacts,
      });
    }
  }

  if (args.verifyObservability) {
    const revision = args.expectedRevision ?? [...observedRevisions][0];
    if (!revision) {
      checks.push(
        errorCheck(
          "observability-verification",
          "Observability verification requires an expected or observed deployment revision",
        ),
      );
    } else {
      checks.push(observabilityVerificationCheck(args, revision, dependencies));
    }
  } else {
    checks.push({
      id: "observability-verification",
      status: "skipped",
      remediationClass: "observe",
      summary: "Full observability verification was not requested",
    });
  }

  const status = aggregateStatus(checks);
  return {
    schemaVersion: "opengeni.deployment-health-audit.v1",
    observedAt: now.toISOString(),
    status,
    ok: status === "healthy",
    exitCode: HEALTH_AUDIT_EXIT_CODES[status],
    deployment: {
      namespace: args.namespace,
      release: args.release,
      ...(args.expectedRevision ? { expectedRevision: args.expectedRevision } : {}),
      ...(args.upstreamRevision ? { upstreamRevision: args.upstreamRevision } : {}),
      observedRevisions: [...observedRevisions].sort(),
      upstreamLagPolicy: "informational",
    },
    checks,
  };
}

function inventoryCheck(
  checks: DeploymentHealthCheck[],
  dependencies: DeploymentHealthAuditDependencies,
  id: string,
  command: string[],
  evaluate: (value: unknown) => DeploymentHealthCheck,
): void {
  try {
    checks.push(evaluate(runJsonCommand(dependencies, command)));
  } catch (error) {
    checks.push(errorCheck(id, safeCommandFailureSummary(command, error)));
  }
}

function runJsonCommand(
  dependencies: DeploymentHealthAuditDependencies,
  command: string[],
): unknown {
  const result = dependencies.run(command);
  if (result.exitCode !== 0) {
    throw { command, exitCode: result.exitCode } satisfies CommandFailure;
  }
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    throw new Error("invalid-json");
  }
}

function evaluateNodes(value: unknown): DeploymentHealthCheck {
  const items = listItems(value);
  if (items.length === 0) {
    return failedCheck("kubernetes-nodes", "Kubernetes returned no nodes");
  }
  const unavailable = items.flatMap((item) => {
    const record = objectValue(item);
    const conditions = arrayValue(objectValue(record.status).conditions);
    const ready = conditions.find((condition) => objectValue(condition).type === "Ready");
    return objectValue(ready).status === "True"
      ? []
      : [stringValue(objectValue(record.metadata).name)];
  });
  return unavailable.length > 0
    ? failedCheck("kubernetes-nodes", "One or more Kubernetes nodes are not Ready", {
        unavailableNodeCount: unavailable.length,
        unavailableNodes: unavailable.slice(0, MAX_FACT_ITEMS),
        nodeCount: items.length,
      })
    : passedCheck("kubernetes-nodes", "All Kubernetes nodes are Ready", {
        nodeCount: items.length,
      });
}

function evaluateWorkloads(value: unknown): DeploymentHealthCheck {
  const items = listItems(value);
  if (items.length === 0) {
    return failedCheck(
      "kubernetes-workloads",
      "No workloads matched the OpenGeni release selector",
    );
  }
  const unavailable: string[] = [];
  for (const item of items) {
    const record = objectValue(item);
    const metadata = objectValue(record.metadata);
    const spec = objectValue(record.spec);
    const status = objectValue(record.status);
    const kind = stringValue(record.kind);
    const name = stringValue(metadata.name);
    const desired = numberValue(spec.replicas, 1);
    let ready = false;
    if (kind === "Deployment") {
      ready =
        numberValue(status.availableReplicas) >= desired &&
        numberValue(status.updatedReplicas) >= desired &&
        numberValue(status.observedGeneration) >= numberValue(metadata.generation);
    } else if (kind === "StatefulSet") {
      ready = numberValue(status.readyReplicas) >= desired;
    } else if (kind === "DaemonSet") {
      ready =
        numberValue(status.desiredNumberScheduled) > 0 &&
        numberValue(status.numberReady) >= numberValue(status.desiredNumberScheduled) &&
        numberValue(status.numberUnavailable) === 0;
    }
    if (!ready) unavailable.push(`${kind}/${name}`);
  }
  return unavailable.length > 0
    ? failedCheck("kubernetes-workloads", "One or more OpenGeni workloads are unavailable", {
        unavailableWorkloadCount: unavailable.length,
        unavailableWorkloads: unavailable.slice(0, MAX_FACT_ITEMS),
        workloadCount: items.length,
      })
    : passedCheck("kubernetes-workloads", "All selected OpenGeni workloads are available", {
        workloadCount: items.length,
      });
}

function evaluatePods(
  value: unknown,
  now: Date,
  restartWindowSeconds: number,
): DeploymentHealthCheck {
  const items = listItems(value);
  if (items.length === 0) {
    return failedCheck("kubernetes-pods", "No pods matched the OpenGeni release selector");
  }
  const unavailable: string[] = [];
  const recentRestarts: Array<{ pod: string; container: string; restartCount: number }> = [];
  for (const item of items) {
    const record = objectValue(item);
    const metadata = objectValue(record.metadata);
    const status = objectValue(record.status);
    const name = stringValue(metadata.name);
    const ready = arrayValue(status.conditions).some((condition) => {
      const entry = objectValue(condition);
      return entry.type === "Ready" && entry.status === "True";
    });
    if (status.phase !== "Running" || !ready || metadata.deletionTimestamp) {
      unavailable.push(name);
    }
    for (const container of arrayValue(status.containerStatuses)) {
      const entry = objectValue(container);
      const restartCount = numberValue(entry.restartCount);
      if (restartCount <= 0) continue;
      const finishedAt = stringValue(
        objectValue(objectValue(entry.lastState).terminated).finishedAt,
      );
      if (!finishedAt || withinWindow(finishedAt, now, restartWindowSeconds)) {
        recentRestarts.push({
          pod: name,
          container: stringValue(entry.name),
          restartCount,
        });
      }
    }
  }
  if (unavailable.length > 0) {
    return failedCheck("kubernetes-pods", "One or more OpenGeni pods are not ready", {
      unavailablePodCount: unavailable.length,
      unavailablePods: unavailable.slice(0, MAX_FACT_ITEMS),
      podCount: items.length,
      recentRestartCount: recentRestarts.length,
      recentRestarts: recentRestarts.slice(0, MAX_FACT_ITEMS),
    });
  }
  if (recentRestarts.length > 0) {
    return degradedCheck("kubernetes-pods", "OpenGeni pods are ready but restarted recently", {
      podCount: items.length,
      recentRestartCount: recentRestarts.length,
      recentRestarts: recentRestarts.slice(0, MAX_FACT_ITEMS),
    });
  }
  return passedCheck("kubernetes-pods", "All selected OpenGeni pods are ready", {
    podCount: items.length,
  });
}

function evaluateHelmRelease(value: unknown, release: string): DeploymentHealthCheck {
  const items = arrayValue(value).map(objectValue);
  const matched = items.find((item) => item.name === release);
  if (!matched) return failedCheck("helm-release", "The OpenGeni Helm release was not found");
  const status = stringValue(matched.status);
  return status === "deployed"
    ? passedCheck("helm-release", "The OpenGeni Helm release is deployed", {
        chart: stringValue(matched.chart),
        revision: stringValue(matched.revision),
      })
    : failedCheck("helm-release", "The OpenGeni Helm release is not deployed", {
        status,
        revision: stringValue(matched.revision),
      });
}

function evaluatePersistentVolumeClaims(value: unknown): DeploymentHealthCheck {
  const items = listItems(value);
  const unavailable = items.flatMap((item) => {
    const record = objectValue(item);
    return objectValue(record.status).phase === "Bound"
      ? []
      : [stringValue(objectValue(record.metadata).name)];
  });
  return unavailable.length > 0
    ? failedCheck("persistent-volume-claims", "One or more PVCs are not Bound", {
        unavailableClaimCount: unavailable.length,
        unavailableClaims: unavailable.slice(0, MAX_FACT_ITEMS),
        claimCount: items.length,
      })
    : passedCheck(
        "persistent-volume-claims",
        items.length === 0 ? "The namespace declares no PVCs" : "All PVCs are Bound",
        { claimCount: items.length },
      );
}

function evaluateWarningEvents(
  value: unknown,
  now: Date,
  warningWindowSeconds: number,
): DeploymentHealthCheck {
  const recent = listItems(value).flatMap((item) => {
    const record = objectValue(item);
    const observedAt = [record.eventTime, record.lastTimestamp, record.firstTimestamp]
      .map(stringValue)
      .find(Boolean);
    if (!observedAt || !withinWindow(observedAt, now, warningWindowSeconds)) return [];
    return [
      {
        reason: stringValue(record.reason),
        object: `${stringValue(objectValue(record.involvedObject).kind)}/${stringValue(
          objectValue(record.involvedObject).name,
        )}`,
      },
    ];
  });
  return recent.length > 0
    ? degradedCheck("kubernetes-warning-events", "Recent Kubernetes Warning events exist", {
        warningCount: recent.length,
        warnings: recent.slice(0, MAX_FACT_ITEMS),
      })
    : passedCheck("kubernetes-warning-events", "No recent Kubernetes Warning events exist", {
        warningCount: 0,
      });
}

function serviceProxyJsonCheck(
  namespace: string,
  service: { id: string; service: string; port: number; path: string },
  dependencies: DeploymentHealthAuditDependencies,
): { check: DeploymentHealthCheck; revision?: string } {
  const command = [
    "kubectl",
    "get",
    "--raw",
    serviceProxyPath(namespace, service.service, service.port, service.path),
  ];
  const result = dependencies.run(command);
  if (result.exitCode !== 0) {
    return {
      check: failedCheck(
        service.id,
        `${service.service}/${service.path} was unavailable through the Kubernetes Service proxy`,
      ),
    };
  }
  let payload: Record<string, unknown>;
  try {
    payload = objectValue(JSON.parse(result.stdout));
  } catch {
    return {
      check: errorCheck(service.id, `${service.service}/${service.path} returned invalid JSON`),
    };
  }
  if (payload.ok !== true) {
    return {
      check: failedCheck(service.id, `${service.service}/${service.path} did not report ok=true`),
    };
  }
  const revision = stringValue(payload.deploymentRevision) || undefined;
  const state = stringValue(payload.state) || undefined;
  const role = stringValue(payload.role) || undefined;
  return {
    check: passedCheck(service.id, `${service.service}/${service.path} reported healthy`, {
      ...(revision ? { deploymentRevision: revision } : {}),
      ...(state ? { state } : {}),
      ...(role ? { role } : {}),
    }),
    ...(revision ? { revision } : {}),
  };
}

function serviceProxyTextCheck(
  namespace: string,
  service: { id: string; service: string; port: number; path: string; expected: string },
  dependencies: DeploymentHealthAuditDependencies,
): DeploymentHealthCheck {
  const result = dependencies.run([
    "kubectl",
    "get",
    "--raw",
    serviceProxyPath(namespace, service.service, service.port, service.path),
  ]);
  if (result.exitCode !== 0) {
    return failedCheck(
      service.id,
      `${service.service}/${service.path} was unavailable through the Kubernetes Service proxy`,
    );
  }
  return result.stdout.trim() === service.expected
    ? passedCheck(service.id, `${service.service}/${service.path} reported healthy`)
    : failedCheck(service.id, `${service.service}/${service.path} returned an unexpected response`);
}

function observabilityVerificationCheck(
  args: DeploymentHealthAuditArgs,
  revision: string,
  dependencies: DeploymentHealthAuditDependencies,
): DeploymentHealthCheck {
  const command = [
    dependencies.bunExecutable ?? "bun",
    "scripts/verify-observability-stack.ts",
    "--namespace",
    args.observabilityNamespace,
    "--release",
    args.observabilityRelease,
    "--app-namespace",
    args.namespace,
    "--source-revision",
    revision,
  ];
  const result = dependencies.run(command);
  if (result.exitCode !== 0) {
    return failedCheck(
      "observability-verification",
      "The canonical observability verifier did not pass",
    );
  }
  try {
    const payload = objectValue(JSON.parse(result.stdout));
    if (payload.ok !== true) {
      return failedCheck(
        "observability-verification",
        "The canonical observability verifier did not report ok=true",
      );
    }
    return passedCheck(
      "observability-verification",
      "The canonical observability verifier passed",
      { sourceRevision: revision },
    );
  } catch {
    return errorCheck(
      "observability-verification",
      "The canonical observability verifier returned invalid JSON",
    );
  }
}

function aggregateStatus(checks: DeploymentHealthCheck[]): DeploymentHealthStatus {
  if (checks.some((check) => check.status === "error")) return "audit_error";
  if (checks.some((check) => check.status === "failed")) return "incident";
  if (checks.some((check) => check.status === "degraded")) return "degraded";
  return "healthy";
}

function passedCheck(
  id: string,
  summary: string,
  facts?: Record<string, JsonValue>,
): DeploymentHealthCheck {
  return {
    id,
    status: "passed",
    remediationClass: "none",
    summary,
    ...(facts ? { facts } : {}),
  };
}

function degradedCheck(
  id: string,
  summary: string,
  facts?: Record<string, JsonValue>,
): DeploymentHealthCheck {
  return {
    id,
    status: "degraded",
    remediationClass: "observe",
    summary,
    ...(facts ? { facts } : {}),
  };
}

function failedCheck(
  id: string,
  summary: string,
  facts?: Record<string, JsonValue>,
): DeploymentHealthCheck {
  return {
    id,
    status: "failed",
    remediationClass: "operator_required",
    summary,
    ...(facts ? { facts } : {}),
  };
}

function errorCheck(id: string, summary: string): DeploymentHealthCheck {
  return {
    id,
    status: "error",
    remediationClass: "retry_read_only",
    summary,
  };
}

function safeCommandFailureSummary(command: string[], error: unknown): string {
  if (isCommandFailure(error)) {
    return `${command[0]} audit command failed with exit code ${error.exitCode}`;
  }
  return `${command[0]} audit command returned invalid JSON`;
}

function isCommandFailure(value: unknown): value is CommandFailure {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<CommandFailure>;
  return Array.isArray(record.command) && typeof record.exitCode === "number";
}

function listItems(value: unknown): unknown[] {
  return arrayValue(objectValue(value).items);
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (
    !trimmed ||
    Buffer.byteLength(trimmed, "utf8") > MAX_FACT_STRING_BYTES ||
    !SAFE_FACT_STRING.test(trimmed)
  ) {
    return "";
  }
  return trimmed;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function withinWindow(value: string, now: Date, windowSeconds: number): boolean {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const age = now.getTime() - timestamp;
  return age >= 0 && age <= windowSeconds * 1_000;
}

function serviceProxyPath(namespace: string, service: string, port: number, path: string): string {
  return `/api/v1/namespaces/${encodeURIComponent(namespace)}/services/http:${encodeURIComponent(
    service,
  )}:${port}/proxy/${path.replace(/^\/+/, "")}`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function boundedIdentifier(value: string, argument: string): string {
  if (!/^[a-z0-9]([a-z0-9.-]{0,61}[a-z0-9])?$/.test(value)) {
    throw new Error(`${argument} must be a bounded DNS-style identifier`);
  }
  return value;
}

function boundedRevision(value: string, argument: string): string {
  if (!value.trim() || value.length > 128 || /\s/.test(value)) {
    throw new Error(`${argument} must be a non-empty revision without whitespace`);
  }
  return value;
}

function positiveInteger(value: string, argument: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${argument} must be a positive integer`);
  }
  return parsed;
}

if (import.meta.main) {
  try {
    const args = parseDeploymentHealthAuditArgs(process.argv.slice(2));
    const result = auditDeploymentHealth(args);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.exitCode);
  } catch {
    const result: DeploymentHealthAuditResult = {
      schemaVersion: "opengeni.deployment-health-audit.v1",
      observedAt: new Date().toISOString(),
      status: "audit_error",
      ok: false,
      exitCode: 3,
      deployment: {
        namespace: "unknown",
        release: "unknown",
        observedRevisions: [],
        upstreamLagPolicy: "informational",
      },
      checks: [
        errorCheck(
          "health-audit-cli",
          "The health audit could not start because its arguments or runtime dependencies were invalid",
        ),
      ],
    };
    console.log(JSON.stringify(result, null, 2));
    process.exit(3);
  }
}
