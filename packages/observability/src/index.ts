import { createHash } from "node:crypto";
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";
import { SandboxBackend } from "@opengeni/contracts";

export type AttributeValue = string | number | boolean | null | undefined;
export type Attributes = Record<string, AttributeValue>;

export type ObservabilitySettings = {
  serviceName: string;
  environment: string;
  deploymentRevision?: string | undefined;
  observabilityStructuredLogs: boolean;
  observabilityMetricsEnabled: boolean;
  observabilityOtlpEndpoint?: string | undefined;
  observabilityOtlpHeaders: string;
};

export type ObservabilityOptions = {
  component: string;
  now?: () => number;
  exporter?: (url: string, body: unknown, headers: Record<string, string>) => Promise<void>;
};

export type Span = {
  traceId: string;
  spanId: string;
  end: (input?: { attributes?: Attributes; error?: unknown }) => void;
};

export type MetricLabels = Record<string, AttributeValue>;

/**
 * Stable, non-reversible correlation key for one logical sandbox lease. Public
 * telemetry intentionally drops workspace/group identifiers; this key lets an
 * operator correlate API, worker, and reaper failures without publishing
 * either UUID. The domain separator prevents reuse as a generic identifier
 * digest.
 */
export function sandboxLeaseTelemetryKey(workspaceId: string, sandboxGroupId: string): string {
  return `slk_${createHash("sha256")
    .update("opengeni:sandbox-lease-telemetry:v1\0")
    .update(workspaceId)
    .update("\0")
    .update(sandboxGroupId)
    .digest("hex")
    .slice(0, 32)}`;
}

/**
 * Stable selectors shared by OpenGeni's runtime metrics and optional
 * Prometheus/Grafana distribution. Operators can use these values for custom
 * namespaces and dashboard ConfigMaps without duplicating chart internals.
 */
export const OPENGENI_OBSERVABILITY_DISTRIBUTION = {
  monitoringNamespaceLabel: "opengeni.ai/monitoring",
  monitoringNamespaceLabelValue: "enabled",
  grafanaDashboardLabel: "grafana_dashboard",
  grafanaDashboardLabelValue: "1",
} as const;

const httpHistogramBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const durationHistogramBuckets = [
  0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 900, 1800, 3600,
];

const SANDBOX_OPERATION_BACKENDS = new Set<string>([...SandboxBackend.options, "unprovisioned"]);

const SANDBOX_OPERATION_NAMES = new Set([
  "desktopInput",
  "screenshot",
  "exec",
  "execCommand",
  "writeStdin",
  "cancelExecCommand",
  "readFile",
  "writeFile",
  "listDir",
  "pathExists",
  "viewImage",
  "materializeEntry",
  "editor.createFile",
  "editor.updateFile",
  "editor.deleteFile",
  "resolveExposedPort",
  "serializeSessionState",
]);

/**
 * External logs and OTLP are public/third-party projections, not canonical
 * OpenGeni storage. Only this reviewed closed set of operational fields may
 * cross that boundary. Unknown keys are omitted regardless of their value, so
 * a new diagnostic, identifier, command, response, or provider field cannot
 * become public by accident. This is schema projection, never value inspection
 * or rewriting.
 */
const PUBLIC_TELEMETRY_ATTRIBUTE_KEYS = new Set([
  "http.request.method",
  "http.response.status_code",
  "opengeni.route",
  "opengeni.duration_ms",
  "opengeni.finalization_duration_ms",
  "opengeni.trigger_kind",
  "opengeni.status",
  "error.type",
  "error.status_code",
  "method",
  "route",
  "status",
  "durationMs",
  "attempt",
  "attempts",
  "delayMs",
  "provider",
  "providerApi",
  "model",
  "inputTokens",
  "outputTokens",
  "cachedTokens",
  "cacheWriteTokens",
  "reasoningTokens",
  "accountChangedFromPrevCall",
  "rejectedFields",
  "dependency",
  "activity",
  "backend",
  "op",
  "outcome",
  "eventType",
  "surface",
  "reason",
  "originalBytes",
  "deliveredBytes",
  "estimatedOriginalTokens",
  "estimatedDeliveredTokens",
  "fullEvidenceAvailable",
  "retainedOutputKind",
]);

/** Opaque correlation fields require both a reviewed name and a closed value
 * grammar. Merely adding one to the ordinary allow-list would let an unrelated
 * caller accidentally publish a raw identifier under that name. */
