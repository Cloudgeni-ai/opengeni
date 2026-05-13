export type AttributeValue = string | number | boolean | null | undefined;
export type Attributes = Record<string, AttributeValue>;

export type ObservabilitySettings = {
  serviceName: string;
  environment: string;
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

const histogramBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export function createObservability(settings: ObservabilitySettings, options: ObservabilityOptions): Observability {
  return new Observability(settings, options);
}

export class Observability {
  private readonly metrics = new MetricsRegistry();
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
    if (!this.settings.observabilityMetricsEnabled) {
      return;
    }
    const labels = {
      method: input.method,
      route: input.route,
      status: String(input.status),
      component: this.options.component,
    };
    this.metrics.increment("opengeni_http_requests_total", labels);
    this.metrics.observe("opengeni_http_request_duration_seconds", histogramBuckets, input.durationSeconds, {
      method: input.method,
      route: input.route,
      component: this.options.component,
    });
  }

  recordWorkerActivity(input: { activity: string; status: string; durationSeconds: number }): void {
    if (!this.settings.observabilityMetricsEnabled) {
      return;
    }
    const labels = {
      activity: input.activity,
      status: input.status,
      component: this.options.component,
    };
    this.metrics.increment("opengeni_worker_activity_runs_total", labels);
    this.metrics.observe("opengeni_worker_activity_duration_seconds", histogramBuckets, input.durationSeconds, {
      activity: input.activity,
      component: this.options.component,
    });
  }

  prometheusMetrics(): string {
    return this.metrics.toPrometheus({
      service: this.settings.serviceName,
      environment: this.settings.environment,
      component: this.options.component,
    });
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

class MetricsRegistry {
  private readonly counters = new Map<string, number>();
  private readonly histograms = new Map<string, { buckets: number[]; counts: number[]; sum: number; count: number; labels: Record<string, string> }>();

  increment(name: string, labels: Record<string, string>, amount = 1): void {
    const key = metricKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + amount);
  }

  observe(name: string, buckets: number[], value: number, labels: Record<string, string>): void {
    const key = metricKey(name, labels);
    const histogram = this.histograms.get(key) ?? {
      buckets,
      counts: buckets.map(() => 0),
      sum: 0,
      count: 0,
      labels,
    };
    histogram.sum += value;
    histogram.count += 1;
    for (let index = 0; index < buckets.length; index += 1) {
      if (value <= buckets[index]!) {
        histogram.counts[index] = (histogram.counts[index] ?? 0) + 1;
      }
    }
    this.histograms.set(key, histogram);
  }

  toPrometheus(resourceLabels: Record<string, string>): string {
    const lines = [
      "# HELP opengeni_http_requests_total Total HTTP requests handled by the OpenGeni API.",
      "# TYPE opengeni_http_requests_total counter",
    ];
    for (const [key, value] of this.counters) {
      const { name, labels } = parseMetricKey(key);
      if (name.endsWith("_total")) {
        lines.push(`${name}${formatLabels({ ...resourceLabels, ...labels })} ${value}`);
      }
    }
    lines.push(
      "# HELP opengeni_http_request_duration_seconds HTTP request duration in seconds.",
      "# TYPE opengeni_http_request_duration_seconds histogram",
      "# HELP opengeni_worker_activity_runs_total Total worker activity executions.",
      "# TYPE opengeni_worker_activity_runs_total counter",
      "# HELP opengeni_worker_activity_duration_seconds Worker activity duration in seconds.",
      "# TYPE opengeni_worker_activity_duration_seconds histogram",
    );
    for (const [key, histogram] of this.histograms) {
      const { name, labels } = parseMetricKey(key);
      const baseLabels = { ...resourceLabels, ...labels };
      for (let index = 0; index < histogram.buckets.length; index += 1) {
        lines.push(`${name}_bucket${formatLabels({ ...baseLabels, le: String(histogram.buckets[index]) })} ${histogram.counts[index]}`);
      }
      lines.push(`${name}_bucket${formatLabels({ ...baseLabels, le: "+Inf" })} ${histogram.count}`);
      lines.push(`${name}_sum${formatLabels(baseLabels)} ${histogram.sum}`);
      lines.push(`${name}_count${formatLabels(baseLabels)} ${histogram.count}`);
    }
    return `${lines.join("\n")}\n`;
  }
}

function metricKey(name: string, labels: Record<string, string>): string {
  return JSON.stringify({ name, labels: Object.fromEntries(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b))) });
}

function parseMetricKey(key: string): { name: string; labels: Record<string, string> } {
  return JSON.parse(key) as { name: string; labels: Record<string, string> };
}

function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels).filter(([, value]) => value.length > 0);
  if (entries.length === 0) {
    return "";
  }
  return `{${entries.map(([key, value]) => `${key}="${escapeMetricLabel(value)}"`).join(",")}}`;
}

function escapeMetricLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\n");
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
