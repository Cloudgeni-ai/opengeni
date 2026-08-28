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
  sandboxOwnershipEnabled?: boolean | undefined;
  sandboxLazyProvisionEnabled?: boolean | undefined;
  rigVerificationLeaseOwnershipEnabled?: boolean | undefined;
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
 * Closed set of organization-tenancy compatibility lanes (the tenancy
 * migration's validate phase; see `docs/organization-tenancy.md`).
 *
 * Each entry names one legacy behaviour a live request can still take today.
 * The metric built from them is deliberately a COUNTER of lane USES, and it
 * measures exactly one thing: **is this lane still being exercised?** That is
 * the question the tenancy cutover gate ("zero incompatible writers") actually
 * asks, and it is answerable.
 *
 * It is emphatically NOT a burndown of unmigrated rows, and must never be
 * relabelled as one. Every one of these lanes is still *open*: the live write
 * paths keep producing rows in it, so no row-count predicate over any of them
 * can reach zero and a backlog gauge would read as a permanent, untruthful
 * unmigrated backlog. `docs/organization-tenancy.md` records, per lane, why -
 * including the lanes deliberately left uninstrumented because no truthful
 * signal exists for them yet.
 *
 * The recorded value is the lane name and nothing else. No organization,
 * workspace, session, subject, connection, or resource identity, and no
 * credential, name, or content, may ever become a label here.
 */
export const TENANCY_COMPATIBILITY_LANES = [
  /**
   * A provider connection carrying `authority_scope = 'legacy_user'` was
   * resolved for accepted use: a personal row with no common authority or
   * grant, admitted through `legacy_user_compatibility` provenance instead of
   * an explicit delegation. Migration 0256 backfilled the existing rows, but
   * its `bind_connection_authority` trigger still classifies a NEW personal
   * connection this way whenever the inserting subject has no active
   * organization membership, so this counter is expected to stay above zero
   * until that classification changes. That is the finding, not a defect.
   */
  "connection_legacy_user",
  /**
   * A workspace-scope connection ref carried no connection id, so the
   * accepted-use authority (migration 0279) could not identify the exact row
   * and the request fell back to the unprivileged pre-snapshot resolution.
   * This lane writes no `connection_use_audit_facts` row and leaves no durable
   * trace of any kind, so a use counter is the only possible evidence it was
   * taken at all.
   */
  "connection_pre_snapshot_ref",
  /**
   * A NEW persistable `/workspace` mutation was refused because the writer
   * behind it has no recorded authority (`authority_unattributed`): either a
   * direct request whose principal froze the pre-0096 legacy initiator, or a
   * retained process whose pre-0277 row has no tenancy half. This counts
   * REFUSED MUTATIONS, not unattributed rows - the turn and process admission
   * lanes deliberately still accept a `legacy_unattributed` initiator, and
   * nothing may invent the missing authority or disturb the running provider
   * process.
   */
  "workspace_writer_unattributed",
] as const;
export type TenancyCompatibilityLane = (typeof TENANCY_COMPATIBILITY_LANES)[number];

const TENANCY_COMPATIBILITY_LANE_SET = new Set<string>(TENANCY_COMPATIBILITY_LANES);

const TENANCY_COMPATIBILITY_LANE_METRIC = {
  name: "opengeni_tenancy_compatibility_lane_uses_total",
  help: "Live uses of an organization-tenancy compatibility lane, by lane.",
} as const;

/**
 * Record one live use of a tenancy compatibility lane. Fail-safe by
 * construction: telemetry must never change an authorization or credential
 * outcome, so a registry failure is counted best-effort and swallowed here.
 */
export function recordTenancyCompatibilityLaneUse(
  observability: Observability | null | undefined,
  lane: TenancyCompatibilityLane,
): void {
  if (!observability) return;
  // An unreviewed lane name must not silently mint a new series.
  if (!TENANCY_COMPATIBILITY_LANE_SET.has(lane)) return;
  try {
    observability.incrementCounter({ ...TENANCY_COMPATIBILITY_LANE_METRIC, labels: { lane } });
  } catch {
    recordObserverFailure(observability, "tenancy_compatibility_lane");
  }
}

const INTERACTION_RESOURCES = new Set(["browser", "computer"]);
const INTERACTION_OPERATIONS = new Set([
  "create",
  "end",
  "suspend",
  "resume",
  "publish",
  "observe",
  "act",
  "open_target",
  "select_target",
  "close_target",
  "attach",
  "auth_start",
  "auth_report",
  "auth_fill",
  "auth_verify",
  "intervention_create",
  "intervention_resolve",
]);
const INTERACTION_OUTCOMES = new Set([
  "prepared",
  "dispatched",
  "completed",
  "failed",
  "outcome_unknown",
  "stale",
  "cancelled",
]);
const INTERACTION_MODES = new Set([
  "semantic",
  "coordinate",
  "keyboard",
  "clipboard",
  "permission",
  "lifecycle",
  "media",
  "auth",
  "human",
]);
const INTERACTION_AUTH_STATES = new Set([
  "discovering",
  "awaiting_choice",
  "awaiting_secret",
  "awaiting_external_action",
  "working",
  "verified",
  "failed",
  "cancelled",
]);
const INTERACTION_INTERVENTION_KINDS = new Set([
  "manual_login",
  "mfa",
  "external_action",
  "confirmation",
  "other",
]);
const INTERACTION_INTERVENTION_OUTCOMES = new Set([
  "opened",
  "completed",
  "dismissed",
  "expired",
  "cancelled",
]);
const WORKSPACE_INSIGHTS_RANGES = new Set(["today", "week", "month", "ytd"]);
const WORKSPACE_INSIGHTS_OUTCOMES = new Set(["completed", "failed"]);
const workspaceInsightsDurationHistogramBuckets = [0.05, 0.1, 0.25, 0.5, 1, 1.5, 2, 3, 5, 10, 30];
const PUBLIC_STARTUP_DEPENDENCIES = new Set([
  "Modal private-registry image",
  "NATS",
  "PostgreSQL runtime posture",
  "Temporal",
  "Temporal client",
  "Temporal schedule (file upload reaper)",
  "Temporal schedule (sandbox reaper)",
  "Temporal schedule (session-workflow wake dispatcher)",
  "Temporal schedule (site auth maintenance)",
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
  ["correlationId", /^[A-Za-z0-9._:-]{1,128}$/],
]);

const PUBLIC_CHANNEL_A_OPERATIONS = new Set([
  "fs.list",
  "fs.list-batch",
  "fs.read",
  "fs.write",
  "fs.delete",
  "fs.move",
  "fs.mkdir",
  "git.status",
  "git.diff",
  "git.read-batch",
  "git.log",
  "git.show",
  "terminal.exec",
  "terminal.pty.open",
  "terminal.pty.write",
  "terminal.pty.resize",
  "terminal.pty.close",
  "read",
  "mutation",
]);

const PUBLIC_CHANNEL_A_FAILURE_REASONS = new Set([
  "request_cancelled",
  "provider_read_busy",
  "provider_unavailable",
  "lifecycle_conflict",
  "request_rejected",
  "unexpected",
]);

const PUBLIC_API_FATAL_PHASES = new Set(["startup", "running"]);
const PUBLIC_API_FATAL_REASON_KINDS = new Set([
  "bigint",
  "boolean",
  "error",
  "function",
  "null",
  "number",
  "object",
  "string",
  "symbol",
  "undefined",
]);

/**
 * Public diagnostic values are protocol constants, never values inferred from
 * an exception's name, constructor, code, message, or enumerable properties.
 * Unknown classes collapse to one fixed fallback; unknown codes and origins
 * are omitted rather than copied through based on syntax.
 */
const PUBLIC_TELEMETRY_ERROR_CLASSES = new Set([
  "ApiFatalOperationError",
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
  "SandboxChannelAOperationError",
  "SnapshotOperationError",
  "StartupDependencyError",
  "TelemetryExportError",
  "CodemodeOperationError",
  "CodemodeTokenRenewalOperationError",
  "WorkerLifecycleOperation",
  "WorkerLifecycleOperationError",
  "WorkerOperationError",
  "WorkflowWakeOperationError",
]);

const PUBLIC_TELEMETRY_ERROR_CODES = new Set([
  "agent_command_wake_failed",
  "api_startup_failed",
  "api_uncaught_exception",
  "api_unhandled_rejection",
  "artifact_materializer_native_input_framing_failed",
  "artifact_materializer_native_snapshot_open_failed",
  "artifact_materializer_native_state_mismatch",
  "artifact_materializer_source_content_type_mismatch",
  "artifact_materializer_source_open_failed",
  "artifact_materializer_source_revalidation_failed",
  "artifact_materializer_source_stream_identity_mismatch",
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
  "sandbox_channel_a_cancelled",
  "sandbox_channel_a_lifecycle_conflict",
  "sandbox_channel_a_operation_failed",
  "sandbox_channel_a_provider_busy",
  "sandbox_channel_a_provider_unavailable",
  "screenshot_capture_failed",
  "session_event_live_publish_failed",
  "session_workflow_wake_failed",
  "snapshot_operation_failed",
  "startup_dependency_retry",
  "tool_list_too_large",
  "tool_result_too_large",
  "codemode_operation_failed",
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
  "codemode",
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
  private readonly pendingExports = new Set<Promise<void>>();
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
      deployment_revision: settings.deploymentRevision ?? "dev",
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
      this.registerSandboxRolloutConfig();
      this.registerTenancyCompatibilityLanes();
    }
  }

  /**
   * Publish every compatibility lane at zero on startup. Without this an
   * un-exercised lane has no series at all, and an operator cannot tell "this
   * lane is dormant" from "this lane was never wired up" - the two readings
   * that matter most to a cutover gate.
   */
  private registerTenancyCompatibilityLanes(): void {
    for (const lane of TENANCY_COMPATIBILITY_LANES) {
      this.incrementCounter({ ...TENANCY_COMPATIBILITY_LANE_METRIC, labels: { lane }, amount: 0 });
    }
  }

  private registerSandboxRolloutConfig(): void {
    const ownership = this.settings.sandboxOwnershipEnabled;
    const lazyConfigured = this.settings.sandboxLazyProvisionEnabled;
    const rigVerification = this.settings.rigVerificationLeaseOwnershipEnabled;
    if (
      typeof ownership !== "boolean" ||
      typeof lazyConfigured !== "boolean" ||
      typeof rigVerification !== "boolean"
    ) {
      return;
    }

    const values = [
      ["ownership", "configured", ownership],
      ["ownership", "effective", ownership],
      ["lazy_provision", "configured", lazyConfigured],
      ["lazy_provision", "effective", ownership && lazyConfigured],
      ["rig_verification_lease_ownership", "configured", rigVerification],
      ["rig_verification_lease_ownership", "effective", rigVerification],
    ] as const;
    for (const [feature, state, enabled] of values) {
      this.setGauge({
        name: "opengeni_sandbox_rollout_config",
        help: "Configured and effective sandbox rollout state for this workload revision.",
        labels: { feature, state },
        value: enabled ? 1 : 0,
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

  /** Wait for every OTLP export accepted before or during this drain. */
  async flush(): Promise<void> {
    while (this.pendingExports.size > 0) {
      await Promise.allSettled([...this.pendingExports]);
    }
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
    let pendingExport: Promise<void>;
    pendingExport = Promise.resolve()
      .then(() =>
        this.exporter(endpoint, body, parseHeaders(this.settings.observabilityOtlpHeaders)),
      )
      .catch(() => {
        this.warn("OTLP span export failed", {
          errorClass: "TelemetryExportError",
          errorCode: "otlp_export_failed",
          origin: "observability",
        });
      })
      .finally(() => {
        this.pendingExports.delete(pendingExport);
      });
    this.pendingExports.add(pendingExport);
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

export type InteractionOperationMetricObservation = {
  resource: string;
  operation: string;
  outcome: string;
  mode: string;
  durationMs: number;
  replayed?: boolean | undefined;
};

/** Safe low-cardinality telemetry for Browser/Computer control operations.
 * Resource ids, URLs, locators, page/app text, and input values are excluded by
 * construction. Unknown future enum values collapse until explicitly reviewed. */
export function interactionOperationMetricObserver(
  observability: Observability | null | undefined,
): (observation: InteractionOperationMetricObservation) => void {
  if (!observability) return () => undefined;
  return (observation) => {
    if (observation.replayed) return;
    const resource = boundedMetricEnum(INTERACTION_RESOURCES, observation.resource);
    const operation = boundedMetricEnum(INTERACTION_OPERATIONS, observation.operation);
    const outcome = boundedMetricEnum(INTERACTION_OUTCOMES, observation.outcome);
    const mode = boundedMetricEnum(INTERACTION_MODES, observation.mode);
    try {
      observability.incrementCounter({
        name: "opengeni_interaction_operations_total",
        help: "Browser and Computer operations by bounded resource, operation, mode, and outcome.",
        labels: { resource, operation, mode, outcome },
      });
      observability.observeHistogram({
        name: "opengeni_interaction_operation_duration_seconds",
        help: "Browser and Computer operation duration in seconds.",
        labels: { resource, operation, mode },
        value: boundedMetricDuration(observation.durationMs),
      });
    } catch {
      recordObserverFailure(observability, "interaction_operation");
    }
  };
}

export type InteractionAuthMetricObservation = {
  state: string;
  durationMs: number;
  replayed?: boolean | undefined;
};

export function interactionAuthMetricObserver(
  observability: Observability | null | undefined,
): (observation: InteractionAuthMetricObservation) => void {
  if (!observability) return () => undefined;
  return (observation) => {
    if (observation.replayed) return;
    const state = boundedMetricEnum(INTERACTION_AUTH_STATES, observation.state);
    try {
      observability.incrementCounter({
        name: "opengeni_interaction_auth_transitions_total",
        help: "Browser authentication transitions by bounded resulting state.",
        labels: { state },
      });
      observability.observeHistogram({
        name: "opengeni_interaction_auth_transition_duration_seconds",
        help: "Browser authentication transition request duration in seconds.",
        labels: { state },
        value: boundedMetricDuration(observation.durationMs),
      });
    } catch {
      recordObserverFailure(observability, "interaction_auth");
    }
  };
}

export type InteractionInterventionMetricObservation = {
  kind: string;
  outcome: string;
  waitMs?: number | undefined;
  replayed?: boolean | undefined;
};

export function interactionInterventionMetricObserver(
  observability: Observability | null | undefined,
): (observation: InteractionInterventionMetricObservation) => void {
  if (!observability) return () => undefined;
  return (observation) => {
    if (observation.replayed) return;
    const kind = boundedMetricEnum(INTERACTION_INTERVENTION_KINDS, observation.kind);
    const outcome = boundedMetricEnum(INTERACTION_INTERVENTION_OUTCOMES, observation.outcome);
    try {
      observability.incrementCounter({
        name: "opengeni_interaction_interventions_total",
        help: "Human browser/computer interventions by bounded kind and outcome.",
        labels: { kind, outcome },
      });
      if (observation.waitMs !== undefined) {
        observability.observeHistogram({
          name: "opengeni_interaction_intervention_wait_seconds",
          help: "Time an interaction intervention remained open before settlement.",
          labels: { kind, outcome },
          value: boundedMetricDuration(observation.waitMs),
        });
      }
    } catch {
      recordObserverFailure(observability, "interaction_intervention");
    }
  };
}

export type WorkspaceInsightsMetricObservation = {
  range: string;
  providerFiltered: boolean;
  modelFiltered: boolean;
  outcome: string;
  durationMs: number;
};

/**
 * Identity-free route timing for Workspace Insights. The dedicated two-second
 * bucket is the service target; fixed enums and filter-presence flags keep
 * tenant ids and caller-supplied provider/model values out of telemetry.
 */
export function workspaceInsightsMetricObserver(
  observability: Observability | null | undefined,
): (observation: WorkspaceInsightsMetricObservation) => void {
  if (!observability) return () => undefined;
  return (observation) => {
    const range = boundedMetricEnum(WORKSPACE_INSIGHTS_RANGES, observation.range);
    const outcome = boundedMetricEnum(WORKSPACE_INSIGHTS_OUTCOMES, observation.outcome);
    const providerFilter = observation.providerFiltered ? "filtered" : "all";
    const modelFilter = observation.modelFiltered ? "filtered" : "all";
    const durationSeconds = boundedMetricDuration(observation.durationMs);
    try {
      observability.observeHistogram({
        name: "opengeni_workspace_insights_request_duration_seconds",
        help: "Workspace Insights route service duration by bounded range, filter presence, and outcome.",
        buckets: workspaceInsightsDurationHistogramBuckets,
        labels: {
          range,
          provider_filter: providerFilter,
          model_filter: modelFilter,
          outcome,
        },
        value: durationSeconds,
      });
      observability.info("Workspace Insights request measured", {
        surface: "workspace_insights",
        eventType: "request_latency",
        route: "/v1/workspaces/:workspaceId/insights",
        outcome,
        durationMs: Math.round(durationSeconds * 1_000),
      });
    } catch {
      recordObserverFailure(observability, "workspace_insights");
    }
  };
}

function boundedMetricEnum(allowed: ReadonlySet<string>, value: string): string {
  return allowed.has(value) ? value : "unknown";
}

function boundedMetricDuration(durationMs: number): number {
  return Number.isFinite(durationMs) ? Math.max(0, durationMs) / 1_000 : 0;
}

function recordObserverFailure(observability: Observability, observer: string): void {
  try {
    observability.incrementCounter({
      name: "opengeni_observability_observer_errors_total",
      help: "Observability observer failures isolated from product execution.",
      labels: { observer },
    });
  } catch {
    // The metrics registry itself is unhealthy. Product execution remains
    // authoritative and must not inherit an observability failure.
  }
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
  const dependency = PUBLIC_STARTUP_DEPENDENCIES.has(event.label) ? event.label : "Dependency";
  observability.warn(
    `Startup dependency ${dependency} connection failed; retrying (${event.attempt}/${event.attempts} in ${event.delayMs}ms)`,
    {
      dependency,
      attempt: event.attempt,
      attempts: event.attempts,
      delayMs: event.delayMs,
      errorClass: "StartupDependencyError",
      errorCode: "startup_dependency_retry",
      origin: "observability",
    },
  );
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
    return {
      ...projectStartupDependencyAttributes(attributes),
      ...projectPublicChannelADiagnosticAttributes(attributes),
      ...projectApiFatalDiagnosticAttributes(attributes),
      ...projectPublicDiagnosticAttributes(attributes),
    };
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

function projectApiFatalDiagnosticAttributes(attributes: Attributes): Attributes {
  if (attributes.errorClass !== "ApiFatalOperationError") return {};
  const phase = attributes.phase;
  const reasonKind = attributes.reasonKind;
  return {
    ...(typeof phase === "string" && PUBLIC_API_FATAL_PHASES.has(phase) ? { phase } : {}),
    ...(typeof reasonKind === "string" && PUBLIC_API_FATAL_REASON_KINDS.has(reasonKind)
      ? { reasonKind }
      : {}),
  };
}

function projectStartupDependencyAttributes(attributes: Attributes): Attributes {
  if (
    attributes.errorClass !== "StartupDependencyError" ||
    attributes.errorCode !== "startup_dependency_retry"
  ) {
    return {};
  }
  const dependency = attributes.dependency;
  const attempt = attributes.attempt;
  const attempts = attributes.attempts;
  const delayMs = attributes.delayMs;
  return {
    ...(typeof dependency === "string" && PUBLIC_STARTUP_DEPENDENCIES.has(dependency)
      ? { dependency }
      : {}),
    ...(typeof attempt === "number" && Number.isInteger(attempt) && attempt > 0 ? { attempt } : {}),
    ...(typeof attempts === "number" && Number.isInteger(attempts) && attempts > 0
      ? { attempts }
      : {}),
    ...(typeof delayMs === "number" && Number.isFinite(delayMs) && delayMs >= 0 ? { delayMs } : {}),
  };
}

function projectPublicChannelADiagnosticAttributes(attributes: Attributes): Attributes {
  if (attributes.errorClass !== "SandboxChannelAOperationError") return {};
  const backend = attributes.backend;
  const op = attributes.op;
  const outcome = attributes.outcome;
  const reason = attributes.reason;
  const durationMs = attributes.durationMs;
  const sandboxLeaseKey = attributes.sandboxLeaseKey;
  return {
    ...(typeof backend === "string" && SANDBOX_OPERATION_BACKENDS.has(backend) ? { backend } : {}),
    ...(typeof op === "string" && PUBLIC_CHANNEL_A_OPERATIONS.has(op) ? { op } : {}),
    ...(outcome === "failed" ? { outcome } : {}),
    ...(typeof reason === "string" && PUBLIC_CHANNEL_A_FAILURE_REASONS.has(reason)
      ? { reason }
      : {}),
    ...(typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0
      ? { durationMs }
      : {}),
    ...(typeof sandboxLeaseKey === "string" &&
    PUBLIC_TELEMETRY_OPAQUE_ATTRIBUTE_PATTERNS.get("sandboxLeaseKey")?.test(sandboxLeaseKey)
      ? { sandboxLeaseKey }
      : {}),
  };
}

function projectPublicDiagnosticAttributes(attributes: Attributes): Attributes {
  const errorClass = attributes.errorClass;
  const errorCode = attributes.errorCode;
  const status = attributes.status;
  const origin = attributes.origin;
  const correlationId = attributes.correlationId;
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
    ...(typeof correlationId === "string" &&
    PUBLIC_TELEMETRY_OPAQUE_ATTRIBUTE_PATTERNS.get("correlationId")?.test(correlationId)
      ? { correlationId }
      : {}),
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
