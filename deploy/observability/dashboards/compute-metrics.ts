import { readFileSync } from "node:fs";

// The Prometheus metric names Opengeni compute emits, read from their
// sources, so the Compute dashboard and the chart's compute alerts can only
// query metrics that exist: the control service's, in its text format, and
// the hosts', as Prometheus's OTLP receiver names them (dots become
// underscores, the unit a suffix, sums end in _total and histograms in
// _bucket, _sum and _count).

const sources = new URL("../../../compute/crates/", import.meta.url);

const unitSuffix: Record<string, string> = { s: "_seconds", By: "_bytes", us: "_microseconds" };

export function computeMetricNames(): Set<string> {
  const names = new Set<string>();
  const control = readFileSync(new URL("compute-control/src/metrics.rs", sources), "utf8");
  for (const [, name] of control.matchAll(/"(compute_(?:control|fleet)_[a-z_]+)"/g)) {
    names.add(name!);
  }
  const host = readFileSync(new URL("compute-host/src/observe/otlp.rs", sources), "utf8");
  for (const [, name, unit] of host.matchAll(/"((?:compute|process)\.[a-z_.]+)" => \("([^"]*)"/g)) {
    const base = name!.replaceAll(".", "_") + (unitSuffix[unit!] ?? "");
    for (const suffix of ["", "_total", "_bucket", "_sum", "_count"]) names.add(base + suffix);
  }
  return names;
}

/** The metric names an expression selects: every name followed by `{` or `[`. */
export function selectedMetrics(expression: string): string[] {
  return [...expression.matchAll(/\b([a-z_:][a-z0-9_:]*)\s*(?=\{|\[)/g)].map((match) => match[1]!);
}