const PUBLIC_TELEMETRY_OPAQUE_ATTRIBUTE_PATTERNS = new Map<string, RegExp>([
  ["sandboxLeaseKey", /^slk_[0-9a-f]{32}$/],
]);

/**
 * Public diagnostic values are protocol constants, never values inferred from
 * an exception's name, constructor, code, message, or enumerable properties.
 * Unknown classes collapse to one fixed fallback; unknown codes and origins
 * are omitted rather than copied through based on syntax.
 */
const PUBLIC_TELEMETRY_ERROR_CLASSES = new Set([
  "OperationError",
  "CodexCheckpointOperationError",
  "CodexFleetShadowOperationError",
  "ComputerActionTimeoutError",
  "ComputerUnavailableError",
  "CredentialRenewalOperationError",
  "CredentialReadOperationError",
  "EventPublishOperationError",
  "GitCredentialRenewalOperationError",
  "HostExportOperationError",
  "HttpOperationError",
  "McpLifecycleError",
  "McpOperationError",
  "MemoryEmbeddingOperationError",
  "MemorySearchOperationError",
  "NatsAuthCalloutOperationError",
  "OAuthOperationError",
  "RunCredentialRenewalOperationError",
  "RunStateCompatibilityError",
  "SnapshotOperationError",
  "StartupDependencyError",
  "TelemetryExportError",
  "ToolspaceOperationError",
  "ToolspaceTokenRenewalOperationError",
  "WorkerLifecycleOperation",
  "WorkerLifecycleOperationError",
  "WorkerOperationError",
  "WorkflowWakeOperationError",
]);

const PUBLIC_TELEMETRY_ERROR_CODES = new Set([
  "agent_command_wake_failed",
  "cleared_goal_live_publish_failed",
  "codex_failover_checkpoint_failed",
  "codex_fleet_shadow_failed",
  "codex_lease_loss_checkpoint_failed",
  "codex_active_credential_read_failed",
  "command_yield_timeout",
  "conflict",
  "control_wake_dispatch_failed",
  "fenced_event_live_publish_failed",
  "forbidden",
  "host_export_batch_delivery_failed",
  "host_export_failure_settlement_stale",
  "host_export_pump_iteration_failed",
  "host_export_retention_prune_failed",
  "idempotency_conflict",
  "incompatible_exposed_ports",
  "internal_error",
  "limit_exceeded",
  "mcp_close_failed",
  "mcp_connect_failed",
  "mcp_tool_call_failed",
  "mcp_tools_list_failed",
  "mcp_transport_failed",
  "memory_edit_embedding_failed",
  "memory_hybrid_vector_failed",
  "memory_save_embedding_failed",
  "nats_auth_callout_start_failed",
  "nested_agent_depth_exceeded",
  "nested_agent_depth_override_forbidden",
  "not_found",
  "oauth_operation_failed",
  "otlp_export_failed",
  "payment_required",
  "provider_verification_failed",
  "screenshot_capture_failed",
  "session_event_live_publish_failed",
  "session_workflow_wake_failed",
  "snapshot_operation_failed",
  "startup_dependency_retry",
  "tool_list_too_large",
  "tool_result_too_large",
  "toolspace_operation_failed",
  "unauthenticated",
  "upstream_unavailable",
  "validation_failed",
  "worker_draining",
  "worker_operation_failed",
  "worker_shutdown_request_failed",
  "workspace_control_live_publish_failed",
]);

const PUBLIC_TELEMETRY_ERROR_ORIGINS = new Set([
  "api",
  "core",
  "db",
  "events",
  "host-export",
  "oauth",
  "observability",
  "runtime",
  "sandbox-computer",
  "sandbox-resume",
  "toolspace",
  "worker",
  "worker-lifecycle",
]);

export type SandboxOperationMetricObservation = {
  backend: string;
  op: string;
  outcome: "ok" | "not_found" | "failed";
  durationMs: number;
};

export function createObservability(
  settings: ObservabilitySettings,
  options: ObservabilityOptions,
): Observability {
  return new Observability(settings, options);
}

type MetricRegistration = {
  kind: "counter" | "gauge" | "histogram";
  labelNames: string[];
};

