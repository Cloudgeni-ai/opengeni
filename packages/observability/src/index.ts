import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from "prom-client";

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

const httpHistogramBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const durationHistogramBuckets = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 900, 1800, 3600];

export function createObservability(settings: ObservabilitySettings, options: ObservabilityOptions): Observability {
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
  private readonly exporter: (url: string, body: unknown, headers: Record<string, string>) => Promise<void>;
  private readonly resourceAttributes: Attributes;

  constructor(private readonly settings: ObservabilitySettings, private readonly options: ObservabilityOptions) {
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

  log(level: "debug" | "info" | "warn" | "error", message: string, attributes: Attributes = {}): void {
    if (!this.settings.observabilityStructuredLogs) {
      const line = attributes.error ? `${message}: ${String(attributes.error)}` : message;
      if (level === "warn") {
        console.warn(line);
      } else if (level === "error") {
        console.error(line);
      } else {
        console.log(line);
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
      ...cleanAttributes(attributes),
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
        const errorAttributes = input.error ? errorToAttributes(input.error) : {};
        this.exportSpan({
          traceId,
          spanId,
          name,
          startMs,
          endMs: this.now(),
          attributes: {
            ...attributes,
            ...input.attributes,
            ...errorAttributes,
          },
          error: input.error,
        });
      },
    };
  }

  recordHttpRequest(input: { method: string; route: string; status: number; durationSeconds: number }): void {
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

  incrementCounter(input: { name: string; help?: string; labels?: MetricLabels; amount?: number }): void {
    if (!this.settings.observabilityMetricsEnabled) {
      return;
    }
    const labels = normalizeLabels(input.labels);
    const counter = this.counter(input.name, input.help ?? `${input.name} counter.`, Object.keys(labels));
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

  incrementGauge(input: { name: string; help?: string; labels?: MetricLabels; amount?: number }): void {
    if (!this.settings.observabilityMetricsEnabled) {
      return;
    }
    const labels = normalizeLabels(input.labels);
    const gauge = this.gauge(input.name, input.help ?? `${input.name} gauge.`, Object.keys(labels));
    gauge.inc(labels as never, input.amount ?? 1);
  }

  observeHistogram(input: { name: string; help?: string; labels?: MetricLabels; value: number; buckets?: number[] }): void {
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

  private histogram(name: string, help: string, labelNames: string[], buckets: number[]): Histogram<string> {
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

  private assertRegistration(name: string, kind: MetricRegistration["kind"], labelNames: string[]): void {
    const registration = this.registrations.get(name);
    const sorted = [...labelNames].sort();
    if (
      !registration
      || registration.kind !== kind
      || registration.labelNames.length !== sorted.length
      || registration.labelNames.some((label, index) => label !== sorted[index])
    ) {
      throw new Error(
        `Metric ${name} was already registered as ${registration?.kind ?? "unknown"} `
        + `with labels [${registration?.labelNames.join(",") ?? ""}], not ${kind} [${sorted.join(",")}]`,
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
    error?: unknown;
  }): void {
    if (!this.settings.observabilityOtlpEndpoint) {
      return;
    }
    const endpoint = `${this.settings.observabilityOtlpEndpoint.replace(/\/$/, "")}/v1/traces`;
    const body = {
      resourceSpans: [{
        resource: {
          attributes: otlpAttributes(this.resourceAttributes),
        },
        scopeSpans: [{
          scope: {
            name: "@opengeni/observability",
            version: "0.1.0",
          },
          spans: [{
            traceId: span.traceId,
            spanId: span.spanId,
            name: span.name,
            kind: 1,
            startTimeUnixNano: millisToNanos(span.startMs),
            endTimeUnixNano: millisToNanos(span.endMs),
            attributes: otlpAttributes(span.attributes),
            status: span.error ? { code: 2, message: errorMessage(span.error) } : { code: 1 },
          }],
        }],
      }],
    };
    void this.exporter(endpoint, body, parseHeaders(this.settings.observabilityOtlpHeaders)).catch((error) => {
      this.warn("OTLP span export failed", { error: errorMessage(error), endpoint });
    });
  }
}

export type StartupDependencyRetryEvent = {
  label: string;
  attempt: number;
  attempts: number;
  delayMs: number;
  error: unknown;
};

export function logStartupDependencyRetry(observability: Observability, event: StartupDependencyRetryEvent): void {
  const message = event.error instanceof Error ? event.error.message : String(event.error);
  observability.warn("Startup dependency connection failed; retrying", {
    dependency: event.label,
    attempt: event.attempt,
    attempts: event.attempts,
    delayMs: event.delayMs,
    error: message,
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
  return process.env.OPENGENI_VERSION
    ?? process.env.npm_package_version
    ?? "dev";
}

function cleanAttributes(attributes: Attributes): Record<string, string | number | boolean | null> {
  return Object.fromEntries(Object.entries(attributes).filter(([, value]) => value !== undefined)) as Record<string, string | number | boolean | null>;
}

function errorToAttributes(error: unknown): Attributes {
  return {
    "error.type": error instanceof Error ? error.name : "Error",
    "error.message": errorMessage(error),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function otlpAttributes(attributes: Attributes): Array<{ key: string; value: Record<string, string | number | boolean> }> {
  return Object.entries(cleanAttributes(attributes)).map(([key, value]) => ({
    key,
    value: otlpValue(value),
  }));
}

function otlpValue(value: string | number | boolean | null): Record<string, string | number | boolean> {
  if (typeof value === "number") {
    return Number.isInteger(value) ? { intValue: value } : { doubleValue: value };
  }
  if (typeof value === "boolean") {
    return { boolValue: value };
  }
  return { stringValue: value === null ? "" : value };
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
  const entries: Array<[string, string]> = value.split(",").map((pair): [string, string] => {
    const separator = pair.indexOf("=");
    if (separator === -1) {
      return [pair.trim(), ""];
    }
    return [pair.slice(0, separator).trim(), pair.slice(separator + 1).trim()];
  }).filter(([key]) => key.length > 0);
  return Object.fromEntries(entries);
}

async function defaultExporter(url: string, body: unknown, headers: Record<string, string>): Promise<void> {
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
