import { readFileSync } from "node:fs";

// The Prometheus metric names Opengeni compute emits, read from their
// sources, so the Compute dashboard and the chart's compute alerts can only
// query metrics that exist: the control service's, as its text format writes
// them, and the hosts', from the list the control service passes on
// (compute-protocol's host_metrics), as Prometheus's OTLP receiver names
// them: dots become underscores, the unit a suffix, counters end in _total
// and histograms are _bucket, _sum and _count.

const sources = new URL("../../../compute/crates/", import.meta.url);

const unitSuffix: Record<string, string> = { s: "_seconds", By: "_bytes", us: "_microseconds" };

function controlNames(): string[] {
  const control = readFileSync(new URL("compute-control/src/metrics.rs", sources), "utf8");
  const histograms = new Set(
    [...control.matchAll(/family\(\s*"([a-z_]+)",\s*"histogram"/g)].map((match) => match[1]!),
  );
  // Every series name is written out in full; a histogram's family name is
  // only its TYPE line.
  return [...control.matchAll(/"(compute_(?:control|fleet)_[a-z_]+)"/g)]
    .map((match) => match[1]!)
    .filter((name) => !histograms.has(name));
}

function hostNames(): string[] {
  const listed = readFileSync(new URL("compute-protocol/src/host_metrics.rs", sources), "utf8");
  const names: string[] = [];
  const declared = /\b(sum|gauge|histogram)\(\s*"((?:compute|process)\.[a-z_.]+)"\s*,\s*"([^"]*)"/g;
  for (const [, kind, name, second] of listed.matchAll(declared)) {
    // A histogram's unit is seconds; its second argument is its description.
    const unit = kind === "histogram" ? "s" : second!;
    const base = name!.replaceAll(".", "_") + (unitSuffix[unit] ?? "");
    if (kind === "sum") names.push(`${base}_total`);
    else if (kind === "gauge") names.push(base);
    else names.push(`${base}_bucket`, `${base}_sum`, `${base}_count`);
  }
  if (names.length === 0) throw new Error("no host metrics found in host_metrics.rs");
  return names;
}

export function computeMetricNames(): Set<string> {
  return new Set([...controlNames(), ...hostNames()]);
}

const notMetrics = new Set([
  "and",
  "or",
  "unless",
  "bool",
  "offset",
  "by",
  "without",
  "on",
  "ignoring",
  "group_left",
  "group_right",
  "inf",
  "nan",
]);

/**
 * The metric names a PromQL expression selects, bare or with matchers: every
 * name that is not a function, keyword, label or Grafana variable.
 */
export function selectedMetrics(expression: string): string[] {
  const names = expression
    .replace(/"(?:[^"\\]|\\.)*"/g, " ")
    .replace(/\{[^}]*\}/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\b(?:by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)/g, " ");
  return [...names.matchAll(/(?<![\w$:.])([a-zA-Z_:][\w:]*)\b(?!\s*\()/g)]
    .map((match) => match[1]!)
    .filter((name) => !notMetrics.has(name));
}