export class Observability {
  private readonly registry = new Registry();
  private readonly counters = new Map<string, Counter<string>>();
  private readonly gauges = new Map<string, Gauge<string>>();
  private readonly histograms = new Map<string, Histogram<string>>();
  private readonly registrations = new Map<string, MetricRegistration>();
  private readonly now: () => number;
  private readonly exporter: (
    url: string,
    body: unknown,
    headers: Record<string, string>,
  ) => Promise<void>;
  private readonly resourceAttributes: Attributes;

  constructor(
    private readonly settings: ObservabilitySettings,
    private readonly options: ObservabilityOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.exporter = options.exporter ?? defaultExporter;
    this.resourceAttributes = {
      "service.name": settings.serviceName,
      "deployment.environment": settings.environment,
      "opengeni.component": options.component,
    };
    this.registry.setDefaultLabels({
      service: settings.serviceName,
      environment: settings.environment,
      component: options.component,
    });
    if (settings.observabilityMetricsEnabled) {
      collectDefaultMetrics({ register: this.registry, prefix: "opengeni_" });
      this.setGauge({
        name: "opengeni_build_info",
        help: "OpenGeni build information.",
        labels: {
          version: buildVersion(),
          revision: settings.deploymentRevision ?? "dev",
        },
        value: 1,
      });
    }
  }

  debug(message: string, attributes: Attributes = {}): void {
    this.log("debug", message, attributes);
  }

  info(message: string, attributes: Attributes = {}): void {
    this.log("info", message, attributes);
  }

  warn(message: string, attributes: Attributes = {}): void {
    this.log("warn", message, attributes);
  }

  error(message: string, attributes: Attributes = {}): void {
    this.log("error", message, attributes);
  }

