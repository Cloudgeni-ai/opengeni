// Minimal expander for the closed set of Prometheus alert-template actions the
// chart's notification annotations use, so promtool unit tests can state the
// exact text an alert renders. Any other template action throws: extend this
// deliberately (matching Prometheus' Go implementation) rather than guessing.

type Sample = { value: number; labels?: Record<string, string> };

export function expandAlertAnnotations(
  annotations: Record<string, string>,
  sample: Sample,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(annotations).map(([key, text]) => [key, expandAlertTemplate(text, sample)]),
  );
}

export function expandAlertTemplate(text: string, sample: Sample): string {
  return text.replace(/\{\{ (.+?) \}\}/g, (_, action: string) => {
    const label = /^\$labels\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(action);
    if (label) return sample.labels?.[label[1]!] ?? "";
    switch (action) {
      case "$value | humanizePercentage":
        return `${formatG4(sample.value * 100)}%`;
      case "$value | humanizeDuration":
        return humanizeDuration(sample.value);
      case "$value | humanize":
        return humanize(sample.value);
      case "printf `%.0f` $value":
        return sample.value.toFixed(0);
      default:
        throw new Error(`Unsupported alert template action: {{ ${action} }}`);
    }
  });
}

/** Go `%.4g` for the finite magnitudes these fixtures use. */
function formatG4(value: number): string {
  return String(Number(value.toPrecision(4)));
}

function humanize(value: number): string {
  if (value === 0 || !Number.isFinite(value)) return formatG4(value);
  if (Math.abs(value) >= 1) {
    const prefixes = ["k", "M", "G", "T", "P", "E", "Z", "Y"];
    let prefix = "";
    for (const next of prefixes) {
      if (Math.abs(value) < 1000) break;
      prefix = next;
      value /= 1000;
    }
    return `${formatG4(value)}${prefix}`;
  }
  const prefixes = ["m", "u", "n", "p", "f", "a", "z", "y"];
  let prefix = "";
  for (const next of prefixes) {
    if (Math.abs(value) >= 1) break;
    prefix = next;
    value *= 1000;
  }
  return `${formatG4(value)}${prefix}`;
}

function humanizeDuration(value: number): string {
  if (!Number.isFinite(value)) return formatG4(value);
  if (value === 0) return "0s";
  const sign = value < 0 ? "-" : "";
  const magnitude = Math.abs(value);
  if (magnitude < 1) {
    let scaled = value;
    let prefix = "";
    for (const next of ["m", "u", "n", "p", "f", "a", "z", "y"]) {
      if (Math.abs(scaled) >= 1) break;
      prefix = next;
      scaled *= 1000;
    }
    return `${formatG4(scaled)}${prefix}s`;
  }
  const total = Math.trunc(magnitude);
  const days = Math.trunc(total / 86_400);
  const hours = Math.trunc(total / 3_600) % 24;
  const minutes = Math.trunc(total / 60) % 60;
  const seconds = magnitude - days * 86_400 - hours * 3_600 - minutes * 60;
  if (days !== 0) return `${sign}${days}d ${hours}h ${minutes}m ${Math.trunc(seconds)}s`;
  if (hours !== 0) return `${sign}${hours}h ${minutes}m ${Math.trunc(seconds)}s`;
  if (minutes !== 0) return `${sign}${minutes}m ${Math.trunc(seconds)}s`;
  return `${sign}${formatG4(seconds)}s`;
}