  log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    attributes: Attributes = {},
  ): void {
    const publicAttributes = projectPublicTelemetryAttributes(attributes);
    if (!this.settings.observabilityStructuredLogs) {
      if (level === "warn") {
        console.warn(message);
      } else if (level === "error") {
        console.error(message);
      } else {
        console.log(message);
      }
      return;
    }
    const record = {
      timestamp: new Date(this.now()).toISOString(),
      level,
      message,
      service: this.settings.serviceName,
      environment: this.settings.environment,
      component: this.options.component,
      ...cleanAttributes(publicAttributes),
    };
    const serialized = JSON.stringify(record);
    if (level === "warn") {
      console.warn(serialized);
    } else if (level === "error") {
      console.error(serialized);
    } else {
      console.log(serialized);
    }
  }

  startSpan(name: string, attributes: Attributes = {}): Span {
    const traceId = randomHex(16);
    const spanId = randomHex(8);
    const startMs = this.now();
    let ended = false;
    return {
      traceId,
      spanId,
      end: (input = {}) => {
        if (ended) {
          return;
        }
        ended = true;
        const telemetryError =
          input.error !== undefined && input.error !== null
            ? projectSpanErrorForTelemetry(input.error)
            : undefined;
        const errorAttributes = telemetryError ? errorToAttributes(telemetryError) : {};
        this.exportSpan({
          traceId,
          spanId,
          name,
          startMs,
          endMs: this.now(),
          attributes: {
            ...projectPublicTelemetryAttributes({
              ...attributes,
              ...input.attributes,
              ...errorAttributes,
            }),
          },
          ...(telemetryError ? { error: telemetryError } : {}),
        });
      },
    };
  }

  recordHttpRequest(input: {
    method: string;
    route: string;
    status: number;
    durationSeconds: number;
  }): void {
    this.incrementCounter({
      name: "opengeni_http_requests_total",
      help: "Total HTTP requests handled by OpenGeni.",
      labels: {
        method: input.method,
        route: input.route,
        status: String(input.status),
        component: this.options.component,
      },
    });
    this.observeHistogram({
      name: "opengeni_http_request_duration_seconds",
      help: "HTTP request duration in seconds.",
      buckets: httpHistogramBuckets,
      value: input.durationSeconds,
      labels: {
        method: input.method,
        route: input.route,
        component: this.options.component,
      },
    });
  }

  recordWorkerActivity(input: { activity: string; status: string; durationSeconds: number }): void {
    this.incrementCounter({
      name: "opengeni_worker_activity_runs_total",
      help: "Total worker activity executions.",
      labels: {
        activity: input.activity,
        status: input.status,
        component: this.options.component,
      },
    });
    this.observeHistogram({
      name: "opengeni_worker_activity_duration_seconds",
      help: "Worker activity duration in seconds.",
      buckets: durationHistogramBuckets,
      value: input.durationSeconds,
      labels: {
        activity: input.activity,
        component: this.options.component,
      },
    });
  }

  incrementCounter(input: {
    name: string;
    help?: string;
    labels?: MetricLabels;
    amount?: number;
  }): void {
    if (!this.settings.observabilityMetricsEnabled) {
      return;
    }
    const labels = normalizeLabels(input.labels);
    const counter = this.counter(
      input.name,
      input.help ?? `${input.name} counter.`,
      Object.keys(labels),
    );
    counter.inc(labels as never, input.amount ?? 1);
  }

  setGauge(input: { name: string; help?: string; labels?: MetricLabels; value: number }): void {
    if (!this.settings.observabilityMetricsEnabled) {
      return;
    }
    const labels = normalizeLabels(input.labels);
    const gauge = this.gauge(input.name, input.help ?? `${input.name} gauge.`, Object.keys(labels));
    gauge.set(labels as never, input.value);
  }

  incrementGauge(input: {
    name: string;
    help?: string;
    labels?: MetricLabels;
    amount?: number;
  }): void {
    if (!this.settings.observabilityMetricsEnabled) {
      return;
    }
    const labels = normalizeLabels(input.labels);
    const gauge = this.gauge(input.name, input.help ?? `${input.name} gauge.`, Object.keys(labels));
    gauge.inc(labels as never, input.amount ?? 1);
  }

  observeHistogram(input: {
    name: string;
    help?: string;
    labels?: MetricLabels;
    value: number;
    buckets?: number[];
  }): void {
    if (!this.settings.observabilityMetricsEnabled) {
      return;
    }
    const labels = normalizeLabels(input.labels);
    const histogram = this.histogram(
      input.name,
      input.help ?? `${input.name} histogram.`,
      Object.keys(labels),
      input.buckets ?? durationHistogramBuckets,
    );
    histogram.observe(labels as never, input.value);
  }

  async prometheusMetrics(): Promise<string> {
    if (!this.settings.observabilityMetricsEnabled) {
      return "";
    }
    return await this.registry.metrics();
  }

  private counter(name: string, help: string, labelNames: string[]): Counter<string> {
    const existing = this.counters.get(name);
    if (existing) {
      this.assertRegistration(name, "counter", labelNames);
      return existing;
    }
    this.register(name, "counter", labelNames);
    const metric = new Counter({ name, help, labelNames, registers: [this.registry] });
    this.counters.set(name, metric);
    return metric;
  }

  private gauge(name: string, help: string, labelNames: string[]): Gauge<string> {
    const existing = this.gauges.get(name);
    if (existing) {
      this.assertRegistration(name, "gauge", labelNames);
      return existing;
    }
    this.register(name, "gauge", labelNames);
    const metric = new Gauge({ name, help, labelNames, registers: [this.registry] });
    this.gauges.set(name, metric);
    return metric;
  }

  private histogram(
    name: string,
    help: string,
    labelNames: string[],
    buckets: number[],
  ): Histogram<string> {
    const existing = this.histograms.get(name);
    if (existing) {
      this.assertRegistration(name, "histogram", labelNames);
      return existing;
    }
    this.register(name, "histogram", labelNames);
    const metric = new Histogram({ name, help, labelNames, buckets, registers: [this.registry] });
    this.histograms.set(name, metric);
    return metric;
  }

  private register(name: string, kind: MetricRegistration["kind"], labelNames: string[]): void {
    const sorted = [...labelNames].sort();
    this.registrations.set(name, { kind, labelNames: sorted });
  }

  private assertRegistration(
    name: string,
    kind: MetricRegistration["kind"],
    labelNames: string[],
  ): void {
    const registration = this.registrations.get(name);
    const sorted = [...labelNames].sort();
    if (
      !registration ||
      registration.kind !== kind ||
      registration.labelNames.length !== sorted.length ||
      registration.labelNames.some((label, index) => label !== sorted[index])
    ) {
      throw new Error(
        `Metric ${name} was already registered as ${registration?.kind ?? "unknown"} ` +
          `with labels [${registration?.labelNames.join(",") ?? ""}], not ${kind} [${sorted.join(",")}]`,
      );
    }
  }

  private exportSpan(span: {
    traceId: string;
    spanId: string;
    name: string;
    startMs: number;
    endMs: number;
    attributes: Attributes;
    error?: TelemetrySpanError;
  }): void {
    if (!this.settings.observabilityOtlpEndpoint) {
      return;
    }
    const endpoint = `${this.settings.observabilityOtlpEndpoint.replace(/\/$/, "")}/v1/traces`;
    const body = {
      resourceSpans: [
        {
          resource: {
            attributes: otlpAttributes(this.resourceAttributes),
          },
          scopeSpans: [
            {
              scope: {
                name: "@opengeni/observability",
                version: "0.1.0",
              },
              spans: [
                {
                  traceId: span.traceId,
                  spanId: span.spanId,
                  name: span.name,
                  kind: 1,
                  startTimeUnixNano: millisToNanos(span.startMs),
                  endTimeUnixNano: millisToNanos(span.endMs),
                  attributes: otlpAttributes(span.attributes),
                  status: span.error ? { code: 2, message: span.error.statusMessage } : { code: 1 },
                },
              ],
            },
          ],
        },
      ],
    };
    void this.exporter(endpoint, body, parseHeaders(this.settings.observabilityOtlpHeaders)).catch(
      () => {
        this.warn("OTLP span export failed", {
          errorClass: "TelemetryExportError",
          errorCode: "otlp_export_failed",
          origin: "observability",
        });
      },
    );
  }
}

/**
 * Convert routed sandbox-provider observations into one bounded Prometheus
 * contract shared by API-direct and worker-turn execution. Provider/session
 * identifiers, commands, paths, and other request data can never become labels:
 * a future backend or operation is deliberately collapsed to `unknown` until
 * this allowlist is reviewed.
 *
 * The returned callback is fail-safe. Metrics must never change the provider
 * operation's result; a registration/exporter error is counted best-effort and
 * then swallowed at this telemetry boundary.
 */
export function sandboxOperationMetricObserver(
  observability: Observability,
): (observation: SandboxOperationMetricObservation) => void {
  return (observation) => {
    const backend = SANDBOX_OPERATION_BACKENDS.has(observation.backend)
      ? observation.backend
      : "unknown";
    const op = SANDBOX_OPERATION_NAMES.has(observation.op) ? observation.op : "unknown";
    try {
      observability.incrementCounter({
        name: "opengeni_sandbox_operations_total",
        help: "Physical routed sandbox provider operations by backend, operation, and outcome.",
        labels: { backend, op, outcome: observation.outcome },
      });
      observability.observeHistogram({
        name: "opengeni_sandbox_operation_duration_seconds",
        help: "Physical routed sandbox provider-operation duration in seconds.",
        labels: { backend, op },
        value: Math.max(0, observation.durationMs) / 1_000,
      });
    } catch {
      try {
        observability.incrementCounter({
          name: "opengeni_observability_observer_errors_total",
          help: "Observability observer failures isolated from product execution.",
          labels: { observer: "sandbox_operation" },
        });
      } catch {
        // The metrics registry itself is unhealthy. Product execution remains
        // authoritative and must not inherit an observability failure.
      }
    }
  };
}

export type StartupDependencyRetryEvent = {
  label: string;
  attempt: number;
  attempts: number;
  delayMs: number;
  error: unknown;
};

export function logStartupDependencyRetry(
  observability: Observability,
  event: StartupDependencyRetryEvent,
): void {
  observability.warn("Startup dependency connection failed; retrying", {
    dependency: event.label,
    attempt: event.attempt,
    attempts: event.attempts,
    delayMs: event.delayMs,
    errorClass: "StartupDependencyError",
    errorCode: "startup_dependency_retry",
    origin: "observability",
  });
}

function normalizeLabels(labels: MetricLabels = {}): Record<string, string> {
  return Object.fromEntries(
    Object.entries(labels)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]): [string, string] => [key, String(value)])
      .sort((left, right) => left[0].localeCompare(right[0])),
  );
}

function buildVersion(): string {
  return process.env.OPENGENI_VERSION ?? process.env.npm_package_version ?? "dev";
}

function cleanAttributes(attributes: Attributes): Record<string, string | number | boolean | null> {
  return Object.fromEntries(
    Object.entries(attributes).filter(([, value]) => value !== undefined),
  ) as Record<string, string | number | boolean | null>;
}

function projectPublicTelemetryAttributes(attributes: Attributes): Attributes {
  if ("errorClass" in attributes || "errorCode" in attributes) {
    return projectPublicDiagnosticAttributes(attributes);
  }
  return Object.fromEntries(
    Object.entries(attributes).filter(([key, value]) => {
      if (value === undefined) return false;
      if (PUBLIC_TELEMETRY_ATTRIBUTE_KEYS.has(key)) return true;
      const pattern = PUBLIC_TELEMETRY_OPAQUE_ATTRIBUTE_PATTERNS.get(key);
      return typeof value === "string" && pattern?.test(value) === true;
    }),
  );
}

function projectPublicDiagnosticAttributes(attributes: Attributes): Attributes {
  const errorClass = attributes.errorClass;
  const errorCode = attributes.errorCode;
  const status = attributes.status;
  const origin = attributes.origin;
  return {
    errorClass:
      typeof errorClass === "string" && PUBLIC_TELEMETRY_ERROR_CLASSES.has(errorClass)
        ? errorClass
        : "OperationError",
    ...(typeof errorCode === "string" && PUBLIC_TELEMETRY_ERROR_CODES.has(errorCode)
      ? { errorCode }
      : {}),
    ...(typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
      ? { status }
      : {}),
    ...(typeof origin === "string" && PUBLIC_TELEMETRY_ERROR_ORIGINS.has(origin) ? { origin } : {}),
  };
}

type TelemetrySpanError = {
  type: string;
  statusCode?: number;
  statusMessage: string;
};

/**
 * External OTLP projection. It intentionally exports only error class/status
 * metadata and never mutates canonical OpenGeni errors, events, or history.
 */
function projectSpanErrorForTelemetry(error: unknown): TelemetrySpanError {
  const statusCode = errorStatusCode(error);
  return {
    type: "OperationError",
    ...(statusCode === undefined ? {} : { statusCode }),
    statusMessage: statusCode === undefined ? "operation failed" : `HTTP ${statusCode}`,
  };
}

function errorStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  try {
    const value = (error as { status?: unknown; statusCode?: unknown }).status;
    const statusCode =
      Number.isInteger(value) && typeof value === "number"
        ? value
        : (error as { statusCode?: unknown }).statusCode;
    return Number.isInteger(statusCode) &&
      typeof statusCode === "number" &&
      statusCode >= 100 &&
      statusCode <= 599
      ? statusCode
      : undefined;
  } catch {
    // OTLP projection must never mask the exact internal failure.
    return undefined;
  }
}

function errorToAttributes(error: TelemetrySpanError): Attributes {
  return {
    "error.type": error.type,
    ...(error.statusCode === undefined ? {} : { "error.status_code": error.statusCode }),
  };
}

function otlpAttributes(
  attributes: Attributes,
): Array<{ key: string; value: Record<string, string | number | boolean> }> {
  return Object.entries(cleanAttributes(attributes)).map(([key, value]) => ({
    key,
    value: otlpValue(value),
  }));
}

function otlpValue(
  value: string | number | boolean | null,
): Record<string, string | number | boolean> {
  if (typeof value === "number") {
    return Number.isInteger(value) ? { intValue: value } : { doubleValue: value };
  }
  if (typeof value === "boolean") {
    return { boolValue: value };
  }
  return { stringValue: value === null ? "" : boundedOtlpString(value) };
}

function boundedOtlpString(value: string): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= 512) return value;
  return `${new TextDecoder().decode(bytes.slice(0, 509))}…`;
}

function millisToNanos(ms: number): string {
  return String(BigInt(Math.round(ms)) * 1_000_000n);
}

function randomHex(bytes: number): string {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(values, (value) => value.toString(16).padStart(2, "0")).join("");
}

export function parseHeaders(value: string): Record<string, string> {
  if (!value.trim()) {
    return {};
  }
  const entries: Array<[string, string]> = value
    .split(",")
    .map((pair): [string, string] => {
      const separator = pair.indexOf("=");
      if (separator === -1) {
        return [pair.trim(), ""];
      }
      return [pair.slice(0, separator).trim(), pair.slice(separator + 1).trim()];
    })
    .filter(([key]) => key.length > 0);
  return Object.fromEntries(entries);
}

async function defaultExporter(
  url: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`OTLP endpoint returned HTTP ${response.status}`);
  }
}
